use tauri::Manager;

use crate::commands::workbook::{SaveResult, MAX_SNAPSHOTS_PER_WORKBOOK};

pub fn autosave_temp_core(
    data_dir: &std::path::Path,
    workbook_id: &str,
    snapshot_json: &str,
) -> Result<SaveResult, String> {
    let recovery_dir = data_dir.join("recovery");
    std::fs::create_dir_all(&recovery_dir).map_err(|e| e.to_string())?;

    let temp_path = recovery_dir.join(format!("{}.coco", workbook_id));
    let temp_path_str = temp_path.to_string_lossy().to_string();

    let conn = rusqlite::Connection::open(&temp_path).map_err(|e| e.to_string())?;
    crate::db::schema::initialize(&conn).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO workbook_meta (workbook_id, app_version, created_at, updated_at, source_type, calc_mode, locale, encrypted)
         VALUES (?1, ?2, ?3, ?3, 'new', 'auto', 'ja-JP', 0)
         ON CONFLICT(workbook_id) DO UPDATE SET updated_at = excluded.updated_at",
        rusqlite::params![workbook_id, env!("CARGO_PKG_VERSION"), now],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO workbook_snapshots (workbook_id, snapshot_json, created_at, reason) VALUES (?1, ?2, ?3, 'auto_save')",
        rusqlite::params![workbook_id, snapshot_json, now],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM workbook_snapshots
         WHERE workbook_id = ?1
           AND snapshot_id NOT IN (
             SELECT snapshot_id FROM workbook_snapshots
             WHERE workbook_id = ?1
             ORDER BY snapshot_id DESC
             LIMIT ?2
           )",
        rusqlite::params![workbook_id, MAX_SNAPSHOTS_PER_WORKBOOK],
    )
    .map_err(|e| e.to_string())?;

    let ok: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    if ok != "ok" {
        drop(conn);
        let _ = std::fs::remove_file(&temp_path);
        return Ok(SaveResult {
            success: false,
            path: temp_path_str,
            error: Some(format!("Integrity check failed: {}", ok)),
        });
    }

    drop(conn);

    let app_conn = crate::db::app_db::open_app_db_at(data_dir)?;
    crate::db::operations::save_recovery_candidate(
        &app_conn,
        workbook_id,
        None,
        &temp_path_str,
        "auto_save",
    )
    .map_err(|e| e.to_string())?;

    Ok(SaveResult {
        success: true,
        path: temp_path_str,
        error: None,
    })
}

pub fn clear_recovery_core(data_dir: &std::path::Path, candidate_id: &str) -> Result<(), String> {
    let conn = crate::db::app_db::open_app_db_at(data_dir)?;
    let temp_path: Option<String> = conn
        .query_row(
            "SELECT temp_path FROM recovery_candidates WHERE candidate_id = ?1",
            rusqlite::params![candidate_id],
            |row| row.get::<_, String>(0),
        )
        .ok();

    if let Some(p) = temp_path {
        let _ = std::fs::remove_file(&p);
    }

    crate::db::operations::delete_recovery_candidate(&conn, candidate_id)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn workbook_autosave_temp(
    app: tauri::AppHandle,
    workbook_id: String,
    snapshot_json: String,
) -> Result<SaveResult, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    autosave_temp_core(&data_dir, &workbook_id, &snapshot_json)
}

#[tauri::command]
pub fn workbook_clear_recovery(app: tauri::AppHandle, candidate_id: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    clear_recovery_core(&data_dir, &candidate_id)
}

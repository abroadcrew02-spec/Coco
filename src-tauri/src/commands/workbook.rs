use rusqlite::Connection;
use std::io;
use std::path::{Path, PathBuf};

pub const MAX_BACKUPS: u32 = 5;
pub const MAX_SNAPSHOTS_PER_WORKBOOK: i64 = 5;

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookHandle {
    pub workbook_id: String,
    pub path: Option<String>,
    pub source_type: String, // "new" | "coco" | "xlsx"
    pub snapshot_json: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkbookResult {
    pub handle: WorkbookHandle,
    pub warnings: Vec<CompatibilityWarning>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWorkbookResult {
    pub handle: WorkbookHandle,
    pub warnings: Vec<CompatibilityWarning>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub success: bool,
    pub path: String,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub success: bool,
    pub path: String,
    pub warnings: Vec<CompatibilityWarning>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityWarning {
    pub severity: String, // "info" | "warning" | "blocking"
    pub code: String,
    pub message: String,
    pub affected_sheets: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub last_opened: String,
    pub exists: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    pub candidate_id: String,
    pub original_path: Option<String>,
    pub saved_at: String,
    pub reason: String,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn open_workbook_db(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    crate::db::schema::initialize(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn bak_path(target: &Path, n: u32) -> PathBuf {
    // Append ".bak.N" to the full target path so multi-dot names like
    // "data.archive.coco" become "data.archive.coco.bak.1" rather than
    // mangling the extension.
    let mut s = target.as_os_str().to_owned();
    s.push(format!(".bak.{n}"));
    PathBuf::from(s)
}

pub fn rotate_backups(target: &Path) -> io::Result<()> {
    if !target.exists() {
        return Ok(());
    }

    let oldest = bak_path(target, MAX_BACKUPS);
    if oldest.exists() {
        std::fs::remove_file(&oldest)?;
    }

    for n in (1..MAX_BACKUPS).rev() {
        let from = bak_path(target, n);
        let to = bak_path(target, n + 1);
        if from.exists() {
            std::fs::rename(&from, &to)?;
        }
    }

    std::fs::copy(target, bak_path(target, 1))?;
    Ok(())
}

pub fn temp_save_path(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or(Path::new("."));
    let stem = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled.coco");
    parent.join(format!(".{stem}.tmp-{}", uuid::Uuid::new_v4()))
}

fn do_save(
    workbook_id: &str,
    path: &str,
    snapshot_json: &str,
    reason: &str,
) -> Result<SaveResult, String> {
    let target = PathBuf::from(path);

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    let tmp_path = temp_save_path(&target);

    if target.exists() {
        rotate_backups(&target).map_err(|e| format!("backup rotation failed: {e}"))?;
        // Seed the tmp DB from the existing target so that prior workbook_snapshots
        // rows are preserved across saves. Without this, every save rewrites a fresh
        // empty DB and the retention cap is meaningless. After insert + cap, the
        // tmp file replaces the target via atomic rename.
        std::fs::copy(&target, &tmp_path).map_err(|e| e.to_string())?;
    }

    let tmp_str = tmp_path
        .to_str()
        .ok_or_else(|| "tmp path is not valid UTF-8".to_string())?;
    let conn = open_workbook_db(tmp_str)?;
    let now = chrono::Utc::now().to_rfc3339();

    // Upsert workbook_meta
    conn.execute(
        "INSERT INTO workbook_meta (workbook_id, app_version, created_at, updated_at, source_type, calc_mode, locale, encrypted)
         VALUES (?1, ?2, ?3, ?3, 'coco', 'auto', 'ja-JP', 0)
         ON CONFLICT(workbook_id) DO UPDATE SET updated_at = excluded.updated_at",
        rusqlite::params![workbook_id, env!("CARGO_PKG_VERSION"), now],
    )
    .map_err(|e| e.to_string())?;

    // Insert snapshot
    conn.execute(
        "INSERT INTO workbook_snapshots (workbook_id, snapshot_json, created_at, reason) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![workbook_id, snapshot_json, now, reason],
    )
    .map_err(|e| e.to_string())?;

    // Integrity check
    let ok: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    if ok != "ok" {
        drop(conn);
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(SaveResult {
            success: false,
            path: path.to_string(),
            error: Some(format!("Integrity check failed: {}", ok)),
        });
    }

    // Keep at most MAX_SNAPSHOTS_PER_WORKBOOK rows per workbook_id; .bak.N
    // file-level rotation already preserves historical recovery, so older
    // in-DB snapshots are dead weight that would grow the file unboundedly.
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

    // Release the SQLite file handle before renaming — Windows refuses to
    // rename a file that still has an open handle.
    drop(conn);

    if let Err(e) = std::fs::rename(&tmp_path, &target) {
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(SaveResult {
            success: false,
            path: path.to_string(),
            error: Some(format!("rename failed: {e}")),
        });
    }

    // Clean up leftover WAL/SHM sidecars for the tmp name.
    let mut wal = tmp_path.as_os_str().to_owned();
    wal.push("-wal");
    let _ = std::fs::remove_file(PathBuf::from(wal));
    let mut shm = tmp_path.as_os_str().to_owned();
    shm.push("-shm");
    let _ = std::fs::remove_file(PathBuf::from(shm));

    Ok(SaveResult {
        success: true,
        path: path.to_string(),
        error: None,
    })
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn workbook_new() -> Result<WorkbookHandle, String> {
    let workbook_id = uuid::Uuid::new_v4().to_string();
    Ok(WorkbookHandle {
        workbook_id,
        path: None,
        source_type: "new".to_string(),
        snapshot_json: None,
    })
}

pub fn open_coco_core(
    data_dir: &std::path::Path,
    path: &str,
) -> Result<OpenWorkbookResult, String> {
    let conn = open_workbook_db(path)?;

    let result: Result<(String, String), rusqlite::Error> = conn.query_row(
        "SELECT workbook_id, snapshot_json FROM workbook_snapshots ORDER BY snapshot_id DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );

    let (workbook_id, snapshot_json) = result.map_err(|e| e.to_string())?;

    let file_name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();

    // Best-effort recent-file recording. Failure to open the app DB or insert
    // must not block the open itself.
    if let Ok(app_conn) = crate::db::app_db::open_app_db_at(data_dir) {
        let _ = crate::db::operations::record_recent_file(&app_conn, path, &file_name);
    }

    Ok(OpenWorkbookResult {
        handle: WorkbookHandle {
            workbook_id,
            path: Some(path.to_string()),
            source_type: "coco".to_string(),
            snapshot_json: Some(snapshot_json),
        },
        warnings: vec![],
    })
}

#[tauri::command]
pub fn workbook_open_coco(app: tauri::AppHandle, path: String) -> Result<OpenWorkbookResult, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    open_coco_core(&data_dir, &path)
}

#[tauri::command]
pub fn workbook_save(
    workbook_id: String,
    path: Option<String>,
    snapshot_json: String,
) -> Result<SaveResult, String> {
    let Some(p) = path else {
        return Ok(SaveResult {
            success: false,
            path: String::new(),
            error: Some("NEEDS_PATH".to_string()),
        });
    };
    do_save(&workbook_id, &p, &snapshot_json, "manual_save")
}

#[tauri::command]
pub fn workbook_save_as(
    workbook_id: String,
    path: String,
    snapshot_json: String,
) -> Result<SaveResult, String> {
    do_save(&workbook_id, &path, &snapshot_json, "manual_save")
}

#[tauri::command]
pub fn workbook_autosave_coco(
    workbook_id: String,
    path: String,
    snapshot_json: String,
) -> Result<SaveResult, String> {
    do_save(&workbook_id, &path, &snapshot_json, "auto_save")
}

pub fn list_recent_core(data_dir: &std::path::Path) -> Result<Vec<RecentFile>, String> {
    let conn = crate::db::app_db::open_app_db_at(data_dir)?;
    let rows = crate::db::operations::list_recent_files(&conn).map_err(|e| e.to_string())?;
    let result = rows
        .into_iter()
        .map(|(path, name, last_opened)| {
            let exists = std::path::Path::new(&path).exists();
            RecentFile { path, name, last_opened, exists }
        })
        .collect();
    Ok(result)
}

#[tauri::command]
pub fn workbook_list_recent(app: tauri::AppHandle) -> Result<Vec<RecentFile>, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    list_recent_core(&data_dir)
}

pub fn list_recovery_core(data_dir: &std::path::Path) -> Result<Vec<RecoveryCandidate>, String> {
    let conn = crate::db::app_db::open_app_db_at(data_dir)?;
    let rows =
        crate::db::operations::list_recovery_candidates(&conn).map_err(|e| e.to_string())?;
    let result = rows
        .into_iter()
        .map(|(candidate_id, original_path, saved_at, reason, _temp_path)| RecoveryCandidate {
            candidate_id,
            original_path,
            saved_at,
            reason,
        })
        .collect();
    Ok(result)
}

#[tauri::command]
pub fn workbook_list_recovery(app: tauri::AppHandle) -> Result<Vec<RecoveryCandidate>, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    list_recovery_core(&data_dir)
}

pub fn restore_backup_core(
    data_dir: &std::path::Path,
    candidate_id: &str,
) -> Result<OpenWorkbookResult, String> {
    let conn = crate::db::app_db::open_app_db_at(data_dir)?;
    let rows =
        crate::db::operations::list_recovery_candidates(&conn).map_err(|e| e.to_string())?;

    let entry = rows
        .into_iter()
        .find(|(id, _, _, _, _)| id == candidate_id)
        .ok_or_else(|| format!("Recovery candidate not found: {}", candidate_id))?;

    let (_id, _original_path, _saved_at, _reason, temp_path) = entry;

    let wb_conn = open_workbook_db(&temp_path)?;
    let result: Result<(String, String), rusqlite::Error> = wb_conn.query_row(
        "SELECT workbook_id, snapshot_json FROM workbook_snapshots ORDER BY snapshot_id DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let (workbook_id, snapshot_json) = result.map_err(|e| e.to_string())?;

    Ok(OpenWorkbookResult {
        handle: WorkbookHandle {
            workbook_id,
            path: Some(temp_path),
            source_type: "coco".to_string(),
            snapshot_json: Some(snapshot_json),
        },
        warnings: vec![],
    })
}

#[tauri::command]
pub fn workbook_restore_backup(
    candidate_id: String,
    app: tauri::AppHandle,
) -> Result<OpenWorkbookResult, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    restore_backup_core(&data_dir, &candidate_id)
}


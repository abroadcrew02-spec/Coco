use rusqlite::Connection;
use std::io;
use std::path::{Path, PathBuf};

pub const MAX_BACKUPS: u32 = 5;
pub const MAX_SNAPSHOTS_PER_WORKBOOK: i64 = 5;
/// req 5.4.3: total size of .bak.1..N must stay under this cap. Older generations
/// are evicted until the total falls below.
pub const MAX_TOTAL_BACKUP_BYTES: u64 = 1024 * 1024 * 1024; // 1 GB

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

    // req 5.4.3: enforce total-size cap by evicting oldest generations.
    enforce_backup_size_cap(target, MAX_TOTAL_BACKUP_BYTES)?;
    Ok(())
}

/// Sum of all existing .bak.* file sizes for the given target. Missing files
/// contribute zero.
pub fn total_backup_size(target: &Path) -> u64 {
    let mut total: u64 = 0;
    for n in 1..=MAX_BACKUPS {
        if let Ok(meta) = std::fs::metadata(bak_path(target, n)) {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// Evict from the highest existing .bak.N (oldest) downward until the total
/// .bak.* size is at or under `max_total_bytes`. Idempotent; no-op when already
/// under cap or when no .bak files exist.
pub fn enforce_backup_size_cap(target: &Path, max_total_bytes: u64) -> io::Result<()> {
    loop {
        let total = total_backup_size(target);
        if total <= max_total_bytes {
            return Ok(());
        }
        // Find the highest-N (oldest) existing .bak file and remove it.
        let mut evicted = false;
        for n in (1..=MAX_BACKUPS).rev() {
            let p = bak_path(target, n);
            if p.exists() {
                std::fs::remove_file(&p)?;
                evicted = true;
                break;
            }
        }
        if !evicted {
            // No more files to evict — total can't shrink further; bail out to
            // avoid an infinite loop in pathological situations.
            return Ok(());
        }
    }
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
    // SQLite's open() silently creates the file if missing — that would leave a
    // bogus empty .coco where the user thought their workbook used to live.
    // Reject missing paths explicitly so the user sees a clear error.
    if !std::path::Path::new(path).exists() {
        return Err(format!("File not found: {path}"));
    }
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

/// Best-effort: after a successful save, record the file in recent_files so
/// the user sees it on next Home visit without needing to re-open.
fn record_saved_path(app: &tauri::AppHandle, path: &str) {
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();
    if let Ok(conn) = crate::db::app_db::open_app_db(app) {
        let _ = crate::db::operations::record_recent_file(&conn, path, &name);
    }
}

/// Pure-Rust save core (callable from tests; identical body to the Tauri
/// command minus the recent-files side effect).
pub fn save_core(
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
pub fn workbook_save(
    app: tauri::AppHandle,
    workbook_id: String,
    path: Option<String>,
    snapshot_json: String,
) -> Result<SaveResult, String> {
    let result = save_core(workbook_id, path, snapshot_json)?;
    if result.success {
        record_saved_path(&app, &result.path);
    }
    Ok(result)
}

/// Pure-Rust save-as core.
pub fn save_as_core(
    workbook_id: String,
    path: String,
    snapshot_json: String,
) -> Result<SaveResult, String> {
    do_save(&workbook_id, &path, &snapshot_json, "manual_save")
}

#[tauri::command]
pub fn workbook_save_as(
    app: tauri::AppHandle,
    workbook_id: String,
    path: String,
    snapshot_json: String,
) -> Result<SaveResult, String> {
    let result = save_as_core(workbook_id, path, snapshot_json)?;
    if result.success {
        record_saved_path(&app, &result.path);
    }
    Ok(result)
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

pub fn remove_recent_core(data_dir: &std::path::Path, path: &str) -> Result<(), String> {
    let conn = crate::db::app_db::open_app_db_at(data_dir)?;
    crate::db::operations::remove_recent_file(&conn, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workbook_remove_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    remove_recent_core(&data_dir, &path)
}

pub fn clear_recent_core(data_dir: &std::path::Path) -> Result<(), String> {
    let conn = crate::db::app_db::open_app_db_at(data_dir)?;
    crate::db::operations::clear_recent_files(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workbook_clear_recent(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    clear_recent_core(&data_dir)
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

    // Defensive: if the recovery temp file has been wiped (user cleared app data,
    // or the .coco was deleted manually), don't let SQLite re-create an empty one.
    if !std::path::Path::new(&temp_path).exists() {
        // Drop the stale candidate row so it stops haunting the home screen.
        let _ = crate::db::operations::delete_recovery_candidate(&conn, candidate_id);
        return Err(format!("Recovery file is missing: {temp_path}"));
    }

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

/// One row from the workbook_snapshots table — surfaces the snapshot id,
/// creation timestamp, and the reason code that triggered the save.
/// The snapshot JSON itself is NOT included to keep the response cheap;
/// a follow-up `workbook_open_snapshot(id)` command can load a specific one.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub snapshot_id: i64,
    pub created_at: String,
    pub reason: String,
}

/// Reads the snapshot list from a .coco file at `path`. The result is ordered
/// newest first. Empty list if the file has no snapshots (e.g. just created)
/// or the table doesn't exist (corrupted file). Returns Err if the path
/// doesn't exist or isn't readable so the frontend can surface a friendly
/// "File not found" message.
pub fn list_snapshots_core(path: &str) -> Result<Vec<SnapshotMeta>, String> {
    if path.is_empty() {
        return Err("NEEDS_PATH".to_string());
    }
    if !std::path::Path::new(path).exists() {
        return Err(format!("File not found: {path}"));
    }
    let conn = open_workbook_db(path)?;
    let mut stmt = conn
        .prepare(
            "SELECT snapshot_id, created_at, reason FROM workbook_snapshots ORDER BY snapshot_id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SnapshotMeta {
                snapshot_id: row.get::<_, i64>(0)?,
                created_at: row.get::<_, String>(1)?,
                reason: row.get::<_, String>(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
pub fn workbook_list_snapshots(path: String) -> Result<Vec<SnapshotMeta>, String> {
    list_snapshots_core(&path)
}

/// Loads a specific snapshot back into a workbook handle without modifying the
/// .coco file. The caller is responsible for any subsequent save — this is
/// only a one-way "open an older version" trip, leaving the on-disk DB intact
/// so the user can compare and roll back without losing the latest state.
pub fn open_snapshot_core(path: &str, snapshot_id: i64) -> Result<OpenWorkbookResult, String> {
    if path.is_empty() {
        return Err("NEEDS_PATH".to_string());
    }
    if !std::path::Path::new(path).exists() {
        return Err(format!("File not found: {path}"));
    }
    let conn = open_workbook_db(path)?;
    let row: Result<(String, String), rusqlite::Error> = conn.query_row(
        "SELECT workbook_id, snapshot_json FROM workbook_snapshots WHERE snapshot_id = ?1",
        rusqlite::params![snapshot_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    let (workbook_id, snapshot_json) =
        row.map_err(|_| format!("Snapshot not found: {snapshot_id}"))?;

    Ok(OpenWorkbookResult {
        handle: WorkbookHandle {
            workbook_id,
            // Intentionally None: opening a historical snapshot detaches it
            // from the on-disk file so Ctrl+S prompts Save As. This protects
            // the user from accidentally overwriting current state with an
            // older version.
            path: None,
            source_type: "coco".to_string(),
            snapshot_json: Some(snapshot_json),
        },
        warnings: vec![],
    })
}

#[tauri::command]
pub fn workbook_open_snapshot(
    path: String,
    snapshot_id: i64,
) -> Result<OpenWorkbookResult, String> {
    open_snapshot_core(&path, snapshot_id)
}

/// VACUUM result with the on-disk size before and after, so the UI can show
/// the user how much they reclaimed. Both sizes are in bytes.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VacuumResult {
    pub before_bytes: u64,
    pub after_bytes: u64,
}

/// Compacts a .coco file via SQLite VACUUM. Reclaims space freed by snapshot
/// retention and the temp-file rename dance. Safe to run while the user is
/// not actively editing — VACUUM holds an exclusive lock for the duration.
///
/// Returns Err for: empty path (NEEDS_PATH), missing file, or any SQLite
/// failure. The file is left untouched on error since VACUUM operates on a
/// temp database internally before swapping.
pub fn vacuum_core(path: &str) -> Result<VacuumResult, String> {
    if path.is_empty() {
        return Err("NEEDS_PATH".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    let before_bytes = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch("VACUUM;").map_err(|e| e.to_string())?;
    // Release the connection so the filesystem can report the final size.
    drop(conn);
    let after_bytes = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    Ok(VacuumResult {
        before_bytes,
        after_bytes,
    })
}

#[tauri::command]
pub fn workbook_vacuum(path: String) -> Result<VacuumResult, String> {
    vacuum_core(&path)
}

/// Result of `PRAGMA integrity_check`. SQLite returns "ok" on success or a
/// list of failure descriptions; we model that as `ok: bool` + the raw lines
/// so the UI can surface a count of issues without parsing free-form text.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityCheckResult {
    pub ok: bool,
    pub issues: Vec<String>,
}

/// Runs `PRAGMA integrity_check` on the given .coco file. Useful for
/// diagnosing corruption that survived the per-save check in `do_save`.
/// Returns Err for missing files; SQL errors are surfaced as a result with
/// ok=false rather than Err so the UI can still show the diagnostic.
pub fn check_integrity_core(path: &str) -> Result<IntegrityCheckResult, String> {
    if path.is_empty() {
        return Err("NEEDS_PATH".to_string());
    }
    if !std::path::Path::new(path).exists() {
        return Err(format!("File not found: {path}"));
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("PRAGMA integrity_check")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = Vec::new();
    for row in rows {
        lines.push(row.map_err(|e| e.to_string())?);
    }
    // SQLite returns exactly one row "ok" when the database is healthy;
    // anything else is a list of issue descriptions.
    let ok = lines.len() == 1 && lines[0] == "ok";
    Ok(IntegrityCheckResult {
        ok,
        issues: if ok { Vec::new() } else { lines },
    })
}

#[tauri::command]
pub fn workbook_check_integrity(path: String) -> Result<IntegrityCheckResult, String> {
    check_integrity_core(&path)
}


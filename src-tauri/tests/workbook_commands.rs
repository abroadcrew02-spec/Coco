use coco_lib::commands::recovery::autosave_temp_core;
use coco_lib::commands::workbook::{
    list_recent_core,
    list_recovery_core,
    open_coco_core,
    restore_backup_core,
    workbook_new,
    workbook_save,
};
use rusqlite::Connection;
use tempfile::TempDir;

fn coco_path(dir: &TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn workbook_new_produces_unique_ids() {
    let a = workbook_new().unwrap();
    let b = workbook_new().unwrap();
    let c = workbook_new().unwrap();
    assert_ne!(a.workbook_id, b.workbook_id);
    assert_ne!(b.workbook_id, c.workbook_id);
    assert_eq!(a.source_type, "new");
    assert_eq!(a.path, None);
    assert_eq!(a.snapshot_json, None);
}

#[test]
fn open_coco_reads_latest_snapshot() {
    let app_dir = TempDir::new().unwrap();
    let wb_dir = TempDir::new().unwrap();
    let wb_path = coco_path(&wb_dir, "data.coco");

    workbook_save(
        "wb-test".into(),
        Some(path_str(&wb_path)),
        "{\"v\":1}".into(),
    )
    .unwrap();
    workbook_save(
        "wb-test".into(),
        Some(path_str(&wb_path)),
        "{\"v\":2}".into(),
    )
    .unwrap();

    let result = open_coco_core(app_dir.path(), &path_str(&wb_path)).unwrap();
    assert_eq!(result.handle.workbook_id, "wb-test");
    assert_eq!(result.handle.path.as_deref(), Some(path_str(&wb_path).as_str()));
    assert_eq!(result.handle.source_type, "coco");
    assert_eq!(
        result.handle.snapshot_json.as_deref(),
        Some("{\"v\":2}"),
        "should return the most recent snapshot"
    );
    assert!(result.warnings.is_empty());
}

#[test]
fn open_coco_records_recent_file() {
    let app_dir = TempDir::new().unwrap();
    let wb_dir = TempDir::new().unwrap();
    let wb_path = coco_path(&wb_dir, "alpha.coco");
    workbook_save("wb".into(), Some(path_str(&wb_path)), "{}".into()).unwrap();

    open_coco_core(app_dir.path(), &path_str(&wb_path)).unwrap();

    let conn = Connection::open(app_dir.path().join("app_state.db")).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM recent_files WHERE path = ?1",
            rusqlite::params![path_str(&wb_path)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn list_recent_returns_recorded_files_with_existence_flags() {
    let app_dir = TempDir::new().unwrap();
    let wb_dir = TempDir::new().unwrap();
    let alive = coco_path(&wb_dir, "alive.coco");
    let dead = coco_path(&wb_dir, "dead.coco");

    workbook_save("wb-a".into(), Some(path_str(&alive)), "{}".into()).unwrap();
    workbook_save("wb-d".into(), Some(path_str(&dead)), "{}".into()).unwrap();

    open_coco_core(app_dir.path(), &path_str(&alive)).unwrap();
    open_coco_core(app_dir.path(), &path_str(&dead)).unwrap();

    std::fs::remove_file(&dead).unwrap();

    let recent = list_recent_core(app_dir.path()).unwrap();
    assert_eq!(recent.len(), 2);
    let alive_entry = recent.iter().find(|r| r.path == path_str(&alive)).unwrap();
    let dead_entry = recent.iter().find(|r| r.path == path_str(&dead)).unwrap();
    assert!(alive_entry.exists);
    assert!(!dead_entry.exists);
    assert_eq!(alive_entry.name, "alive.coco");
}

#[test]
fn list_recent_empty_when_no_app_dir_used() {
    let app_dir = TempDir::new().unwrap();
    let recent = list_recent_core(app_dir.path()).unwrap();
    assert!(recent.is_empty());
}

#[test]
fn list_recovery_returns_autosave_candidates() {
    let app_dir = TempDir::new().unwrap();

    autosave_temp_core(app_dir.path(), "wb-a", "{\"a\":1}").unwrap();
    autosave_temp_core(app_dir.path(), "wb-b", "{\"b\":2}").unwrap();

    let candidates = list_recovery_core(app_dir.path()).unwrap();
    assert_eq!(candidates.len(), 2);
    let ids: Vec<_> = candidates.iter().map(|c| c.candidate_id.as_str()).collect();
    assert!(ids.contains(&"wb-a"));
    assert!(ids.contains(&"wb-b"));
    for c in &candidates {
        assert_eq!(c.reason, "auto_save");
    }
}

#[test]
fn restore_backup_opens_temp_coco_snapshot() {
    let app_dir = TempDir::new().unwrap();

    autosave_temp_core(app_dir.path(), "wb-r", "{\"restored\":true}").unwrap();

    let result = restore_backup_core(app_dir.path(), "wb-r").unwrap();
    assert_eq!(result.handle.workbook_id, "wb-r");
    assert_eq!(
        result.handle.snapshot_json.as_deref(),
        Some("{\"restored\":true}")
    );
    let expected_path = app_dir.path().join("recovery").join("wb-r.coco");
    assert_eq!(
        result.handle.path.as_deref(),
        Some(path_str(&expected_path).as_str())
    );
    assert!(result.warnings.is_empty());
}

#[test]
fn restore_backup_errors_on_missing_candidate() {
    let app_dir = TempDir::new().unwrap();
    let result = restore_backup_core(app_dir.path(), "does-not-exist");
    assert!(result.is_err());
    let msg = result.unwrap_err();
    assert!(
        msg.to_lowercase().contains("not found") || msg.contains("does-not-exist"),
        "error message should mention the missing candidate, got: {}",
        msg
    );
}

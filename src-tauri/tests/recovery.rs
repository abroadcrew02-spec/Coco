use coco_lib::commands::recovery::{autosave_temp_core, clear_recovery_core};
use coco_lib::commands::workbook::MAX_SNAPSHOTS_PER_WORKBOOK;
use rusqlite::Connection;
use tempfile::TempDir;

fn app_db(data_dir: &std::path::Path) -> Connection {
    Connection::open(data_dir.join("app_state.db")).unwrap()
}

fn count_candidates(data_dir: &std::path::Path, candidate_id: &str) -> i64 {
    app_db(data_dir)
        .query_row(
            "SELECT COUNT(*) FROM recovery_candidates WHERE candidate_id = ?1",
            rusqlite::params![candidate_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
}

#[test]
fn autosave_creates_temp_coco_and_candidate_row() {
    let tmp = TempDir::new().unwrap();
    let result = autosave_temp_core(tmp.path(), "wb-1", "{\"x\":1}").unwrap();
    assert!(result.success);

    // Temp .coco exists at the expected path.
    let expected_path = tmp.path().join("recovery").join("wb-1.coco");
    assert!(
        expected_path.exists(),
        "expected {:?} to exist",
        expected_path
    );
    assert_eq!(result.path, expected_path.to_string_lossy());

    // The .coco contains the snapshot we wrote.
    let conn = Connection::open(&expected_path).unwrap();
    let snap: String = conn
        .query_row(
            "SELECT snapshot_json FROM workbook_snapshots WHERE workbook_id = ?1 ORDER BY snapshot_id DESC LIMIT 1",
            rusqlite::params!["wb-1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(snap, "{\"x\":1}");

    // A recovery_candidates row exists in app_state.db.
    assert_eq!(count_candidates(tmp.path(), "wb-1"), 1);
}

#[test]
fn autosave_uses_auto_save_reason() {
    let tmp = TempDir::new().unwrap();
    autosave_temp_core(tmp.path(), "wb-2", "{}").unwrap();

    let coco_path = tmp.path().join("recovery").join("wb-2.coco");
    let conn = Connection::open(&coco_path).unwrap();
    let reason: String = conn
        .query_row(
            "SELECT reason FROM workbook_snapshots WHERE workbook_id = ?1",
            rusqlite::params!["wb-2"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(reason, "auto_save");
}

#[test]
fn second_autosave_overwrites_candidate_row_not_creating_duplicates() {
    let tmp = TempDir::new().unwrap();
    autosave_temp_core(tmp.path(), "wb-3", "{\"v\":1}").unwrap();
    autosave_temp_core(tmp.path(), "wb-3", "{\"v\":2}").unwrap();
    autosave_temp_core(tmp.path(), "wb-3", "{\"v\":3}").unwrap();

    // Same workbook_id used as candidate_id (per implementation) — should be 1 row.
    assert_eq!(count_candidates(tmp.path(), "wb-3"), 1);
}

#[test]
fn repeated_autosave_prunes_snapshots_to_cap_and_keeps_latest() {
    let tmp = TempDir::new().unwrap();
    let iterations = MAX_SNAPSHOTS_PER_WORKBOOK + 3;
    for i in 0..iterations {
        autosave_temp_core(tmp.path(), "wb-retention", &format!("{{\"v\":{i}}}")).unwrap();
    }

    let coco_path = tmp.path().join("recovery").join("wb-retention.coco");
    let conn = Connection::open(&coco_path).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workbook_snapshots WHERE workbook_id = ?1",
            rusqlite::params!["wb-retention"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, MAX_SNAPSHOTS_PER_WORKBOOK);

    let latest_snapshot: String = conn
        .query_row(
            "SELECT snapshot_json FROM workbook_snapshots WHERE workbook_id = ?1 ORDER BY snapshot_id DESC LIMIT 1",
            rusqlite::params!["wb-retention"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(latest_snapshot, format!("{{\"v\":{}}}", iterations - 1));
}

#[test]
fn clear_recovery_removes_file_and_row() {
    let tmp = TempDir::new().unwrap();
    autosave_temp_core(tmp.path(), "wb-4", "{}").unwrap();

    let coco_path = tmp.path().join("recovery").join("wb-4.coco");
    assert!(coco_path.exists());
    assert_eq!(count_candidates(tmp.path(), "wb-4"), 1);

    clear_recovery_core(tmp.path(), "wb-4").unwrap();

    assert!(!coco_path.exists(), "temp .coco should be deleted");
    assert_eq!(count_candidates(tmp.path(), "wb-4"), 0);
}

#[test]
fn clear_recovery_on_missing_candidate_is_noop() {
    let tmp = TempDir::new().unwrap();
    // No prior autosave — there's nothing to clear.
    let result = clear_recovery_core(tmp.path(), "does-not-exist");
    assert!(
        result.is_ok(),
        "clear on missing candidate should be Ok, got {:?}",
        result
    );
}

#[test]
fn clear_recovery_tolerates_missing_temp_file() {
    let tmp = TempDir::new().unwrap();
    autosave_temp_core(tmp.path(), "wb-5", "{}").unwrap();

    // Manually delete the temp file BEFORE calling clear_recovery.
    let coco_path = tmp.path().join("recovery").join("wb-5.coco");
    std::fs::remove_file(&coco_path).unwrap();

    // clear_recovery should still succeed and remove the DB row.
    clear_recovery_core(tmp.path(), "wb-5").unwrap();
    assert_eq!(count_candidates(tmp.path(), "wb-5"), 0);
}

#[test]
fn autosave_preserves_existing_recovery_dir_files() {
    // Make sure a leftover unrelated file in the recovery dir doesn't get wiped.
    let tmp = TempDir::new().unwrap();
    let recovery_dir = tmp.path().join("recovery");
    std::fs::create_dir_all(&recovery_dir).unwrap();
    std::fs::write(recovery_dir.join("stranger.txt"), b"hello").unwrap();

    autosave_temp_core(tmp.path(), "wb-6", "{}").unwrap();

    assert!(recovery_dir.join("stranger.txt").exists());
    assert!(recovery_dir.join("wb-6.coco").exists());
}

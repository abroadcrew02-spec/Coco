use coco_lib::commands::workbook::{workbook_autosave_coco, workbook_save, MAX_SNAPSHOTS_PER_WORKBOOK};
use rusqlite::Connection;
use tempfile::TempDir;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

fn count_snapshots(coco_path: &std::path::Path, workbook_id: &str) -> i64 {
    let conn = Connection::open(coco_path).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM workbook_snapshots WHERE workbook_id = ?1",
        rusqlite::params![workbook_id],
        |row| row.get::<_, i64>(0),
    ).unwrap()
}

fn count_with_reason(coco_path: &std::path::Path, workbook_id: &str, reason: &str) -> i64 {
    let conn = Connection::open(coco_path).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM workbook_snapshots WHERE workbook_id = ?1 AND reason = ?2",
        rusqlite::params![workbook_id, reason],
        |row| row.get::<_, i64>(0),
    ).unwrap()
}

#[test]
fn manual_save_records_manual_save_reason() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    let wb_id = "test-wb-1";

    let result = workbook_save(wb_id.into(), Some(path_str(&path)), "{\"x\":1}".into()).unwrap();
    assert!(result.success);
    assert_eq!(count_with_reason(&path, wb_id, "manual_save"), 1);
    assert_eq!(count_with_reason(&path, wb_id, "auto_save"), 0);
}

#[test]
fn autosave_coco_records_auto_save_reason() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    let wb_id = "test-wb-2";

    let result = workbook_autosave_coco(wb_id.into(), path_str(&path), "{\"x\":1}".into()).unwrap();
    assert!(result.success);
    assert_eq!(count_with_reason(&path, wb_id, "auto_save"), 1);
    assert_eq!(count_with_reason(&path, wb_id, "manual_save"), 0);
}

#[test]
fn snapshots_capped_to_max_per_workbook() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    let wb_id = "test-wb-3";

    // Do 7 saves; the cap should hold the total at MAX_SNAPSHOTS_PER_WORKBOOK.
    for i in 0..7 {
        let snap = format!("{{\"v\":{i}}}");
        let result = workbook_save(wb_id.into(), Some(path_str(&path)), snap).unwrap();
        assert!(result.success, "save {i} should succeed");
    }

    assert_eq!(
        count_snapshots(&path, wb_id),
        MAX_SNAPSHOTS_PER_WORKBOOK,
        "expected exactly {} snapshots after 7 saves",
        MAX_SNAPSHOTS_PER_WORKBOOK
    );
}

#[test]
fn retention_keeps_most_recent() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    let wb_id = "test-wb-4";

    for i in 0..7 {
        let snap = format!("{{\"i\":{i}}}");
        workbook_save(wb_id.into(), Some(path_str(&path)), snap).unwrap();
    }

    // After cap, the oldest surviving snapshot should be from iteration (7 - 5) = 2.
    // I.e. snapshots for i=2..=6 survived; i=0,1 were evicted.
    let conn = Connection::open(&path).unwrap();
    let mut stmt = conn
        .prepare("SELECT snapshot_json FROM workbook_snapshots WHERE workbook_id = ?1 ORDER BY snapshot_id ASC")
        .unwrap();
    let rows: Vec<String> = stmt
        .query_map(rusqlite::params![wb_id], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();

    assert_eq!(rows.len(), MAX_SNAPSHOTS_PER_WORKBOOK as usize);
    assert_eq!(rows[0], "{\"i\":2}", "oldest should be i=2");
    assert_eq!(rows[4], "{\"i\":6}", "newest should be i=6");
}

#[test]
fn retention_is_per_workbook_not_global() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("multi.coco");

    // Save 7 snapshots for wb-A and 7 for wb-B in the same file.
    for i in 0..7 {
        workbook_save("wb-A".into(), Some(path_str(&path)), format!("{{\"a\":{i}}}")).unwrap();
        workbook_save("wb-B".into(), Some(path_str(&path)), format!("{{\"b\":{i}}}")).unwrap();
    }

    // Each workbook should independently have exactly MAX_SNAPSHOTS_PER_WORKBOOK rows.
    assert_eq!(count_snapshots(&path, "wb-A"), MAX_SNAPSHOTS_PER_WORKBOOK);
    assert_eq!(count_snapshots(&path, "wb-B"), MAX_SNAPSHOTS_PER_WORKBOOK);
}

use coco_lib::commands::workbook::{save_core, workbook_autosave_coco, MAX_SNAPSHOTS_PER_WORKBOOK};
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
    )
    .unwrap()
}

fn count_with_reason(coco_path: &std::path::Path, workbook_id: &str, reason: &str) -> i64 {
    let conn = Connection::open(coco_path).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM workbook_snapshots WHERE workbook_id = ?1 AND reason = ?2",
        rusqlite::params![workbook_id, reason],
        |row| row.get::<_, i64>(0),
    )
    .unwrap()
}

#[test]
fn manual_save_records_manual_save_reason() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    let wb_id = "test-wb-1";

    let result = save_core(wb_id.into(), Some(path_str(&path)), "{\"x\":1}".into()).unwrap();
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
        let result = save_core(wb_id.into(), Some(path_str(&path)), snap).unwrap();
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
        save_core(wb_id.into(), Some(path_str(&path)), snap).unwrap();
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
        save_core(
            "wb-A".into(),
            Some(path_str(&path)),
            format!("{{\"a\":{i}}}"),
        )
        .unwrap();
        save_core(
            "wb-B".into(),
            Some(path_str(&path)),
            format!("{{\"b\":{i}}}"),
        )
        .unwrap();
    }

    // Each workbook should independently have exactly MAX_SNAPSHOTS_PER_WORKBOOK rows.
    assert_eq!(count_snapshots(&path, "wb-A"), MAX_SNAPSHOTS_PER_WORKBOOK);
    assert_eq!(count_snapshots(&path, "wb-B"), MAX_SNAPSHOTS_PER_WORKBOOK);
}

#[test]
fn save_preserves_snapshot_waiting_in_wal_sidecar() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("wal.coco");
    let wb_id = "test-wb-wal";

    save_core(wb_id.into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();

    {
        let conn = Connection::open(&path).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        conn.execute_batch("PRAGMA wal_autocheckpoint=0").unwrap();
        conn.execute(
            "INSERT INTO workbook_snapshots (workbook_id, snapshot_json, created_at, reason)
             VALUES (?1, ?2, ?3, 'manual_save')",
            rusqlite::params![wb_id, "{\"v\":2}", "2026-05-15T00:00:00Z"],
        )
        .unwrap();
        assert!(
            path.with_extension("coco-wal").exists(),
            "fixture should leave a WAL sidecar before save"
        );
    }

    let result = save_core(wb_id.into(), Some(path_str(&path)), "{\"v\":3}".into()).unwrap();
    assert!(result.success);

    let conn = Connection::open(&path).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT snapshot_json FROM workbook_snapshots
             WHERE workbook_id = ?1
             ORDER BY snapshot_id ASC",
        )
        .unwrap();
    let rows: Vec<String> = stmt
        .query_map(rusqlite::params![wb_id], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect();

    assert!(
        rows.contains(&"{\"v\":2}".to_string()),
        "save should preserve the snapshot that was only present in the WAL sidecar"
    );
    assert!(
        rows.contains(&"{\"v\":3}".to_string()),
        "save should still write the new snapshot"
    );
}

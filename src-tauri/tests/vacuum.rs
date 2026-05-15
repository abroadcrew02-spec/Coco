use coco_lib::commands::workbook::{save_core, vacuum_core};
use tempfile::TempDir;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn empty_path_returns_needs_path() {
    assert_eq!(vacuum_core("").unwrap_err(), "NEEDS_PATH");
}

#[test]
fn missing_file_returns_file_not_found() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nope.coco");
    let err = vacuum_core(&path_str(&path)).unwrap_err();
    assert!(err.starts_with("File not found:"), "got: {err}");
}

#[test]
fn vacuum_on_fresh_file_reports_sizes() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();
    let result = vacuum_core(&path_str(&path)).unwrap();
    // Both sizes should be > 0 (SQLite files have header pages even when "empty").
    assert!(result.before_bytes > 0);
    assert!(result.after_bytes > 0);
}

#[test]
fn vacuum_after_many_saves_reduces_or_holds_size() {
    // Repeated saves grow the DB; VACUUM should not grow it further, and
    // typically reclaims at least a little. We only assert "doesn't grow" so
    // the test is robust against SQLite implementation details.
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    for i in 0..15 {
        save_core(
            "wb1".into(),
            Some(path_str(&path)),
            format!("{{\"v\":{i},\"padding\":\"{}\"}}", "x".repeat(2000)),
        )
        .unwrap();
    }
    let result = vacuum_core(&path_str(&path)).unwrap();
    assert!(
        result.after_bytes <= result.before_bytes,
        "VACUUM should not grow the file: before={} after={}",
        result.before_bytes,
        result.after_bytes
    );
}

#[test]
fn vacuum_preserves_existing_data() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core(
        "wb1".into(),
        Some(path_str(&path)),
        "{\"keep\":\"yes\"}".into(),
    )
    .unwrap();
    vacuum_core(&path_str(&path)).unwrap();
    // The file should still be a valid SQLite DB with the saved snapshot.
    let conn = rusqlite::Connection::open(&path).unwrap();
    let snapshot_json: String = conn
        .query_row(
            "SELECT snapshot_json FROM workbook_snapshots ORDER BY snapshot_id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(snapshot_json.contains("\"keep\":\"yes\""));
}

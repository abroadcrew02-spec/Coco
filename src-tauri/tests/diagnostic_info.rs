use coco_lib::commands::workbook::{diagnostic_info_core, save_core};
use coco_lib::db::schema::CURRENT_SCHEMA_VERSION;
use tempfile::TempDir;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn empty_path_returns_needs_path() {
    assert_eq!(diagnostic_info_core("").unwrap_err(), "NEEDS_PATH");
}

#[test]
fn missing_file_returns_file_not_found() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nope.coco");
    let err = diagnostic_info_core(&path_str(&path)).unwrap_err();
    assert!(err.starts_with("File not found:"), "got: {err}");
}

#[test]
fn fresh_coco_reports_one_snapshot_and_current_schema_version() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();

    let info = diagnostic_info_core(&path_str(&path)).unwrap();
    assert_eq!(info.path, path_str(&path));
    assert!(info.size_bytes > 0);
    assert_eq!(info.snapshot_count, 1);
    assert_eq!(info.schema_version, Some(CURRENT_SCHEMA_VERSION));
    assert!(info.last_saved_at.is_some());
    let ts = info.last_saved_at.unwrap();
    // RFC3339 timestamps contain a 'T' between date and time.
    assert!(ts.contains('T'), "expected RFC3339 timestamp, got: {ts}");
}

#[test]
fn snapshot_count_caps_at_retention_limit() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    for i in 0..10 {
        save_core(
            "wb1".into(),
            Some(path_str(&path)),
            format!("{{\"v\":{i}}}"),
        )
        .unwrap();
    }
    let info = diagnostic_info_core(&path_str(&path)).unwrap();
    // do_save prunes to MAX_SNAPSHOTS_PER_WORKBOOK = 5.
    assert_eq!(info.snapshot_count, 5);
}

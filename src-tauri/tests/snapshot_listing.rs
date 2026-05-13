use coco_lib::commands::workbook::{
    list_snapshots_core, save_core, workbook_autosave_coco,
};
use tempfile::TempDir;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn empty_path_returns_needs_path_error() {
    let err = list_snapshots_core("").unwrap_err();
    assert_eq!(err, "NEEDS_PATH");
}

#[test]
fn missing_file_returns_file_not_found_error() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nope.coco");
    let err = list_snapshots_core(&path_str(&path)).unwrap_err();
    assert!(err.starts_with("File not found:"), "got: {err}");
}

#[test]
fn fresh_coco_after_single_save_has_one_snapshot() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();

    let snapshots = list_snapshots_core(&path_str(&path)).unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].reason, "manual_save");
    // created_at should be a non-empty RFC3339 string.
    assert!(snapshots[0].created_at.contains('T'), "got: {:?}", snapshots[0].created_at);
}

#[test]
fn snapshots_returned_in_descending_order_newest_first() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();
    workbook_autosave_coco("wb1".into(), path_str(&path), "{\"v\":2}".into()).unwrap();
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":3}".into()).unwrap();

    let snapshots = list_snapshots_core(&path_str(&path)).unwrap();
    assert_eq!(snapshots.len(), 3);
    // Highest snapshot_id (most recent) comes first.
    assert!(snapshots[0].snapshot_id > snapshots[1].snapshot_id);
    assert!(snapshots[1].snapshot_id > snapshots[2].snapshot_id);
    // Verify the reasons match the save sequence (descending: latest manual,
    // then auto, then earliest manual).
    assert_eq!(snapshots[0].reason, "manual_save");
    assert_eq!(snapshots[1].reason, "auto_save");
    assert_eq!(snapshots[2].reason, "manual_save");
}

#[test]
fn snapshot_retention_caps_results_at_five() {
    // workbook_snapshots is pruned to MAX_SNAPSHOTS_PER_WORKBOOK = 5 on each
    // save, so listing should never return more than 5 even after 10 saves.
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
    let snapshots = list_snapshots_core(&path_str(&path)).unwrap();
    assert_eq!(snapshots.len(), 5);
}

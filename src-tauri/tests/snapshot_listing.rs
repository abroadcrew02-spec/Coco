use coco_lib::commands::workbook::{
    list_snapshots_core, open_snapshot_core, save_core, workbook_autosave_coco,
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
    assert!(
        snapshots[0].created_at.contains('T'),
        "got: {:?}",
        snapshots[0].created_at
    );
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
fn open_snapshot_returns_handle_with_detached_path() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":2}".into()).unwrap();

    let snapshots = list_snapshots_core(&path_str(&path)).unwrap();
    let older = snapshots[1].snapshot_id; // [0] is newest

    let result = open_snapshot_core(&path_str(&path), older).unwrap();
    // path is None so Ctrl+S triggers Save As → user cannot accidentally
    // overwrite the on-disk file with the older snapshot.
    assert!(result.handle.path.is_none());
    assert_eq!(result.handle.source_type, "coco");
    assert_eq!(result.handle.workbook_id, "wb1");
    let snap = result.handle.snapshot_json.unwrap();
    assert!(
        snap.contains("\"v\":1"),
        "expected older snapshot, got: {snap}"
    );
}

#[test]
fn open_snapshot_missing_id_returns_friendly_error() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();

    let err = open_snapshot_core(&path_str(&path), 999_999).unwrap_err();
    assert!(err.starts_with("Snapshot not found:"), "got: {err}");
}

#[test]
fn open_snapshot_empty_path_returns_needs_path() {
    let err = open_snapshot_core("", 1).unwrap_err();
    assert_eq!(err, "NEEDS_PATH");
}

#[test]
fn open_snapshot_missing_file_returns_file_not_found() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nope.coco");
    let err = open_snapshot_core(&path_str(&path), 1).unwrap_err();
    assert!(err.starts_with("File not found:"), "got: {err}");
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

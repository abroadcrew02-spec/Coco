use coco_lib::commands::shell::reveal_in_file_manager_core;

#[test]
fn empty_path_returns_dedicated_error_code() {
    let err = reveal_in_file_manager_core("").unwrap_err();
    assert!(
        err.contains("REVEAL_EMPTY_PATH"),
        "expected error code for empty path, got {:?}",
        err
    );
}

// We can't reliably assert that explorer / open / xdg-open actually launches
// without leaving a UI behind on the CI machine. So we cover the deterministic
// branch (empty path) here; spawn failures are wrapped in REVEAL_SPAWN_FAILED:
// which is observable through manual testing.

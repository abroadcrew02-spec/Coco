use coco_lib::commands::workbook::{check_integrity_core, save_core};
use tempfile::TempDir;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn empty_path_returns_needs_path() {
    assert_eq!(check_integrity_core("").unwrap_err(), "NEEDS_PATH");
}

#[test]
fn missing_file_returns_file_not_found() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("nope.coco");
    let err = check_integrity_core(&path_str(&path)).unwrap_err();
    assert!(err.starts_with("File not found:"), "got: {err}");
}

#[test]
fn freshly_saved_file_passes_integrity_check() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();

    let result = check_integrity_core(&path_str(&path)).unwrap();
    assert!(
        result.ok,
        "expected ok=true, got issues: {:?}",
        result.issues
    );
    assert!(result.issues.is_empty());
}

#[test]
fn file_with_many_saves_still_passes() {
    // Repeated saves exercise the snapshot retention + atomic rename path;
    // verify the file remains structurally sound through that workflow.
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    for i in 0..12 {
        save_core(
            "wb1".into(),
            Some(path_str(&path)),
            format!("{{\"v\":{i}}}"),
        )
        .unwrap();
    }
    let result = check_integrity_core(&path_str(&path)).unwrap();
    assert!(
        result.ok,
        "expected ok=true after 12 saves, got: {:?}",
        result.issues
    );
}

#[test]
fn corrupted_file_returns_ok_false_with_issues() {
    // Write a file that opens as SQLite but reports corruption: easiest way
    // is to truncate a real DB partway. SQLite will detect the header
    // mismatch and surface it.
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("data.coco");
    save_core("wb1".into(), Some(path_str(&path)), "{\"v\":1}".into()).unwrap();

    // Truncate the file to half its size to provoke a structural complaint.
    let original_size = std::fs::metadata(&path).unwrap().len();
    let f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    f.set_len(original_size / 2).unwrap();
    drop(f);

    // The integrity check may EITHER report issues (ok=false) OR fail to
    // open the file at all (Err). Both are valid "this file is broken"
    // signals — we just want to confirm we don't incorrectly report ok=true.
    match check_integrity_core(&path_str(&path)) {
        Ok(result) => {
            assert!(
                !result.ok,
                "truncated DB should not report ok=true (got issues: {:?})",
                result.issues
            );
        }
        Err(_) => {
            // SQLite refused to open the truncated file; that's also fine.
        }
    }
}

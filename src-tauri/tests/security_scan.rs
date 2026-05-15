use coco_lib::commands::security::{security_scan_xlsx, SecurityScanResult};
use rust_xlsxwriter::Workbook;
use std::io::Write;
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn test_valid_xlsx_is_safe() {
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("valid.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("S").expect("set name");
        ws.write_string(0, 0, "hello").expect("write a1");
        wb.save(&path).expect("save xlsx");
    }

    let result: SecurityScanResult =
        security_scan_xlsx(path_str(&path)).expect("scan should succeed");

    assert!(!result.blocked, "valid xlsx should not be blocked");
    assert!(
        result.issues.is_empty(),
        "valid xlsx should have no issues, got {:?}",
        result.issues
    );
    assert!(
        result.warnings.is_empty(),
        "valid xlsx should have no warnings now that §5.3.2 caps are enforced, got {:?}",
        result.warnings
    );
    assert!(
        result.safe,
        "valid xlsx should report safe=true once the Phase 2 placeholder warning is gone"
    );
}

#[test]
fn test_missing_file_returns_err() {
    let result = security_scan_xlsx("/definitely/does/not/exist.xlsx".to_string());
    assert!(result.is_err(), "missing file should return Err");
}

#[test]
fn test_oversized_file_blocked() {
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("huge.xlsx");
    let big = vec![0u8; 51 * 1024 * 1024];
    std::fs::write(&path, &big).expect("write huge file");

    let path_str = path_str(&path);
    // Size check now short-circuits before attempting ZIP parsing, so an oversize
    // non-ZIP blob returns Ok with the size verdict (not an opaque zip-parse error).
    let result = security_scan_xlsx(path_str).expect("size check should short-circuit to Ok");
    assert!(result.blocked, "should be blocked for oversize file");
    assert!(
        result
            .issues
            .iter()
            .any(|m| m.contains("50 MB") || m.contains("file size") || m.contains("exceeds")),
        "expected size-limit issue, got {:?}",
        result.issues
    );
}

#[test]
fn test_zip_with_too_many_entries_blocked() {
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("many.xlsx");

    {
        let file = std::fs::File::create(&path).expect("create zip");
        let mut zip = zip::ZipWriter::new(file);
        let opts: FileOptions = FileOptions::default();
        for i in 0..2001 {
            zip.start_file(format!("entry_{i}.bin"), opts)
                .expect("start_file");
            zip.write_all(b"x").expect("write entry");
        }
        zip.finish().expect("finish zip");
    }

    let result = security_scan_xlsx(path_str(&path)).expect("scan should succeed (valid zip)");
    assert!(
        result.blocked,
        "too many entries should be blocked, got {:?}",
        result
    );
    assert!(
        result
            .issues
            .iter()
            .any(|m| m.contains("entry count") || m.contains("2,000") || m.contains("limit")),
        "expected entry-count issue, got {:?}",
        result.issues
    );
}

fn build_sheet_zip(path: &std::path::Path, n: usize) {
    let file = std::fs::File::create(path).expect("create zip");
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions = FileOptions::default();
    for i in 1..=n {
        zip.start_file(format!("xl/worksheets/sheet{i}.xml"), opts)
            .expect("start_file");
        zip.write_all(b"<x/>").expect("write entry");
    }
    zip.finish().expect("finish zip");
}

#[test]
fn test_zip_with_many_sheets_warns_then_blocks() {
    let tmp = TempDir::new().expect("tempdir");

    // 101 sheets -> warn, not blocked.
    let path_warn = tmp.path().join("warn.xlsx");
    build_sheet_zip(&path_warn, 101);
    let r_warn = security_scan_xlsx(path_str(&path_warn)).expect("scan warn case");
    assert!(
        !r_warn.blocked,
        "101 sheets should not be blocked, got {:?}",
        r_warn
    );
    assert!(
        r_warn
            .warnings
            .iter()
            .any(|m| m.contains("Sheet count") || m.contains("101") || m.contains("soft limit")),
        "expected sheet-count soft warning, got {:?}",
        r_warn.warnings
    );

    // 201 sheets -> blocked.
    let path_block = tmp.path().join("block.xlsx");
    build_sheet_zip(&path_block, 201);
    let r_block = security_scan_xlsx(path_str(&path_block)).expect("scan block case");
    assert!(
        r_block.blocked,
        "201 sheets should be blocked, got {:?}",
        r_block
    );
    assert!(
        r_block
            .issues
            .iter()
            .any(|m| m.contains("Sheet count") || m.contains("201")),
        "expected sheet-count hard issue, got {:?}",
        r_block.issues
    );
}

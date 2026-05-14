use coco_lib::commands::xlsx_io::import_xlsx_core;
use std::io::Write;
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn oversize_xlsx_returns_blocking_warning_not_panic() {
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("huge.xlsx");
    // 51 MB of random bytes — exceeds the 50 MB hard limit in security.rs.
    let big = vec![0u8; 51 * 1024 * 1024];
    std::fs::write(&path, &big).expect("write huge file");

    let result = import_xlsx_core(path_str(&path)).expect("should not Err");
    let blocking: Vec<_> = result
        .warnings
        .iter()
        .filter(|w| w.severity == "blocking")
        .collect();
    assert!(!blocking.is_empty(), "expected blocking warning, got {:?}", result.warnings);
    assert!(
        blocking.iter().any(|w| w.code == "XLSX_SECURITY_BLOCKED"),
        "expected XLSX_SECURITY_BLOCKED code, got {:?}",
        result.warnings
    );
    // Snapshot should be the empty placeholder — no real workbook data.
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(snap["sheetOrder"].as_array().unwrap().len(), 0);
}

#[test]
fn many_entries_xlsx_blocked() {
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("many.xlsx");
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions = FileOptions::default();
    for i in 0..2_001 {
        zip.start_file(format!("entry_{i}.bin"), opts).unwrap();
        zip.write_all(b"x").unwrap();
    }
    zip.finish().unwrap();

    let result = import_xlsx_core(path_str(&path)).expect("should not Err");
    let blocking: Vec<_> = result
        .warnings
        .iter()
        .filter(|w| w.severity == "blocking")
        .collect();
    assert!(!blocking.is_empty(), "expected blocking warning for 2,001 entries");
}

#[test]
fn valid_small_xlsx_imports_without_security_block() {
    use rust_xlsxwriter::Workbook;
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("ok.xlsx");
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("S").expect("name");
    ws.write_string(0, 0, "hi").expect("a1");
    wb.save(&path).expect("save");

    let result = import_xlsx_core(path_str(&path)).expect("import");
    let blocking: Vec<_> = result
        .warnings
        .iter()
        .filter(|w| w.severity == "blocking")
        .collect();
    assert!(blocking.is_empty(), "valid file should not be blocked, got {:?}", result.warnings);
    // §5.3.2 caps are now enforced inline, so the legacy "Phase 2 limits not yet
    // checked" XLSX_SECURITY_WARNING is gone. A clean small file should produce
    // no XLSX_SECURITY_WARNING entries.
    assert!(
        !result.warnings.iter().any(|w| w.code == "XLSX_SECURITY_WARNING"),
        "valid small xlsx should not surface any XLSX_SECURITY_WARNING entries, got {:?}",
        result.warnings
    );
    // The original PoC import info warning should also be there.
    assert!(result.warnings.iter().any(|w| w.code == "XLSX_POC_IMPORT"));
}

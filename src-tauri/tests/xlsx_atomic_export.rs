use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::workbook_export_xlsx;
use serde_json::json;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

fn snapshot_with_a1(value: &str) -> String {
    json!({
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "id": "sheet-1",
                "name": "S",
                "cellData": { "0": { "0": { "v": value } } }
            }
        }
    })
    .to_string()
}

fn read_a1(path: &PathBuf) -> Data {
    let mut wb: Xlsx<_> = open_workbook(path).expect("open xlsx");
    let range = wb.worksheet_range("S").expect("sheet S exists");
    range
        .get_value((0, 0))
        .cloned()
        .expect("A1 should have a value")
}

fn count_baks(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".bak."))
        .count()
}

#[test]
fn first_export_creates_no_bak() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("out.xlsx");
    let snap = snapshot_with_a1("first");

    let result = workbook_export_xlsx(path_str(&target), snap).expect("export ok");
    assert!(result.success, "export should succeed; error={:?}", result.error);

    assert!(target.exists(), "out.xlsx should exist");
    assert_eq!(read_a1(&target), Data::String("first".into()), "A1 should be 'first'");

    assert_eq!(count_baks(tmp.path()), 0, "no .bak.* files for first export");
}

#[test]
fn second_export_creates_bak_1_with_old_content() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.xlsx");

    let r1 = workbook_export_xlsx(path_str(&target), snapshot_with_a1("v1")).expect("export 1 ok");
    assert!(r1.success, "first export should succeed; error={:?}", r1.error);

    let r2 = workbook_export_xlsx(path_str(&target), snapshot_with_a1("v2")).expect("export 2 ok");
    assert!(r2.success, "second export should succeed; error={:?}", r2.error);

    assert!(target.exists(), "data.xlsx should exist");
    assert_eq!(read_a1(&target), Data::String("v2".into()), "A1 should be 'v2'");

    let bak1 = tmp.path().join("data.xlsx.bak.1");
    assert!(bak1.exists(), "data.xlsx.bak.1 should exist");
    assert_eq!(read_a1(&bak1), Data::String("v1".into()), "bak.1 should preserve old 'v1'");

    let bak2 = tmp.path().join("data.xlsx.bak.2");
    assert!(!bak2.exists(), "data.xlsx.bak.2 should NOT exist");
}

#[test]
fn seven_exports_keep_only_five_baks() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.xlsx");

    for i in 1..=7 {
        let snap = snapshot_with_a1(&format!("v{i}"));
        let r = workbook_export_xlsx(path_str(&target), snap)
            .unwrap_or_else(|e| panic!("export {i} failed: {e}"));
        assert!(r.success, "export {i} should succeed; error={:?}", r.error);
    }

    assert_eq!(read_a1(&target), Data::String("v7".into()), "current file should be v7");

    let expectations = [(1u32, "v6"), (2, "v5"), (3, "v4"), (4, "v3"), (5, "v2")];
    for (n, expected) in expectations {
        let p = tmp.path().join(format!("data.xlsx.bak.{n}"));
        assert!(p.exists(), "data.xlsx.bak.{n} should exist");
        assert_eq!(
            read_a1(&p),
            Data::String(expected.into()),
            "bak.{n} should contain {expected}"
        );
    }

    let bak6 = tmp.path().join("data.xlsx.bak.6");
    let bak7 = tmp.path().join("data.xlsx.bak.7");
    assert!(!bak6.exists(), "data.xlsx.bak.6 should NOT exist");
    assert!(!bak7.exists(), "data.xlsx.bak.7 should NOT exist");

    assert_eq!(count_baks(tmp.path()), 5, "exactly 5 .bak.* files should exist");
}

#[test]
fn no_leftover_tmp_files_after_success() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("clean.xlsx");

    let result = workbook_export_xlsx(path_str(&target), snapshot_with_a1("hi")).expect("export ok");
    assert!(result.success, "export should succeed; error={:?}", result.error);

    let entries: Vec<String> = std::fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    for name in &entries {
        assert!(
            !name.starts_with(".clean.xlsx.tmp-"),
            "leftover tmp file found: {name}"
        );
    }

    assert_eq!(entries, vec!["clean.xlsx".to_string()], "only clean.xlsx should be present");
}

#[test]
fn bad_extension_returns_failure_without_touching_disk() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("wrong.txt");

    let result =
        workbook_export_xlsx(path_str(&target), snapshot_with_a1("x")).expect("call returns Ok");
    assert!(!result.success, "export should fail for bad extension");
    let err = result.error.unwrap_or_default();
    assert!(
        err.contains("XLSX_INVALID_EXTENSION"),
        "error should mention XLSX_INVALID_EXTENSION, got: {err}"
    );

    let entries: Vec<String> = std::fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(entries.is_empty(), "tmp dir should be empty, got: {entries:?}");
}

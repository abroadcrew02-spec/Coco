use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::import_xlsx_core;
use rust_xlsxwriter::Workbook;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

// Build a minimal xlsx fixture, then copy it with a .xlsm extension. calamine
// reads either equivalently; the test exercises Coco's extension-based routing
// (working_path derivation, macro-loss warning, optional overwrite warning).
fn build_xlsm_fixture(dir: &TempDir, name: &str) -> PathBuf {
    let xlsx = dir.path().join("__base.xlsx");
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("S").unwrap();
        ws.write_string(0, 0, "from-xlsm").unwrap();
        wb.save(&xlsx).unwrap();
    }
    let xlsm = dir.path().join(name);
    std::fs::copy(&xlsx, &xlsm).unwrap();
    xlsm
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn xlsm_import_derives_sibling_xlsx_working_path() {
    let tmp = TempDir::new().unwrap();
    let xlsm = build_xlsm_fixture(&tmp, "macro_book.xlsm");

    let result = import_xlsx_core(path_str(&xlsm)).unwrap();
    let working = result.handle.path.as_deref().unwrap();

    // The working path should be the sibling .xlsx — same dir, .xlsx extension,
    // same stem. The original .xlsm is left untouched (we don't check the file
    // is unchanged here, but the working path being different is the contract).
    assert!(working.ends_with(".xlsx"), "working path should be .xlsx, got {working}");
    assert!(
        working.ends_with("macro_book.xlsx"),
        "working path should preserve stem, got {working}"
    );
    assert_ne!(working, path_str(&xlsm));
}

#[test]
fn xlsm_import_emits_macros_discarded_warning() {
    let tmp = TempDir::new().unwrap();
    let xlsm = build_xlsm_fixture(&tmp, "with_macros.xlsm");

    let result = import_xlsx_core(path_str(&xlsm)).unwrap();
    assert!(
        result.warnings.iter().any(|w| w.code == "XLSM_MACROS_DISCARDED"),
        "expected XLSM_MACROS_DISCARDED warning, got {:?}",
        result.warnings.iter().map(|w| &w.code).collect::<Vec<_>>()
    );
}

#[test]
fn xlsm_import_warns_when_derived_xlsx_already_exists() {
    let tmp = TempDir::new().unwrap();
    let xlsm = build_xlsm_fixture(&tmp, "report.xlsm");
    // Pre-create the sibling .xlsx that the import would default to overwriting.
    std::fs::write(tmp.path().join("report.xlsx"), b"pre-existing content").unwrap();

    let result = import_xlsx_core(path_str(&xlsm)).unwrap();
    assert!(
        result.warnings.iter().any(|w| w.code == "XLSM_DERIVED_XLSX_EXISTS"),
        "expected XLSM_DERIVED_XLSX_EXISTS warning, got {:?}",
        result.warnings.iter().map(|w| &w.code).collect::<Vec<_>>()
    );
}

#[test]
fn xlsm_import_loads_data_into_snapshot() {
    let tmp = TempDir::new().unwrap();
    let xlsm = build_xlsm_fixture(&tmp, "data.xlsm");

    let result = import_xlsx_core(path_str(&xlsm)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();

    // A1 should be the seeded "from-xlsm" string.
    assert_eq!(
        snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"],
        "from-xlsm"
    );
}

#[test]
fn xlsm_import_does_not_modify_original() {
    let tmp = TempDir::new().unwrap();
    let xlsm = build_xlsm_fixture(&tmp, "untouched.xlsm");
    let before = std::fs::metadata(&xlsm).unwrap().len();

    import_xlsx_core(path_str(&xlsm)).unwrap();

    // Original .xlsm size shouldn't have changed (we never write to it).
    let after = std::fs::metadata(&xlsm).unwrap().len();
    assert_eq!(before, after, ".xlsm file size changed");

    // And calamine can still re-read the seeded data from the original.
    let mut wb: Xlsx<_> = open_workbook(&xlsm).unwrap();
    let range = wb.worksheet_range("S").unwrap();
    assert_eq!(
        range.get_value((0, 0)),
        Some(&Data::String("from-xlsm".into()))
    );
}

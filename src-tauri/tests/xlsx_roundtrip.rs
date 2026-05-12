use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{import_xlsx_core, workbook_export_xlsx};
use rust_xlsxwriter::Workbook;
use serde_json::Value;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn simple_values_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture_path = tmp.path().join("fixture_values.xlsx");
    let exported_path = tmp.path().join("exported.xlsx");

    // Build fixture
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Data").expect("set name");
        ws.write_string(0, 0, "Name").expect("a1");
        ws.write_string(0, 1, "Score").expect("b1");
        ws.write_string(0, 2, "Pass").expect("c1");
        ws.write_string(1, 0, "Alice").expect("a2");
        ws.write_number(1, 1, 92.5).expect("b2");
        ws.write_boolean(1, 2, true).expect("c2");
        ws.write_string(2, 0, "Bob").expect("a3");
        ws.write_number(2, 1, 58.0).expect("b3");
        ws.write_boolean(2, 2, false).expect("c3");
        wb.save(&fixture_path).expect("save fixture");
    }

    // Import
    let result = import_xlsx_core(path_str(&fixture_path)).expect("import ok");
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.code == "XLSX_POC_IMPORT"),
        "expected XLSX_POC_IMPORT info warning"
    );
    assert_eq!(result.handle.source_type, "xlsx", "source_type should be xlsx");
    assert!(result.handle.snapshot_json.is_some(), "snapshot_json should be Some");

    let snapshot_json = result.handle.snapshot_json.clone().unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let sheet_order = snapshot["sheetOrder"].as_array().expect("sheetOrder array");
    assert_eq!(sheet_order.len(), 1, "expected 1 sheet, got {}", sheet_order.len());
    assert_eq!(
        snapshot["sheets"]["sheet-1"]["name"], "Data",
        "sheet name should be Data"
    );
    assert_eq!(
        snapshot["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"], "Name",
        "A1 should be 'Name'"
    );
    assert_eq!(
        snapshot["sheets"]["sheet-1"]["cellData"]["1"]["1"]["v"], 92.5,
        "B2 should be 92.5"
    );
    assert_eq!(
        snapshot["sheets"]["sheet-1"]["cellData"]["1"]["2"]["v"], true,
        "C2 should be true"
    );

    // Export
    let export_result =
        workbook_export_xlsx(path_str(&exported_path), snapshot_json).expect("export ok");
    assert!(
        export_result.success,
        "export should succeed; error={:?}",
        export_result.error
    );

    // Re-open with calamine
    let mut wb: Xlsx<_> = open_workbook(&exported_path).expect("open exported");
    let range = wb.worksheet_range("Data").expect("Data sheet exists");
    assert_eq!(
        range.get_value((0, 0)),
        Some(&Data::String("Name".into())),
        "exported A1 should be string 'Name'"
    );
    assert_eq!(
        range.get_value((1, 1)),
        Some(&Data::Float(92.5)),
        "exported B2 should be float 92.5"
    );
    assert_eq!(
        range.get_value((1, 2)),
        Some(&Data::Bool(true)),
        "exported C2 should be bool true"
    );
}

#[test]
fn formula_preserved_through_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture_path = tmp.path().join("fixture_formula.xlsx");
    let exported_path = tmp.path().join("exported_formula.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Calc").expect("set name");
        ws.write_number(0, 0, 10.0).expect("a1");
        ws.write_number(1, 0, 20.0).expect("a2");
        ws.write_number(2, 0, 30.0).expect("a3");
        ws.write_formula(0, 1, "=SUM(A1:A3)").expect("b1 formula");
        wb.save(&fixture_path).expect("save fixture");
    }

    let result = import_xlsx_core(path_str(&fixture_path)).expect("import ok");
    let snapshot_json = result.handle.snapshot_json.clone().expect("snapshot json");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let b1 = &snapshot["sheets"]["sheet-1"]["cellData"]["0"]["1"];
    let f = b1
        .get("f")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("expected formula 'f' field at (0,1), got: {b1}"));
    assert!(
        f.starts_with('='),
        "formula should start with '=', got: {f}"
    );

    let export_result =
        workbook_export_xlsx(path_str(&exported_path), snapshot_json).expect("export ok");
    assert!(
        export_result.success,
        "export should succeed; error={:?}",
        export_result.error
    );

    let mut wb: Xlsx<_> = open_workbook(&exported_path).expect("open exported");
    // worksheet_formula returns a *sparse* range starting at the first formula
    // cell, so look up by absolute sheet position with get_value, not get.
    let formulas = wb.worksheet_formula("Calc").expect("formula range");
    let cell = formulas
        .get_value((0, 1))
        .expect("cell (0,1) should exist in formula range");
    assert!(
        !cell.is_empty(),
        "formula at (0,1) should be non-empty"
    );
    assert!(
        cell.contains("SUM"),
        "formula at (0,1) should contain 'SUM', got: {cell}"
    );
}

#[test]
fn multi_sheet_order_preserved() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture_path = tmp.path().join("fixture_multi.xlsx");
    let exported_path = tmp.path().join("exported_multi.xlsx");

    {
        let mut wb = Workbook::new();
        let ws1 = wb.add_worksheet();
        ws1.set_name("First").expect("First");
        ws1.write_string(0, 0, "F").expect("F a1");
        let ws2 = wb.add_worksheet();
        ws2.set_name("Second").expect("Second");
        ws2.write_string(0, 0, "S").expect("S a1");
        let ws3 = wb.add_worksheet();
        ws3.set_name("Third").expect("Third");
        ws3.write_string(0, 0, "T").expect("T a1");
        wb.save(&fixture_path).expect("save fixture");
    }

    let result = import_xlsx_core(path_str(&fixture_path)).expect("import ok");
    let snapshot_json = result.handle.snapshot_json.clone().expect("snapshot json");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let sheet_order = snapshot["sheetOrder"].as_array().expect("sheetOrder array");
    assert_eq!(sheet_order.len(), 3, "expected 3 sheets, got {}", sheet_order.len());
    assert_eq!(
        snapshot["sheets"]["sheet-1"]["name"], "First",
        "sheet-1 should be 'First'"
    );
    assert_eq!(
        snapshot["sheets"]["sheet-2"]["name"], "Second",
        "sheet-2 should be 'Second'"
    );
    assert_eq!(
        snapshot["sheets"]["sheet-3"]["name"], "Third",
        "sheet-3 should be 'Third'"
    );

    let export_result =
        workbook_export_xlsx(path_str(&exported_path), snapshot_json).expect("export ok");
    assert!(
        export_result.success,
        "export should succeed; error={:?}",
        export_result.error
    );

    let wb: Xlsx<_> = open_workbook(&exported_path).expect("open exported");
    let names = wb.sheet_names();
    assert_eq!(
        names,
        vec!["First".to_string(), "Second".to_string(), "Third".to_string()],
        "sheet names order should be preserved"
    );
}

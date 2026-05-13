use calamine::{open_workbook, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{import_xlsx_core, workbook_export_xlsx};
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Build a minimal xlsx fixture with a single data sheet plus the provided
/// (name, formula) defined-name entries.
fn build_fixture(path: &PathBuf, names: &[(&str, &str)]) {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("Sheet1").expect("set name");
    for r in 0..10u32 {
        ws.write_number(r, 0, (r as f64) + 1.0).expect("write");
    }
    for (n, f) in names {
        wb.define_name(*n, f).expect("define_name");
    }
    wb.save(path).expect("save fixture");
}

#[test]
fn workbook_scoped_named_range_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    build_fixture(&fixture, &[("Sales", "=Sheet1!$A$1:$A$10")]);

    // Import
    let result = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let named = snapshot["namedRanges"]
        .as_array()
        .expect("namedRanges should be an array");
    assert_eq!(named.len(), 1, "expected one named range, got {}", named.len());
    assert_eq!(named[0]["name"].as_str().unwrap(), "Sales");
    let formula = named[0]["formula"].as_str().unwrap();
    assert!(
        formula.contains("A$1:$A$10") || formula.contains("$A$1:$A$10"),
        "formula should reference A1:A10 range, got {formula}"
    );

    // Export
    let export = workbook_export_xlsx(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    // Re-open exported xlsx with calamine and confirm the name is present.
    let wb: Xlsx<_> = open_workbook(&exported).expect("open exported");
    let names = wb.defined_names();
    assert!(
        names.iter().any(|(n, _)| n == "Sales"),
        "exported workbook should expose 'Sales' defined name; got {names:?}"
    );
}

#[test]
fn multiple_named_ranges_round_trip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    let inputs = &[
        ("Sales", "=Sheet1!$A$1:$A$10"),
        ("Tax_Rate", "=0.08"),
        ("First_Cell", "=Sheet1!$A$1"),
    ];
    build_fixture(&fixture, inputs);

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let named = snapshot["namedRanges"].as_array().expect("array");
    assert_eq!(named.len(), inputs.len(), "all names should round-trip");
    let got_names: Vec<&str> = named
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    for (expected, _) in inputs {
        assert!(
            got_names.contains(expected),
            "imported snapshot is missing named range '{expected}'; got {got_names:?}"
        );
    }

    let export = workbook_export_xlsx(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok");

    let wb: Xlsx<_> = open_workbook(&exported).expect("re-open");
    let exported_names: Vec<&str> = wb
        .defined_names()
        .iter()
        .map(|(n, _)| n.as_str())
        .collect();
    for (expected, _) in inputs {
        assert!(
            exported_names.contains(expected),
            "exported workbook is missing '{expected}'; got {exported_names:?}"
        );
    }
}

#[test]
fn missing_named_ranges_section_yields_empty_array() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture_nonames.xlsx");
    build_fixture(&fixture, &[]);

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = result.handle.snapshot_json.expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    // We chose: always emit the array, empty when there are no names.
    let named = snapshot["namedRanges"]
        .as_array()
        .expect("namedRanges should always be present as an array");
    assert!(named.is_empty(), "expected empty namedRanges array, got {named:?}");
}

#[test]
fn malformed_named_range_entries_are_ignored() {
    // Build a snapshot directly (bypassing import) with garbage namedRanges
    // entries and ensure export drops them gracefully without panicking and
    // without failing the overall export.
    let tmp = TempDir::new().expect("tempdir");
    let exported = tmp.path().join("exported_malformed.xlsx");

    let snapshot = json!({
        "id": "wb-test",
        "name": "Test",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": {},
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "id": "sheet-1",
                "name": "Sheet1",
                "rowCount": 10,
                "columnCount": 5,
                "cellData": {
                    "0": { "0": { "v": 1.0 } }
                }
            }
        },
        "namedRanges": [
            { "name": "", "formula": "=Sheet1!$A$1" },           // empty name
            { "name": "OnlyName" },                                // missing formula
            { "formula": "=Sheet1!$A$1" },                         // missing name
            { "name": "   ", "formula": "=Sheet1!$A$1" },         // whitespace name
            { "name": "Good_Name", "formula": "=Sheet1!$A$1" },   // this one should survive
            "not an object",                                       // wrong type entirely
            { "name": "1BadStart", "formula": "=Sheet1!$A$1" },   // invalid Excel name (digit start)
        ],
    });

    let snapshot_json = serde_json::to_string(&snapshot).expect("serialize");
    let export = workbook_export_xlsx(path_str(&exported), snapshot_json).expect("export call");
    assert!(
        export.success,
        "export should still succeed despite malformed entries: {:?}",
        export.error
    );

    let wb: Xlsx<_> = open_workbook(&exported).expect("re-open");
    let names: Vec<&str> = wb
        .defined_names()
        .iter()
        .map(|(n, _)| n.as_str())
        .collect();
    assert!(
        names.contains(&"Good_Name"),
        "the one valid entry should survive; got {names:?}"
    );
    // The invalid-name entry should have been reported as a failure warning
    // (not crash the export).
    assert!(
        export
            .warnings
            .iter()
            .any(|w| w.code == "XLSX_NAMED_RANGE_DROPPED"),
        "expected XLSX_NAMED_RANGE_DROPPED warning for invalid name entry"
    );
}

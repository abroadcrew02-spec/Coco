use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{import_xlsx_core, workbook_export_xlsx};
use rust_xlsxwriter::{Format, Workbook};
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn date_cell_imports_with_fmt_hint() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("dated.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("D").unwrap();
        let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
        ws.write_number_with_format(0, 0, 44562.0, &date_fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let result = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert!(
        cell.get("_fmt").is_some(),
        "expected _fmt hint on date cell, got {}",
        cell
    );
    assert_eq!(cell["v"].as_f64(), Some(44562.0));
}

#[test]
fn date_round_trip_preserves_visual_format() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("dated.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("D").unwrap();
        let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
        ws.write_number_with_format(0, 0, 44562.0, &date_fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snapshot_json = imported.handle.snapshot_json.unwrap();

    let export_result = workbook_export_xlsx(path_str(&exported), snapshot_json).unwrap();
    assert!(
        export_result.success,
        "export failed: {:?}",
        export_result.error
    );

    let mut wb: Xlsx<_> = open_workbook(&exported).unwrap();
    let range = wb.worksheet_range("D").unwrap();
    let cell = range.get_value((0, 0)).unwrap();
    match cell {
        Data::DateTime(dt) => {
            assert!(
                (dt.as_f64() - 44562.0).abs() < 1e-9,
                "expected serial ~44562, got {}",
                dt.as_f64()
            );
        }
        other => panic!("expected DateTime after round-trip, got {:?}", other),
    }
}

#[test]
fn non_date_cells_unaffected() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("mixed.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("M").unwrap();
        ws.write_string(0, 0, "name").unwrap();
        ws.write_number(1, 0, 42.5).unwrap();
        ws.write_boolean(2, 0, true).unwrap();
        wb.save(&fixture).unwrap();
    }

    let result = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();

    assert!(snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]
        .get("_fmt")
        .is_none());
    assert!(snap["sheets"]["sheet-1"]["cellData"]["1"]["0"]
        .get("_fmt")
        .is_none());
    assert!(snap["sheets"]["sheet-1"]["cellData"]["2"]["0"]
        .get("_fmt")
        .is_none());
}

use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Format, Workbook};
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Pull `xl/styles.xml` from an xlsx and return it as a string. Used to assert
/// that a particular `formatCode` is registered after export.
fn read_styles_xml(path: &PathBuf) -> String {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;
    let f = File::open(path).expect("open xlsx");
    let mut z = ZipArchive::new(f).expect("zip");
    let mut s = String::new();
    z.by_name("xl/styles.xml")
        .expect("styles.xml")
        .read_to_string(&mut s)
        .expect("read");
    s
}

#[test]
fn custom_num_format_round_trips() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("custom.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("N").unwrap();
        let fmt = Format::new().set_num_format("#,##0.00");
        ws.write_number_with_format(0, 0, 1234.5, &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.clone().unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("#,##0.00"),
        "expected _fmt='#,##0.00' on imported cell, got {}",
        cell
    );
    assert!((cell["v"].as_f64().unwrap() - 1234.5).abs() < 1e-9);

    let export_result =
        export_xlsx_core(path_str(&exported), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(
        export_result.success,
        "export failed: {:?}",
        export_result.error
    );

    // The exported xlsx must register the same formatCode.
    let styles = read_styles_xml(&exported);
    assert!(
        styles.contains("#,##0.00"),
        "exported styles.xml missing formatCode '#,##0.00': {}",
        styles
    );

    // And the value must still be 1234.5.
    let mut wb: Xlsx<_> = open_workbook(&exported).unwrap();
    let range = wb.worksheet_range("N").unwrap();
    let v = range.get_value((0, 0)).unwrap();
    match v {
        Data::Float(f) => assert!((f - 1234.5).abs() < 1e-9),
        Data::Int(i) => assert_eq!(*i, 1234),
        other => panic!("expected number after round-trip, got {:?}", other),
    }
}

#[test]
fn builtin_percent_format_id_9_maps_to_zero_percent() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("pct.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("P").unwrap();
        // "0%" is built-in numFmtId 9 — rust_xlsxwriter will recognize and reuse it.
        let fmt = Format::new().set_num_format("0%");
        ws.write_number_with_format(0, 0, 0.5, &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("0%"),
        "expected built-in id 9 to map to '0%', got {}",
        cell
    );
    assert!((cell["v"].as_f64().unwrap() - 0.5).abs() < 1e-9);
}

#[test]
fn cell_without_num_format_has_no_fmt() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("plain.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("S").unwrap();
        ws.write_number(0, 0, 42.0).unwrap();
        ws.write_string(0, 1, "hello").unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.unwrap()).unwrap();

    let num_cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let str_cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["1"];
    assert!(
        num_cell.get("_fmt").is_none(),
        "plain number should have no _fmt, got {}",
        num_cell
    );
    assert!(
        str_cell.get("_fmt").is_none(),
        "plain string should have no _fmt, got {}",
        str_cell
    );
}

#[test]
fn date_format_still_round_trips_regression() {
    // Regression check: the existing DateTime fallback in data_to_cell must
    // remain — even when the new code path runs, dates without an explicit
    // numFmt should still get a date _fmt hint.
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("date.xlsx");
    let exported = tmp.path().join("exported_date.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("D").unwrap();
        let fmt = Format::new().set_num_format("yyyy-mm-dd");
        ws.write_number_with_format(0, 0, 44562.0, &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.clone().unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("yyyy-mm-dd"),
        "expected date _fmt preserved, got {}",
        cell
    );

    let export_result =
        export_xlsx_core(path_str(&exported), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(export_result.success);

    let mut wb: Xlsx<_> = open_workbook(&exported).unwrap();
    let range = wb.worksheet_range("D").unwrap();
    let cell = range.get_value((0, 0)).unwrap();
    match cell {
        Data::DateTime(dt) => {
            assert!((dt.as_f64() - 44562.0).abs() < 1e-9);
        }
        other => panic!("expected DateTime after round-trip, got {:?}", other),
    }
}

#[test]
fn text_format_at_sign_round_trips() {
    // Built-in id 49 = "@" (text). Ensure cells with explicit text format
    // are flagged on import.
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("text.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("T").unwrap();
        let fmt = Format::new().set_num_format("@");
        ws.write_string_with_format(0, 0, "0123", &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("@"),
        "expected '@' text format, got {}",
        cell
    );
    assert_eq!(cell["v"].as_str(), Some("0123"));
}

#[test]
fn poc_warning_no_longer_lists_number_formats() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("any.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("X").unwrap();
        ws.write_string(0, 0, "hi").unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let poc = imported
        .warnings
        .iter()
        .find(|w| w.code == "XLSX_POC_IMPORT")
        .expect("import PoC banner present");
    // The "not preserved" list (everything before "are not yet preserved") must
    // not contain "number formats" — but the "preserved" list (after) may.
    let not_preserved_segment = poc
        .message
        .split("are not yet preserved")
        .next()
        .unwrap_or("");
    assert!(
        !not_preserved_segment.contains("number formats"),
        "import PoC banner should no longer list 'number formats' as not-preserved: {}",
        poc.message
    );
    // And it should explicitly mention number formats as preserved.
    assert!(
        poc.message.contains("number formats"),
        "import PoC banner should mention number formats: {}",
        poc.message
    );
}

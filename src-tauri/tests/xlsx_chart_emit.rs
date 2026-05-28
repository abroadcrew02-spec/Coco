//! Tests for #330: Coco-authored chart OOXML emit via inject_charts_to_xlsx.
//! Each test builds a snapshot with _charts entries, exports to xlsx, then
//! inspects the produced zip for correct chart/drawing/rels structure.

use std::io::{Read, Write};
use std::path::PathBuf;

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use tempfile::TempDir;
use zip::ZipArchive;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Build a minimal plain xlsx and return the import snapshot as a Value.
fn base_snapshot(tmp: &TempDir, sheet_name: &str) -> (PathBuf, String) {
    let plain = tmp.path().join("plain.xlsx");
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name(sheet_name).unwrap();
        // Write some data: header row + 3 data rows, 2 columns
        ws.write_string(0, 0, "Month").unwrap();
        ws.write_string(0, 1, "Sales").unwrap();
        ws.write_string(1, 0, "Jan").unwrap();
        ws.write_number(1, 1, 100.0).unwrap();
        ws.write_string(2, 0, "Feb").unwrap();
        ws.write_number(2, 1, 200.0).unwrap();
        ws.write_string(3, 0, "Mar").unwrap();
        ws.write_number(3, 1, 150.0).unwrap();
        wb.save(&plain).unwrap();
    }
    let import = import_xlsx_core(path_str(&plain)).expect("import ok");
    let snap_json = import.handle.snapshot_json.expect("snapshot present");
    (plain, snap_json)
}

/// Inject a _charts array into the snapshot JSON for the first sheet.
fn inject_charts(snap_json: &str, charts: Value) -> String {
    let mut snap: Value = serde_json::from_str(snap_json).expect("parse snapshot");
    let sheet_order = snap
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let first_sheet_id = sheet_order
        .first()
        .and_then(|v| v.as_str())
        .expect("at least one sheet");
    snap["sheets"][first_sheet_id]["_charts"] = charts;
    serde_json::to_string(&snap).unwrap()
}

/// Read a zip entry as a string.
fn read_zip_entry_str(zip: &mut ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str) -> Option<String> {
    let mut e = zip.by_name(name).ok()?;
    let mut s = String::new();
    e.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Check that the zip contains at least one chart9xxx.xml part with barChart.
fn assert_bar_chart_emitted(zip: &mut ZipArchive<std::io::Cursor<Vec<u8>>>) {
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_parts: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .collect();
    assert!(
        !chart_parts.is_empty(),
        "expected at least one xl/charts/chart9xxx.xml, got names: {:?}",
        names.iter().filter(|n| n.starts_with("xl/charts")).collect::<Vec<_>>()
    );
    for part in &chart_parts {
        let xml = read_zip_entry_str(zip, part).expect("read chart xml");
        assert!(
            xml.contains("<c:barChart>"),
            "{part} should contain <c:barChart>, got:\n{xml}"
        );
    }
}

// --------------------------------------------------------------------------
// Test 1: bar chart — minimal single-series emit
// --------------------------------------------------------------------------

#[test]
fn bar_chart_emits_chart_xml_with_bar_chart_element() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");

    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "bar",
        "title": "Sales Chart",
        "showLegend": true,
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 1,
        "anchorCol": 5,
        "widthPx": 400,
        "heightPx": 300
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));

    let out = tmp.path().join("bar_out.xlsx");
    let result = export_xlsx_core(path_str(&out), snap_with_chart).expect("export ok");
    assert!(result.success, "export failed: {:?}", result.error);

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert_bar_chart_emitted(&mut zip);
}

// --------------------------------------------------------------------------
// Test 2: bar chart — axId consistency (catAx/valAx must match barChart axId refs)
// --------------------------------------------------------------------------

#[test]
fn bar_chart_axid_consistency() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "bar",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("bar_axid.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export ok").success.then(|| ()).expect("export success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_part = names
        .iter()
        .find(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .expect("chart part exists");
    let xml = read_zip_entry_str(&mut zip, chart_part).unwrap();

    // barChart must reference axId 9001 and 9002
    assert!(xml.contains("<c:axId val=\"9001\"/>"), "barChart axId 9001 not found");
    assert!(xml.contains("<c:axId val=\"9002\"/>"), "barChart axId 9002 not found");
    // catAx and valAx must declare the same IDs
    assert!(xml.contains("<c:catAx>"), "catAx missing");
    assert!(xml.contains("<c:valAx>"), "valAx missing");
}

// --------------------------------------------------------------------------
// Test 3: numCache values are present and ptCount matches pt count
// --------------------------------------------------------------------------

#[test]
fn bar_chart_num_cache_values_present() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "bar",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("numcache.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_part = names
        .iter()
        .find(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .unwrap();
    let xml = read_zip_entry_str(&mut zip, chart_part).unwrap();

    // Should contain numRef/numCache
    assert!(xml.contains("<c:numCache>"), "numCache missing");
    assert!(xml.contains("<c:ptCount val=\"3\"/>"), "ptCount 3 expected (3 data rows)");
    // Values 100, 200, 150 should be present
    assert!(xml.contains("<c:v>100</c:v>"), "value 100 missing");
    assert!(xml.contains("<c:v>200</c:v>"), "value 200 missing");
    assert!(xml.contains("<c:v>150</c:v>"), "value 150 missing");
}

// --------------------------------------------------------------------------
// Test 4: line chart
// --------------------------------------------------------------------------

#[test]
fn line_chart_emits_line_chart_element() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "line",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("line.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_part = names
        .iter()
        .find(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .unwrap();
    let xml = read_zip_entry_str(&mut zip, chart_part).unwrap();
    assert!(xml.contains("<c:lineChart>"), "lineChart element missing");
    assert!(xml.contains("<c:catAx>"), "catAx missing for line");
    assert!(xml.contains("<c:valAx>"), "valAx missing for line");
}

// --------------------------------------------------------------------------
// Test 5: pie chart — no axes (Excel breaks if axes present for pie)
// --------------------------------------------------------------------------

#[test]
fn pie_chart_has_no_axes() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "pie",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("pie.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_part = names
        .iter()
        .find(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .unwrap();
    let xml = read_zip_entry_str(&mut zip, chart_part).unwrap();
    assert!(xml.contains("<c:pieChart>"), "pieChart element missing");
    assert!(
        !xml.contains("<c:catAx>"),
        "pie must NOT have catAx — Excel breaks: {xml}"
    );
    assert!(
        !xml.contains("<c:valAx>"),
        "pie must NOT have valAx — Excel breaks: {xml}"
    );
}

// --------------------------------------------------------------------------
// Test 6: stacked bar chart → grouping="stacked"
// --------------------------------------------------------------------------

#[test]
fn stacked_bar_chart_has_stacked_grouping() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "bar",
        "stacked": true,
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("stacked.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_part = names
        .iter()
        .find(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .unwrap();
    let xml = read_zip_entry_str(&mut zip, chart_part).unwrap();
    assert!(
        xml.contains("<c:grouping val=\"stacked\"/>"),
        "stacked grouping missing"
    );
    assert!(
        xml.contains("<c:overlap val=\"100\"/>"),
        "stacked bar should have overlap 100"
    );
}

// --------------------------------------------------------------------------
// Test 7: multi-series chart (2 series columns)
// --------------------------------------------------------------------------

#[test]
fn multi_series_chart_emits_two_series() {
    let tmp = TempDir::new().unwrap();
    let plain = tmp.path().join("plain2.xlsx");
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Data").unwrap();
        ws.write_string(0, 0, "Month").unwrap();
        ws.write_string(0, 1, "Sales").unwrap();
        ws.write_string(0, 2, "Costs").unwrap();
        ws.write_string(1, 0, "Jan").unwrap();
        ws.write_number(1, 1, 100.0).unwrap();
        ws.write_number(1, 2, 60.0).unwrap();
        ws.write_string(2, 0, "Feb").unwrap();
        ws.write_number(2, 1, 200.0).unwrap();
        ws.write_number(2, 2, 80.0).unwrap();
        ws.write_string(3, 0, "Mar").unwrap();
        ws.write_number(3, 1, 150.0).unwrap();
        ws.write_number(3, 2, 70.0).unwrap();
        wb.save(&plain).unwrap();
    }
    let import = import_xlsx_core(path_str(&plain)).expect("import ok");
    let snap_json = import.handle.snapshot_json.expect("snap");
    let chart = json!({
        "range": "Data!A1:C4",
        "type": "bar",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("multi.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_part = names
        .iter()
        .find(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .unwrap();
    let xml = read_zip_entry_str(&mut zip, chart_part).unwrap();
    // Two series: idx 0 and idx 1
    assert!(xml.contains("<c:idx val=\"0\"/>"), "series 0 missing");
    assert!(xml.contains("<c:idx val=\"1\"/>"), "series 1 missing");
}

// --------------------------------------------------------------------------
// Test 8: round-trip — _charts survive export → re-import via cocoExtensions
// --------------------------------------------------------------------------

#[test]
fn charts_round_trip_via_coco_extensions() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "bar",
        "title": "RT Chart",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));

    // Export
    let out = tmp.path().join("rt.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    // Re-import
    let re_import = import_xlsx_core(path_str(&out)).expect("re-import ok");
    let re_snap_json = re_import.handle.snapshot_json.expect("re-snap");
    let re_snap: Value = serde_json::from_str(&re_snap_json).expect("parse re-snap");

    // _charts must be restored on the first sheet via cocoExtensions
    let sheet_order = re_snap["sheetOrder"].as_array().expect("sheetOrder");
    let first_id = sheet_order[0].as_str().expect("first sheet id");
    let charts = re_snap["sheets"][first_id]["_charts"]
        .as_array()
        .expect("_charts should be restored after round-trip");
    assert_eq!(charts.len(), 1, "expected 1 chart after round-trip");
    assert_eq!(
        charts[0]["type"].as_str(),
        Some("bar"),
        "chart type should be bar"
    );
}

// --------------------------------------------------------------------------
// Test 9: no double-take — Coco-emitted charts should NOT land in _preservedParts
// --------------------------------------------------------------------------

#[test]
fn coco_emitted_charts_not_in_preserved_parts() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "bar",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));

    let out = tmp.path().join("no_double.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let re_import = import_xlsx_core(path_str(&out)).expect("re-import ok");
    let re_snap_json = re_import.handle.snapshot_json.expect("snap");
    let re_snap: Value = serde_json::from_str(&re_snap_json).expect("parse");

    // Coco-emitted chart parts (9001+) should not be in _preservedParts
    if let Some(preserved) = re_snap.get("_preservedParts") {
        if let Some(parts) = preserved.get("parts").and_then(|v| v.as_object()) {
            let coco_charts: Vec<&String> = parts
                .keys()
                .filter(|k| k.starts_with("xl/charts/chart9"))
                .collect();
            assert!(
                coco_charts.is_empty(),
                "Coco-emitted chart parts should not be in _preservedParts, found: {:?}",
                coco_charts
            );
        }
    }
}

// --------------------------------------------------------------------------
// Test 10: Excel-origin chart blobs survive (regression guard)
// --------------------------------------------------------------------------

/// Hand-splice a chart part into the xlsx so it looks like an Excel-origin chart,
/// then export and verify the blob survives verbatim (inject_charts_to_xlsx must
/// not clobber xl/charts/ entries with low numeric IDs).
#[test]
fn excel_origin_chart_blob_preserved() {
    use zip::write::FileOptions;

    const CHART_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <c:chart><c:plotArea><c:layout/></c:plotArea></c:chart>
</c:chartSpace>"#;

    let tmp = TempDir::new().unwrap();
    let plain = tmp.path().join("plain.xlsx");
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("S1").unwrap();
        ws.write_string(0, 0, "x").unwrap();
        wb.save(&plain).unwrap();
    }

    // Splice in a chart1.xml (low ID = Excel-origin)
    let fixture = tmp.path().join("with_excel_chart.xlsx");
    {
        let src_bytes = std::fs::read(&plain).unwrap();
        let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
        let out_file = std::fs::File::create(&fixture).unwrap();
        let mut out = zip::ZipWriter::new(out_file);
        let opts: FileOptions =
            FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let rewrites = &["[Content_Types].xml"];
        for i in 0..src.len() {
            let mut e = src.by_index(i).unwrap();
            let name = e.name().to_string();
            if rewrites.contains(&name.as_str()) { continue; }
            let mut buf = Vec::new();
            e.read_to_end(&mut buf).unwrap();
            out.start_file(&name, opts).unwrap();
            out.write_all(&buf).unwrap();
        }
        let mut ct = String::new();
        src.by_name("[Content_Types].xml").unwrap().read_to_string(&mut ct).unwrap();
        let close = ct.rfind("</Types>").unwrap();
        let mut new_ct = ct[..close].to_string();
        new_ct.push_str(r#"<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>"#);
        new_ct.push_str(&ct[close..]);
        out.start_file("[Content_Types].xml", opts).unwrap();
        out.write_all(new_ct.as_bytes()).unwrap();
        out.start_file("xl/charts/chart1.xml", opts).unwrap();
        out.write_all(CHART_XML.as_bytes()).unwrap();
        out.finish().unwrap();
    }

    // Import → add a Coco chart → export
    let import = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = import.handle.snapshot_json.expect("snap");
    let coco_chart = json!({
        "range": "S1!A1:A1",
        "type": "bar",
        "hasHeaderRow": false,
        "hasHeaderCol": false,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_coco = inject_charts(&snap_json, json!([coco_chart]));

    let out = tmp.path().join("with_both.xlsx");
    export_xlsx_core(path_str(&out), snap_with_coco).expect("export").success.then(|| ()).expect("success");

    // chart1.xml must still be present and verbatim
    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let chart1_xml = read_zip_entry_str(&mut zip, "xl/charts/chart1.xml")
        .expect("xl/charts/chart1.xml must survive");
    assert_eq!(
        chart1_xml.as_bytes(),
        CHART_XML.as_bytes(),
        "Excel-origin chart1.xml must be byte-identical after round-trip"
    );
}

// --------------------------------------------------------------------------
// Test 11: drawing part is valid (contains graphicFrame for the chart)
// --------------------------------------------------------------------------

#[test]
fn drawing_contains_graphic_frame_for_chart() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "bar",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 2,
        "anchorCol": 6,
        "widthPx": 400,
        "heightPx": 300
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("drawing_check.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let drawing_part = names
        .iter()
        .find(|n| n.starts_with("xl/drawings/drawing9") && n.ends_with(".xml"))
        .expect("drawing9xxx.xml should exist");
    let xml = read_zip_entry_str(&mut zip, drawing_part).unwrap();
    assert!(
        xml.contains("<xdr:graphicFrame"),
        "drawing should contain graphicFrame, got:\n{xml}"
    );
    assert!(
        xml.contains("drawingml/2006/chart"),
        "graphicFrame should reference chart namespace"
    );
}

// --------------------------------------------------------------------------
// Test 12: doughnut chart type
// --------------------------------------------------------------------------

#[test]
fn doughnut_chart_has_no_axes() {
    let tmp = TempDir::new().unwrap();
    let (_, snap_json) = base_snapshot(&tmp, "Sheet1");
    let chart = json!({
        "range": "Sheet1!A1:B4",
        "type": "doughnut",
        "hasHeaderRow": true,
        "hasHeaderCol": true,
        "anchorRow": 0,
        "anchorCol": 5,
        "widthPx": 380,
        "heightPx": 280
    });
    let snap_with_chart = inject_charts(&snap_json, json!([chart]));
    let out = tmp.path().join("doughnut.xlsx");
    export_xlsx_core(path_str(&out), snap_with_chart).expect("export").success.then(|| ()).expect("success");

    let bytes = std::fs::read(&out).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .collect();
    let chart_part = names
        .iter()
        .find(|n| n.starts_with("xl/charts/chart9") && n.ends_with(".xml"))
        .unwrap();
    let xml = read_zip_entry_str(&mut zip, chart_part).unwrap();
    assert!(xml.contains("<c:doughnutChart>"), "doughnutChart element missing");
    assert!(!xml.contains("<c:catAx>"), "doughnut must not have catAx");
    assert!(!xml.contains("<c:valAx>"), "doughnut must not have valAx");
}

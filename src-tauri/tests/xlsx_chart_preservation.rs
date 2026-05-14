//! Round-trip test for chart "blob-level" preservation. Verifies that a
//! source xlsx with chart parts survives import → export with the chart
//! bytes intact in the output zip.
//!
//! We hand-craft a fixture by writing a plain xlsx with rust_xlsxwriter then
//! splicing in chart/drawing parts + a worksheet `<drawing>` reference using
//! the zip crate. After round-tripping through Coco's xlsx_io, we re-open
//! the output zip and assert the chart part still exists and matches.

use std::io::{Read, Write};
use std::path::PathBuf;

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::Workbook;
use tempfile::TempDir;
use zip::write::FileOptions;
use zip::ZipArchive;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Hand-craft a minimal chart XML body — enough that "the bytes survived"
/// can be asserted. This is NOT a chart Excel will render (no series data),
/// but the preservation pipeline operates on opaque bytes so the contents
/// don't matter — only that they survive verbatim.
const CHART_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <c:chart><c:plotArea><c:layout/></c:plotArea></c:chart>
</c:chartSpace>"#;

const DRAWING_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor>
    <xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff>
              <xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff>
            <xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="Chart 1"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
        <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/>
      </a:graphicData></a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>"#;

const DRAWING_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>"#;

const SHEET_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdDraw1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#;

/// Build a fixture xlsx by writing a plain workbook then re-zipping it with
/// chart-related parts spliced in.
fn build_chart_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain.xlsx");
    let fixture_path = tmp.path().join("with_chart.xlsx");

    // 1. Plain workbook with one sheet, a few cells.
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sales").unwrap();
        ws.write_string(0, 0, "Q").unwrap();
        ws.write_string(0, 1, "Amount").unwrap();
        ws.write_string(1, 0, "Q1").unwrap();
        ws.write_number(1, 1, 100.0).unwrap();
        ws.write_string(2, 0, "Q2").unwrap();
        ws.write_number(2, 1, 200.0).unwrap();
        wb.save(&plain_path).unwrap();
    }

    // 2. Re-zip with chart parts spliced in. We have to rewrite worksheets
    //    /sheet1.xml to add `<drawing r:id="rIdDraw1"/>` so the chart is
    //    actually referenced. (The preservation pipeline reads that ref
    //    on import.)
    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // Track names we'll rewrite so we skip them on copy.
    let rewrites: &[&str] = &["xl/worksheets/sheet1.xml", "[Content_Types].xml"];

    for i in 0..src.len() {
        let mut entry = src.by_index(i).unwrap();
        let name = entry.name().to_string();
        if rewrites.contains(&name.as_str()) {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        out.start_file(&name, opts).unwrap();
        out.write_all(&buf).unwrap();
    }

    // Patched sheet1.xml: inject `<drawing r:id="rIdDraw1"/>` before
    // `</worksheet>`.
    let mut sheet_xml = String::new();
    src.by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut sheet_xml)
        .unwrap();
    let pos = sheet_xml.rfind("</worksheet>").unwrap();
    let mut patched = String::with_capacity(sheet_xml.len() + 64);
    patched.push_str(&sheet_xml[..pos]);
    patched.push_str("<drawing r:id=\"rIdDraw1\"/>");
    patched.push_str(&sheet_xml[pos..]);
    out.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    out.write_all(patched.as_bytes()).unwrap();

    // Patched [Content_Types].xml: add Overrides for the chart + drawing.
    let mut ct_xml = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct_xml)
        .unwrap();
    let close = ct_xml.rfind("</Types>").unwrap();
    let mut patched_ct = String::new();
    patched_ct.push_str(&ct_xml[..close]);
    patched_ct.push_str(
        r#"<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>"#,
    );
    patched_ct.push_str(
        r#"<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
    );
    patched_ct.push_str(&ct_xml[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(patched_ct.as_bytes()).unwrap();

    // New parts: chart, drawing, drawing rels, sheet rels.
    out.start_file("xl/charts/chart1.xml", opts).unwrap();
    out.write_all(CHART_XML.as_bytes()).unwrap();

    out.start_file("xl/drawings/drawing1.xml", opts).unwrap();
    out.write_all(DRAWING_XML.as_bytes()).unwrap();

    out.start_file("xl/drawings/_rels/drawing1.xml.rels", opts)
        .unwrap();
    out.write_all(DRAWING_RELS.as_bytes()).unwrap();

    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(SHEET_RELS.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

#[test]
fn chart_blob_survives_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_chart_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    // Import the fixture. Snapshot should contain `_preservedParts`.
    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");
    let preserved = snapshot
        .get("_preservedParts")
        .expect("_preservedParts should be on snapshot");
    let parts = preserved
        .get("parts")
        .and_then(|v| v.as_object())
        .expect("parts object");
    assert!(
        parts.contains_key("xl/charts/chart1.xml"),
        "chart should be preserved in snapshot, got keys: {:?}",
        parts.keys().collect::<Vec<_>>()
    );
    assert!(
        parts.contains_key("xl/drawings/drawing1.xml"),
        "drawing should be preserved in snapshot"
    );

    // Export. The output must still carry the chart bytes.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");
    let mut chart_bytes = Vec::new();
    out_zip
        .by_name("xl/charts/chart1.xml")
        .expect("chart part must exist in output zip")
        .read_to_end(&mut chart_bytes)
        .unwrap();
    assert!(
        !chart_bytes.is_empty(),
        "chart part should not be empty after round-trip"
    );
    assert_eq!(
        chart_bytes,
        CHART_XML.as_bytes(),
        "chart bytes should round-trip verbatim"
    );

    // Drawing part should also be preserved.
    let mut drawing_bytes = Vec::new();
    out_zip
        .by_name("xl/drawings/drawing1.xml")
        .expect("drawing part must exist in output zip")
        .read_to_end(&mut drawing_bytes)
        .unwrap();
    assert_eq!(drawing_bytes, DRAWING_XML.as_bytes());
}

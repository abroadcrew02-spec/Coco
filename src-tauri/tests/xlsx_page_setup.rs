//! Tests for xlsx print / page setup round-trip preservation.
//!
//! Fixtures are built by writing minimal xlsx zips directly so the page-setup
//! attributes appear literally in the worksheet XML — that way the import side
//! reads back the exact values we expect to assert on without rust_xlsxwriter
//! defaults muddying the assertions.

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use serde_json::Value;
use std::io::{Read, Write};
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Minimal valid xlsx fixture with one sheet "S1". Lets the caller inject the
/// inner-`<worksheet>` XML so each test can shape the page-setup metadata.
fn write_xlsx_fixture(path: &std::path::Path, worksheet_inner: &str) {
    let file = std::fs::File::create(path).expect("create xlsx fixture");
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions = FileOptions::default();

    zip.start_file("[Content_Types].xml", opts).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
    )
    .unwrap();

    zip.start_file("_rels/.rels", opts).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
    )
    .unwrap();

    zip.start_file("xl/workbook.xml", opts).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
    )
    .unwrap();

    zip.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
    )
    .unwrap();

    zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{worksheet_inner}</worksheet>"#
    );
    zip.write_all(xml.as_bytes()).unwrap();

    zip.finish().expect("finalize fixture zip");
}

fn read_sheet1_xml(path: &std::path::Path) -> String {
    let f = std::fs::File::open(path).expect("open exported");
    let mut archive = zip::ZipArchive::new(f).expect("read zip");
    let mut entry = archive
        .by_name("xl/worksheets/sheet1.xml")
        .expect("sheet1.xml present");
    let mut s = String::new();
    entry.read_to_string(&mut s).expect("read sheet1.xml");
    s
}

#[test]
fn orientation_scale_and_margins_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("pagesetup.xlsx");
    let exported = tmp.path().join("pagesetup_out.xlsx");

    // Landscape, scale=80, plus custom margins.
    write_xlsx_fixture(
        &fixture,
        r#"<sheetData/>
<pageMargins left="0.5" right="0.6" top="0.8" bottom="0.9" header="0.25" footer="0.35"/>
<pageSetup orientation="landscape" paperSize="9" scale="80"/>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    let ps = &snap["sheets"]["sheet-1"]["_pageSetup"];
    assert!(ps.is_object(), "expected _pageSetup on sheet-1, got {snap}");
    assert_eq!(ps["orientation"].as_str(), Some("landscape"));
    assert_eq!(ps["scale"].as_u64(), Some(80));
    assert_eq!(ps["paperSize"].as_u64(), Some(9));

    let m = &ps["margins"];
    assert_eq!(m["left"].as_f64(), Some(0.5));
    assert_eq!(m["right"].as_f64(), Some(0.6));
    assert_eq!(m["top"].as_f64(), Some(0.8));
    assert_eq!(m["bottom"].as_f64(), Some(0.9));
    assert_eq!(m["header"].as_f64(), Some(0.25));
    assert_eq!(m["footer"].as_f64(), Some(0.35));

    // Export and confirm the values survive to disk.
    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert!(
        xml.contains("orientation=\"landscape\""),
        "exported xml should keep landscape orientation: {xml}"
    );
    assert!(
        xml.contains("scale=\"80\""),
        "exported xml should keep scale=80: {xml}"
    );
    assert!(
        xml.contains("left=\"0.5\""),
        "exported xml should keep left margin: {xml}"
    );

    // Re-import and confirm the field survives a second round-trip.
    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value =
        serde_json::from_str(&result2.handle.snapshot_json.unwrap()).expect("parse re-import");
    let ps2 = &snap2["sheets"]["sheet-1"]["_pageSetup"];
    assert_eq!(ps2["orientation"].as_str(), Some("landscape"));
    assert_eq!(ps2["scale"].as_u64(), Some(80));
    assert_eq!(ps2["margins"]["top"].as_f64(), Some(0.8));
}

#[test]
fn header_and_footer_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("hf.xlsx");
    let exported = tmp.path().join("hf_out.xlsx");

    // Header "&CMy Report", footer "Page &P".
    write_xlsx_fixture(
        &fixture,
        r#"<sheetData/>
<headerFooter><oddHeader>&amp;CMy Report</oddHeader><oddFooter>Page &amp;P</oddFooter></headerFooter>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    let ps = &snap["sheets"]["sheet-1"]["_pageSetup"];
    assert!(ps.is_object(), "expected _pageSetup on sheet-1");
    assert_eq!(ps["header"].as_str(), Some("&CMy Report"));
    assert_eq!(ps["footer"].as_str(), Some("Page &P"));

    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert!(
        xml.contains("My Report"),
        "exported xml should keep the header text: {xml}"
    );
    assert!(
        xml.contains("Page"),
        "exported xml should keep the footer text: {xml}"
    );

    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value =
        serde_json::from_str(&result2.handle.snapshot_json.unwrap()).expect("parse re-import");
    let ps2 = &snap2["sheets"]["sheet-1"]["_pageSetup"];
    assert_eq!(ps2["header"].as_str(), Some("&CMy Report"));
    assert_eq!(ps2["footer"].as_str(), Some("Page &P"));
}

#[test]
fn no_page_setup_means_no_field_on_snapshot() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("nops.xlsx");

    // Bare worksheet — no pageSetup / pageMargins / headerFooter / printOptions.
    // We still avoid setting `showGridLines` or `zoomScale` so the opt-in
    // contract holds.
    write_xlsx_fixture(&fixture, r#"<sheetData/>"#);

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).expect("parse snap");

    let sheet = &snap["sheets"]["sheet-1"];
    assert!(
        sheet.get("_pageSetup").is_none(),
        "_pageSetup must be absent when no page-setup metadata was declared, got {sheet}"
    );
}

//! Tests for xlsx column-width + row-height round-trip preservation.
//!
//! Fixtures are built by writing minimal xlsx zips directly (not via
//! rust_xlsxwriter) so the `width="N"` and `ht="N"` attributes appear
//! literally in the worksheet XML — that way the import side reads back the
//! exact values we expect to assert on. rust_xlsxwriter applies a Calibri-11
//! char-width conversion when *it* writes widths, which would otherwise muddy
//! the assertions for the import test step.

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use serde_json::Value;
use std::io::{Read, Write};
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Minimal valid xlsx fixture with one sheet "S1". Lets the caller inject the
/// inner-<sheetData>-and-friends XML so each test can shape the worksheet to
/// taste.
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

/// Pulls `xl/worksheets/sheet1.xml` text out of an xlsx zip — used to inspect
/// the on-disk result of an export step.
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
fn column_width_roundtrip_for_single_column() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("colwidth.xlsx");
    let exported = tmp.path().join("colwidth_exported.xlsx");

    // Column B (1-based: min=2 max=2 → 0-based index 1) with width=30.
    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="2" max="2" width="30" customWidth="1"/></cols><sheetData/>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    let col_data = &snap["sheets"]["sheet-1"]["columnData"];
    assert!(
        col_data.is_object(),
        "expected columnData object on sheet-1, got {snap}"
    );
    assert_eq!(
        col_data["1"]["w"].as_f64(),
        Some(30.0),
        "columnData[\"1\"].w should be 30, got {col_data}"
    );

    // Export and verify the same width survived to disk.
    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert!(
        xml.contains("width=\"30\""),
        "exported xml should contain width=\"30\", got: {xml}"
    );
    assert!(
        xml.contains("customWidth=\"1\""),
        "exported xml should mark column as customWidth=\"1\", got: {xml}"
    );

    // Re-import and confirm the round-trip is still 30.
    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value = serde_json::from_str(&result2.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(
        snap2["sheets"]["sheet-1"]["columnData"]["1"]["w"].as_f64(),
        Some(30.0),
        "after re-import, width should still be 30"
    );
}

#[test]
fn row_height_roundtrip_for_single_row() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("rowheight.xlsx");
    let exported = tmp.path().join("rowheight_exported.xlsx");

    // Row 5 (1-based, → 0-based index 4) with height=40.
    write_xlsx_fixture(
        &fixture,
        r#"<sheetData><row r="5" ht="40" customHeight="1"/></sheetData>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    let row_data = &snap["sheets"]["sheet-1"]["rowData"];
    assert!(
        row_data.is_object(),
        "expected rowData object on sheet-1, got {snap}"
    );
    assert_eq!(
        row_data["4"]["h"].as_f64(),
        Some(40.0),
        "rowData[\"4\"].h should be 40"
    );

    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert!(
        xml.contains("ht=\"40\""),
        "exported xml should contain ht=\"40\", got: {xml}"
    );
    assert!(
        xml.contains("customHeight=\"1\""),
        "exported xml should mark row as customHeight=\"1\""
    );

    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value = serde_json::from_str(&result2.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(
        snap2["sheets"]["sheet-1"]["rowData"]["4"]["h"].as_f64(),
        Some(40.0),
        "after re-import, height should still be 40"
    );
}

#[test]
fn column_span_expands_to_multiple_indices() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("colspan.xlsx");

    // <col min=1 max=3 width=20 customWidth=1/> → columns 0, 1, 2 all width 20.
    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="1" max="3" width="20" customWidth="1"/></cols><sheetData/>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).expect("parse snap");

    let col_data = &snap["sheets"]["sheet-1"]["columnData"];
    assert_eq!(
        col_data["0"]["w"].as_f64(),
        Some(20.0),
        "col 0 should be 20"
    );
    assert_eq!(
        col_data["1"]["w"].as_f64(),
        Some(20.0),
        "col 1 should be 20"
    );
    assert_eq!(
        col_data["2"]["w"].as_f64(),
        Some(20.0),
        "col 2 should be 20"
    );
    assert!(
        col_data.get("3").is_none(),
        "col 3 must NOT be populated, span was 1..=3"
    );
}

#[test]
fn no_custom_width_means_no_column_data() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("default.xlsx");

    // <col> without customWidth="1" — default size, should be ignored.
    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="1" max="3" width="8.43"/></cols><sheetData/>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).expect("parse snap");

    let sheet = &snap["sheets"]["sheet-1"];
    // columnData must be absent OR an empty object. The implementation only
    // attaches it when there's at least one customized column, so we expect
    // it to be entirely absent here.
    assert!(
        sheet.get("columnData").is_none(),
        "columnData should be absent for a sheet with no customWidth columns, got {sheet}"
    );
    assert!(
        sheet.get("rowData").is_none(),
        "rowData should be absent when there are no customHeight rows, got {sheet}"
    );
}

#[test]
fn row_without_custom_height_is_ignored() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("noheight.xlsx");

    // Row 2 has `ht` but no `customHeight="1"` — should be skipped.
    write_xlsx_fixture(
        &fixture,
        r#"<sheetData><row r="2" ht="15"/><row r="3" ht="25" customHeight="1"/></sheetData>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).expect("parse snap");

    let row_data = &snap["sheets"]["sheet-1"]["rowData"];
    assert!(
        row_data.get("1").is_none(),
        "row 1 (=row r=2, no customHeight) must NOT be in rowData"
    );
    assert_eq!(
        row_data["2"]["h"].as_f64(),
        Some(25.0),
        "row 2 (=row r=3, customHeight=1) should be present at h=25"
    );
}

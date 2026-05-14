//! Tests for xlsx frozen-pane + sheet-visibility round-trip preservation.
//!
//! Fixtures are written as minimal xlsx zips directly so the `<sheetView>
//! <pane.../></sheetView>` and `<sheet state="..."/>` constructs appear
//! literally in the source XML. The import side then reads them back, the
//! export side re-emits via rust_xlsxwriter, and we assert the resulting XML
//! still carries the same frozen-pane / visibility data.

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use serde_json::Value;
use std::io::{Read, Write};
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Minimal valid xlsx fixture with two sheets: "S1" and "S2". The caller
/// supplies the `<sheet ...>` entries for `xl/workbook.xml` (so visibility
/// state can be injected) and the body for each worksheet (so `<sheetView>`
/// can include a freeze pane).
fn write_xlsx_fixture(
    path: &std::path::Path,
    workbook_sheets_xml: &str,
    sheet1_inner: &str,
    sheet2_inner: &str,
) {
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
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
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
    let wb_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>{workbook_sheets_xml}</sheets>
</workbook>"#
    );
    zip.write_all(wb_xml.as_bytes()).unwrap();

    zip.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#,
    )
    .unwrap();

    zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    let xml1 = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{sheet1_inner}</worksheet>"#
    );
    zip.write_all(xml1.as_bytes()).unwrap();

    zip.start_file("xl/worksheets/sheet2.xml", opts).unwrap();
    let xml2 = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{sheet2_inner}</worksheet>"#
    );
    zip.write_all(xml2.as_bytes()).unwrap();

    zip.finish().expect("finalize fixture zip");
}

/// Pulls a named entry's text out of an xlsx zip.
fn read_entry(path: &std::path::Path, entry: &str) -> String {
    let f = std::fs::File::open(path).expect("open exported");
    let mut archive = zip::ZipArchive::new(f).expect("read zip");
    let mut e = archive.by_name(entry).expect("entry present");
    let mut s = String::new();
    e.read_to_string(&mut s).expect("read entry");
    s
}

#[test]
fn freeze_panes_rows_and_cols_round_trip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("freeze.xlsx");
    let exported = tmp.path().join("freeze_exported.xlsx");

    // Sheet 1 freezes 2 rows + 3 cols; topLeftCell="D3" sets the scroll origin.
    // ySplit=2 means rows 0..2 are frozen (i.e. row 2 is the first scrolling row,
    // matching `set_freeze_panes(2, 3)`).
    let sheet1_inner = r#"<sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="2" topLeftCell="D3" state="frozen"/></sheetView></sheetViews><sheetData/>"#;
    // Sheet 2 has no freeze pane.
    let sheet2_inner = r#"<sheetData/>"#;
    write_xlsx_fixture(
        &fixture,
        r#"<sheet name="S1" sheetId="1" r:id="rId1"/><sheet name="S2" sheetId="2" r:id="rId2"/>"#,
        sheet1_inner,
        sheet2_inner,
    );

    // Import → snapshot should expose `_freezePane` on sheet-1 only.
    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    let fp = &snap["sheets"]["sheet-1"]["_freezePane"];
    assert!(fp.is_object(), "expected _freezePane on sheet-1, got {snap}");
    assert_eq!(fp["row"].as_u64(), Some(2));
    assert_eq!(fp["col"].as_u64(), Some(3));
    assert_eq!(fp["topLeft"].as_str(), Some("D3"));

    assert!(
        snap["sheets"]["sheet-2"].get("_freezePane").is_none(),
        "sheet-2 has no freeze pane in the fixture; _freezePane should be omitted"
    );

    // Export → re-import → freeze pane should still be present on sheet-1.
    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value = serde_json::from_str(&result2.handle.snapshot_json.unwrap()).unwrap();
    let fp2 = &snap2["sheets"]["sheet-1"]["_freezePane"];
    assert!(
        fp2.is_object(),
        "after round-trip, sheet-1 should still carry _freezePane; got {snap2}"
    );
    assert_eq!(fp2["row"].as_u64(), Some(2));
    assert_eq!(fp2["col"].as_u64(), Some(3));

    // Belt-and-braces: the on-disk sheet1.xml mentions both xSplit=3 and ySplit=2.
    let xml = read_entry(&exported, "xl/worksheets/sheet1.xml");
    assert!(
        xml.contains("xSplit=\"3\""),
        "exported sheet1.xml should record xSplit=\"3\"; got:\n{xml}"
    );
    assert!(
        xml.contains("ySplit=\"2\""),
        "exported sheet1.xml should record ySplit=\"2\"; got:\n{xml}"
    );
}

#[test]
fn hidden_sheet_state_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("hidden.xlsx");
    let exported = tmp.path().join("hidden_exported.xlsx");

    // S1 is visible, S2 is hidden. (rust_xlsxwriter doesn't allow ALL sheets
    // to be hidden — at least one must remain visible — so keep S1 visible.)
    write_xlsx_fixture(
        &fixture,
        r#"<sheet name="S1" sheetId="1" r:id="rId1"/><sheet name="S2" sheetId="2" state="hidden" r:id="rId2"/>"#,
        r#"<sheetData/>"#,
        r#"<sheetData/>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    assert!(
        snap["sheets"]["sheet-1"].get("_sheetState").is_none(),
        "visible sheet should not carry _sheetState; got {snap}"
    );
    assert_eq!(
        snap["sheets"]["sheet-2"]["_sheetState"].as_str(),
        Some("hidden"),
        "hidden sheet should carry _sheetState=\"hidden\"; got {snap}"
    );

    // Export and confirm workbook.xml records the hidden state on S2.
    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let wb_xml = read_entry(&exported, "xl/workbook.xml");
    assert!(
        wb_xml.contains("state=\"hidden\""),
        "exported workbook.xml should mark a sheet as state=\"hidden\"; got:\n{wb_xml}"
    );

    // Re-import to verify the round-trip is stable.
    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value = serde_json::from_str(&result2.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(
        snap2["sheets"]["sheet-2"]["_sheetState"].as_str(),
        Some("hidden"),
        "after round-trip, hidden state should still be \"hidden\"; got {snap2}"
    );
    assert!(
        snap2["sheets"]["sheet-1"].get("_sheetState").is_none(),
        "after round-trip, S1 should still be the default (visible) — no _sheetState; got {snap2}"
    );
}

#[test]
fn defaults_are_not_emitted() {
    // Regression: a workbook with no frozen panes and all-visible sheets must
    // round-trip cleanly — i.e. neither `_freezePane` nor `_sheetState` should
    // appear on any sheet in the snapshot. This guards against accidentally
    // materializing default fields on every sheet.
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("clean.xlsx");
    write_xlsx_fixture(
        &fixture,
        r#"<sheet name="S1" sheetId="1" r:id="rId1"/><sheet name="S2" sheetId="2" r:id="rId2"/>"#,
        r#"<sheetData/>"#,
        r#"<sheetData/>"#,
    );

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    for sid in ["sheet-1", "sheet-2"] {
        assert!(
            snap["sheets"][sid].get("_freezePane").is_none(),
            "{sid} has no frozen pane; _freezePane should be omitted, got {snap}"
        );
        assert!(
            snap["sheets"][sid].get("_sheetState").is_none(),
            "{sid} is visible; _sheetState should be omitted, got {snap}"
        );
    }
}

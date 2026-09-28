//! Tests for xlsx column-width + row-height conversion and round-trip.
//!
//! The snapshot handed to Univer stores sizes in pixels: `columnData[c].w`,
//! `rowData[r].h`, `defaultColumnWidth` and `defaultRowHeight`. The xlsx file
//! stores column widths in characters (ECMA-376 §18.3.1.13, max digit width
//! 7 px for Calibri 11) and row heights in points. Import converts to pixels,
//! export converts back.
//!
//! Fixtures are built by writing minimal xlsx zips directly (not via
//! rust_xlsxwriter) so the `width="N"` and `ht="N"` attributes appear
//! literally in the worksheet XML.

use nicel_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use serde_json::{json, Value};
use std::io::{Read, Write};
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

fn import_snapshot(path: &std::path::Path) -> (String, Value) {
    let result = import_xlsx_core(path_str(path)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");
    (snap_json, snap)
}

/// Returns the value of `attr` on the first `<tag ...>` element whose
/// attribute `key_attr` equals `key_value`, e.g. the `width` of
/// `<col min="2" ...>`.
fn attr_of(xml: &str, tag: &str, key_attr: &str, key_value: &str, attr: &str) -> Option<String> {
    let open = format!("<{tag} ");
    let key = format!("{key_attr}=\"{key_value}\"");
    let mut cursor = 0usize;
    while let Some(pos) = xml[cursor..].find(&open) {
        let start = cursor + pos;
        let end = start + xml[start..].find('>')?;
        let element = &xml[start..end];
        if element.contains(&key) {
            let needle = format!(" {attr}=\"");
            let s = element.find(&needle)? + needle.len();
            let e = element[s..].find('"')?;
            return Some(element[s..s + e].to_string());
        }
        cursor = end;
    }
    None
}

/// Returns the value of `attr` on the first `<tag ...>` element.
fn first_attr(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start = xml.find(&open)?;
    let end = start + xml[start..].find('>')?;
    let element = &xml[start..end];
    let needle = format!(" {attr}=\"");
    let s = element.find(&needle)? + needle.len();
    let e = element[s..].find('"')?;
    Some(element[s..s + e].to_string())
}

/// Minimal valid xlsx fixture with one sheet "S1". Lets the caller inject the
/// inner-<sheetData>-and-friends XML so each test can shape the worksheet to
/// taste.
fn write_xlsx_fixture(path: &std::path::Path, worksheet_inner: &str) {
    write_xlsx_fixture_with_parts(path, worksheet_inner, &[]);
}

/// Same as `write_xlsx_fixture` but also writes `extra_parts` (zip path,
/// content) verbatim — used to plant e.g. `xl/threadedComments/*` parts.
fn write_xlsx_fixture_with_parts(
    path: &std::path::Path,
    worksheet_inner: &str,
    extra_parts: &[(&str, &str)],
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

    for (name, content) in extra_parts {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }

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
fn column_width_is_converted_to_pixels_and_back() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("colwidth.xlsx");
    let exported = tmp.path().join("colwidth_exported.xlsx");

    // Column B (1-based: min=2 max=2 → 0-based index 1) with width=30
    // characters → floor(((256*30 + 18) / 256) * 7) = 210 px.
    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="2" max="2" width="30" customWidth="1"/></cols><sheetData/>"#,
    );

    let (snap_json, snap) = import_snapshot(&fixture);
    let col_data = &snap["sheets"]["sheet-1"]["columnData"];
    assert!(
        col_data.is_object(),
        "expected columnData object on sheet-1, got {snap}"
    );
    assert_eq!(
        col_data["1"]["w"].as_f64(),
        Some(210.0),
        "columnData[\"1\"].w should be 210 px, got {col_data}"
    );

    // Export and verify the xlsx records the original character width again.
    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert_eq!(
        attr_of(&xml, "col", "min", "2", "width").as_deref(),
        Some("30"),
        "exported column B should have width=\"30\", got: {xml}"
    );
    assert_eq!(
        attr_of(&xml, "col", "min", "2", "customWidth").as_deref(),
        Some("1"),
        "exported column B should be customWidth=\"1\", got: {xml}"
    );

    // Re-import and confirm the round-trip is still 210 px.
    let (_, snap2) = import_snapshot(&exported);
    assert_eq!(
        snap2["sheets"]["sheet-1"]["columnData"]["1"]["w"].as_f64(),
        Some(210.0),
        "after re-import, width should still be 210 px"
    );
}

#[test]
fn non_pixel_aligned_width_snaps_to_the_pixel_excel_draws() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("colwidth_frac.xlsx");
    let exported = tmp.path().join("colwidth_frac_exported.xlsx");

    // 10.5 characters is drawn by Excel as 73 px. On export the width is
    // written back as the character width of exactly 73 px.
    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="1" max="1" width="10.5" customWidth="1"/></cols><sheetData/>"#,
    );
    let (snap_json, snap) = import_snapshot(&fixture);
    assert_eq!(
        snap["sheets"]["sheet-1"]["columnData"]["0"]["w"].as_f64(),
        Some(73.0)
    );

    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);
    let xml = read_sheet1_xml(&exported);
    assert_eq!(
        attr_of(&xml, "col", "min", "1", "width").as_deref(),
        Some("10.42578125"),
        "73 px should be written as width=10.42578125, got: {xml}"
    );
    let (_, snap2) = import_snapshot(&exported);
    assert_eq!(
        snap2["sheets"]["sheet-1"]["columnData"]["0"]["w"].as_f64(),
        Some(73.0),
        "pixel width must be stable after one round-trip"
    );
}

#[test]
fn row_height_is_converted_to_pixels_and_back() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("rowheight.xlsx");
    let exported = tmp.path().join("rowheight_exported.xlsx");

    // Row 5 (0-based 4): 30 pt → 40 px. Row 7 (0-based 6): 18.75 pt → 25 px.
    write_xlsx_fixture(
        &fixture,
        r#"<sheetData><row r="5" ht="30" customHeight="1"/><row r="7" ht="18.75" customHeight="1"/></sheetData>"#,
    );

    let (snap_json, snap) = import_snapshot(&fixture);
    let row_data = &snap["sheets"]["sheet-1"]["rowData"];
    assert!(
        row_data.is_object(),
        "expected rowData object on sheet-1, got {snap}"
    );
    assert_eq!(row_data["4"]["h"].as_f64(), Some(40.0), "30 pt → 40 px");
    assert_eq!(row_data["6"]["h"].as_f64(), Some(25.0), "18.75 pt → 25 px");
    // customHeight rows must not be overridden by Univer's auto height.
    assert_eq!(row_data["4"]["ia"].as_i64(), Some(0));

    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert_eq!(
        attr_of(&xml, "row", "r", "5", "ht").as_deref(),
        Some("30"),
        "row 5 should be written back as ht=\"30\", got: {xml}"
    );
    assert_eq!(
        attr_of(&xml, "row", "r", "7", "ht").as_deref(),
        Some("18.75"),
        "row 7 should be written back as ht=\"18.75\", got: {xml}"
    );
    assert_eq!(
        attr_of(&xml, "row", "r", "5", "customHeight").as_deref(),
        Some("1"),
        "exported row should be customHeight=\"1\""
    );

    let (_, snap2) = import_snapshot(&exported);
    assert_eq!(
        snap2["sheets"]["sheet-1"]["rowData"]["4"]["h"].as_f64(),
        Some(40.0),
        "after re-import, height should still be 40 px"
    );
    assert_eq!(
        snap2["sheets"]["sheet-1"]["rowData"]["6"]["h"].as_f64(),
        Some(25.0),
        "after re-import, height should still be 25 px"
    );
}

#[test]
fn column_span_expands_to_multiple_indices() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("colspan.xlsx");

    // <col min=1 max=3 width=20 customWidth=1/> → columns 0, 1, 2 all 140 px.
    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="1" max="3" width="20" customWidth="1"/></cols><sheetData/>"#,
    );

    let (_, snap) = import_snapshot(&fixture);
    let col_data = &snap["sheets"]["sheet-1"]["columnData"];
    for c in ["0", "1", "2"] {
        assert_eq!(
            col_data[c]["w"].as_f64(),
            Some(140.0),
            "col {c} should be 140 px, got {col_data}"
        );
    }
    assert!(
        col_data.get("3").is_none(),
        "col 3 must NOT be populated, span was 1..=3"
    );
}

#[test]
fn no_custom_width_means_no_column_data_and_excel_defaults() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("default.xlsx");

    // <col> without customWidth="1" — default size, should be ignored. No
    // <sheetFormatPr>, so the sheet defaults are Excel's 64 px / 20 px.
    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="1" max="3" width="8.43"/></cols><sheetData/>"#,
    );

    let (_, snap) = import_snapshot(&fixture);
    let sheet = &snap["sheets"]["sheet-1"];
    assert!(
        sheet.get("columnData").is_none(),
        "columnData should be absent for a sheet with no customWidth columns, got {sheet}"
    );
    assert!(
        sheet.get("rowData").is_none(),
        "rowData should be absent when there are no customHeight rows, got {sheet}"
    );
    assert_eq!(sheet["defaultColumnWidth"].as_f64(), Some(64.0));
    assert_eq!(sheet["defaultRowHeight"].as_f64(), Some(20.0));
}

#[test]
fn sheet_format_pr_defaults_land_in_snapshot() {
    let tmp = TempDir::new().expect("tempdir");

    // Explicit defaultColWidth (character width incl. padding) + a Japanese
    // Excel style default row height of 18.75 pt.
    let explicit = tmp.path().join("fmt_explicit.xlsx");
    write_xlsx_fixture(
        &explicit,
        r#"<sheetFormatPr defaultColWidth="10.7109375" defaultRowHeight="18.75"/><sheetData/>"#,
    );
    let (_, snap) = import_snapshot(&explicit);
    let sheet = &snap["sheets"]["sheet-1"];
    assert_eq!(sheet["defaultColumnWidth"].as_f64(), Some(75.0));
    assert_eq!(sheet["defaultRowHeight"].as_f64(), Some(25.0));

    // Only baseColWidth (8 characters, Excel's default) → 64 px.
    let base = tmp.path().join("fmt_base.xlsx");
    write_xlsx_fixture(
        &base,
        r#"<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><sheetData/>"#,
    );
    let (_, snap) = import_snapshot(&base);
    let sheet = &snap["sheets"]["sheet-1"];
    assert_eq!(sheet["defaultColumnWidth"].as_f64(), Some(64.0));
    assert_eq!(sheet["defaultRowHeight"].as_f64(), Some(20.0));
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

    let (_, snap) = import_snapshot(&fixture);
    let row_data = &snap["sheets"]["sheet-1"]["rowData"];
    assert!(
        row_data.get("1").is_none(),
        "row 1 (=row r=2, no customHeight) must NOT be in rowData"
    );
    assert_eq!(
        row_data["2"]["h"].as_f64(),
        Some(33.0),
        "row 2 (=row r=3, customHeight=1, 25 pt) should be present at 33 px"
    );
}

#[test]
fn pixel_sizes_set_in_nicel_are_written_as_excel_units() {
    let tmp = TempDir::new().expect("tempdir");
    let exported = tmp.path().join("nicel_px.xlsx");

    // A column the user dragged to 120 px and a row dragged to 40 px.
    let snap = json!({
        "id": "wb",
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "id": "s1",
                "name": "S1",
                "cellData": { "0": { "0": { "v": "x" } } },
                "columnData": { "1": { "w": 120 } },
                "rowData": { "2": { "h": 40 } },
                "defaultColumnWidth": 64,
                "defaultRowHeight": 20
            }
        }
    });
    let export = export_xlsx_core(path_str(&exported), snap.to_string()).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    // 120 px = 16.43 characters in Excel's column-width dialog; the stored
    // `width` attribute adds the 5 px cell padding: (16.43*7 + 5)/7 → 17.140625.
    assert_eq!(
        attr_of(&xml, "col", "min", "2", "width").as_deref(),
        Some("17.140625"),
        "120 px should be written as width=17.140625, got: {xml}"
    );
    assert_eq!(
        attr_of(&xml, "row", "r", "3", "ht").as_deref(),
        Some("30"),
        "40 px should be written as ht=30, got: {xml}"
    );

    // Opening the file again yields the same pixels.
    let (_, snap2) = import_snapshot(&exported);
    assert_eq!(
        snap2["sheets"]["sheet-1"]["columnData"]["1"]["w"].as_f64(),
        Some(120.0)
    );
    assert_eq!(
        snap2["sheets"]["sheet-1"]["rowData"]["2"]["h"].as_f64(),
        Some(40.0)
    );
}

#[test]
fn default_row_height_is_exported_in_points() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("default_row.xlsx");
    let exported = tmp.path().join("default_row_exported.xlsx");

    write_xlsx_fixture(
        &fixture,
        r#"<sheetFormatPr defaultRowHeight="18.75"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData>"#,
    );
    let (snap_json, snap) = import_snapshot(&fixture);
    assert_eq!(
        snap["sheets"]["sheet-1"]["defaultRowHeight"].as_f64(),
        Some(25.0)
    );

    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);
    let xml = read_sheet1_xml(&exported);
    assert_eq!(
        first_attr(&xml, "sheetFormatPr", "defaultRowHeight").as_deref(),
        Some("18.75"),
        "sheet default row height should be 18.75 pt, got: {xml}"
    );

    let (_, snap2) = import_snapshot(&exported);
    assert_eq!(
        snap2["sheets"]["sheet-1"]["defaultRowHeight"].as_f64(),
        Some(25.0)
    );
}

#[test]
fn hidden_columns_and_rows_round_trip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("hidden.xlsx");
    let exported = tmp.path().join("hidden_exported.xlsx");

    write_xlsx_fixture(
        &fixture,
        r#"<cols><col min="3" max="3" width="12.7109375" hidden="1" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row><row r="4" hidden="1"/></sheetData>"#,
    );

    let (snap_json, snap) = import_snapshot(&fixture);
    let sheet = &snap["sheets"]["sheet-1"];
    assert_eq!(sheet["columnData"]["2"]["hd"].as_i64(), Some(1));
    assert_eq!(sheet["columnData"]["2"]["w"].as_f64(), Some(89.0));
    assert_eq!(sheet["rowData"]["3"]["hd"].as_i64(), Some(1));
    assert!(
        sheet["rowData"]["3"].get("h").is_none(),
        "a hidden row without customHeight carries no height"
    );

    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);
    let xml = read_sheet1_xml(&exported);
    assert_eq!(
        attr_of(&xml, "col", "min", "3", "hidden").as_deref(),
        Some("1"),
        "column C should stay hidden, got: {xml}"
    );
    assert_eq!(
        attr_of(&xml, "row", "r", "4", "hidden").as_deref(),
        Some("1"),
        "row 4 should stay hidden, got: {xml}"
    );

    let (_, snap2) = import_snapshot(&exported);
    let sheet2 = &snap2["sheets"]["sheet-1"];
    assert_eq!(sheet2["columnData"]["2"]["hd"].as_i64(), Some(1));
    assert_eq!(sheet2["columnData"]["2"]["w"].as_f64(), Some(89.0));
    assert_eq!(sheet2["rowData"]["3"]["hd"].as_i64(), Some(1));
}

#[test]
fn threaded_comments_warning_only_when_parts_exist() {
    let tmp = TempDir::new().expect("tempdir");

    let plain = tmp.path().join("plain.xlsx");
    write_xlsx_fixture(&plain, "<sheetData/>");
    let result = import_xlsx_core(path_str(&plain)).expect("import plain");
    assert!(
        !result
            .warnings
            .iter()
            .any(|w| w.code == "XLSX_THREADED_COMMENTS_FLATTENED"),
        "plain file must not warn about threaded comments: {:?}",
        result.warnings
    );
    assert_eq!(
        result
            .warnings
            .iter()
            .filter(|w| w.severity == "info")
            .count(),
        0,
        "plain file must not produce any info banner: {:?}",
        result.warnings
    );
    assert!(
        !result.warnings.iter().any(|w| w.code == "XLSX_POC_IMPORT"),
        "the unconditional PoC banner is gone"
    );

    let threaded = tmp.path().join("threaded.xlsx");
    write_xlsx_fixture_with_parts(
        &threaded,
        "<sheetData/>",
        &[(
            "xl/threadedComments/threadedComment1.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"/>"#,
        )],
    );
    let result = import_xlsx_core(path_str(&threaded)).expect("import threaded");
    let warning = result
        .warnings
        .iter()
        .find(|w| w.code == "XLSX_THREADED_COMMENTS_FLATTENED")
        .expect("threaded-comment warning present");
    assert_eq!(warning.severity, "warning");
    assert!(
        warning.message.contains("スレッド形式のコメント"),
        "message should be the Japanese notice, got {}",
        warning.message
    );
}

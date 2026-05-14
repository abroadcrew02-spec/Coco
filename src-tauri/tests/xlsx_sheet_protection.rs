//! Tests for xlsx sheet-protection (`<sheetProtection sheet="1"/>`) round-trip
//! preservation. Mirrors the structure of `xlsx_panes_visibility.rs`: build a
//! minimal xlsx by hand, import it, assert the snapshot carries `_protected`,
//! then re-export and verify the resulting `xl/worksheets/sheet1.xml` still
//! contains `<sheetProtection sheet="1"/>`.

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use serde_json::Value;
use std::io::{Read, Write};
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Minimal xlsx fixture with a single sheet "S1" whose inner XML is supplied
/// by the caller — so `<sheetProtection.../>` can be dropped in directly.
fn write_xlsx_fixture(path: &std::path::Path, sheet1_inner: &str) {
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
    let xml1 = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{sheet1_inner}</worksheet>"#
    );
    zip.write_all(xml1.as_bytes()).unwrap();

    zip.finish().expect("finalize fixture zip");
}

fn read_entry(path: &std::path::Path, entry: &str) -> String {
    let f = std::fs::File::open(path).expect("open exported");
    let mut archive = zip::ZipArchive::new(f).expect("read zip");
    let mut e = archive.by_name(entry).expect("entry present");
    let mut s = String::new();
    e.read_to_string(&mut s).expect("read entry");
    s
}

#[test]
fn protected_sheet_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("protected.xlsx");
    let exported = tmp.path().join("protected_exported.xlsx");

    // A worksheet with `<sheetProtection sheet="1"/>` — the bare on-off form
    // Excel writes when "Protect Sheet" is invoked with no password.
    let sheet1_inner =
        r#"<sheetData/><sheetProtection sheet="1" objects="false" scenarios="false"/>"#;
    write_xlsx_fixture(&fixture, sheet1_inner);

    // Import → snapshot should expose `_protected.protected: true`.
    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    let prot = &snap["sheets"]["sheet-1"]["_protected"];
    assert!(
        prot.is_object(),
        "expected _protected on sheet-1, got {snap}"
    );
    assert_eq!(prot["protected"].as_bool(), Some(true));

    // Export → confirm the re-emitted sheet1.xml still records the protection.
    let export = export_xlsx_core(path_str(&exported), snap_json).expect("export");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let xml = read_entry(&exported, "xl/worksheets/sheet1.xml");
    assert!(
        xml.contains("<sheetProtection"),
        "exported sheet1.xml should record <sheetProtection>; got:\n{xml}"
    );
    assert!(
        xml.contains("sheet=\"1\"") || xml.contains("sheet=\"true\""),
        "exported sheet1.xml should mark sheet=\"1\"; got:\n{xml}"
    );

    // Re-import to confirm the round-trip is stable end-to-end.
    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value =
        serde_json::from_str(&result2.handle.snapshot_json.unwrap()).expect("parse re-snap");
    assert_eq!(
        snap2["sheets"]["sheet-1"]["_protected"]["protected"].as_bool(),
        Some(true),
        "after round-trip, protected flag should remain true; got {snap2}"
    );
}

#[test]
fn unprotected_sheet_omits_field() {
    // Regression: a workbook with no `<sheetProtection>` element must NOT
    // gain a `_protected` field on import — otherwise every round-trip would
    // materialize the marker on every sheet.
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("clean.xlsx");

    write_xlsx_fixture(&fixture, r#"<sheetData/>"#);

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap_json = result.handle.snapshot_json.expect("snapshot");
    let snap: Value = serde_json::from_str(&snap_json).expect("parse snap");

    assert!(
        snap["sheets"]["sheet-1"].get("_protected").is_none(),
        "sheet-1 has no <sheetProtection>; _protected should be omitted, got {snap}"
    );
}

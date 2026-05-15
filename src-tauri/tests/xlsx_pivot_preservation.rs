//! Round-trip test for pivot-table "blob-level" preservation. Verifies that
//! a source xlsx with pivot-table parts survives import → export with the
//! pivot bytes intact in the output zip.
//!
//! rust_xlsxwriter doesn't expose a pivot-table API, so we hand-craft a
//! fixture by writing a plain xlsx with rust_xlsxwriter and splicing in
//! pivotTable + pivotCache parts plus a worksheet rel pointing at the pivot.
//! After round-tripping through Coco's xlsx_io we re-open the output zip and
//! assert the pivot part still exists and matches.

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

/// Minimal pivotTable XML — opaque bytes from the preservation pipeline's
/// perspective. Not a pivot Excel will render, but the round-trip operates on
/// raw bytes so contents don't matter as long as they survive verbatim.
const PIVOT_TABLE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                      name="PivotTable1" cacheId="1" applyNumberFormats="0"
                      applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0"
                      applyAlignmentFormats="0" applyWidthHeightFormats="1"
                      dataCaption="Values" updatedVersion="6" minRefreshableVersion="3"
                      useAutoFormatting="1" itemPrintTitles="1" createdVersion="6"
                      indent="0" outline="1" outlineData="1" multipleFieldFilters="0">
  <location ref="A1:B2" firstHeaderRow="0" firstDataRow="1" firstDataCol="1"/>
</pivotTableDefinition>"#;

const PIVOT_CACHE_DEF_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                      r:id="rId1" refreshedBy="Coco" recordCount="0"/>"#;

const PIVOT_CACHE_REC_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pivotCacheRecords xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0"/>"#;

const SHEET_RELS_WITH_PIVOT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdPivot1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/>
</Relationships>"#;

const PIVOT_TABLE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/>
</Relationships>"#;

/// Build a fixture xlsx with pivot-table parts spliced in.
fn build_pivot_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain.xlsx");
    let fixture_path = tmp.path().join("with_pivot.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Data").unwrap();
        ws.write_string(0, 0, "Region").unwrap();
        ws.write_string(0, 1, "Amount").unwrap();
        ws.write_string(1, 0, "North").unwrap();
        ws.write_number(1, 1, 100.0).unwrap();
        ws.write_string(2, 0, "South").unwrap();
        ws.write_number(2, 1, 200.0).unwrap();
        wb.save(&plain_path).unwrap();
    }

    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let rewrites: &[&str] = &["[Content_Types].xml"];

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

    // Patched [Content_Types].xml: register pivot parts.
    let mut ct_xml = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct_xml)
        .unwrap();
    let close = ct_xml.rfind("</Types>").unwrap();
    let mut patched_ct = String::new();
    patched_ct.push_str(&ct_xml[..close]);
    patched_ct.push_str(
        r#"<Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>"#,
    );
    patched_ct.push_str(
        r#"<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>"#,
    );
    patched_ct.push_str(
        r#"<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>"#,
    );
    patched_ct.push_str(&ct_xml[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(patched_ct.as_bytes()).unwrap();

    // New parts: pivotTable, pivotCacheDefinition, pivotCacheRecords + their rels.
    out.start_file("xl/pivotTables/pivotTable1.xml", opts)
        .unwrap();
    out.write_all(PIVOT_TABLE_XML.as_bytes()).unwrap();

    out.start_file("xl/pivotTables/_rels/pivotTable1.xml.rels", opts)
        .unwrap();
    out.write_all(PIVOT_TABLE_RELS.as_bytes()).unwrap();

    out.start_file("xl/pivotCache/pivotCacheDefinition1.xml", opts)
        .unwrap();
    out.write_all(PIVOT_CACHE_DEF_XML.as_bytes()).unwrap();

    out.start_file("xl/pivotCache/pivotCacheRecords1.xml", opts)
        .unwrap();
    out.write_all(PIVOT_CACHE_REC_XML.as_bytes()).unwrap();

    // Sheet rels pointing at the pivot table.
    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(SHEET_RELS_WITH_PIVOT.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

#[test]
fn pivot_blob_survives_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_pivot_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    // Import: snapshot should carry `_preservedParts` with the pivot blobs.
    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).expect("parse snapshot");
    let preserved = snapshot
        .get("_preservedParts")
        .expect("_preservedParts should be on snapshot");
    let parts = preserved
        .get("parts")
        .and_then(|v| v.as_object())
        .expect("parts object");
    assert!(
        parts.contains_key("xl/pivotTables/pivotTable1.xml"),
        "pivot table should be preserved in snapshot, got keys: {:?}",
        parts.keys().collect::<Vec<_>>()
    );
    assert!(
        parts.contains_key("xl/pivotCache/pivotCacheDefinition1.xml"),
        "pivot cache definition should be preserved in snapshot"
    );

    // The sheet's pivot rel should be captured under `sheetRefs`.
    let sheet_refs = preserved
        .get("sheetRefs")
        .and_then(|v| v.as_array())
        .expect("sheetRefs array");
    let pivot_rels = sheet_refs
        .first()
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("pivotRels"))
        .and_then(|v| v.as_array())
        .expect("first sheet should have pivotRels");
    assert!(
        !pivot_rels.is_empty(),
        "first sheet should have at least one pivot relationship"
    );

    // Export. The output must still carry the pivot bytes.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");
    let mut pivot_bytes = Vec::new();
    out_zip
        .by_name("xl/pivotTables/pivotTable1.xml")
        .expect("pivot table part must exist in output zip")
        .read_to_end(&mut pivot_bytes)
        .unwrap();
    assert_eq!(
        pivot_bytes,
        PIVOT_TABLE_XML.as_bytes(),
        "pivot table bytes should round-trip verbatim"
    );

    // Cache definition should also be preserved.
    let mut cache_def_bytes = Vec::new();
    out_zip
        .by_name("xl/pivotCache/pivotCacheDefinition1.xml")
        .expect("pivot cache definition must exist in output zip")
        .read_to_end(&mut cache_def_bytes)
        .unwrap();
    assert_eq!(cache_def_bytes, PIVOT_CACHE_DEF_XML.as_bytes());

    // The sheet rels file should reference the pivot table.
    let mut rels_bytes = Vec::new();
    out_zip
        .by_name("xl/worksheets/_rels/sheet1.xml.rels")
        .expect("sheet1 rels must exist in output zip")
        .read_to_end(&mut rels_bytes)
        .unwrap();
    let rels_str = String::from_utf8_lossy(&rels_bytes);
    assert!(
        rels_str.contains("/pivotTable"),
        "sheet1 rels should contain a pivotTable relationship: {}",
        rels_str
    );
    assert!(
        rels_str.contains("../pivotTables/pivotTable1.xml"),
        "sheet1 rels should target the preserved pivot table part: {}",
        rels_str
    );
}

#[test]
fn no_pivot_means_no_preservation_noise() {
    // Regression: a workbook with NO pivot parts must round-trip cleanly with
    // no pivot entries leaking into the snapshot or the output zip.
    let tmp = TempDir::new().unwrap();
    let plain_path = tmp.path().join("plain.xlsx");
    let exported = tmp.path().join("out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Plain").unwrap();
        ws.write_string(0, 0, "hello").unwrap();
        wb.save(&plain_path).unwrap();
    }

    let import = import_xlsx_core(path_str(&plain_path)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).expect("parse snapshot");
    // Either no _preservedParts, or its parts map has no pivot keys.
    if let Some(preserved) = snapshot.get("_preservedParts") {
        if let Some(parts) = preserved.get("parts").and_then(|v| v.as_object()) {
            assert!(
                parts
                    .keys()
                    .all(|k| !k.starts_with("xl/pivotTables/") && !k.starts_with("xl/pivotCache/")),
                "plain workbook should not preserve pivot entries: {:?}",
                parts.keys().collect::<Vec<_>>()
            );
        }
    }

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success);
    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");
    for i in 0..out_zip.len() {
        let entry = out_zip.by_index(i).expect("entry");
        let name = entry.name();
        assert!(
            !name.starts_with("xl/pivotTables/") && !name.starts_with("xl/pivotCache/"),
            "plain workbook should not emit pivot parts, got: {}",
            name
        );
    }
}

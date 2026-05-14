//! Round-trip test for external-link "blob-level" preservation. Verifies
//! that a source xlsx with `xl/externalLinks/*` parts survives import →
//! export with the link bytes intact in the output zip and the cached value
//! cell unchanged. Per req 5.3.2, Coco never auto-fetches the external
//! workbook — only the structure + cached values are preserved.
//!
//! rust_xlsxwriter has no external-link API, so we hand-craft a fixture by
//! writing a plain xlsx with rust_xlsxwriter and splicing in an externalLink
//! part plus the workbook-level rels and `<externalReferences>` wiring.

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

/// Minimal externalLink XML — describes one referenced book ("Other.xlsx")
/// with one cached value. Opaque bytes from the preservation pipeline's
/// perspective; what matters is that they survive verbatim.
const EXTERNAL_LINK_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <externalBook r:id="rId1">
    <sheetNames><sheetName val="Sheet1"/></sheetNames>
    <sheetDataSet>
      <sheetData sheetId="0">
        <row r="1"><cell r="A1"><v>42</v></cell></row>
      </sheetData>
    </sheetDataSet>
  </externalBook>
</externalLink>"#;

const EXTERNAL_LINK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="Other.xlsx" TargetMode="External"/>
</Relationships>"#;

/// Build a fixture xlsx with an external link spliced in. We patch:
///   - `[Content_Types].xml` → add externalLink override
///   - `xl/_rels/workbook.xml.rels` → add externalLink rel
///   - `xl/workbook.xml` → add `<externalReferences>` block
///   - new `xl/externalLinks/externalLink1.xml` + its rels
fn build_external_link_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain.xlsx");
    let fixture_path = tmp.path().join("with_extlink.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Main").unwrap();
        ws.write_string(0, 0, "Cached").unwrap();
        // The "cached value" of an external formula. A real xlsx would store
        // `<c><f>[1]Sheet1!A1</f><v>42</v></c>` — for this fixture we just
        // confirm a plain numeric value survives the round-trip.
        ws.write_number(0, 1, 42.0).unwrap();
        wb.save(&plain_path).unwrap();
    }

    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let rewrites: &[&str] = &[
        "[Content_Types].xml",
        "xl/_rels/workbook.xml.rels",
        "xl/workbook.xml",
    ];

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

    // Patched [Content_Types].xml.
    let mut ct_xml = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct_xml)
        .unwrap();
    let close = ct_xml.rfind("</Types>").unwrap();
    let mut patched_ct = String::new();
    patched_ct.push_str(&ct_xml[..close]);
    patched_ct.push_str(
        r#"<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/>"#,
    );
    patched_ct.push_str(&ct_xml[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(patched_ct.as_bytes()).unwrap();

    // Patched xl/_rels/workbook.xml.rels.
    let mut rels_xml = String::new();
    src.by_name("xl/_rels/workbook.xml.rels")
        .unwrap()
        .read_to_string(&mut rels_xml)
        .unwrap();
    let close = rels_xml.rfind("</Relationships>").unwrap();
    let mut patched_rels = String::new();
    patched_rels.push_str(&rels_xml[..close]);
    patched_rels.push_str(
        r#"<Relationship Id="rIdExt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/>"#,
    );
    patched_rels.push_str(&rels_xml[close..]);
    out.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
    out.write_all(patched_rels.as_bytes()).unwrap();

    // Patched xl/workbook.xml: insert `<externalReferences>` before `</workbook>`.
    let mut wb_xml = String::new();
    src.by_name("xl/workbook.xml")
        .unwrap()
        .read_to_string(&mut wb_xml)
        .unwrap();
    let close = wb_xml.rfind("</workbook>").unwrap();
    let mut patched_wb = String::new();
    patched_wb.push_str(&wb_xml[..close]);
    patched_wb.push_str(
        r#"<externalReferences><externalReference r:id="rIdExt1"/></externalReferences>"#,
    );
    patched_wb.push_str(&wb_xml[close..]);
    out.start_file("xl/workbook.xml", opts).unwrap();
    out.write_all(patched_wb.as_bytes()).unwrap();

    // New parts: externalLink + its rels.
    out.start_file("xl/externalLinks/externalLink1.xml", opts)
        .unwrap();
    out.write_all(EXTERNAL_LINK_XML.as_bytes()).unwrap();

    out.start_file("xl/externalLinks/_rels/externalLink1.xml.rels", opts)
        .unwrap();
    out.write_all(EXTERNAL_LINK_RELS.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

#[test]
fn external_link_blob_and_cached_value_survive_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_external_link_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    // Import: snapshot should carry `_preservedParts` with the external-link
    // blob plus the workbook-level rels/references metadata.
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
        parts.contains_key("xl/externalLinks/externalLink1.xml"),
        "external link blob should be preserved in snapshot, got keys: {:?}",
        parts.keys().collect::<Vec<_>>()
    );
    let ext_rels = preserved
        .get("workbookExternalLinkRels")
        .and_then(|v| v.as_array())
        .expect("workbookExternalLinkRels should be captured");
    assert_eq!(
        ext_rels.len(),
        1,
        "expected one external-link rel, got {:?}",
        ext_rels
    );
    let ext_refs = preserved
        .get("workbookExternalReferences")
        .and_then(|v| v.as_str())
        .expect("workbookExternalReferences should be captured");
    assert!(
        ext_refs.contains("rIdExt1"),
        "captured externalReferences block should reference rIdExt1: {}",
        ext_refs
    );

    // Export.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");

    // 1. The externalLink blob must survive verbatim.
    let mut ext_bytes = Vec::new();
    out_zip
        .by_name("xl/externalLinks/externalLink1.xml")
        .expect("external link part must exist in output zip")
        .read_to_end(&mut ext_bytes)
        .unwrap();
    assert_eq!(
        ext_bytes,
        EXTERNAL_LINK_XML.as_bytes(),
        "external link bytes should round-trip verbatim"
    );

    // 2. workbook.xml.rels must reference the externalLink.
    let mut rels_bytes = Vec::new();
    out_zip
        .by_name("xl/_rels/workbook.xml.rels")
        .expect("workbook rels must exist")
        .read_to_end(&mut rels_bytes)
        .unwrap();
    let rels_str = String::from_utf8_lossy(&rels_bytes);
    assert!(
        rels_str.contains("/externalLink"),
        "workbook rels should keep externalLink relationship: {}",
        rels_str
    );
    assert!(
        rels_str.contains("externalLinks/externalLink1.xml"),
        "workbook rels should target the preserved externalLink part: {}",
        rels_str
    );

    // 3. workbook.xml must carry the `<externalReferences>` wiring.
    let mut wb_bytes = Vec::new();
    out_zip
        .by_name("xl/workbook.xml")
        .expect("workbook.xml must exist")
        .read_to_end(&mut wb_bytes)
        .unwrap();
    let wb_str = String::from_utf8_lossy(&wb_bytes);
    assert!(
        wb_str.contains("<externalReferences"),
        "workbook.xml should contain <externalReferences> block: {}",
        wb_str
    );
    assert!(
        wb_str.contains("rIdExt1"),
        "workbook.xml should reference rIdExt1: {}",
        wb_str
    );

    // 4. Cached value cell (B1 = 42) must be preserved.
    //    We re-import the exported file and check the snapshot.
    let reimport = import_xlsx_core(path_str(&exported)).expect("reimport ok");
    let reimported_json = reimport.handle.snapshot_json.expect("snapshot present");
    let reimported: serde_json::Value =
        serde_json::from_str(&reimported_json).expect("parse reimported");
    // Locate the Main sheet's cell map and check B1 = 42 (row 0, col 1).
    // Cells live under sheets.{id}.cellData["0"]["1"].v in the snapshot.
    let sheets = reimported
        .get("sheets")
        .and_then(|v| v.as_object())
        .expect("sheets object");
    let mut found = false;
    for sheet in sheets.values() {
        let name = sheet.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name != "Main" {
            continue;
        }
        let cell = sheet
            .get("cellData")
            .and_then(|v| v.get("0"))
            .and_then(|v| v.get("1"));
        let v = cell.and_then(|c| c.get("v"));
        // Univer stores numbers either as Number or String; accept both.
        let matches = match v {
            Some(serde_json::Value::Number(n)) => n.as_f64() == Some(42.0),
            Some(serde_json::Value::String(s)) => s == "42",
            _ => false,
        };
        assert!(matches, "B1 cached value should be 42, got {:?}", cell);
        found = true;
        break;
    }
    assert!(found, "Main sheet should be present in re-imported workbook");
}

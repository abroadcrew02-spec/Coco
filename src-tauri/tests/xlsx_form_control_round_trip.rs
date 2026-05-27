//! Round-trip test for form-control "blob-level" preservation (#194).
//!
//! Excel stores form controls across three zip entries:
//!   - xl/ctrlProps/ctrlPropN.xml      (control properties / linked cell)
//!   - xl/drawings/vmlDrawingN.vml     (VML shape / visual decorations)
//!   - xl/worksheets/_rels/sheetN.xml.rels  (relationships stitching them in)
//!
//! Coco cannot yet author these parts natively, but the byte-preserve pipeline
//! (PRESERVED_PREFIXES in xlsx_io.rs) captures them verbatim on import and
//! reinjerts them on export.  This test file pins that behaviour so a future
//! regression is caught immediately.
//!
//! Strategy: hand-craft a minimal xlsx fixture that contains the three entry
//! types above (no real Excel needed), round-trip it through import_xlsx_core →
//! export_xlsx_core, then re-open the output zip and assert byte equality.

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

// ---------------------------------------------------------------------------
// Minimal XML bodies — content is intentionally trivial; the preservation
// pipeline operates on opaque bytes so correctness of the XML is irrelevant.
// ---------------------------------------------------------------------------

/// xl/ctrlProps/ctrlProp1.xml — form control properties (linked cell, type).
const CTRL_PROP_XML: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<formControlPr xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
               objectType="CheckBox" checked="Unchecked" fmlaLink="Sheet1!$B$1"
               lockText="1" defaultSize="0"/>
"#;

/// xl/drawings/vmlDrawing1.vml — VML shape for the checkbox.
/// NOTE: CSS colon-values like `position:absolute` prevent using a plain str
/// literal in Rust 2021; we use a byte-string literal instead.
const VML_DRAWING_XML: &[u8] = b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<xml xmlns:v=\"urn:schemas-microsoft-com:vml\"\n\
     xmlns:o=\"urn:schemas-microsoft-com:office:office\"\n\
     xmlns:x=\"urn:schemas-microsoft-com:office:excel\">\n\
  <v:shape id=\"_x0000_s1025\" type=\"#_x0000_t201\"\n\
           style=\"position:absolute;margin-left:53.25pt;margin-top:12.75pt;\
width:108pt;height:14.25pt;z-index:1\"\n\
           filled=\"f\" stroked=\"f\">\n\
    <v:path shadowok=\"f\" o:connecttype=\"none\"/>\n\
    <v:textbox><div style=\"text-align:left\"/></v:textbox>\n\
    <x:ClientData ObjectType=\"Checkbox\">\n\
      <x:Anchor>1, 15, 0, 2, 3, 15, 1, 7</x:Anchor>\n\
      <x:PrintObject/>\n\
      <x:AutoFill>False</x:AutoFill>\n\
      <x:FmlaMacro/>\n\
    </x:ClientData>\n\
  </v:shape>\n\
</xml>\n";

/// xl/drawings/_rels/vmlDrawing1.vml.rels — drawing → ctrlProp relationship.
const VML_DRAWING_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1"
  Type="http://schemas.microsoft.com/office/2006/relationships/ctrlProp"
  Target="../ctrlProps/ctrlProp1.xml"/>
</Relationships>
"#;

/// xl/worksheets/_rels/sheet1.xml.rels — sheet → vmlDrawing relationship.
const SHEET_RELS_WITH_VML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1"
  Type="http://schemas.microsoft.com/office/2006/relationships/vmlDrawing"
  Target="../drawings/vmlDrawing1.vml"/>
</Relationships>
"#;

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/// Build a minimal xlsx that contains form-control blob entries.
///
/// Steps:
/// 1. Generate a plain workbook via rust_xlsxwriter (1 sheet, 2 cells).
/// 2. Re-zip it, splicing in the ctrlProp, vmlDrawing, and their _rels.
/// 3. Patch [Content_Types].xml with the matching Override entries.
///
/// The worksheet body does NOT need a `<legacyDrawing>` element for our
/// purposes — the preservation pipeline harvests parts by prefix, not by
/// walking the worksheet XML.  The linked-cell value (B1) is written as a
/// normal cell so the linked-value round-trip assertion can also be checked.
fn build_form_control_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain.xlsx");
    let fixture_path = tmp.path().join("with_form_control.xlsx");

    // 1. Plain workbook: Sheet1 with a label in A1 and the linked bool in B1.
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "Agreed?").unwrap();
        // Linked cell value — FALSE means checkbox is unchecked.
        ws.write_boolean(0, 1, false).unwrap();
        wb.save(&plain_path).unwrap();
    }

    // 2. Re-zip with form-control parts spliced in.
    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Entries we will rewrite rather than copy verbatim.
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

    // Inject form-control blobs.
    out.start_file("xl/ctrlProps/ctrlProp1.xml", opts).unwrap();
    out.write_all(CTRL_PROP_XML).unwrap();

    out.start_file("xl/drawings/vmlDrawing1.vml", opts).unwrap();
    out.write_all(VML_DRAWING_XML).unwrap();

    out.start_file("xl/drawings/_rels/vmlDrawing1.vml.rels", opts)
        .unwrap();
    out.write_all(VML_DRAWING_RELS.as_bytes()).unwrap();

    // Sheet rels: skip any existing one emitted by rust_xlsxwriter (none
    // expected for a plain workbook) and write ours.
    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(SHEET_RELS_WITH_VML.as_bytes()).unwrap();

    // Patch [Content_Types].xml: add Override entries for the new parts.
    let mut ct_xml = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct_xml)
        .unwrap();
    let close = ct_xml.rfind("</Types>").unwrap();
    let mut patched_ct = String::new();
    patched_ct.push_str(&ct_xml[..close]);
    patched_ct.push_str(
        r#"<Override PartName="/xl/ctrlProps/ctrlProp1.xml" ContentType="application/vnd.ms-excel.controlproperties+xml"/>"#,
    );
    patched_ct.push_str(
        r#"<Override PartName="/xl/drawings/vmlDrawing1.vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>"#,
    );
    patched_ct.push_str(&ct_xml[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(patched_ct.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Core assertion helper: read a named zip entry and return its bytes.
fn zip_entry_bytes(archive: &mut ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    archive
        .by_name(name)
        .unwrap_or_else(|_| panic!("expected zip entry '{name}' not found"))
        .read_to_end(&mut buf)
        .unwrap();
    buf
}

/// ctrlProp1.xml survives import → export byte-for-byte.
#[test]
fn ctrl_prop_xml_survives_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_form_control_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    // 1. ctrlProp must appear in the snapshot's preserved parts.
    let parts = snapshot["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        parts.contains_key("xl/ctrlProps/ctrlProp1.xml"),
        "ctrlProp1.xml should be in _preservedParts, got keys: {:?}",
        parts.keys().collect::<Vec<_>>()
    );

    // 2. Export and verify byte equality.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");
    let actual = zip_entry_bytes(&mut out_zip, "xl/ctrlProps/ctrlProp1.xml");
    assert_eq!(
        actual,
        CTRL_PROP_XML,
        "ctrlProp1.xml bytes must survive round-trip verbatim"
    );
}

/// vmlDrawing1.vml survives import → export byte-for-byte.
#[test]
fn vml_drawing_survives_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_form_control_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let parts = snapshot["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        parts.contains_key("xl/drawings/vmlDrawing1.vml"),
        "vmlDrawing1.vml should be in _preservedParts"
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed");

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");
    let actual = zip_entry_bytes(&mut out_zip, "xl/drawings/vmlDrawing1.vml");
    assert_eq!(
        actual,
        VML_DRAWING_XML,
        "vmlDrawing1.vml bytes must survive round-trip verbatim"
    );
}

/// vmlDrawing _rels entry survives import → export byte-for-byte.
#[test]
fn vml_drawing_rels_survives_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_form_control_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let parts = snapshot["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        parts.contains_key("xl/drawings/_rels/vmlDrawing1.vml.rels"),
        "vmlDrawing rels should be in _preservedParts"
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed");

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");
    let actual = zip_entry_bytes(&mut out_zip, "xl/drawings/_rels/vmlDrawing1.vml.rels");
    assert_eq!(
        actual,
        VML_DRAWING_RELS.as_bytes(),
        "vmlDrawing rels must survive round-trip verbatim"
    );
}

/// The vmlDrawing _rels entry (xl/drawings/_rels/vmlDrawing1.vml.rels) is
/// captured in `_preservedParts.parts` on import. The per-sheet sheetN.xml.rels
/// is NOT stored in parts — it is managed separately via the sheetRefs /
/// inject pipeline and is only rewritten when a `<drawing>` (not `<legacyDrawing>`)
/// relationship is present.  This test pins the snapshot-side behaviour.
#[test]
fn vml_drawing_rels_in_preserved_parts_snapshot() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_form_control_fixture(&tmp);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let parts = snapshot["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        parts.contains_key("xl/drawings/_rels/vmlDrawing1.vml.rels"),
        "vmlDrawing rels must be captured in _preservedParts.parts on import, \
         got keys: {:?}",
        parts.keys().collect::<Vec<_>>()
    );
}

/// Both form-control blob entries appear simultaneously in one round-trip.
/// This exercises the case where multiple preserved parts co-exist.
#[test]
fn ctrl_prop_and_vml_both_preserved() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_form_control_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let parts = snapshot["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        parts.contains_key("xl/ctrlProps/ctrlProp1.xml"),
        "ctrlProp must be present"
    );
    assert!(
        parts.contains_key("xl/drawings/vmlDrawing1.vml"),
        "vmlDrawing must be present"
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export must succeed");

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");

    let ctrl = zip_entry_bytes(&mut out_zip, "xl/ctrlProps/ctrlProp1.xml");
    assert_eq!(ctrl, CTRL_PROP_XML);

    let vml = zip_entry_bytes(&mut out_zip, "xl/drawings/vmlDrawing1.vml");
    assert_eq!(vml, VML_DRAWING_XML);
}

/// The [Content_Types].xml Override for ctrlProp is preserved so Excel can
/// recognise the part when it opens the exported file.
#[test]
fn content_types_carries_ctrl_prop_override() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_form_control_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export must succeed");

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");
    let mut ct_bytes = Vec::new();
    out_zip
        .by_name("[Content_Types].xml")
        .expect("[Content_Types].xml must exist")
        .read_to_end(&mut ct_bytes)
        .unwrap();
    let ct_str = String::from_utf8_lossy(&ct_bytes);
    assert!(
        ct_str.contains("xl/ctrlProps/ctrlProp1.xml"),
        "[Content_Types].xml must reference ctrlProp1.xml, got:\n{ct_str}"
    );
}

/// Two independent round-trips of the same fixture yield identical output
/// for the preserved parts (idempotency check).
#[test]
fn double_roundtrip_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_form_control_fixture(&tmp);

    // First round-trip.
    let out1_path = tmp.path().join("out1.xlsx");
    let import1 = import_xlsx_core(path_str(&fixture)).expect("import 1 ok");
    let snap1 = import1.handle.snapshot_json.expect("snap1 present");
    let export1 = export_xlsx_core(path_str(&out1_path), snap1).expect("export 1 ok");
    assert!(export1.success);

    // Second round-trip: re-import the exported file.
    let out2_path = tmp.path().join("out2.xlsx");
    let import2 = import_xlsx_core(path_str(&out1_path)).expect("import 2 ok");
    let snap2 = import2.handle.snapshot_json.expect("snap2 present");
    let export2 = export_xlsx_core(path_str(&out2_path), snap2).expect("export 2 ok");
    assert!(export2.success);

    // Compare ctrlProp bytes from both outputs.
    let bytes1 = std::fs::read(&out1_path).expect("read out1");
    let bytes2 = std::fs::read(&out2_path).expect("read out2");
    let mut zip1 = ZipArchive::new(std::io::Cursor::new(bytes1)).unwrap();
    let mut zip2 = ZipArchive::new(std::io::Cursor::new(bytes2)).unwrap();

    let ctrl1 = zip_entry_bytes(&mut zip1, "xl/ctrlProps/ctrlProp1.xml");
    let ctrl2 = zip_entry_bytes(&mut zip2, "xl/ctrlProps/ctrlProp1.xml");
    assert_eq!(ctrl1, ctrl2, "ctrlProp bytes must be identical across two round-trips");

    let vml1 = zip_entry_bytes(&mut zip1, "xl/drawings/vmlDrawing1.vml");
    let vml2 = zip_entry_bytes(&mut zip2, "xl/drawings/vmlDrawing1.vml");
    assert_eq!(vml1, vml2, "vmlDrawing bytes must be identical across two round-trips");
}

/// A workbook without any form controls must still import/export cleanly
/// (no panic, export succeeds).  Regression guard: _preservedParts should
/// be absent or empty — it must not synthesise phantom form-control entries.
#[test]
fn plain_workbook_unaffected() {
    let tmp = TempDir::new().unwrap();
    let plain_path = tmp.path().join("plain.xlsx");
    let exported = tmp.path().join("out.xlsx");

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.write_string(0, 0, "hello").unwrap();
    wb.save(&plain_path).unwrap();

    let import = import_xlsx_core(path_str(&plain_path)).expect("import ok");
    let snap = import.handle.snapshot_json.expect("snap present");
    let snapshot: serde_json::Value = serde_json::from_str(&snap).unwrap();

    // No form-control parts should appear.
    if let Some(pp) = snapshot.get("_preservedParts") {
        if let Some(parts) = pp.get("parts").and_then(|v| v.as_object()) {
            assert!(
                !parts.keys().any(|k| k.starts_with("xl/ctrlProps/")),
                "plain workbook should have no ctrlProps in _preservedParts"
            );
            assert!(
                !parts
                    .keys()
                    .any(|k| k.starts_with("xl/drawings/vmlDrawing")),
                "plain workbook should have no vmlDrawing in _preservedParts"
            );
        }
    }

    let export = export_xlsx_core(path_str(&exported), snap).expect("export ok");
    assert!(export.success, "plain workbook export must succeed");
}

// ---------------------------------------------------------------------------
// #309: Coco-new CheckBox OOXML emit tests
// ---------------------------------------------------------------------------

/// Build a minimal snapshot JSON string with one Coco-new checkbox on Sheet1.
fn snapshot_with_coco_checkbox(checked: bool, label: &str, fmla_link: Option<&str>) -> String {
    let checked_val = if checked { "true" } else { "false" };
    let fmla_link_field = if let Some(link) = fmla_link {
        format!(r#", "fmlaLink": "{link}""#)
    } else {
        String::new()
    };
    format!(
        r#"{{"sheetOrder":["sheet1"],"sheets":{{"sheet1":{{"id":"sheet1","name":"Sheet1","rowData":{{}},"_checkboxes":[{{"_provenance":"coco-new","row":0,"col":0,"label":"{label}","checked":{checked_val}{fmla_link_field}}}]}}}}}}"#
    )
}

/// A single Coco-new checkbox must produce ctrlProp and vmlDrawing parts.
#[test]
fn coco_new_checkbox_emits_ctrl_prop_and_vml() {
    let tmp = TempDir::new().unwrap();
    let out_path = tmp.path().join("out.xlsx");
    let snap = snapshot_with_coco_checkbox(false, "Agree?", None);

    let export = export_xlsx_core(path_str(&out_path), snap).expect("export ok");
    assert!(export.success, "export must succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&out_path).expect("read output");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");

    assert!(
        zip.by_name("xl/ctrlProps/ctrlProp9000.xml").is_ok(),
        "ctrlProp9000.xml must be emitted for first-sheet Coco-new checkbox"
    );
    assert!(
        zip.by_name("xl/drawings/vmlDrawing9000.vml").is_ok(),
        "vmlDrawing9000.vml must be emitted"
    );
    assert!(
        zip.by_name("xl/drawings/_rels/vmlDrawing9000.vml.rels").is_ok(),
        "vmlDrawing9000.vml.rels must be emitted"
    );
}

/// [Content_Types].xml must get Override entries for ctrlProp and vmlDrawing.
#[test]
fn coco_new_checkbox_content_types_overrides() {
    let tmp = TempDir::new().unwrap();
    let out_path = tmp.path().join("out.xlsx");
    let snap = snapshot_with_coco_checkbox(true, "Done", None);

    let export = export_xlsx_core(path_str(&out_path), snap).expect("export ok");
    assert!(export.success, "export must succeed");

    let out_bytes = std::fs::read(&out_path).expect("read output");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");

    let mut ct_bytes = Vec::new();
    zip.by_name("[Content_Types].xml")
        .expect("[Content_Types].xml must exist")
        .read_to_end(&mut ct_bytes)
        .unwrap();
    let ct = String::from_utf8_lossy(&ct_bytes);

    assert!(
        ct.contains("xl/ctrlProps/ctrlProp9000.xml"),
        "[Content_Types].xml must list ctrlProp9000.xml, got:\n{ct}"
    );
    assert!(
        ct.contains("xl/drawings/vmlDrawing9000.vml"),
        "[Content_Types].xml must list vmlDrawing9000.vml, got:\n{ct}"
    );
}

/// ctrlProp XML has objectType="CheckBox" and the correct checked attribute.
#[test]
fn coco_new_checkbox_ctrl_prop_xml_content() {
    for &checked in &[false, true] {
        let tmp = TempDir::new().unwrap();
        let out_path = tmp.path().join("out.xlsx");
        let snap = snapshot_with_coco_checkbox(checked, "Task", None);

        let export = export_xlsx_core(path_str(&out_path), snap).unwrap();
        assert!(export.success);

        let out_bytes = std::fs::read(&out_path).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out_bytes)).unwrap();
        let mut buf = Vec::new();
        zip.by_name("xl/ctrlProps/ctrlProp9000.xml")
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        let ctrl_xml = String::from_utf8_lossy(&buf);

        assert!(
            ctrl_xml.contains("objectType=\"CheckBox\""),
            "ctrlProp must have objectType=CheckBox: {ctrl_xml}"
        );
        let expected = if checked { "Checked" } else { "Unchecked" };
        assert!(
            ctrl_xml.contains(&format!("checked=\"{expected}\"")),
            "ctrlProp checked attr wrong for checked={checked}: {ctrl_xml}"
        );
    }
}

/// The sheet XML must receive a <legacyDrawing> element after emit.
#[test]
fn coco_new_checkbox_legacy_drawing_in_sheet_xml() {
    let tmp = TempDir::new().unwrap();
    let out_path = tmp.path().join("out.xlsx");
    let snap = snapshot_with_coco_checkbox(false, "Mark", None);

    let export = export_xlsx_core(path_str(&out_path), snap).expect("export ok");
    assert!(export.success);

    let out_bytes = std::fs::read(&out_path).expect("read output");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");
    let mut buf = Vec::new();
    zip.by_name("xl/worksheets/sheet1.xml")
        .expect("sheet1.xml must exist")
        .read_to_end(&mut buf)
        .unwrap();
    let sheet_xml = String::from_utf8_lossy(&buf);

    assert!(
        sheet_xml.contains("<legacyDrawing"),
        "sheet1.xml must contain <legacyDrawing>: {sheet_xml}"
    );
}

/// Sheet rels must contain the vmlDrawing relationship after emit.
#[test]
fn coco_new_checkbox_sheet_rels_has_vml_rel() {
    let tmp = TempDir::new().unwrap();
    let out_path = tmp.path().join("out.xlsx");
    let snap = snapshot_with_coco_checkbox(false, "Select", None);

    let export = export_xlsx_core(path_str(&out_path), snap).expect("export ok");
    assert!(export.success);

    let out_bytes = std::fs::read(&out_path).expect("read output");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");
    let mut buf = Vec::new();
    zip.by_name("xl/worksheets/_rels/sheet1.xml.rels")
        .expect("sheet1 rels must exist")
        .read_to_end(&mut buf)
        .unwrap();
    let rels_xml = String::from_utf8_lossy(&buf);

    assert!(
        rels_xml.contains("vmlDrawing9000.vml"),
        "sheet1 rels must reference vmlDrawing9000.vml: {rels_xml}"
    );
}

/// A snapshot with no Coco-new checkboxes must not emit ctrlProp or vmlDrawing.
#[test]
fn no_coco_new_checkboxes_emits_nothing_extra() {
    let tmp = TempDir::new().unwrap();
    let out_path = tmp.path().join("out.xlsx");
    // Checkbox without _provenance field — treated as non-Coco-new.
    let snap = r#"{"sheetOrder":["s1"],"sheets":{"s1":{"id":"s1","name":"S1","rowData":{},"_checkboxes":[{"row":0,"col":0,"label":"X","checked":false}]}}}"#.to_string();

    let export = export_xlsx_core(path_str(&out_path), snap).expect("export ok");
    assert!(export.success, "export must succeed");

    let out_bytes = std::fs::read(&out_path).expect("read output");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");

    assert!(
        zip.by_name("xl/ctrlProps/ctrlProp9000.xml").is_err(),
        "no ctrlProp should be emitted when no coco-new checkboxes"
    );
    assert!(
        zip.by_name("xl/drawings/vmlDrawing9000.vml").is_err(),
        "no vmlDrawing should be emitted when no coco-new checkboxes"
    );
}

/// Mixed: one non-provenance + one Coco-new checkbox; only the Coco-new one emits OOXML.
#[test]
fn mixed_non_provenance_and_coco_new() {
    let tmp = TempDir::new().unwrap();
    let out_path = tmp.path().join("out.xlsx");
    let snap = r#"{"sheetOrder":["s1"],"sheets":{"s1":{"id":"s1","name":"S1","rowData":{},"_checkboxes":[{"row":0,"col":0,"label":"Old","checked":false},{"_provenance":"coco-new","row":2,"col":0,"label":"New","checked":true}]}}}"#.to_string();

    let export = export_xlsx_core(path_str(&out_path), snap).expect("export ok");
    assert!(export.success, "export must succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&out_path).expect("read output");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out_bytes)).expect("zip");

    // One Coco-new checkbox → ctrlProp9000 only.
    assert!(
        zip.by_name("xl/ctrlProps/ctrlProp9000.xml").is_ok(),
        "ctrlProp9000.xml must exist for the coco-new checkbox"
    );
    // Should NOT have ctrlProp9001 — only one Coco-new entry.
    assert!(
        zip.by_name("xl/ctrlProps/ctrlProp9001.xml").is_err(),
        "ctrlProp9001.xml must NOT exist (only one coco-new checkbox)"
    );
}

//! Phase 4c bridge test: import an xlsx with an embedded image and assert
//! that the snapshot carries a `resources[SHEET_DRAWING_PLUGIN]` entry in
//! addition to `_preservedParts`. The `@univerjs/sheets-drawing` plugin
//! reads this slot to render the image in-grid.
//!
//! Fixture reuses the same hand-crafted PNG + drawing parts as
//! `xlsx_image_preservation.rs`; we keep them duplicated rather than sharing
//! a helper module so this file stays self-contained (each integration test
//! is its own crate target).

use std::io::{Read, Write};
use std::path::PathBuf;

use coco_lib::commands::xlsx_io::import_xlsx_core;
use rust_xlsxwriter::Workbook;
use tempfile::TempDir;
use zip::write::FileOptions;
use zip::ZipArchive;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

const PNG_BYTES: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

// twoCellAnchor with from=(col 1, row 1, no offsets) to=(col 3, row 5, no
// offsets). The bridge should produce a `sheetTransform` with column=1,
// row=1 for `from` and column=3, row=5 for `to`, both offsets = 0.
const DRAWING_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>1</xdr:col><xdr:colOff>9525</xdr:colOff>
              <xdr:row>1</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff>
            <xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="2" name="Picture 1"/>
        <xdr:cNvPicPr/>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>"#;

const DRAWING_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>"#;

fn build_image_fixture(tmp: &TempDir) -> PathBuf {
    build_image_fixture_with(tmp, PNG_BYTES)
}

/// Variant that lets the caller swap the image bytes — used by the
/// size-cap regression test below.
fn build_image_fixture_with(tmp: &TempDir, image_bytes: &[u8]) -> PathBuf {
    let plain_path = tmp.path().join("plain.xlsx");
    let fixture_path = tmp.path().join("with_image.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Pics").unwrap();
        ws.write_string(0, 0, "header").unwrap();
        wb.save(&plain_path).unwrap();
    }

    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let rewrites: &[&str] = &[
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/_rels/sheet1.xml.rels",
        "[Content_Types].xml",
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

    // Inject `<drawing r:id="rId1"/>` into sheet1.xml.
    let mut sheet_xml = String::new();
    src.by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut sheet_xml)
        .unwrap();
    let pos = sheet_xml.rfind("</worksheet>").unwrap();
    let mut patched = String::with_capacity(sheet_xml.len() + 64);
    patched.push_str(&sheet_xml[..pos]);
    patched.push_str("<drawing r:id=\"rId1\"/>");
    patched.push_str(&sheet_xml[pos..]);
    out.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    out.write_all(patched.as_bytes()).unwrap();

    // [Content_Types].xml: add PNG default + drawing override.
    let mut ct_xml = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct_xml)
        .unwrap();
    let close = ct_xml.rfind("</Types>").unwrap();
    let mut patched_ct = String::new();
    patched_ct.push_str(&ct_xml[..close]);
    patched_ct.push_str(r#"<Default Extension="png" ContentType="image/png"/>"#);
    patched_ct.push_str(
        r#"<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
    );
    patched_ct.push_str(&ct_xml[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(patched_ct.as_bytes()).unwrap();

    // Media + drawing + drawing rels + sheet rels patch.
    out.start_file("xl/media/image1.png", opts).unwrap();
    out.write_all(image_bytes).unwrap();

    out.start_file("xl/drawings/drawing1.xml", opts).unwrap();
    out.write_all(DRAWING_XML.as_bytes()).unwrap();

    out.start_file("xl/drawings/_rels/drawing1.xml.rels", opts)
        .unwrap();
    out.write_all(DRAWING_RELS.as_bytes()).unwrap();

    let sheet_rels = if let Ok(mut e) = src.by_name("xl/worksheets/_rels/sheet1.xml.rels") {
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        let close = s.rfind("</Relationships>").unwrap();
        let mut patched_rels = String::new();
        patched_rels.push_str(&s[..close]);
        patched_rels.push_str(r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>"#);
        patched_rels.push_str(&s[close..]);
        patched_rels
    } else {
        // No existing sheet rels — fabricate one with just the drawing rel.
        String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#,
        )
    };
    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(sheet_rels.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

#[test]
fn drawing_bridge_emits_sheet_drawing_plugin_resource() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_image_fixture(&tmp);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    // Preserved parts MUST still be present (byte-perfect round-trip is
    // load-bearing — this test guards that the bridge is additive, not a
    // replacement).
    assert!(
        snapshot.get("_preservedParts").is_some(),
        "_preservedParts should still be on snapshot after bridge runs"
    );

    // Top-level `resources` array with a SHEET_DRAWING_PLUGIN entry.
    let resources = snapshot
        .get("resources")
        .and_then(|v| v.as_array())
        .expect("resources array should exist when an image is present");
    let sheet_drawing = resources
        .iter()
        .find(|e| {
            e.get("name").and_then(|n| n.as_str()) == Some("SHEET_DRAWING_PLUGIN")
        })
        .expect("SHEET_DRAWING_PLUGIN resource entry should be present");
    let data_str = sheet_drawing
        .get("data")
        .and_then(|v| v.as_str())
        .expect("resource `data` should be a JSON-stringified subunit map");
    let subunit_map: serde_json::Value =
        serde_json::from_str(data_str).expect("parse subunit map");

    // sheet-1 (first sheet) should carry one image entry.
    let s1 = subunit_map
        .get("sheet-1")
        .expect("sheet-1 entry should be present");
    let order = s1.get("order").and_then(|v| v.as_array()).expect("order");
    let data = s1.get("data").and_then(|v| v.as_object()).expect("data");
    assert_eq!(order.len(), 1, "expected exactly one drawing in order");
    assert_eq!(data.len(), 1, "expected exactly one drawing in data");

    let drawing_id = order[0].as_str().expect("drawingId str");
    let img = data.get(drawing_id).expect("data entry");

    // ISheetImage fields the plugin requires.
    assert_eq!(img.get("subUnitId").and_then(|v| v.as_str()), Some("sheet-1"));
    assert_eq!(img.get("drawingType").and_then(|v| v.as_i64()), Some(0));
    assert_eq!(
        img.get("imageSourceType").and_then(|v| v.as_str()),
        Some("BASE64")
    );
    let source = img.get("source").and_then(|v| v.as_str()).expect("source");
    assert!(
        source.starts_with("data:image/png;base64,"),
        "source should be a PNG data URL, got: {}",
        &source[..source.len().min(80)]
    );
    assert!(
        source.len() > "data:image/png;base64,".len() + 8,
        "data URL body should be non-trivial"
    );

    let st = img.get("sheetTransform").expect("sheetTransform");
    let from = st.get("from").expect("sheetTransform.from");
    let to = st.get("to").expect("sheetTransform.to");

    // from: col=1, row=1, colOff=9525 EMU → 1 px, rowOff=19050 EMU → 2 px.
    assert_eq!(from.get("column").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(from.get("row").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(from.get("columnOffset").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(from.get("rowOffset").and_then(|v| v.as_i64()), Some(2));

    // to: col=3, row=5, no offsets.
    assert_eq!(to.get("column").and_then(|v| v.as_i64()), Some(3));
    assert_eq!(to.get("row").and_then(|v| v.as_i64()), Some(5));
    assert_eq!(to.get("columnOffset").and_then(|v| v.as_i64()), Some(0));
    assert_eq!(to.get("rowOffset").and_then(|v| v.as_i64()), Some(0));

    // axisAlignSheetTransform must mirror sheetTransform (Univer reads both).
    assert_eq!(img.get("axisAlignSheetTransform"), Some(st));

    // unitId should match the snapshot's id (workbook unitId).
    let wb_id = snapshot.get("id").and_then(|v| v.as_str()).expect("workbook id");
    assert_eq!(img.get("unitId").and_then(|v| v.as_str()), Some(wb_id));

    // twoCellAnchor → SheetDrawingAnchorType.Both ("1"): the image moves AND
    // resizes with cells.
    assert_eq!(img.get("anchorType").and_then(|v| v.as_str()), Some("1"));
}

// Drawing XML with BOTH a oneCellAnchor (rId1) and a twoCellAnchor (rId2)
// referencing the same media. The bridge should emit `anchorType: "0"` for
// the first and `anchorType: "1"` for the second.
const MIXED_ANCHOR_DRAWING_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:oneCellAnchor>
    <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>
              <xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="914400" cy="914400"/>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="2" name="Picture 1"/>
        <xdr:cNvPicPr/>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:oneCellAnchor>
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff>
              <xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff>
            <xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="3" name="Picture 2"/>
        <xdr:cNvPicPr/>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>"#;

/// Variant of `build_image_fixture` that injects `MIXED_ANCHOR_DRAWING_XML`
/// instead of the default twoCellAnchor-only `DRAWING_XML`. The two anchors
/// reuse rId1 so the rels / media parts stay identical.
fn build_mixed_anchor_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain_mixed.xlsx");
    let fixture_path = tmp.path().join("with_mixed_anchors.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Pics").unwrap();
        ws.write_string(0, 0, "header").unwrap();
        wb.save(&plain_path).unwrap();
    }

    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let rewrites: &[&str] = &[
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/_rels/sheet1.xml.rels",
        "[Content_Types].xml",
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

    let mut sheet_xml = String::new();
    src.by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut sheet_xml)
        .unwrap();
    let pos = sheet_xml.rfind("</worksheet>").unwrap();
    let mut patched = String::with_capacity(sheet_xml.len() + 64);
    patched.push_str(&sheet_xml[..pos]);
    patched.push_str("<drawing r:id=\"rId1\"/>");
    patched.push_str(&sheet_xml[pos..]);
    out.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    out.write_all(patched.as_bytes()).unwrap();

    let mut ct_xml = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct_xml)
        .unwrap();
    let close = ct_xml.rfind("</Types>").unwrap();
    let mut patched_ct = String::new();
    patched_ct.push_str(&ct_xml[..close]);
    patched_ct.push_str(r#"<Default Extension="png" ContentType="image/png"/>"#);
    patched_ct.push_str(
        r#"<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
    );
    patched_ct.push_str(&ct_xml[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(patched_ct.as_bytes()).unwrap();

    out.start_file("xl/media/image1.png", opts).unwrap();
    out.write_all(PNG_BYTES).unwrap();

    out.start_file("xl/drawings/drawing1.xml", opts).unwrap();
    out.write_all(MIXED_ANCHOR_DRAWING_XML.as_bytes()).unwrap();

    out.start_file("xl/drawings/_rels/drawing1.xml.rels", opts)
        .unwrap();
    out.write_all(DRAWING_RELS.as_bytes()).unwrap();

    let sheet_rels = if let Ok(mut e) = src.by_name("xl/worksheets/_rels/sheet1.xml.rels") {
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        let close = s.rfind("</Relationships>").unwrap();
        let mut patched_rels = String::new();
        patched_rels.push_str(&s[..close]);
        patched_rels.push_str(r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>"#);
        patched_rels.push_str(&s[close..]);
        patched_rels
    } else {
        String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#,
        )
    };
    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(sheet_rels.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

/// Bug #1 regression: a `oneCellAnchor` image must NOT be tagged with
/// `anchorType: "1"` (Both = move + resize). Excel semantics: oneCellAnchor
/// is position-only (move with cells, fixed size) → SheetDrawingAnchorType
/// `Position` = "0". A sibling `twoCellAnchor` in the same drawing should
/// still emit "1", proving the kind is threaded out of the parser, not
/// inferred from anchor order or some other proxy.
#[test]
fn one_cell_anchor_emits_position_anchor_type() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_mixed_anchor_fixture(&tmp);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    let resources = snapshot
        .get("resources")
        .and_then(|v| v.as_array())
        .expect("resources array");
    let sheet_drawing = resources
        .iter()
        .find(|e| e.get("name").and_then(|n| n.as_str()) == Some("SHEET_DRAWING_PLUGIN"))
        .expect("SHEET_DRAWING_PLUGIN entry");
    let data_str = sheet_drawing
        .get("data")
        .and_then(|v| v.as_str())
        .expect("resource data is a string");
    let subunit_map: serde_json::Value =
        serde_json::from_str(data_str).expect("parse subunit map");

    let s1 = subunit_map
        .get("sheet-1")
        .expect("sheet-1 entry");
    let order = s1.get("order").and_then(|v| v.as_array()).expect("order");
    let data = s1.get("data").and_then(|v| v.as_object()).expect("data");

    assert_eq!(order.len(), 2, "expected one oneCellAnchor + one twoCellAnchor");

    // The parser iterates `twoCellAnchor` then `oneCellAnchor` by tag name
    // (not source-XML document order), and both anchors reuse `rId1` here so
    // we disambiguate by parse position via the anchor_idx baked into the
    // drawingId (`coco-img-<sheet>-<anchor_idx>-<rid>`).
    let parse_order_two = order[0].as_str().expect("two-cell drawingId");
    let parse_order_one = order[1].as_str().expect("one-cell drawingId");
    assert!(
        parse_order_two.contains("-0-"),
        "first parse slot is anchor_idx 0 = twoCellAnchor: got {parse_order_two}"
    );
    assert!(
        parse_order_one.contains("-1-"),
        "second parse slot is anchor_idx 1 = oneCellAnchor: got {parse_order_one}"
    );

    // twoCellAnchor → "1" (Both, move + resize).
    let two_cell = data.get(parse_order_two).expect("two-cell entry");
    assert_eq!(
        two_cell.get("anchorType").and_then(|v| v.as_str()),
        Some("1"),
        "twoCellAnchor should map to SheetDrawingAnchorType.Both (\"1\")"
    );

    // oneCellAnchor → "0" (Position, move-only).
    let one_cell = data.get(parse_order_one).expect("one-cell entry");
    assert_eq!(
        one_cell.get("anchorType").and_then(|v| v.as_str()),
        Some("0"),
        "oneCellAnchor should map to SheetDrawingAnchorType.Position (\"0\")"
    );
}

/// Variant of `build_image_fixture` that renames the worksheet to literal
/// `A&B`. workbook.xml carries the name XML-escaped as `A&amp;B`; calamine
/// (and `parse_workbook_sheets` after the fix) surface it decoded as `A&B`.
/// Pre-fix, the drawing-bridge lookup missed the decoded name and silently
/// dropped the SHEET_DRAWING_PLUGIN entry for the sheet.
fn build_escaped_name_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain_escaped.xlsx");
    let fixture_path = tmp.path().join("with_escaped_name.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        // Use a placeholder name; we'll rewrite workbook.xml below to inject
        // the literal `&` (escaped to `&amp;` in the XML payload).
        ws.set_name("PicsTmp").unwrap();
        ws.write_string(0, 0, "header").unwrap();
        wb.save(&plain_path).unwrap();
    }

    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let rewrites: &[&str] = &[
        "xl/workbook.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/_rels/sheet1.xml.rels",
        "[Content_Types].xml",
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

    // workbook.xml: rewrite the sheet `name="PicsTmp"` → `name="A&amp;B"`.
    let mut wb_xml = String::new();
    src.by_name("xl/workbook.xml")
        .unwrap()
        .read_to_string(&mut wb_xml)
        .unwrap();
    let patched_wb = wb_xml.replace("name=\"PicsTmp\"", "name=\"A&amp;B\"");
    assert!(
        patched_wb.contains("name=\"A&amp;B\""),
        "fixture should embed the XML-escaped sheet name"
    );
    out.start_file("xl/workbook.xml", opts).unwrap();
    out.write_all(patched_wb.as_bytes()).unwrap();

    // sheet1.xml: inject `<drawing r:id="rId1"/>` (same as base fixture).
    let mut sheet_xml = String::new();
    src.by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut sheet_xml)
        .unwrap();
    let pos = sheet_xml.rfind("</worksheet>").unwrap();
    let mut patched = String::with_capacity(sheet_xml.len() + 64);
    patched.push_str(&sheet_xml[..pos]);
    patched.push_str("<drawing r:id=\"rId1\"/>");
    patched.push_str(&sheet_xml[pos..]);
    out.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    out.write_all(patched.as_bytes()).unwrap();

    // [Content_Types].xml: PNG default + drawing override.
    let mut ct_xml = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct_xml)
        .unwrap();
    let close = ct_xml.rfind("</Types>").unwrap();
    let mut patched_ct = String::new();
    patched_ct.push_str(&ct_xml[..close]);
    patched_ct.push_str(r#"<Default Extension="png" ContentType="image/png"/>"#);
    patched_ct.push_str(
        r#"<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
    );
    patched_ct.push_str(&ct_xml[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(patched_ct.as_bytes()).unwrap();

    // Media + drawing parts (reuse base fixture's DRAWING_XML/RELS).
    out.start_file("xl/media/image1.png", opts).unwrap();
    out.write_all(PNG_BYTES).unwrap();

    out.start_file("xl/drawings/drawing1.xml", opts).unwrap();
    out.write_all(DRAWING_XML.as_bytes()).unwrap();

    out.start_file("xl/drawings/_rels/drawing1.xml.rels", opts)
        .unwrap();
    out.write_all(DRAWING_RELS.as_bytes()).unwrap();

    let sheet_rels = if let Ok(mut e) = src.by_name("xl/worksheets/_rels/sheet1.xml.rels") {
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        let close = s.rfind("</Relationships>").unwrap();
        let mut patched_rels = String::new();
        patched_rels.push_str(&s[..close]);
        patched_rels.push_str(r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>"#);
        patched_rels.push_str(&s[close..]);
        patched_rels
    } else {
        String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#,
        )
    };
    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(sheet_rels.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

/// Bug #2 regression: a sheet whose name contains XML-entity characters
/// (here `A&B`, stored as `name="A&amp;B"` in workbook.xml) must still
/// surface its drawings in the SHEET_DRAWING_PLUGIN bridge AND its parts
/// in `_preservedParts.sheetRefs`. Pre-fix, `parse_workbook_sheets` left
/// the entity raw (`A&amp;B`), which mismatched calamine's decoded form
/// (`A&B`) and silently dropped both pipelines.
#[test]
fn xml_escaped_sheet_name_drawing_is_preserved_and_emitted() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_escaped_name_fixture(&tmp);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    // 1) SHEET_DRAWING_PLUGIN resource is emitted (not silently dropped).
    let resources = snapshot
        .get("resources")
        .and_then(|v| v.as_array())
        .expect("resources array");
    let sheet_drawing = resources
        .iter()
        .find(|e| e.get("name").and_then(|n| n.as_str()) == Some("SHEET_DRAWING_PLUGIN"))
        .expect(
            "SHEET_DRAWING_PLUGIN entry should be present for a sheet whose name contains `&`",
        );
    let data_str = sheet_drawing
        .get("data")
        .and_then(|v| v.as_str())
        .expect("resource data is a string");
    let subunit_map: serde_json::Value =
        serde_json::from_str(data_str).expect("parse subunit map");

    // The first sheet's subUnitId is sheet-1 (assigned by sheet_order), not
    // the raw name, so we look up under sheet-1 and then confirm the data
    // entry's subUnitId matches.
    let s1 = subunit_map
        .get("sheet-1")
        .expect("sheet-1 entry should be present (drawing bridge keyed correctly)");
    let order = s1.get("order").and_then(|v| v.as_array()).expect("order");
    let data = s1.get("data").and_then(|v| v.as_object()).expect("data");
    assert_eq!(order.len(), 1, "expected one drawing on the &-named sheet");
    let drawing_id = order[0].as_str().expect("drawingId");
    let img = data.get(drawing_id).expect("data entry");
    assert_eq!(
        img.get("subUnitId").and_then(|v| v.as_str()),
        Some("sheet-1")
    );

    // 2) _preservedParts.sheetRefs MUST include this sheet's drawing entry
    //    too (broader fix landing — `parse_xlsx_preserved_parts` shares the
    //    same parser).
    let preserved = snapshot
        .get("_preservedParts")
        .expect("_preservedParts on snapshot");
    let sheet_refs = preserved
        .get("sheetRefs")
        .and_then(|v| v.as_array())
        .expect("_preservedParts.sheetRefs is an array");
    assert_eq!(sheet_refs.len(), 1, "exactly one sheet in workbook");
    let entry = &sheet_refs[0];
    assert!(
        !entry.is_null(),
        "sheetRefs[0] should NOT be null — the &-named sheet's drawing rels should land here"
    );
    assert_eq!(
        entry.get("drawingRid").and_then(|v| v.as_str()),
        Some("rId1"),
        "drawingRid should be preserved"
    );
    assert!(
        entry
            .get("drawingTarget")
            .and_then(|v| v.as_str())
            .map(|t| t.contains("drawing1.xml"))
            .unwrap_or(false),
        "drawingTarget should point at drawing1.xml"
    );
}

/// CONCERN fix: media bytes over the 16 MiB cap must be skipped from the
/// in-grid render channel (no `SHEET_DRAWING_PLUGIN` entry) and an
/// `XLSX_DRAWING_MEDIA_TOO_LARGE` warning must be emitted. The bytes still
/// land in `_preservedParts` (under its own caps there) — bridge skip is
/// purely for the DoS-prone snapshot/IPC payload, not the round-trip.
#[test]
fn oversized_image_is_skipped_with_warning() {
    // 17 MiB of zero bytes — fake-image payload that exceeds the 16 MiB
    // per-part cap. Not valid PNG (the cap fires before decode), but the
    // zip entry size is what the bridge checks.
    let big: Vec<u8> = vec![0u8; 17 * 1024 * 1024];
    let tmp = TempDir::new().unwrap();
    let fixture = build_image_fixture_with(&tmp, &big);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    // No SHEET_DRAWING_PLUGIN entry (bridge skipped — image too large).
    let resources = snapshot.get("resources").and_then(|v| v.as_array());
    let has_drawing_resource = resources
        .map(|arr| {
            arr.iter()
                .any(|e| e.get("name").and_then(|n| n.as_str()) == Some("SHEET_DRAWING_PLUGIN"))
        })
        .unwrap_or(false);
    assert!(
        !has_drawing_resource,
        "SHEET_DRAWING_PLUGIN entry must be absent when the only image exceeds the size cap"
    );

    // Warning surfaced so the user knows the image won't render in-grid.
    let warn_code = "XLSX_DRAWING_MEDIA_TOO_LARGE";
    let has_warn = import
        .warnings
        .iter()
        .any(|w| w.code == warn_code);
    assert!(
        has_warn,
        "expected {warn_code} warning; got codes: {:?}",
        import.warnings.iter().map(|w| &w.code).collect::<Vec<_>>()
    );
}

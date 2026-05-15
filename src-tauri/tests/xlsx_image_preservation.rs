//! Round-trip test for embedded-image "blob-level" preservation. Verifies
//! that a source xlsx with an `xl/media/imageN.png` (referenced by a
//! `<picture>` inside `xl/drawings/drawingN.xml`) survives import → export
//! with the image bytes intact in the output zip.
//!
//! rust_xlsxwriter 0.77 doesn't expose an image API on its own (the workbook
//! has to be hand-crafted at the zip layer), so we splice a hand-crafted
//! 1x1 PNG into a plain workbook just like the chart preservation fixture.

use std::io::{Read, Write};
use std::path::PathBuf;

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Url, Workbook};
use tempfile::TempDir;
use zip::write::FileOptions;
use zip::ZipArchive;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Minimal valid 1x1 transparent PNG. The exact bytes here aren't important
/// for the preservation pipeline (it operates on opaque bytes) — what
/// matters is that they survive verbatim through round-trip.
const PNG_BYTES: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR length + "IHDR"
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, // bit depth, color type, compression, filter, interlace, CRC
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, // IDAT length + "IDAT"
    0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D,
    0xB4, // IDAT data + CRC
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, // IEND
];

const DRAWING_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>
              <xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
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

/// Build a fixture xlsx by writing a plain workbook then re-zipping it with
/// image + drawing parts spliced in.
fn build_image_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain.xlsx");
    let fixture_path = tmp.path().join("with_image.xlsx");

    // 1. Plain workbook with one sheet.
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Pics").unwrap();
        ws.write_url(
            0,
            0,
            Url::new("https://example.com/pic").set_text("Image link"),
        )
        .unwrap();
        wb.save(&plain_path).unwrap();
    }

    // 2. Re-zip with image + drawing parts spliced in. Patch sheet1.xml to
    //    reference the drawing, patch [Content_Types].xml to advertise both
    //    the drawing Override and a PNG Default.
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

    // Patched sheet1.xml: move the source hyperlink away from rId1, then
    // inject `<drawing r:id="rId1"/>` before `</worksheet>`. On export,
    // rust_xlsxwriter will commonly reuse rId1 for the hyperlink, so the
    // preserved drawing rel must be remapped without losing either relation.
    let mut sheet_xml = String::new();
    src.by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut sheet_xml)
        .unwrap();
    let sheet_xml = sheet_xml.replace("r:id=\"rId1\"", "r:id=\"rIdHyper1\"");
    let pos = sheet_xml.rfind("</worksheet>").unwrap();
    let mut patched = String::with_capacity(sheet_xml.len() + 64);
    patched.push_str(&sheet_xml[..pos]);
    patched.push_str("<drawing r:id=\"rId1\"/>");
    patched.push_str(&sheet_xml[pos..]);
    out.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    out.write_all(patched.as_bytes()).unwrap();

    // Patched [Content_Types].xml: add a PNG Default + drawing Override.
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

    // New parts: media image, drawing, drawing rels, sheet rels.
    out.start_file("xl/media/image1.png", opts).unwrap();
    out.write_all(PNG_BYTES).unwrap();

    out.start_file("xl/drawings/drawing1.xml", opts).unwrap();
    out.write_all(DRAWING_XML.as_bytes()).unwrap();

    out.start_file("xl/drawings/_rels/drawing1.xml.rels", opts)
        .unwrap();
    out.write_all(DRAWING_RELS.as_bytes()).unwrap();

    let mut sheet_rels = String::new();
    src.by_name("xl/worksheets/_rels/sheet1.xml.rels")
        .unwrap()
        .read_to_string(&mut sheet_rels)
        .unwrap();
    let sheet_rels = sheet_rels.replace("Id=\"rId1\"", "Id=\"rIdHyper1\"");
    let close = sheet_rels.rfind("</Relationships>").unwrap();
    let mut patched_rels = String::new();
    patched_rels.push_str(&sheet_rels[..close]);
    patched_rels.push_str(r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>"#);
    patched_rels.push_str(&sheet_rels[close..]);
    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(patched_rels.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

#[test]
fn image_blob_survives_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_image_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    // Import the fixture. Snapshot should contain `_preservedParts` with the
    // media bytes captured under `xl/media/image1.png`.
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
        parts.contains_key("xl/media/image1.png"),
        "media png should be preserved in snapshot, got keys: {:?}",
        parts.keys().collect::<Vec<_>>()
    );
    assert!(
        parts.contains_key("xl/drawings/drawing1.xml"),
        "drawing should be preserved in snapshot"
    );
    assert!(
        parts.contains_key("xl/drawings/_rels/drawing1.xml.rels"),
        "drawing rels should be preserved in snapshot"
    );

    // Export. The output must still carry the image bytes bit-exact.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");
    let mut image_bytes = Vec::new();
    out_zip
        .by_name("xl/media/image1.png")
        .expect("media part must exist in output zip")
        .read_to_end(&mut image_bytes)
        .unwrap();
    assert_eq!(
        image_bytes, PNG_BYTES,
        "image bytes should round-trip bit-exact"
    );

    // Drawing part should also be preserved.
    let mut drawing_bytes = Vec::new();
    out_zip
        .by_name("xl/drawings/drawing1.xml")
        .expect("drawing part must exist in output zip")
        .read_to_end(&mut drawing_bytes)
        .unwrap();
    assert_eq!(drawing_bytes, DRAWING_XML.as_bytes());

    // Drawing rels (with the image rel inside it) should be preserved verbatim.
    let mut drawing_rels = Vec::new();
    out_zip
        .by_name("xl/drawings/_rels/drawing1.xml.rels")
        .expect("drawing rels must exist in output zip")
        .read_to_end(&mut drawing_rels)
        .unwrap();
    assert_eq!(drawing_rels, DRAWING_RELS.as_bytes());

    // [Content_Types].xml should carry the PNG Default so Excel knows how
    // to handle the image bytes.
    let mut ct = String::new();
    out_zip
        .by_name("[Content_Types].xml")
        .expect("content types must exist")
        .read_to_string(&mut ct)
        .unwrap();
    assert!(
        ct.contains(r#"Extension="png""#),
        "[Content_Types].xml should carry PNG Default: {}",
        ct
    );

    let mut sheet_rels = String::new();
    out_zip
        .by_name("xl/worksheets/_rels/sheet1.xml.rels")
        .expect("sheet rels must exist")
        .read_to_string(&mut sheet_rels)
        .unwrap();
    assert!(
        sheet_rels.contains("/drawing") && sheet_rels.contains("../drawings/drawing1.xml"),
        "sheet rels should keep the preserved drawing relationship: {}",
        sheet_rels
    );
    assert!(
        sheet_rels.contains("/hyperlink") && sheet_rels.contains("https://example.com/pic"),
        "sheet rels should keep rust_xlsxwriter hyperlink relationship: {}",
        sheet_rels
    );

    let mut sheet_xml = String::new();
    out_zip
        .by_name("xl/worksheets/sheet1.xml")
        .expect("sheet xml must exist")
        .read_to_string(&mut sheet_xml)
        .unwrap();
    let drawing_rid = sheet_xml
        .find("<drawing")
        .and_then(|start| {
            sheet_xml[start..]
                .find("r:id=\"")
                .map(|rel| start + rel + 6)
        })
        .and_then(|start| {
            sheet_xml[start..]
                .find('"')
                .map(|end| &sheet_xml[start..start + end])
        })
        .expect("sheet xml should contain drawing r:id");
    assert!(
        sheet_rels.contains(&format!(r#"Id="{drawing_rid}""#))
            && sheet_rels.contains("../drawings/drawing1.xml"),
        "drawing r:id should point at the preserved drawing rel: sheet={}, rels={}",
        sheet_xml,
        sheet_rels
    );
}

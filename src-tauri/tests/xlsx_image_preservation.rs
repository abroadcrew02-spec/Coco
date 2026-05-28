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

// Find the first sheet object carrying a non-empty `_images` array.
fn find_sheet_with_images(snapshot: &serde_json::Value) -> Option<&serde_json::Value> {
    let sheets = snapshot.get("sheets")?.as_object()?;
    for sheet in sheets.values() {
        if sheet
            .get("_images")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false)
        {
            return Some(sheet);
        }
    }
    None
}

#[test]
fn image_blob_survives_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_image_fixture(&tmp);
    let exported = tmp.path().join("out.xlsx");

    // #312 changed the contract: an embedded `xl/media` image referenced by a
    // drawing is normalised into the sheet's `_images` array on import (and
    // removed from `_preservedParts` to keep the XOR invariant). On export it
    // is regenerated from `_images` — drawing XML is *not* byte-preserved, but
    // the image bytes still round-trip bit-exact.
    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).expect("parse snapshot");

    // 1. The image is normalised into `_images`, not `_preservedParts`.
    let sheet = find_sheet_with_images(&snapshot)
        .expect("imported image should be normalised into a sheet's _images");
    let images = sheet.get("_images").and_then(|v| v.as_array()).unwrap();
    assert_eq!(images.len(), 1, "exactly one image expected");
    let img = &images[0];
    assert_eq!(
        img.get("ext").and_then(|v| v.as_str()),
        Some("png"),
        "image ext should be png"
    );
    assert!(
        img.get("base64")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "image base64 payload should be present"
    );

    // 2. XOR invariant: the media must NOT linger in `_preservedParts`.
    if let Some(parts) = snapshot
        .get("_preservedParts")
        .and_then(|p| p.get("parts"))
        .and_then(|v| v.as_object())
    {
        assert!(
            !parts.contains_key("xl/media/image1.png"),
            "media must be removed from _preservedParts after _images normalisation, got: {:?}",
            parts.keys().collect::<Vec<_>>()
        );
    }

    // Export. The output must carry the image bytes bit-exact, regenerated
    // from `_images` by inject_images_to_xlsx.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut out_zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");

    // 3. Some xl/media/*.png in the output matches PNG_BYTES exactly. The exact
    //    filename is regenerated, so scan rather than assume `image1.png`.
    let mut media_names: Vec<String> = Vec::new();
    for i in 0..out_zip.len() {
        let name = out_zip.by_index(i).unwrap().name().to_string();
        if name.starts_with("xl/media/") && name.ends_with(".png") {
            media_names.push(name);
        }
    }
    assert!(
        !media_names.is_empty(),
        "output should contain at least one xl/media/*.png"
    );
    let mut found_exact = false;
    for name in &media_names {
        let mut bytes = Vec::new();
        out_zip
            .by_name(name)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        if bytes == PNG_BYTES {
            found_exact = true;
            break;
        }
    }
    assert!(
        found_exact,
        "image bytes should round-trip bit-exact across {media_names:?}"
    );

    // 4. A drawing part referencing the picture is regenerated.
    let mut drawing_xml = String::new();
    for i in 0..out_zip.len() {
        let name = out_zip.by_index(i).unwrap().name().to_string();
        if name.starts_with("xl/drawings/drawing") && name.ends_with(".xml") {
            out_zip
                .by_name(&name)
                .unwrap()
                .read_to_string(&mut drawing_xml)
                .unwrap();
            if drawing_xml.contains("<xdr:pic") || drawing_xml.contains(":blip") {
                break;
            }
            drawing_xml.clear();
        }
    }
    assert!(
        drawing_xml.contains("<xdr:pic") || drawing_xml.contains(":blip"),
        "a regenerated drawing should embed the picture, got: {drawing_xml}"
    );

    // 5. [Content_Types].xml advertises PNG handling.
    let mut ct = String::new();
    out_zip
        .by_name("[Content_Types].xml")
        .expect("content types must exist")
        .read_to_string(&mut ct)
        .unwrap();
    assert!(
        ct.contains(r#"Extension="png""#) || ct.contains("image/png"),
        "[Content_Types].xml should carry PNG handling: {ct}"
    );

    // 6. The rust_xlsxwriter hyperlink relationship still coexists with the
    //    regenerated image drawing (no rel/relationship collision).
    let mut sheet_rels = String::new();
    out_zip
        .by_name("xl/worksheets/_rels/sheet1.xml.rels")
        .expect("sheet rels must exist")
        .read_to_string(&mut sheet_rels)
        .unwrap();
    assert!(
        sheet_rels.contains("/hyperlink") && sheet_rels.contains("https://example.com/pic"),
        "sheet rels should keep rust_xlsxwriter hyperlink relationship: {sheet_rels}"
    );
    assert!(
        sheet_rels.contains("/drawing"),
        "sheet rels should reference a drawing for the regenerated image: {sheet_rels}"
    );
}

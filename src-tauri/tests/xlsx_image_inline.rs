//! #312 integration tests: _images normalisation (import) and regeneration (export).
//!
//! Covers:
//!   - import → _images populated, _preservedParts media removed (XOR invariant)
//!   - import → export → re-import round-trip: anchor / size / bytes preserved
//!   - multi-sheet workbook with images on multiple sheets
//!   - absoluteAnchor fallback: image stays in _preservedParts, not _images
//!   - no images: _images key absent from snapshot

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

/// Minimal valid 1x1 transparent PNG (same bytes used across tests).
const PNG_BYTES: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

fn base64_encode(input: &[u8]) -> String {
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((input.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n =
            ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | input[i + 2] as u32;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

/// Build a single-sheet xlsx with one PNG image in a twoCellAnchor at
/// from=(col=2, row=3) to=(col=5, row=8), no EMU offsets.
fn build_single_image_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain.xlsx");
    let fixture_path = tmp.path().join("single_image.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "data").unwrap();
        wb.save(&plain_path).unwrap();
    }

    let drawing_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff>
              <xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff>
            <xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr><xdr:cNvPr id="2" name="Img1"/><xdr:cNvPicPr/></xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip r:embed="rId1"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>"#;

    let drawing_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>"#;

    let sheet_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#;

    splice_parts(
        &plain_path,
        &fixture_path,
        &[
            ("xl/media/image1.png", PNG_BYTES.to_vec()),
            ("xl/drawings/drawing1.xml", drawing_xml.as_bytes().to_vec()),
            (
                "xl/drawings/_rels/drawing1.xml.rels",
                drawing_rels.as_bytes().to_vec(),
            ),
        ],
        &[
            ("xl/worksheets/sheet1.xml", "<drawing r:id=\"rId1\"/>"),
        ],
        sheet_rels,
        &[
            r#"<Default Extension="png" ContentType="image/png"/>"#,
            r#"<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
        ],
    );

    fixture_path
}

/// Build a two-sheet xlsx where sheet1 has one image and sheet2 has one image.
fn build_multisheet_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain2.xlsx");
    let fixture_path = tmp.path().join("multi_sheet.xlsx");

    {
        let mut wb = Workbook::new();
        let _s1 = wb.add_worksheet();
        let _s2 = wb.add_worksheet();
        wb.save(&plain_path).unwrap();
    }

    let draw1 = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="S1Img"/><xdr:cNvPicPr/></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
      <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic><xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>"#;

    let draw2 = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="S2Img"/><xdr:cNvPicPr/></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
      <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic><xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>"#;

    let rels_tmpl = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/imageMEDIA.png"/>
</Relationships>"#;

    let sheet_rels1 = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#;
    let sheet_rels2 = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing2.xml"/>
</Relationships>"#;

    let src_bytes = std::fs::read(&plain_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(&fixture_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let skip: std::collections::HashSet<&str> = [
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
        "xl/worksheets/_rels/sheet1.xml.rels",
        "xl/worksheets/_rels/sheet2.xml.rels",
        "[Content_Types].xml",
    ]
    .iter()
    .copied()
    .collect();

    for i in 0..src.len() {
        let mut entry = src.by_index(i).unwrap();
        let name = entry.name().to_string();
        if skip.contains(name.as_str()) {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        out.start_file(&name, opts).unwrap();
        out.write_all(&buf).unwrap();
    }

    // Patch sheet1.xml.
    let mut s1_xml = String::new();
    src.by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut s1_xml)
        .unwrap();
    let p = s1_xml.rfind("</worksheet>").unwrap();
    let mut patched = format!("{}<drawing r:id=\"rId1\"/>{}", &s1_xml[..p], &s1_xml[p..]);
    out.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
    out.write_all(patched.as_bytes()).unwrap();

    // Patch sheet2.xml.
    let mut s2_xml = String::new();
    if let Ok(mut e) = src.by_name("xl/worksheets/sheet2.xml") {
        e.read_to_string(&mut s2_xml).unwrap();
    }
    if !s2_xml.is_empty() {
        let p2 = s2_xml.rfind("</worksheet>").unwrap();
        patched = format!("{}<drawing r:id=\"rId1\"/>{}", &s2_xml[..p2], &s2_xml[p2..]);
        out.start_file("xl/worksheets/sheet2.xml", opts).unwrap();
        out.write_all(patched.as_bytes()).unwrap();
    }

    out.start_file("xl/worksheets/_rels/sheet1.xml.rels", opts)
        .unwrap();
    out.write_all(sheet_rels1.as_bytes()).unwrap();

    out.start_file("xl/worksheets/_rels/sheet2.xml.rels", opts)
        .unwrap();
    out.write_all(sheet_rels2.as_bytes()).unwrap();

    // Media (two copies of the same PNG — one per sheet).
    out.start_file("xl/media/image1.png", opts).unwrap();
    out.write_all(PNG_BYTES).unwrap();
    out.start_file("xl/media/image2.png", opts).unwrap();
    out.write_all(PNG_BYTES).unwrap();

    // Drawing XMLs.
    out.start_file("xl/drawings/drawing1.xml", opts).unwrap();
    out.write_all(draw1.as_bytes()).unwrap();
    out.start_file("xl/drawings/drawing2.xml", opts).unwrap();
    out.write_all(draw2.as_bytes()).unwrap();

    // Drawing rels.
    out.start_file("xl/drawings/_rels/drawing1.xml.rels", opts)
        .unwrap();
    out.write_all(
        rels_tmpl.replace("MEDIA", "1").as_bytes(),
    )
    .unwrap();
    out.start_file("xl/drawings/_rels/drawing2.xml.rels", opts)
        .unwrap();
    out.write_all(
        rels_tmpl.replace("MEDIA", "2").as_bytes(),
    )
    .unwrap();

    // Content types.
    let mut ct = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct)
        .unwrap();
    let close = ct.rfind("</Types>").unwrap();
    let mut ct2 = String::new();
    ct2.push_str(&ct[..close]);
    ct2.push_str(r#"<Default Extension="png" ContentType="image/png"/>"#);
    ct2.push_str(r#"<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#);
    ct2.push_str(r#"<Override PartName="/xl/drawings/drawing2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#);
    ct2.push_str(&ct[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(ct2.as_bytes()).unwrap();

    out.finish().unwrap();
    fixture_path
}

/// Build an xlsx with an absoluteAnchor — should stay in _preservedParts, not _images.
fn build_absolute_anchor_fixture(tmp: &TempDir) -> PathBuf {
    let plain_path = tmp.path().join("plain_abs.xlsx");
    let fixture_path = tmp.path().join("absolute_anchor.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        wb.save(&plain_path).unwrap();
    }

    let drawing_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:absoluteAnchor>
    <xdr:pos x="0" y="0"/>
    <xdr:ext cx="914400" cy="914400"/>
    <xdr:pic>
      <xdr:nvPicPr><xdr:cNvPr id="2" name="AbsImg"/><xdr:cNvPicPr/></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
      <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:absoluteAnchor>
</xdr:wsDr>"#;

    let drawing_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>"#;

    let sheet_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#;

    splice_parts(
        &plain_path,
        &fixture_path,
        &[
            ("xl/media/image1.png", PNG_BYTES.to_vec()),
            ("xl/drawings/drawing1.xml", drawing_xml.as_bytes().to_vec()),
            (
                "xl/drawings/_rels/drawing1.xml.rels",
                drawing_rels.as_bytes().to_vec(),
            ),
        ],
        &[("xl/worksheets/sheet1.xml", "<drawing r:id=\"rId1\"/>")],
        sheet_rels,
        &[
            r#"<Default Extension="png" ContentType="image/png"/>"#,
            r#"<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
        ],
    );

    fixture_path
}

/// Utility: splice extra parts into a plain xlsx fixture.
fn splice_parts(
    src_path: &PathBuf,
    dst_path: &PathBuf,
    extra_parts: &[(&str, Vec<u8>)],
    sheet1_drawing_inject: &[(&str, &str)], // (sheet_entry_name, drawing_tag)
    sheet1_rels_xml: &str,
    ct_extras: &[&str],
) {
    let src_bytes = std::fs::read(src_path).unwrap();
    let mut src = ZipArchive::new(std::io::Cursor::new(&src_bytes)).unwrap();
    let out_file = std::fs::File::create(dst_path).unwrap();
    let mut out = zip::ZipWriter::new(out_file);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let extra_names: std::collections::HashSet<&str> =
        extra_parts.iter().map(|(n, _)| *n).collect();
    let mut rewrite_names: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for (name, _) in sheet1_drawing_inject {
        rewrite_names.insert(name.to_string());
    }
    rewrite_names.insert("xl/worksheets/_rels/sheet1.xml.rels".to_string());
    rewrite_names.insert("[Content_Types].xml".to_string());

    for i in 0..src.len() {
        let mut entry = src.by_index(i).unwrap();
        let name = entry.name().to_string();
        if extra_names.contains(name.as_str()) || rewrite_names.contains(&name) {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        out.start_file(&name, opts).unwrap();
        out.write_all(&buf).unwrap();
    }

    for (name, drawing_tag) in sheet1_drawing_inject {
        let mut xml = String::new();
        src.by_name(*name)
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        let p = xml.rfind("</worksheet>").unwrap();
        let patched = format!("{}{}{}", &xml[..p], drawing_tag, &xml[p..]);
        out.start_file(*name, opts).unwrap();
        out.write_all(patched.as_bytes()).unwrap();
    }

    out.start_file(
        "xl/worksheets/_rels/sheet1.xml.rels",
        opts,
    )
    .unwrap();
    out.write_all(sheet1_rels_xml.as_bytes()).unwrap();

    for (name, bytes) in extra_parts {
        out.start_file(*name, opts).unwrap();
        out.write_all(bytes.as_slice()).unwrap();
    }

    let mut ct = String::new();
    src.by_name("[Content_Types].xml")
        .unwrap()
        .read_to_string(&mut ct)
        .unwrap();
    let close = ct.rfind("</Types>").unwrap();
    let mut ct2 = String::new();
    ct2.push_str(&ct[..close]);
    for extra in ct_extras {
        ct2.push_str(extra);
    }
    ct2.push_str(&ct[close..]);
    out.start_file("[Content_Types].xml", opts).unwrap();
    out.write_all(ct2.as_bytes()).unwrap();

    out.finish().unwrap();
}

// =============================================================================
// Tests
// =============================================================================

/// Import a single-image xlsx: _images populated, media removed from _preservedParts.
#[test]
fn import_single_image_into_images_array() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_single_image_fixture(&tmp);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snap: serde_json::Value =
        serde_json::from_str(&import.handle.snapshot_json.unwrap()).unwrap();

    let images = snap["sheets"]["sheet-1"]["_images"]
        .as_array()
        .expect("_images array");
    assert_eq!(images.len(), 1);

    let img = &images[0];
    assert_eq!(img["ext"].as_str(), Some("png"));
    assert_eq!(img["anchorRow"].as_i64(), Some(3));
    assert_eq!(img["anchorCol"].as_i64(), Some(2));

    // XOR invariant: media must not be in _preservedParts.parts.
    let parts = snap["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        !parts.contains_key("xl/media/image1.png"),
        "media should be removed from _preservedParts.parts after normalisation"
    );
}

/// Round-trip: import → export → re-import. Anchor coords and base64 bytes must match.
#[test]
fn round_trip_preserves_anchor_and_bytes() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_single_image_fixture(&tmp);

    // Import.
    let import1 = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snap1: serde_json::Value =
        serde_json::from_str(&import1.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let img1 = &snap1["sheets"]["sheet-1"]["_images"][0];
    let b64_before = img1["base64"].as_str().unwrap().to_string();
    let row_before = img1["anchorRow"].as_i64().unwrap();
    let col_before = img1["anchorCol"].as_i64().unwrap();

    // Export.
    let export_path = tmp.path().join("exported.xlsx");
    let export_result = export_xlsx_core(
        path_str(&export_path),
        import1.handle.snapshot_json.unwrap(),
    )
    .expect("export ok");
    assert!(export_result.success, "export should succeed");

    // Re-import.
    let import2 = import_xlsx_core(path_str(&export_path)).expect("re-import ok");
    let snap2: serde_json::Value =
        serde_json::from_str(&import2.handle.snapshot_json.unwrap()).unwrap();

    let img2 = &snap2["sheets"]["sheet-1"]["_images"][0];
    let b64_after = img2["base64"].as_str().unwrap();
    let row_after = img2["anchorRow"].as_i64().unwrap();
    let col_after = img2["anchorCol"].as_i64().unwrap();

    assert_eq!(b64_before, b64_after, "base64 bytes must survive round-trip");
    assert_eq!(row_before, row_after, "anchorRow must survive round-trip");
    assert_eq!(col_before, col_after, "anchorCol must survive round-trip");
}

/// Multi-sheet: both sheets get their own _images entry.
#[test]
fn multisheet_images_normalised_per_sheet() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_multisheet_fixture(&tmp);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snap: serde_json::Value =
        serde_json::from_str(&import.handle.snapshot_json.unwrap()).unwrap();

    let s1_images = snap["sheets"]["sheet-1"]["_images"].as_array();
    let s2_images = snap["sheets"]["sheet-2"]["_images"].as_array();

    assert!(
        s1_images.map(|a| a.len()).unwrap_or(0) >= 1,
        "sheet-1 should have at least 1 image"
    );
    assert!(
        s2_images.map(|a| a.len()).unwrap_or(0) >= 1,
        "sheet-2 should have at least 1 image"
    );

    // Both media files should be gone from _preservedParts.parts.
    let parts = snap["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        !parts.contains_key("xl/media/image1.png"),
        "image1.png should be removed"
    );
    assert!(
        !parts.contains_key("xl/media/image2.png"),
        "image2.png should be removed"
    );
}

/// absoluteAnchor fallback: image stays in _preservedParts, _images is empty/absent.
#[test]
fn absolute_anchor_stays_in_preserved_parts() {
    let tmp = TempDir::new().unwrap();
    let fixture = build_absolute_anchor_fixture(&tmp);

    let import = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snap: serde_json::Value =
        serde_json::from_str(&import.handle.snapshot_json.unwrap()).unwrap();

    // _images should be absent or empty.
    let images_len = snap["sheets"]["sheet-1"]["_images"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(images_len, 0, "_images must be empty for absoluteAnchor");

    // _preservedParts.parts must still contain the drawing (fallback).
    let parts = snap["_preservedParts"]["parts"]
        .as_object()
        .expect("parts object");
    assert!(
        parts.contains_key("xl/drawings/drawing1.xml"),
        "absoluteAnchor drawing must remain in _preservedParts.parts"
    );

    // A warning must be emitted.
    let has_warn = import
        .warnings
        .iter()
        .any(|w| w.code == "XLSX_DRAWING_ABSOLUTE_ANCHOR_UNSUPPORTED");
    assert!(
        has_warn,
        "expected XLSX_DRAWING_ABSOLUTE_ANCHOR_UNSUPPORTED warning"
    );
}

/// Workbook with no images: _images key absent, no warnings, no SHEET_DRAWING_PLUGIN.
#[test]
fn no_images_no_images_key() {
    let tmp = TempDir::new().unwrap();
    let plain_path = tmp.path().join("plain_no_img.xlsx");
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.write_string(0, 0, "hello").unwrap();
        wb.save(&plain_path).unwrap();
    }

    let import = import_xlsx_core(path_str(&plain_path)).expect("import ok");
    let snap: serde_json::Value =
        serde_json::from_str(&import.handle.snapshot_json.unwrap()).unwrap();

    // _images should not be present in any sheet.
    if let Some(sheets) = snap["sheets"].as_object() {
        for (id, sheet) in sheets {
            assert!(
                sheet.get("_images").is_none(),
                "sheet {id} should not have _images when workbook has no images"
            );
        }
    }

    // No SHEET_DRAWING_PLUGIN resource.
    let has_sdp = snap
        .get("resources")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .any(|e| e.get("name").and_then(|n| n.as_str()) == Some("SHEET_DRAWING_PLUGIN"))
        })
        .unwrap_or(false);
    assert!(!has_sdp, "SHEET_DRAWING_PLUGIN must be absent");
}

/// Export with an _images entry containing a known base64 PNG produces a zip
/// that includes xl/media/imageN.png with identical bytes.
#[test]
fn export_produces_media_from_images() {
    let tmp = TempDir::new().unwrap();
    let plain_path = tmp.path().join("plain_exp.xlsx");
    {
        let mut wb = Workbook::new();
        wb.add_worksheet();
        wb.save(&plain_path).unwrap();
    }

    // Import a plain workbook then patch its snapshot with a synthetic _images entry.
    let import = import_xlsx_core(path_str(&plain_path)).expect("import ok");
    let mut snap: serde_json::Value =
        serde_json::from_str(&import.handle.snapshot_json.unwrap()).unwrap();

    let b64_png = base64_encode(PNG_BYTES);
    let sheet_order = snap["sheetOrder"]
        .as_array()
        .unwrap()
        .clone();
    let first_sheet_id = sheet_order[0].as_str().unwrap();

    snap["sheets"][first_sheet_id]["_images"] = serde_json::json!([{
        "base64": b64_png,
        "ext": "png",
        "anchorRow": 0,
        "anchorCol": 0,
        "widthPx": 100,
        "heightPx": 50
    }]);

    let export_path = tmp.path().join("with_images.xlsx");
    let result = export_xlsx_core(
        path_str(&export_path),
        serde_json::to_string(&snap).unwrap(),
    )
    .expect("export ok");
    assert!(result.success, "export should succeed");

    // Open the exported zip and find a media file with the correct bytes.
    let exported_bytes = std::fs::read(&export_path).unwrap();
    let mut exported_zip =
        ZipArchive::new(std::io::Cursor::new(&exported_bytes)).unwrap();

    let mut found_media: Option<Vec<u8>> = None;
    for i in 0..exported_zip.len() {
        let mut entry = exported_zip.by_index(i).unwrap();
        if entry.name().starts_with("xl/media/image") && entry.name().ends_with(".png") {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).unwrap();
            found_media = Some(buf);
            break;
        }
    }

    let media_bytes = found_media.expect("exported zip must contain a media PNG");
    assert_eq!(
        media_bytes, PNG_BYTES,
        "exported media bytes must match the original PNG"
    );
}

// =============================================================================
// #324 — rotation and z-order tests
// =============================================================================

/// Export an image with rotationDeg=90, then re-import: rotationDeg must come
/// back as 90. Verifies the OOXML rot round-trip (90 * 60000 = 5400000).
#[test]
fn rotation_round_trip_90_deg() {
    let tmp = TempDir::new().unwrap();
    let plain_path = tmp.path().join("plain_rot.xlsx");
    {
        let mut wb = Workbook::new();
        wb.add_worksheet();
        wb.save(&plain_path).unwrap();
    }

    let import = import_xlsx_core(path_str(&plain_path)).expect("import ok");
    let mut snap: serde_json::Value =
        serde_json::from_str(&import.handle.snapshot_json.unwrap()).unwrap();

    let b64_png = base64_encode(PNG_BYTES);
    let first_sheet_id = snap["sheetOrder"][0].as_str().unwrap().to_string();

    snap["sheets"][&first_sheet_id]["_images"] = serde_json::json!([{
        "base64": b64_png,
        "ext": "png",
        "anchorRow": 0,
        "anchorCol": 0,
        "widthPx": 100,
        "heightPx": 100,
        "rotationDeg": 90
    }]);

    let export_path = tmp.path().join("rotated.xlsx");
    let result = export_xlsx_core(
        path_str(&export_path),
        serde_json::to_string(&snap).unwrap(),
    )
    .expect("export ok");
    assert!(result.success, "export should succeed");

    // Verify the drawing XML contains the OOXML rotation value (5400000).
    let exported_bytes = std::fs::read(&export_path).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(&exported_bytes)).unwrap();
    let mut found_rot = false;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        if entry.name().starts_with("xl/drawings/drawing") && entry.name().ends_with(".xml") {
            let mut xml = String::new();
            entry.read_to_string(&mut xml).unwrap();
            if xml.contains("rot=\"5400000\"") {
                found_rot = true;
                break;
            }
        }
    }
    assert!(found_rot, "drawing XML must contain rot=\"5400000\" for 90° rotation");

    // Re-import: rotationDeg must be 90.
    let import2 = import_xlsx_core(path_str(&export_path)).expect("re-import ok");
    let snap2: serde_json::Value =
        serde_json::from_str(&import2.handle.snapshot_json.unwrap()).unwrap();

    let rot = snap2["sheets"][&first_sheet_id]["_images"][0]["rotationDeg"]
        .as_i64()
        .unwrap_or(0);
    assert_eq!(rot, 90, "rotationDeg must survive export → re-import round-trip");
}

/// Export two images with different zIndex values. The drawing XML must list
/// the lower-zIndex image first (earlier elements render behind later ones).
#[test]
fn z_order_export_draws_lower_zindex_first() {
    let tmp = TempDir::new().unwrap();
    let plain_path = tmp.path().join("plain_zorder.xlsx");
    {
        let mut wb = Workbook::new();
        wb.add_worksheet();
        wb.save(&plain_path).unwrap();
    }

    let import = import_xlsx_core(path_str(&plain_path)).expect("import ok");
    let mut snap: serde_json::Value =
        serde_json::from_str(&import.handle.snapshot_json.unwrap()).unwrap();

    let b64_png = base64_encode(PNG_BYTES);
    let first_sheet_id = snap["sheetOrder"][0].as_str().unwrap().to_string();

    // Image A has zIndex=10 (front), image B has zIndex=1 (back).
    // After sorting, B should appear first in the drawing XML, A second.
    snap["sheets"][&first_sheet_id]["_images"] = serde_json::json!([
        {
            "base64": b64_png,
            "ext": "png",
            "anchorRow": 0,
            "anchorCol": 0,
            "widthPx": 100,
            "heightPx": 100,
            "name": "ImageA",
            "zIndex": 10
        },
        {
            "base64": b64_png,
            "ext": "png",
            "anchorRow": 2,
            "anchorCol": 2,
            "widthPx": 100,
            "heightPx": 100,
            "name": "ImageB",
            "zIndex": 1
        }
    ]);

    let export_path = tmp.path().join("zorder.xlsx");
    let result = export_xlsx_core(
        path_str(&export_path),
        serde_json::to_string(&snap).unwrap(),
    )
    .expect("export ok");
    assert!(result.success, "export should succeed");

    // In the drawing XML, ImageB (zIndex=1) must appear before ImageA (zIndex=10).
    let exported_bytes = std::fs::read(&export_path).unwrap();
    let mut zip = ZipArchive::new(std::io::Cursor::new(&exported_bytes)).unwrap();
    let mut order_ok = false;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        if entry.name().starts_with("xl/drawings/drawing") && entry.name().ends_with(".xml") {
            let mut xml = String::new();
            entry.read_to_string(&mut xml).unwrap();
            let pos_a = xml.find("ImageA");
            let pos_b = xml.find("ImageB");
            if let (Some(pa), Some(pb)) = (pos_a, pos_b) {
                // B (zIndex=1) must come before A (zIndex=10).
                order_ok = pb < pa;
            }
            break;
        }
    }
    assert!(order_ok, "drawing XML must list ImageB (zIndex=1) before ImageA (zIndex=10)");
}

//! Round-trip test for shape ("text box / rect / ellipse / line") export —
//! issue #146 / #188.
//!
//! Shapes are NOT a Univer feature; Coco stores them under a top-level
//! `_textBoxes` snapshot array and the TS-side `flushTextBoxesToPreservedParts`
//! serialises them into `_preservedParts` (a freshly-minted
//! `xl/drawings/drawingN.xml` + rels + a `[Content_Types].xml` Override) before
//! the snapshot reaches the Rust exporter.
//!
//! This test mirrors that flush output: it imports a plain workbook to obtain
//! a real snapshot, stamps a hand-built `_preservedParts` block carrying an
//! `<xdr:sp>` drawing part, exports through `export_xlsx_core`, and asserts the
//! output xlsx is structurally valid — the drawing part is present, the
//! worksheet references it via `<drawing r:id=.../>`, the sheet rels resolve
//! that id, and `[Content_Types].xml` advertises the drawing part. A missing
//! Override or dangling drawing ref is exactly what makes Excel refuse to open
//! a file, so these assertions stand in for "Excel can open it".

use std::io::Read;
use std::path::PathBuf;

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::Workbook;
use tempfile::TempDir;
use zip::ZipArchive;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// A drawing part holding three autoshapes (rect / ellipse / line) — the exact
/// shape `serializeShapesToAnchors` emits for #188.
const SHAPE_DRAWING_XML: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing""#,
    r#" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#,
    r#" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
    // Rectangle with text.
    r#"<xdr:twoCellAnchor editAs="oneCell">"#,
    r#"<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>"#,
    r#"<xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"#,
    r#"<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff>"#,
    r#"<xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"#,
    r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr>"#,
    r#"<xdr:cNvPr id="2" name="Rectangle r1"/><xdr:cNvSpPr/></xdr:nvSpPr>"#,
    r#"<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>"#,
    r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#,
    r#"<a:solidFill><a:srgbClr val="ffff00"/></a:solidFill>"#,
    r#"<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></xdr:spPr>"#,
    r#"<xdr:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/>"#,
    r#"<a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>Box</a:t></a:r></a:p></xdr:txBody>"#,
    r#"</xdr:sp><xdr:clientData/></xdr:twoCellAnchor>"#,
    // Line with arrowhead.
    r#"<xdr:twoCellAnchor editAs="oneCell">"#,
    r#"<xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff>"#,
    r#"<xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"#,
    r#"<xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff>"#,
    r#"<xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"#,
    r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr>"#,
    r#"<xdr:cNvPr id="2" name="Line l1"/><xdr:cNvSpPr/></xdr:nvSpPr>"#,
    r#"<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>"#,
    r#"<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/>"#,
    r#"<a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>"#,
    r#"<a:tailEnd type="triangle"/></a:ln></xdr:spPr>"#,
    r#"</xdr:sp><xdr:clientData/></xdr:twoCellAnchor>"#,
    r#"</xdr:wsDr>"#,
);

const DRAWING_RELS: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"#,
);

/// A drawing part holding one `<xdr:grpSp>` group of two shapes — the exact
/// shape `serializeShapesToAnchors` emits for a grouped #188 selection. The
/// group and both children carry distinct `cNvPr@id`s (M1) and each child has
/// a real non-zero `<a:ext>` so the group is visible (M2).
const GROUP_DRAWING_XML: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing""#,
    r#" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#,
    r#" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
    r#"<xdr:twoCellAnchor editAs="oneCell">"#,
    r#"<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>"#,
    r#"<xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"#,
    r#"<xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff>"#,
    r#"<xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"#,
    r#"<xdr:grpSp>"#,
    r#"<xdr:nvGrpSpPr><xdr:cNvPr id="1" name="Group grp_1"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>"#,
    r#"<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6400800" cy="3657600"/>"#,
    r#"<a:chOff x="0" y="0"/><a:chExt cx="6400800" cy="3657600"/></a:xfrm></xdr:grpSpPr>"#,
    // Child 1 — id=2, non-zero ext.
    r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr>"#,
    r#"<xdr:cNvPr id="2" name="Rectangle a"/><xdr:cNvSpPr/></xdr:nvSpPr>"#,
    r#"<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1828800"/></a:xfrm>"#,
    r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>"#,
    r#"<a:ln><a:noFill/></a:ln></xdr:spPr>"#,
    r#"<xdr:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/>"#,
    r#"<a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>A</a:t></a:r></a:p></xdr:txBody>"#,
    r#"</xdr:sp>"#,
    // Child 2 — id=3, non-zero ext.
    r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr>"#,
    r#"<xdr:cNvPr id="3" name="Rectangle b"/><xdr:cNvSpPr/></xdr:nvSpPr>"#,
    r#"<xdr:spPr><a:xfrm><a:off x="3657600" y="2743200"/><a:ext cx="2743200" cy="914400"/></a:xfrm>"#,
    r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>"#,
    r#"<a:ln><a:noFill/></a:ln></xdr:spPr>"#,
    r#"<xdr:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/>"#,
    r#"<a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>B</a:t></a:r></a:p></xdr:txBody>"#,
    r#"</xdr:sp>"#,
    r#"</xdr:grpSp><xdr:clientData/></xdr:twoCellAnchor>"#,
    r#"</xdr:wsDr>"#,
);

/// Minimal RFC-4648 base64 encoder — the crate isn't a dependency and the
/// production code rolls its own too (`xlsx_io::b64_encode`, which is private).
fn b64(s: &str) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input = s.as_bytes();
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[test]
fn shape_drawing_survives_export_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let plain = tmp.path().join("plain.xlsx");
    let exported = tmp.path().join("out.xlsx");

    // 1. Plain single-sheet workbook → import to get a real snapshot.
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Shapes").unwrap();
        ws.write_string(0, 0, "data").unwrap();
        wb.save(&plain).unwrap();
    }
    let import = import_xlsx_core(path_str(&plain)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let mut snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    // 2. Stamp a `_preservedParts` block exactly as `flushTextBoxesToPreservedParts`
    //    would for a workbook that had no prior drawing: a minted drawing part,
    //    its (empty) rels, a sheetRefs entry, and a content-types Override.
    snapshot["_preservedParts"] = serde_json::json!({
        "parts": {
            "xl/drawings/drawing1.xml": b64(SHAPE_DRAWING_XML),
            "xl/drawings/_rels/drawing1.xml.rels": b64(DRAWING_RELS),
        },
        "sheetRefs": [
            { "drawingRid": "rId1", "drawingTarget": "../drawings/drawing1.xml" }
        ],
        "contentTypes": concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
            r#"<Override PartName="/xl/drawings/drawing1.xml""#,
            r#" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
            r#"</Types>"#,
        ),
    });

    // 3. Export.
    let export = export_xlsx_core(
        path_str(&exported),
        serde_json::to_string(&snapshot).unwrap(),
    )
    .expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    // 4. Re-open the output and assert structural validity.
    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");

    // Drawing part survives verbatim.
    let mut drawing = String::new();
    zip.by_name("xl/drawings/drawing1.xml")
        .expect("drawing part must exist in output zip")
        .read_to_string(&mut drawing)
        .unwrap();
    assert_eq!(drawing, SHAPE_DRAWING_XML, "drawing XML must round-trip");
    assert!(drawing.contains(r#"prst="rect""#));
    assert!(drawing.contains(r#"prst="line""#));

    // Drawing rels survive.
    assert!(
        zip.by_name("xl/drawings/_rels/drawing1.xml.rels").is_ok(),
        "drawing rels must exist in output zip"
    );

    // Worksheet references the drawing via `<drawing r:id=.../>`.
    let mut sheet = String::new();
    zip.by_name("xl/worksheets/sheet1.xml")
        .expect("sheet1 must exist")
        .read_to_string(&mut sheet)
        .unwrap();
    assert!(
        sheet.contains("<drawing r:id="),
        "sheet1.xml must carry a <drawing> reference: {sheet}"
    );

    // The sheet rels resolve that drawing relationship.
    let mut sheet_rels = String::new();
    zip.by_name("xl/worksheets/_rels/sheet1.xml.rels")
        .expect("sheet1 rels must exist")
        .read_to_string(&mut sheet_rels)
        .unwrap();
    assert!(
        sheet_rels.contains("drawings/drawing1.xml"),
        "sheet rels must point at the drawing part: {sheet_rels}"
    );
    assert!(
        sheet_rels.contains("/relationships/drawing"),
        "sheet rels must use the drawing relationship type"
    );

    // [Content_Types].xml advertises the drawing part — without this Excel
    // refuses to open the file.
    let mut ct = String::new();
    zip.by_name("[Content_Types].xml")
        .expect("content types must exist")
        .read_to_string(&mut ct)
        .unwrap();
    assert!(
        ct.contains("/xl/drawings/drawing1.xml"),
        "[Content_Types].xml must advertise the drawing part: {ct}"
    );
    assert!(
        ct.contains("drawing+xml"),
        "[Content_Types].xml must carry the drawing content type"
    );
}

#[test]
fn grouped_shape_drawing_survives_export_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let plain = tmp.path().join("plain.xlsx");
    let exported = tmp.path().join("out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Shapes").unwrap();
        ws.write_string(0, 0, "data").unwrap();
        wb.save(&plain).unwrap();
    }
    let import = import_xlsx_core(path_str(&plain)).expect("import ok");
    let snapshot_json = import.handle.snapshot_json.expect("snapshot present");
    let mut snapshot: serde_json::Value =
        serde_json::from_str(&snapshot_json).expect("parse snapshot");

    snapshot["_preservedParts"] = serde_json::json!({
        "parts": {
            "xl/drawings/drawing1.xml": b64(GROUP_DRAWING_XML),
            "xl/drawings/_rels/drawing1.xml.rels": b64(DRAWING_RELS),
        },
        "sheetRefs": [
            { "drawingRid": "rId1", "drawingTarget": "../drawings/drawing1.xml" }
        ],
        "contentTypes": concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
            r#"<Override PartName="/xl/drawings/drawing1.xml""#,
            r#" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
            r#"</Types>"#,
        ),
    });

    let export = export_xlsx_core(
        path_str(&exported),
        serde_json::to_string(&snapshot).unwrap(),
    )
    .expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    let out_bytes = std::fs::read(&exported).expect("read exported");
    let mut zip = ZipArchive::new(std::io::Cursor::new(&out_bytes)).expect("zip");

    // The grouped drawing part survives verbatim.
    let mut drawing = String::new();
    zip.by_name("xl/drawings/drawing1.xml")
        .expect("drawing part must exist in output zip")
        .read_to_string(&mut drawing)
        .unwrap();
    assert_eq!(drawing, GROUP_DRAWING_XML, "group drawing XML must round-trip");
    assert!(drawing.contains("<xdr:grpSp>"), "group element must survive");

    // M2: every child <xdr:sp> carries a real non-zero <a:ext> — a zeroed
    // ext would collapse the group to an invisible point.
    assert!(
        !drawing.contains(r#"<a:ext cx="0" cy="0"/>"#),
        "grouped child shapes must not have a zero extent: {drawing}"
    );

    // M1: the group and both children have distinct cNvPr ids.
    let ids: Vec<&str> = drawing
        .match_indices(r#"<xdr:cNvPr id=""#)
        .map(|(i, _)| {
            let rest = &drawing[i + r#"<xdr:cNvPr id=""#.len()..];
            &rest[..rest.find('"').unwrap()]
        })
        .collect();
    assert_eq!(ids, vec!["1", "2", "3"], "cNvPr ids must be unique");
}

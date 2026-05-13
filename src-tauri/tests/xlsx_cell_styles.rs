use coco_lib::commands::xlsx_io::{import_xlsx_core, workbook_export_xlsx};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatPattern, Workbook};
use serde_json::Value;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Parse the cellXfs of a freshly-written xlsx by walking the ZIP for xl/styles.xml.
/// Returns Vec<(font_xml, fill_xml)> for each cellXfs entry so tests can assert
/// the produced format actually contains the expected bold/color/alignment.
fn read_styles_artifacts(path: &PathBuf) -> (String, Vec<(usize, usize, String)>) {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;
    let f = File::open(path).expect("open xlsx for styles read");
    let mut z = ZipArchive::new(f).expect("zip");
    let mut styles = String::new();
    z.by_name("xl/styles.xml")
        .expect("styles.xml present")
        .read_to_string(&mut styles)
        .expect("read styles");

    // Extract each xf entry inside cellXfs as (fontId, fillId, raw_xf_xml).
    let block = styles
        .split("<cellXfs")
        .nth(1)
        .and_then(|s| s.split("</cellXfs>").next())
        .unwrap_or("")
        .to_string();

    let mut out = Vec::new();
    // Each xf is `<xf ... />` or `<xf ...>...</xf>`. We're after the attributes.
    let mut cursor = 0;
    let bytes = block.as_bytes();
    while cursor < bytes.len() {
        // find next "<xf"
        let rest = &block[cursor..];
        let idx = match rest.find("<xf") {
            Some(i) => i,
            None => break,
        };
        let start = cursor + idx;
        // find closing '>'
        let end = match block[start..].find('>') {
            Some(p) => start + p,
            None => break,
        };
        let xf_open = &block[start..=end];
        // Walk forward to find either self-close or </xf>
        let xf_full = if bytes.get(end - 1) == Some(&b'/') {
            xf_open.to_string()
        } else {
            let close_idx = match block[end..].find("</xf>") {
                Some(p) => end + p + "</xf>".len(),
                None => end + 1,
            };
            block[start..close_idx].to_string()
        };

        let font_id = extract_attr(xf_open, "fontId")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        let fill_id = extract_attr(xf_open, "fillId")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        out.push((font_id, fill_id, xf_full));
        cursor = if bytes.get(end - 1) == Some(&b'/') {
            end + 1
        } else {
            // jump past </xf>
            match block[end..].find("</xf>") {
                Some(p) => end + p + "</xf>".len(),
                None => end + 1,
            }
        };
    }

    (styles, out)
}

fn extract_attr(s: &str, name: &str) -> Option<String> {
    let needle = format!("{}=\"", name);
    let i = s.find(&needle)?;
    let start = i + needle.len();
    let end = s[start..].find('"')? + start;
    Some(s[start..end].to_string())
}

/// Build a fixture using rust_xlsxwriter with the given format applied to cell (0,0)
/// labeled "X", and a plain string "Y" at (0,1) so we can assert "plain cells stay
/// styleless".
fn build_fixture(path: &PathBuf, fmt: &Format) {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("Data").expect("name");
    ws.write_string_with_format(0, 0, "X", fmt).expect("X");
    ws.write_string(0, 1, "Y").expect("Y");
    ws.write_string(1, 0, "Z").expect("Z");
    wb.save(path).expect("save fixture");
}

#[test]
fn bold_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("bold.xlsx");
    let exported = tmp.path().join("bold_exported.xlsx");

    let fmt = Format::new().set_bold();
    build_fixture(&fixture, &fmt);

    // Import
    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    // X at (0,0) should reference a style; Y at (0,1) should not.
    let a1 = &snapshot["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let b1 = &snapshot["sheets"]["sheet-1"]["cellData"]["0"]["1"];
    let s_id = a1
        .get("s")
        .and_then(|v| v.as_str())
        .expect("A1 should have a style id");
    assert!(b1.get("s").is_none(), "B1 should not have a style id");

    // Styles map should mark this id as bold.
    let style_obj = &snapshot["styles"][s_id];
    assert_eq!(
        style_obj["font"]["bold"], true,
        "style {} should be bold, got {}",
        s_id, style_obj
    );

    // Export and verify the resulting xlsx has a bold font entry referenced from cellXfs.
    let export_res =
        workbook_export_xlsx(path_str(&exported), snapshot_json).expect("export");
    assert!(export_res.success, "export should succeed: {:?}", export_res.error);

    let (styles_xml, xfs) = read_styles_artifacts(&exported);
    // The xf that A1 uses should have a fontId pointing to a font that has <b/>.
    // Find any xf whose fontId resolves to a bold font in the fonts block.
    assert!(
        styles_xml.contains("<b/>") || styles_xml.contains("<b "),
        "styles.xml should contain a bold font entry. got: {}",
        styles_xml
    );
    // And at least one cellXfs entry must reference a non-default fontId.
    assert!(
        xfs.iter().any(|(font_id, _, _)| *font_id > 0),
        "expected at least one cellXfs entry with non-default fontId"
    );
}

#[test]
fn background_color_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fill.xlsx");
    let exported = tmp.path().join("fill_exported.xlsx");

    let fmt = Format::new()
        .set_background_color(Color::RGB(0xFFFF00))
        .set_pattern(FormatPattern::Solid);
    build_fixture(&fixture, &fmt);

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let a1 = &snapshot["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let s_id = a1
        .get("s")
        .and_then(|v| v.as_str())
        .expect("A1 should have a style id");

    let style_obj = &snapshot["styles"][s_id];
    let color = style_obj["fill"]["color"]
        .as_str()
        .unwrap_or("");
    assert_eq!(
        color.to_ascii_uppercase(),
        "#FFFF00",
        "fill color should be yellow, got {}",
        color
    );

    let export_res =
        workbook_export_xlsx(path_str(&exported), snapshot_json).expect("export");
    assert!(export_res.success, "export should succeed: {:?}", export_res.error);

    let (styles_xml, _xfs) = read_styles_artifacts(&exported);
    // Excel solid fill stores color in <fgColor rgb="FFFFFF00"/>.
    assert!(
        styles_xml.contains("FFFFFF00") || styles_xml.contains("FFFFFF0"),
        "exported styles.xml should reference yellow fill, got: {}",
        styles_xml
    );
}

#[test]
fn horizontal_alignment_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("align.xlsx");
    let exported = tmp.path().join("align_exported.xlsx");

    let fmt = Format::new().set_align(FormatAlign::Center);
    build_fixture(&fixture, &fmt);

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let a1 = &snapshot["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let s_id = a1
        .get("s")
        .and_then(|v| v.as_str())
        .expect("A1 should have a style id");

    let style_obj = &snapshot["styles"][s_id];
    assert_eq!(
        style_obj["alignment"]["horizontal"], "center",
        "horizontal alignment should be 'center', got {}",
        style_obj
    );

    let export_res =
        workbook_export_xlsx(path_str(&exported), snapshot_json).expect("export");
    assert!(export_res.success, "export should succeed: {:?}", export_res.error);

    let (styles_xml, _xfs) = read_styles_artifacts(&exported);
    assert!(
        styles_xml.contains("horizontal=\"center\""),
        "exported styles.xml should contain horizontal=\"center\", got: {}",
        styles_xml
    );
}

#[test]
fn styleless_cells_have_no_s_field_and_styles_map_stays_small() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("plain.xlsx");

    // Build a fixture with all-plain cells AND a few bold cells. Many cells share
    // the same bold style → styles map should have exactly 1 entry, not 1 per cell.
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Plain").expect("name");
        ws.write_string(0, 0, "plain1").expect("p1");
        ws.write_string(0, 1, "plain2").expect("p2");
        ws.write_string(1, 0, "plain3").expect("p3");

        let bold = Format::new().set_bold();
        ws.write_string_with_format(2, 0, "b1", &bold).expect("b1");
        ws.write_string_with_format(2, 1, "b2", &bold).expect("b2");
        ws.write_string_with_format(3, 0, "b3", &bold).expect("b3");

        wb.save(&fixture).expect("save fixture");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    // Plain cells should have NO `s` field.
    let cell00 = &snapshot["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let cell01 = &snapshot["sheets"]["sheet-1"]["cellData"]["0"]["1"];
    let cell10 = &snapshot["sheets"]["sheet-1"]["cellData"]["1"]["0"];
    assert!(cell00.get("s").is_none(), "plain (0,0) should have no s field, got {}", cell00);
    assert!(cell01.get("s").is_none(), "plain (0,1) should have no s field, got {}", cell01);
    assert!(cell10.get("s").is_none(), "plain (1,0) should have no s field, got {}", cell10);

    // Bold cells should all share ONE style id.
    let b1_s = snapshot["sheets"]["sheet-1"]["cellData"]["2"]["0"]["s"]
        .as_str()
        .expect("bold (2,0) should have s");
    let b2_s = snapshot["sheets"]["sheet-1"]["cellData"]["2"]["1"]["s"]
        .as_str()
        .expect("bold (2,1) should have s");
    let b3_s = snapshot["sheets"]["sheet-1"]["cellData"]["3"]["0"]["s"]
        .as_str()
        .expect("bold (3,0) should have s");
    assert_eq!(b1_s, b2_s, "shared bold cells should share a style id");
    assert_eq!(b2_s, b3_s, "shared bold cells should share a style id");

    // styles map should have exactly 1 entry.
    let styles_map = snapshot["styles"]
        .as_object()
        .expect("styles should be an object");
    assert_eq!(
        styles_map.len(),
        1,
        "styles map should have exactly 1 entry (one bold style); got {:?}",
        styles_map
    );
}

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Color, Format, FormatBorder, Workbook};
use serde_json::Value;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Pull `xl/styles.xml` out of a freshly-written xlsx so tests can grep for
/// border-related fragments.
fn read_styles_xml(path: &PathBuf) -> String {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;

    let f = File::open(path).expect("open xlsx for styles read");
    let mut z = ZipArchive::new(f).expect("zip");
    let mut s = String::new();
    z.by_name("xl/styles.xml")
        .expect("styles.xml present")
        .read_to_string(&mut s)
        .expect("read styles");
    s
}

/// Build a fixture: place `format` on B2 (row 1, col 1), and leave A1 / C3 as
/// plain styled-only cells so we can assert that the borders field gates on
/// actual content correctly.
fn build_fixture_at_b2(path: &PathBuf, fmt: &Format) {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("Data").expect("name");
    // A1 plain; B2 with the border format; C3 plain
    ws.write_string(0, 0, "A1").expect("A1");
    ws.write_string_with_format(1, 1, "B2", fmt).expect("B2");
    ws.write_string(2, 2, "C3").expect("C3");
    wb.save(path).expect("save fixture");
}

#[test]
fn thin_black_border_all_four_sides_roundtrip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("borders_all4.xlsx");
    let exported = tmp.path().join("borders_all4_exported.xlsx");

    let fmt = Format::new()
        .set_border_top(FormatBorder::Thin)
        .set_border_top_color(Color::RGB(0x000000))
        .set_border_bottom(FormatBorder::Thin)
        .set_border_bottom_color(Color::RGB(0x000000))
        .set_border_left(FormatBorder::Thin)
        .set_border_left_color(Color::RGB(0x000000))
        .set_border_right(FormatBorder::Thin)
        .set_border_right_color(Color::RGB(0x000000));
    build_fixture_at_b2(&fixture, &fmt);

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    // B2 = row 1, col 1
    let b2 = &snapshot["sheets"]["sheet-1"]["cellData"]["1"]["1"];
    let s_id = b2
        .get("s")
        .and_then(|v| v.as_str())
        .expect("B2 should have a style id");

    let borders = &snapshot["styles"][s_id]["borders"];
    assert!(
        borders.is_object(),
        "borders should be present, got: {snapshot}"
    );
    for side in ["top", "bottom", "left", "right"] {
        assert_eq!(
            borders[side]["style"], "thin",
            "side {side} should be thin, got {borders}"
        );
        let color = borders[side]["color"]
            .as_str()
            .unwrap_or("")
            .to_ascii_uppercase();
        assert_eq!(
            color, "#000000",
            "side {side} color should be black, got {color}"
        );
    }

    // Round-trip
    let export_res = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(
        export_res.success,
        "export should succeed: {:?}",
        export_res.error
    );

    let styles_xml = read_styles_xml(&exported);
    // After export, styles.xml should contain a <borders> block with a thin
    // style on at least the four sides.
    assert!(
        styles_xml.contains("<borders"),
        "exported styles.xml should contain a <borders> block: {styles_xml}"
    );
    for side in ["top", "bottom", "left", "right"] {
        assert!(
            styles_xml.contains(&format!("<{side} style=\"thin\"")),
            "exported styles.xml should contain a thin {side} border: {styles_xml}"
        );
    }
}

#[test]
fn only_top_border_one_sided() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("border_top.xlsx");
    let exported = tmp.path().join("border_top_exported.xlsx");

    let fmt = Format::new().set_border_top(FormatBorder::Thin);
    build_fixture_at_b2(&fixture, &fmt);

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let b2 = &snapshot["sheets"]["sheet-1"]["cellData"]["1"]["1"];
    let s_id = b2
        .get("s")
        .and_then(|v| v.as_str())
        .expect("B2 should have a style id");

    let borders = &snapshot["styles"][s_id]["borders"];
    assert!(borders.is_object(), "borders should be present");
    assert_eq!(borders["top"]["style"], "thin");
    assert!(
        borders.get("bottom").is_none(),
        "bottom side should be absent, got {borders}"
    );
    assert!(
        borders.get("left").is_none(),
        "left side should be absent, got {borders}"
    );
    assert!(
        borders.get("right").is_none(),
        "right side should be absent, got {borders}"
    );

    let export_res = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(
        export_res.success,
        "export should succeed: {:?}",
        export_res.error
    );

    let styles_xml = read_styles_xml(&exported);
    assert!(
        styles_xml.contains("<top style=\"thin\""),
        "exported styles.xml should keep the top thin border: {styles_xml}"
    );
}

#[test]
fn cells_without_borders_have_no_borders_field() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("no_borders.xlsx");

    // Build a fixture where only B2 is bold (no borders anywhere).
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Plain").expect("name");
        ws.write_string(0, 0, "A1").expect("A1");
        let bold = Format::new().set_bold();
        ws.write_string_with_format(1, 1, "B2", &bold).expect("B2");
        wb.save(&fixture).expect("save fixture");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let styles_map = snapshot["styles"]
        .as_object()
        .expect("styles should be object");
    for (sid, sval) in styles_map.iter() {
        assert!(
            sval.get("borders").is_none(),
            "style {sid} should NOT have a borders field, got {sval}"
        );
    }
}

#[test]
fn mixed_border_styles_per_side() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("borders_mixed.xlsx");
    let exported = tmp.path().join("borders_mixed_exported.xlsx");

    // Thin top, thick bottom, medium left, dashed right — each a different
    // style so we can confirm per-side resolution.
    let fmt = Format::new()
        .set_border_top(FormatBorder::Thin)
        .set_border_bottom(FormatBorder::Thick)
        .set_border_left(FormatBorder::Medium)
        .set_border_right(FormatBorder::Dashed);
    build_fixture_at_b2(&fixture, &fmt);

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let b2 = &snapshot["sheets"]["sheet-1"]["cellData"]["1"]["1"];
    let s_id = b2
        .get("s")
        .and_then(|v| v.as_str())
        .expect("B2 should have a style id");

    let borders = &snapshot["styles"][s_id]["borders"];
    assert_eq!(borders["top"]["style"], "thin", "got {borders}");
    assert_eq!(borders["bottom"]["style"], "thick", "got {borders}");
    assert_eq!(borders["left"]["style"], "medium", "got {borders}");
    assert_eq!(borders["right"]["style"], "dashed", "got {borders}");

    let export_res = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(
        export_res.success,
        "export should succeed: {:?}",
        export_res.error
    );

    let styles_xml = read_styles_xml(&exported);
    assert!(
        styles_xml.contains("<top style=\"thin\""),
        "missing top thin: {styles_xml}"
    );
    assert!(
        styles_xml.contains("<bottom style=\"thick\""),
        "missing bottom thick: {styles_xml}"
    );
    assert!(
        styles_xml.contains("<left style=\"medium\""),
        "missing left medium: {styles_xml}"
    );
    assert!(
        styles_xml.contains("<right style=\"dashed\""),
        "missing right dashed: {styles_xml}"
    );
}

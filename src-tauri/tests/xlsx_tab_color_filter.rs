//! Round-trip tests for per-sheet tab color and auto-filter range. Both
//! attributes are stored directly in the worksheet XML (`<sheetPr><tabColor/>`
//! and `<autoFilter ref=".."/>`). calamine doesn't expose them, so we read
//! straight from the parsed snapshot fields (`_tabColor` / `_autoFilter`) and
//! cross-check the on-disk XML after export.

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Color, Workbook};
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

fn read_sheet1_xml(path: &PathBuf) -> String {
    let file = std::fs::File::open(path).expect("open xlsx");
    let mut archive = zip::ZipArchive::new(file).expect("zip");
    let mut entry = archive
        .by_name("xl/worksheets/sheet1.xml")
        .expect("sheet1.xml");
    let mut xml = String::new();
    entry.read_to_string(&mut xml).expect("read xml");
    xml
}

#[test]
fn tab_color_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        // Plain red. rust_xlsxwriter writes <tabColor rgb="FFFF0000"/>.
        ws.set_tab_color(Color::RGB(0xFF0000));
        ws.write_number(0, 0, 1.0).unwrap();
        wb.save(&fixture).expect("save");
    }

    // Sanity-check the fixture actually has a tabColor.
    let fixture_xml = read_sheet1_xml(&fixture);
    assert!(
        fixture_xml.contains("<tabColor"),
        "fixture should contain <tabColor>; got:\n{fixture_xml}"
    );

    // Import → confirm the snapshot exposes _tabColor as "#RRGGBB".
    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let color = snap["sheets"]["sheet-1"]["_tabColor"]
        .as_str()
        .expect("_tabColor should be present on the sheet");
    assert_eq!(
        color.to_ascii_uppercase(),
        "#FF0000",
        "tabColor should normalize to #RRGGBB"
    );

    // Export → re-import → confirm the color survived intact.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let exported_xml = read_sheet1_xml(&exported);
    assert!(
        exported_xml.contains("<tabColor"),
        "exported sheet1.xml should contain <tabColor>; got:\n{exported_xml}"
    );

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(&re.handle.snapshot_json.unwrap()).expect("parse2");
    let re_color = re_snap["sheets"]["sheet-1"]["_tabColor"]
        .as_str()
        .expect("_tabColor should round-trip");
    assert_eq!(re_color.to_ascii_uppercase(), "#FF0000");
}

#[test]
fn auto_filter_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        // Populate a small data region so the autofilter range has cells under
        // it. Not required by rust_xlsxwriter, but mirrors realistic usage.
        ws.write_string(0, 0, "h1").unwrap();
        ws.write_string(0, 1, "h2").unwrap();
        ws.write_string(0, 2, "h3").unwrap();
        ws.write_string(0, 3, "h4").unwrap();
        ws.write_string(0, 4, "h5").unwrap();
        for r in 1..=9u32 {
            ws.write_number(r, 0, r as f64).unwrap();
        }
        ws.autofilter(0, 0, 9, 4).expect("set autofilter");
        wb.save(&fixture).expect("save");
    }

    // Sanity: fixture has <autoFilter ref="A1:E10"/>.
    let fixture_xml = read_sheet1_xml(&fixture);
    assert!(
        fixture_xml.contains("<autoFilter"),
        "fixture should contain <autoFilter>; got:\n{fixture_xml}"
    );

    // Import → snapshot._autoFilter is the original A1 ref.
    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let filter_ref = snap["sheets"]["sheet-1"]["_autoFilter"]
        .as_str()
        .expect("_autoFilter should be present on the sheet");
    assert_eq!(filter_ref, "A1:E10");

    // Export → re-import → range survived.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let exported_xml = read_sheet1_xml(&exported);
    assert!(
        exported_xml.contains("ref=\"A1:E10\""),
        "exported sheet1.xml should contain autoFilter ref=\"A1:E10\"; got:\n{exported_xml}"
    );

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(&re.handle.snapshot_json.unwrap()).expect("parse2");
    let re_ref = re_snap["sheets"]["sheet-1"]["_autoFilter"]
        .as_str()
        .expect("_autoFilter should round-trip");
    assert_eq!(re_ref, "A1:E10");
}

#[test]
fn defaults_omit_tab_color_and_auto_filter() {
    // Regression: a plain workbook with no tab color and no autofilter must
    // not acquire `_tabColor` / `_autoFilter` on the snapshot, and the
    // exported xlsx must not gain a stray <tabColor/> or <autoFilter/> tag.
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("plain.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "hello").unwrap();
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");

    assert!(
        snap["sheets"]["sheet-1"].get("_tabColor").is_none(),
        "plain sheet should not carry _tabColor; snap was {:?}",
        snap["sheets"]["sheet-1"]
    );
    assert!(
        snap["sheets"]["sheet-1"].get("_autoFilter").is_none(),
        "plain sheet should not carry _autoFilter; snap was {:?}",
        snap["sheets"]["sheet-1"]
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let exported_xml = read_sheet1_xml(&exported);
    assert!(
        !exported_xml.contains("<tabColor"),
        "exported plain sheet should not contain <tabColor>; got:\n{exported_xml}"
    );
    assert!(
        !exported_xml.contains("<autoFilter"),
        "exported plain sheet should not contain <autoFilter>; got:\n{exported_xml}"
    );
}

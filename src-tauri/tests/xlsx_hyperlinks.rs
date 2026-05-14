//! Round-trip tests for xlsx hyperlinks.
//!
//! Hyperlinks live in two xlsx parts: `xl/worksheets/sheetN.xml` carries the
//! `<hyperlinks>` block with the cell ref + optional display/tooltip, while
//! `xl/worksheets/_rels/sheetN.xml.rels` resolves each rId to a Target URL for
//! external links. Internal links use the `location` attribute on the
//! `<hyperlink>` element directly. We assert both shapes survive an import →
//! snapshot → export cycle, plus the regression that a clean workbook does not
//! grow an empty `_hyperlinks` array on round-trip.

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Url, Workbook};
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Pull a specific xml entry out of an xlsx zip. Returns the string or empty
/// when the entry is missing (e.g. a sheet with no rels file).
fn read_zip_entry(path: &PathBuf, name: &str) -> String {
    let file = std::fs::File::open(path).expect("open xlsx");
    let mut archive = zip::ZipArchive::new(file).expect("zip");
    let Ok(mut entry) = archive.by_name(name) else {
        return String::new();
    };
    let mut xml = String::new();
    entry.read_to_string(&mut xml).expect("read xml");
    xml
}

#[test]
fn external_hyperlink_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("ext.xlsx");
    let exported = tmp.path().join("ext_out.xlsx");

    // Build a fixture with one external https URL on A1 carrying a tooltip.
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let url = Url::new("https://www.rust-lang.org/")
            .set_text("Rust home")
            .set_tip("Open in browser");
        ws.write_url(0, 0, url).expect("write url");
        wb.save(&fixture).expect("save");
    }

    // Import → snapshot must carry the hyperlink under sheet._hyperlinks.
    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let links = snap["sheets"]["sheet-1"]["_hyperlinks"]
        .as_array()
        .expect("_hyperlinks should be present");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["cell"].as_str(), Some("A1"));
    assert_eq!(
        links[0]["target"].as_str(),
        Some("https://www.rust-lang.org/")
    );
    assert_eq!(links[0]["tooltip"].as_str(), Some("Open in browser"));

    // Export → re-import: link should still be there, same target + tooltip.
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    // Sanity-check the on-disk xml: per-sheet rels file should exist with the
    // URL we wrote.
    let rels = read_zip_entry(&exported, "xl/worksheets/_rels/sheet1.xml.rels");
    assert!(
        rels.contains("https://www.rust-lang.org"),
        "exported sheet1.xml.rels should carry the URL target; got:\n{rels}"
    );

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).expect("parse");
    let re_links = re_snap["sheets"]["sheet-1"]["_hyperlinks"]
        .as_array()
        .expect("_hyperlinks survives round-trip");
    assert_eq!(re_links.len(), 1);
    assert_eq!(re_links[0]["cell"].as_str(), Some("A1"));
    assert_eq!(
        re_links[0]["target"].as_str(),
        Some("https://www.rust-lang.org/")
    );
    assert_eq!(re_links[0]["tooltip"].as_str(), Some("Open in browser"));
}

#[test]
fn internal_hyperlink_round_trips() {
    // Internal links use rust_xlsxwriter's `internal:` pseudo-URI on input;
    // on disk OOXML writes them as a `location` attribute on the hyperlink
    // element (no rels file entry). Our snapshot normalizes them to `#...`.
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("int.xlsx");
    let exported = tmp.path().join("int_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws1 = wb.add_worksheet();
        ws1.set_name("Sheet1").unwrap();
        // Use a sheet name with a space so we exercise the single-quoted
        // worksheet name form Excel uses.
        ws1.write_url(0, 0, Url::new("internal:'Sheet 2'!A1"))
            .expect("write internal");
        let ws2 = wb.add_worksheet();
        ws2.set_name("Sheet 2").unwrap();
        ws2.write_string(0, 0, "target").unwrap();
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let links = snap["sheets"]["sheet-1"]["_hyperlinks"]
        .as_array()
        .expect("_hyperlinks should be present on sheet-1");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["cell"].as_str(), Some("A1"));
    let target = links[0]["target"].as_str().expect("target string");
    assert!(
        target.starts_with('#') && target.contains("Sheet 2") && target.contains("A1"),
        "internal target should be '#Sheet 2!A1'-ish, got {target}"
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).expect("parse");
    let re_links = re_snap["sheets"]["sheet-1"]["_hyperlinks"]
        .as_array()
        .expect("internal link survives round-trip");
    assert_eq!(re_links.len(), 1);
    assert_eq!(re_links[0]["cell"].as_str(), Some("A1"));
    let re_target = re_links[0]["target"].as_str().unwrap();
    assert!(
        re_target.starts_with('#') && re_target.contains("Sheet 2") && re_target.contains("A1"),
        "internal target should round-trip as '#Sheet 2!A1'-ish, got {re_target}"
    );
}

#[test]
fn no_hyperlinks_yields_no_hyperlinks_block() {
    // Regression: a clean workbook must NOT acquire an empty `_hyperlinks`
    // field on import, and the exported xlsx must NOT contain a stray
    // <hyperlinks> element or a sheet rels file referencing one.
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("clean.xlsx");
    let exported = tmp.path().join("clean_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "hi").unwrap();
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.unwrap();
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    assert!(
        snap["sheets"]["sheet-1"].get("_hyperlinks").is_none(),
        "sheets with no hyperlinks must not emit _hyperlinks: {}",
        snap["sheets"]["sheet-1"]
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let sheet_xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
    assert!(
        !sheet_xml.contains("<hyperlinks"),
        "clean sheet must not emit a <hyperlinks> block; got:\n{sheet_xml}"
    );
}

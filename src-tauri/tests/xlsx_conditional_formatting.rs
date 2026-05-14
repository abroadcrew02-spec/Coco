//! Round-trip tests for xlsx conditional formatting rules.
//!
//! Mirrors the data-validation test layout (xlsx_data_validation.rs): import →
//! snapshot → export → re-import, plus a no-CF regression so a clean file
//! doesn't accidentally pick up a `<conditionalFormatting>` block on export.

use coco_lib::commands::xlsx_io::{
    detect_unsupported_features, export_xlsx_core, import_xlsx_core,
};
use rust_xlsxwriter::{
    ConditionalFormatCell, ConditionalFormatCellRule, ConditionalFormatDuplicate,
    ConditionalFormatText, ConditionalFormatTextRule, ConditionalFormatTop, ConditionalFormatTopRule,
    Workbook,
};
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
    let mut entry = archive.by_name("xl/worksheets/sheet1.xml").expect("sheet1.xml");
    let mut xml = String::new();
    entry.read_to_string(&mut xml).expect("read xml");
    xml
}

#[test]
fn cell_is_greater_than_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_cell.xlsx");
    let exported = tmp.path().join("cf_cell_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let cf = ConditionalFormatCell::new()
            .set_rule(ConditionalFormatCellRule::GreaterThan(100));
        ws.add_conditional_format(0, 0, 9, 0, &cf).expect("add cf");
        wb.save(&fixture).expect("save");
    }

    // Sanity: the raw detector still sees CF in the source fixture.
    let raw = detect_unsupported_features(&path_str(&fixture)).expect("detect");
    assert!(
        raw.iter().any(|w| w.code == "XLSX_CONDITIONAL_FORMATTING"),
        "fixture should contain CF: {raw:?}"
    );

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    // After preservation lands, the import-time warning should be suppressed.
    assert!(
        !imported
            .warnings
            .iter()
            .any(|w| w.code == "XLSX_CONDITIONAL_FORMATTING"),
        "import should NOT emit XLSX_CONDITIONAL_FORMATTING once we round-trip: {:?}",
        imported.warnings
    );

    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let cfs = snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("_conditionalFormatting present");
    assert_eq!(cfs.len(), 1, "expected one CF rule");
    assert_eq!(cfs[0]["type"].as_str(), Some("cellIs"));
    assert_eq!(cfs[0]["operator"].as_str(), Some("greaterThan"));
    assert_eq!(cfs[0]["formula1"].as_str(), Some("100"));
    assert!(
        cfs[0]["sqref"].as_str().unwrap().contains("A1:A10"),
        "sqref preserved, got {}",
        cfs[0]["sqref"]
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_cfs = re_snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF survives round-trip");
    assert_eq!(re_cfs.len(), 1);
    assert_eq!(re_cfs[0]["type"].as_str(), Some("cellIs"));
    assert_eq!(re_cfs[0]["operator"].as_str(), Some("greaterThan"));
    assert_eq!(re_cfs[0]["formula1"].as_str(), Some("100"));
}

#[test]
fn contains_text_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_text.xlsx");
    let exported = tmp.path().join("cf_text_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let cf = ConditionalFormatText::new()
            .set_rule(ConditionalFormatTextRule::Contains("foo".into()));
        ws.add_conditional_format(0, 1, 4, 1, &cf).expect("add cf");
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let cfs = snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF present");
    assert_eq!(cfs.len(), 1);
    assert_eq!(cfs[0]["type"].as_str(), Some("containsText"));
    // The literal text Excel matches on. The attribute Excel writes is
    // `text="foo"`; the synthetic <formula> body is `NOT(ISERROR(SEARCH(...)))`
    // so we don't assert on formula1 here.
    assert_eq!(cfs[0]["text"].as_str(), Some("foo"));

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_cfs = re_snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF survives round-trip");
    assert_eq!(re_cfs.len(), 1);
    assert_eq!(re_cfs[0]["type"].as_str(), Some("containsText"));
    assert_eq!(re_cfs[0]["text"].as_str(), Some("foo"));
}

#[test]
fn top10_rule_round_trips() {
    // Top-5 rule: rust_xlsxwriter emits `<cfRule type="top10" rank="5">`. We
    // round-trip the rank and the bottom/percent flags through the snapshot.
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_top10.xlsx");
    let exported = tmp.path().join("cf_top10_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let cf = ConditionalFormatTop::new().set_rule(ConditionalFormatTopRule::Top(5));
        ws.add_conditional_format(0, 0, 9, 0, &cf).expect("add cf");
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let cfs = snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF present");
    assert_eq!(cfs.len(), 1);
    assert_eq!(cfs[0]["type"].as_str(), Some("top10"));
    assert_eq!(cfs[0]["rank"].as_u64(), Some(5));
    // Top(5) — not bottom, not percent — so those flags must be absent.
    assert!(cfs[0].get("bottom").is_none());
    assert!(cfs[0].get("percent").is_none());

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_cfs = re_snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF survives round-trip");
    assert_eq!(re_cfs.len(), 1);
    assert_eq!(re_cfs[0]["type"].as_str(), Some("top10"));
    assert_eq!(re_cfs[0]["rank"].as_u64(), Some(5));
    assert!(re_cfs[0].get("bottom").is_none());
}

#[test]
fn duplicate_values_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_dup.xlsx");
    let exported = tmp.path().join("cf_dup_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let cf = ConditionalFormatDuplicate::new();
        ws.add_conditional_format(0, 0, 4, 0, &cf).expect("add cf");
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let cfs = snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF present");
    assert_eq!(cfs.len(), 1);
    assert_eq!(cfs[0]["type"].as_str(), Some("duplicateValues"));

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_cfs = re_snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF survives round-trip");
    assert_eq!(re_cfs.len(), 1);
    assert_eq!(re_cfs[0]["type"].as_str(), Some("duplicateValues"));
}

#[test]
fn no_conditional_formatting_yields_no_block() {
    // Clean workbook (no CF) must round-trip without an empty/spurious
    // `<conditionalFormatting>` block sneaking into the export.
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
        snap["sheets"]["sheet-1"]
            .get("_conditionalFormatting")
            .is_none(),
        "clean sheet must not emit _conditionalFormatting: {}",
        snap["sheets"]["sheet-1"]
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert!(
        !xml.contains("<conditionalFormatting"),
        "clean sheet must not emit a <conditionalFormatting> block; got:\n{xml}"
    );
}

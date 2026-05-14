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

fn read_styles_xml(path: &PathBuf) -> String {
    let file = std::fs::File::open(path).expect("open xlsx");
    let mut archive = zip::ZipArchive::new(file).expect("zip");
    let mut entry = archive.by_name("xl/styles.xml").expect("styles.xml");
    let mut xml = String::new();
    entry.read_to_string(&mut xml).expect("read styles xml");
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

/// Authored CF rules carry a `style` bag from the dialog
/// (ConditionalFormattingDialog.tsx). On export we must translate that into a
/// rust_xlsxwriter `Format`, which then lands as a non-empty `<dxfs>` block in
/// `xl/styles.xml`. Without the style hookup the exported xlsx had an empty
/// `<dxfs count="0"/>` and Excel showed CF rules with no visible formatting.
#[test]
fn cf_rule_style_emits_dxf_on_export() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_style_in.xlsx");
    let exported = tmp.path().join("cf_style_out.xlsx");

    // Seed a clean workbook (no CF). We'll inject the rule + style via
    // snapshot mutation, which mirrors how the dialog produces rules in
    // production (authored client-side, no source dxf to parse).
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "x").unwrap();
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let mut snap: Value =
        serde_json::from_str(imported.handle.snapshot_json.as_ref().unwrap()).expect("parse");

    // Inject one authored cellIs>100 rule with a bgColor + bold style. This is
    // the exact JSON shape the dialog's submitForm produces.
    let rule = serde_json::json!({
        "sqref": "A1:A10",
        "type": "cellIs",
        "operator": "greaterThan",
        "formula1": "100",
        "priority": 1,
        "style": { "bold": true, "bgColor": "#FFE082" }
    });
    snap["sheets"]["sheet-1"]["_conditionalFormatting"] = Value::Array(vec![rule]);
    let mutated = serde_json::to_string(&snap).expect("ser");

    let export = export_xlsx_core(path_str(&exported), mutated).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    // The cfRule itself must reference a dxfId (rust_xlsxwriter assigns them
    // contiguously starting at 0).
    let sheet_xml = read_sheet1_xml(&exported);
    assert!(
        sheet_xml.contains("dxfId="),
        "exported cfRule should reference a dxfId; sheet1.xml:\n{sheet_xml}"
    );

    // And `xl/styles.xml` must carry a non-trivial `<dxfs>` block containing
    // the colour we asked for. The pattern fill colour shows up as
    // `bgColor rgb="FFFFE082"` (FF alpha prefix). We assert on the hex bytes
    // rather than the exact attribute layout to stay robust against
    // rust_xlsxwriter's emit tweaks.
    let styles_xml = read_styles_xml(&exported);
    assert!(
        styles_xml.contains("<dxfs"),
        "styles.xml should have a <dxfs> block; got:\n{styles_xml}"
    );
    assert!(
        !styles_xml.contains("<dxfs count=\"0\""),
        "styles.xml should NOT have an empty <dxfs> block; got:\n{styles_xml}"
    );
    assert!(
        styles_xml.to_uppercase().contains("FFE082"),
        "styles.xml dxf should encode bgColor #FFE082; got:\n{styles_xml}"
    );
}

/// colorScale CF rules use cfvo + color children that rust_xlsxwriter doesn't
/// model. We round-trip them as a verbatim `<cfRule>` XML splice. The fixture
/// is hand-crafted because rust_xlsxwriter can't write colorScale either —
/// build a minimal xlsx, then post-write the cfRule into sheet1.xml directly.
#[test]
fn color_scale_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_color_scale.xlsx");
    let exported = tmp.path().join("cf_color_scale_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_number(0, 0, 1.0).unwrap();
        ws.write_number(1, 0, 5.0).unwrap();
        ws.write_number(2, 0, 10.0).unwrap();
        wb.save(&fixture).expect("save");
    }
    inject_raw_cfrule(
        &fixture,
        "A1:A3",
        r#"<cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFCFCFF"/></colorScale></cfRule>"#,
    );

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let cfs = snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("_conditionalFormatting present");
    assert_eq!(cfs.len(), 1, "expected one CF rule");
    assert_eq!(cfs[0]["type"].as_str(), Some("colorScale"));
    let raw = cfs[0]["raw"].as_str().expect("raw payload present");
    assert!(
        raw.contains("colorScale") && raw.contains("F8696B"),
        "raw payload should preserve colorScale body, got: {raw}"
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    // Re-import: verify both the type and a piece of the inner payload
    // (gradient stop color) survive byte-for-byte.
    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_cfs = re_snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF survives round-trip");
    assert_eq!(re_cfs.len(), 1);
    assert_eq!(re_cfs[0]["type"].as_str(), Some("colorScale"));
    let re_raw = re_cfs[0]["raw"].as_str().expect("raw present on re-import");
    assert!(
        re_raw.contains("F8696B"),
        "color stop preserved on round-trip, got: {re_raw}"
    );

    // Sanity: the exported sheet XML must carry a <colorScale> element.
    let sheet_xml = read_sheet1_xml(&exported);
    assert!(
        sheet_xml.contains("<colorScale"),
        "exported sheet1.xml must contain <colorScale>; got:\n{sheet_xml}"
    );
}

/// dataBar CF rules use cfvo + color children that rust_xlsxwriter doesn't
/// model. Round-trip via the same verbatim XML splice path.
#[test]
fn data_bar_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_data_bar.xlsx");
    let exported = tmp.path().join("cf_data_bar_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_number(0, 0, 1.0).unwrap();
        ws.write_number(1, 0, 5.0).unwrap();
        ws.write_number(2, 0, 10.0).unwrap();
        wb.save(&fixture).expect("save");
    }
    inject_raw_cfrule(
        &fixture,
        "A1:A3",
        r#"<cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule>"#,
    );

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let cfs = snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF present");
    assert_eq!(cfs.len(), 1);
    assert_eq!(cfs[0]["type"].as_str(), Some("dataBar"));
    assert!(cfs[0]["raw"].as_str().unwrap().contains("638EC6"));

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_cfs = re_snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF survives round-trip");
    assert_eq!(re_cfs.len(), 1);
    assert_eq!(re_cfs[0]["type"].as_str(), Some("dataBar"));
    assert!(re_cfs[0]["raw"].as_str().unwrap().contains("638EC6"));

    let sheet_xml = read_sheet1_xml(&exported);
    assert!(
        sheet_xml.contains("<dataBar"),
        "exported sheet1.xml must contain <dataBar>; got:\n{sheet_xml}"
    );
}

/// iconSet CF rules carry an `iconSet@iconSet` attribute (e.g.
/// `3TrafficLights1`) plus per-threshold cfvo children. Same verbatim splice
/// strategy as colorScale / dataBar.
#[test]
fn icon_set_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_icon_set.xlsx");
    let exported = tmp.path().join("cf_icon_set_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_number(0, 0, 1.0).unwrap();
        ws.write_number(1, 0, 5.0).unwrap();
        ws.write_number(2, 0, 10.0).unwrap();
        wb.save(&fixture).expect("save");
    }
    inject_raw_cfrule(
        &fixture,
        "A1:A3",
        r#"<cfRule type="iconSet" priority="1"><iconSet iconSet="3TrafficLights1"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule>"#,
    );

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let cfs = snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF present");
    assert_eq!(cfs.len(), 1);
    assert_eq!(cfs[0]["type"].as_str(), Some("iconSet"));
    assert!(cfs[0]["raw"].as_str().unwrap().contains("3TrafficLights1"));

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_cfs = re_snap["sheets"]["sheet-1"]["_conditionalFormatting"]
        .as_array()
        .expect("CF survives round-trip");
    assert_eq!(re_cfs.len(), 1);
    assert_eq!(re_cfs[0]["type"].as_str(), Some("iconSet"));
    assert!(re_cfs[0]["raw"].as_str().unwrap().contains("3TrafficLights1"));

    let sheet_xml = read_sheet1_xml(&exported);
    assert!(
        sheet_xml.contains("<iconSet"),
        "exported sheet1.xml must contain <iconSet>; got:\n{sheet_xml}"
    );
}

/// Test helper: splice a raw `<cfRule>` element into `sheet1.xml` of an
/// existing xlsx by wrapping it in a `<conditionalFormatting sqref="...">`
/// block. Used to hand-craft fixtures for rule types (colorScale / dataBar /
/// iconSet) that rust_xlsxwriter cannot emit. Inserts the block just before
/// `</worksheet>`, which Excel accepts even though the strict OOXML schema
/// wants it before pageMargins/etc.
fn inject_raw_cfrule(xlsx_path: &PathBuf, sqref: &str, cf_rule_xml: &str) {
    use std::io::{Cursor, Read, Write};

    let bytes = std::fs::read(xlsx_path).expect("read xlsx");
    let mut archive =
        zip::ZipArchive::new(Cursor::new(&bytes)).expect("open xlsx zip");

    let mut sheet_xml = String::new();
    {
        let mut entry = archive.by_name("xl/worksheets/sheet1.xml").expect("sheet1.xml");
        entry.read_to_string(&mut sheet_xml).expect("read sheet xml");
    }

    let block =
        format!(r#"<conditionalFormatting sqref="{sqref}">{cf_rule_xml}</conditionalFormatting>"#);
    // Insert before the first post-CF element that exists, falling back to
    // </worksheet>. This mirrors the production splice's insertion logic.
    let candidates = [
        "<pageMargins",
        "<pageSetup",
        "<headerFooter",
        "</worksheet>",
    ];
    let insert_at = candidates
        .iter()
        .filter_map(|n| sheet_xml.find(n))
        .min()
        .expect("at least </worksheet>");
    let mut new_sheet = String::with_capacity(sheet_xml.len() + block.len());
    new_sheet.push_str(&sheet_xml[..insert_at]);
    new_sheet.push_str(&block);
    new_sheet.push_str(&sheet_xml[insert_at..]);

    let mut out_buf: Vec<u8> = Vec::with_capacity(bytes.len());
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut out_buf));
        let opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let name = entry.name().to_string();
            writer.start_file(name.clone(), opts).expect("start");
            if name == "xl/worksheets/sheet1.xml" {
                writer.write_all(new_sheet.as_bytes()).expect("write");
            } else {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).expect("read");
                writer.write_all(&data).expect("write");
            }
        }
        writer.finish().expect("zip finish");
    }
    std::fs::write(xlsx_path, &out_buf).expect("write xlsx");
}

/// Style is only emitted as a dxf when the bag has at least one populated
/// field. A rule with no style (the imported-from-source common case) must
/// not balloon `<dxfs>`.
#[test]
fn cf_rule_without_style_keeps_dxfs_empty() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("cf_no_style_in.xlsx");
    let exported = tmp.path().join("cf_no_style_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "y").unwrap();
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let mut snap: Value =
        serde_json::from_str(imported.handle.snapshot_json.as_ref().unwrap()).expect("parse");
    // Same rule, no `style` key.
    let rule = serde_json::json!({
        "sqref": "B1:B5",
        "type": "cellIs",
        "operator": "lessThan",
        "formula1": "10",
        "priority": 1,
    });
    snap["sheets"]["sheet-1"]["_conditionalFormatting"] = Value::Array(vec![rule]);
    let mutated = serde_json::to_string(&snap).expect("ser");

    let export = export_xlsx_core(path_str(&exported), mutated).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let sheet_xml = read_sheet1_xml(&exported);
    assert!(
        sheet_xml.contains("<cfRule"),
        "cfRule must be emitted even without style; got:\n{sheet_xml}"
    );
    // No dxfId reference when no style — rust_xlsxwriter omits the attribute.
    assert!(
        !sheet_xml.contains("dxfId="),
        "unstyled cfRule must not reference a dxfId; got:\n{sheet_xml}"
    );
}

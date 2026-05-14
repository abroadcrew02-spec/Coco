//! Round-trip tests for xlsx data validations.
//!
//! These exercise: list / numeric-range / message-only rules survive an
//! import → snapshot → export → re-import cycle, no spurious empty
//! `<dataValidations>` block on plain files, and the detection warning is
//! suppressed once we know we'll preserve the rules.

use coco_lib::commands::xlsx_io::{
    detect_unsupported_features, export_xlsx_core, import_xlsx_core,
};
use rust_xlsxwriter::{DataValidation, DataValidationRule, Workbook};
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Pull the `xl/worksheets/sheet1.xml` body out of the given xlsx so we can
/// assert on the on-disk XML directly.
fn read_sheet1_xml(path: &PathBuf) -> String {
    let file = std::fs::File::open(path).expect("open xlsx");
    let mut archive = zip::ZipArchive::new(file).expect("zip");
    let mut entry = archive.by_name("xl/worksheets/sheet1.xml").expect("sheet1.xml");
    let mut xml = String::new();
    entry.read_to_string(&mut xml).expect("read xml");
    xml
}

#[test]
fn list_validation_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let dv = DataValidation::new()
            .allow_list_strings(&["Yes", "No", "Maybe"])
            .expect("list dv");
        ws.add_data_validation(0, 0, 9, 0, &dv).expect("add dv");
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let dvs = snap["sheets"]["sheet-1"]["_dataValidations"]
        .as_array()
        .expect("_dataValidations should be present on the sheet");
    assert_eq!(dvs.len(), 1);
    assert_eq!(dvs[0]["type"].as_str(), Some("list"));
    let formula1 = dvs[0]["formula1"].as_str().unwrap();
    assert!(
        formula1.contains("Yes") && formula1.contains("Maybe"),
        "list formula1 should contain the list options; got {formula1}"
    );
    assert!(
        dvs[0]["sqref"].as_str().unwrap().contains("A1:A10"),
        "sqref should round-trip the range, got {}",
        dvs[0]["sqref"]
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    // Re-import the exported file and confirm the rule is still there.
    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(&re.handle.snapshot_json.unwrap()).expect("parse");
    let re_dvs = re_snap["sheets"]["sheet-1"]["_dataValidations"]
        .as_array()
        .expect("_dataValidations after round-trip");
    assert_eq!(re_dvs.len(), 1);
    assert_eq!(re_dvs[0]["type"].as_str(), Some("list"));
    let re_f1 = re_dvs[0]["formula1"].as_str().unwrap();
    assert!(
        re_f1.contains("Yes") && re_f1.contains("Maybe"),
        "list options should survive round-trip; got {re_f1}"
    );
}

#[test]
fn decimal_between_validation_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("dec.xlsx");
    let exported = tmp.path().join("dec_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let dv = DataValidation::new()
            .allow_decimal_number(DataValidationRule::Between(0.0, 100.5));
        ws.add_data_validation(0, 1, 0, 1, &dv).expect("add dv");
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(imported.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let dvs = snap["sheets"]["sheet-1"]["_dataValidations"]
        .as_array()
        .expect("decimal dv recorded");
    assert_eq!(dvs.len(), 1);
    assert_eq!(dvs[0]["type"].as_str(), Some("decimal"));
    // rust_xlsxwriter emits `between` with no `operator` attribute (between is
    // the implicit default for that rule shape), but our parser still preserves
    // formula1 + formula2 either way.
    assert_eq!(dvs[0]["formula1"].as_str(), Some("0"));
    assert_eq!(dvs[0]["formula2"].as_str(), Some("100.5"));

    let export = export_xlsx_core(
        path_str(&exported),
        imported.handle.snapshot_json.unwrap(),
    )
    .expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_dvs = re_snap["sheets"]["sheet-1"]["_dataValidations"]
        .as_array()
        .expect("dv survives round-trip");
    assert_eq!(re_dvs.len(), 1);
    assert_eq!(re_dvs[0]["type"].as_str(), Some("decimal"));
    assert_eq!(re_dvs[0]["formula1"].as_str(), Some("0"));
    assert_eq!(re_dvs[0]["formula2"].as_str(), Some("100.5"));
}

#[test]
fn error_title_and_message_preserved() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("err.xlsx");
    let exported = tmp.path().join("err_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let dv = DataValidation::new()
            .allow_whole_number(DataValidationRule::Between(1, 5))
            .set_error_title("Out of range")
            .unwrap()
            .set_error_message("Pick a number from 1 to 5.")
            .unwrap()
            .set_input_title("Star rating")
            .unwrap()
            .set_input_message("Enter 1-5")
            .unwrap();
        ws.add_data_validation(1, 3, 1, 3, &dv).expect("add dv");
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(imported.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let dvs = snap["sheets"]["sheet-1"]["_dataValidations"]
        .as_array()
        .expect("dv recorded");
    assert_eq!(dvs[0]["errorTitle"].as_str(), Some("Out of range"));
    assert_eq!(
        dvs[0]["errorMessage"].as_str(),
        Some("Pick a number from 1 to 5.")
    );
    assert_eq!(dvs[0]["promptTitle"].as_str(), Some("Star rating"));
    assert_eq!(dvs[0]["promptMessage"].as_str(), Some("Enter 1-5"));

    let export = export_xlsx_core(
        path_str(&exported),
        imported.handle.snapshot_json.unwrap(),
    )
    .expect("export");
    assert!(export.success);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).unwrap();
    let re_dvs = re_snap["sheets"]["sheet-1"]["_dataValidations"]
        .as_array()
        .expect("dv survives");
    assert_eq!(re_dvs[0]["errorTitle"].as_str(), Some("Out of range"));
    assert_eq!(
        re_dvs[0]["errorMessage"].as_str(),
        Some("Pick a number from 1 to 5.")
    );
    assert_eq!(re_dvs[0]["promptTitle"].as_str(), Some("Star rating"));
    assert_eq!(re_dvs[0]["promptMessage"].as_str(), Some("Enter 1-5"));
}

#[test]
fn no_validations_yields_no_data_validations_block() {
    // Regression: a workbook with NO data validations must export a worksheet
    // XML that doesn't contain `<dataValidations`. Excel rejects empty
    // `<dataValidations count="0"/>` blocks in strict mode.
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
    // Snapshot must NOT carry an empty `_dataValidations` field — opt-in only.
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    assert!(
        snap["sheets"]["sheet-1"].get("_dataValidations").is_none(),
        "sheets with no DV must not emit _dataValidations: {}",
        snap["sheets"]["sheet-1"]
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let xml = read_sheet1_xml(&exported);
    assert!(
        !xml.contains("<dataValidations"),
        "clean sheet must not emit a <dataValidations> block; got:\n{xml}"
    );
}

#[test]
fn detection_warning_suppressed_after_preservation() {
    // The XLSX_DATA_VALIDATION detection warning made sense when we silently
    // dropped data validations. Now that we round-trip them, importing a
    // file WITH validations must NOT surface the "will be lost" warning —
    // otherwise the warning is straight-up wrong.
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("with_dv.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        let dv = DataValidation::new()
            .allow_list_strings(&["A", "B"])
            .expect("list dv");
        ws.add_data_validation(0, 0, 4, 0, &dv).expect("add dv");
        wb.save(&fixture).expect("save");
    }

    // Sanity: raw detection helper still sees the DV in the fixture.
    let raw = detect_unsupported_features(&path_str(&fixture)).expect("detect ok");
    assert!(
        raw.iter().any(|w| w.code == "XLSX_DATA_VALIDATION"),
        "the raw detector should see DV in the fixture: {raw:?}"
    );

    // The full import path must SUPPRESS the warning, since we now preserve.
    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    assert!(
        !imported
            .warnings
            .iter()
            .any(|w| w.code == "XLSX_DATA_VALIDATION"),
        "import must not emit XLSX_DATA_VALIDATION once we round-trip the rules: {:?}",
        imported.warnings
    );
}

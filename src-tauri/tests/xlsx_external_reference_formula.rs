//! issue #176: external-workbook-reference formula round-trip.
//!
//! `=[1]Sheet1!A1` (and `=[Other.xlsx]Sheet1!A1`) reference a cell in a
//! *different* workbook. Coco is a single-workbook editor — the referenced
//! book is never loaded as a second Univer unit — so Univer cannot
//! live-evaluate an external reference. The user can only ever see the
//! *cached* value Excel stored at last save.
//!
//! That makes cached-value preservation load-bearing for external references,
//! unlike normal formulas (which Univer recomputes at render time). The catch:
//! rust_xlsxwriter's `write_formula` always stores `0` as the formula result.
//! Without intervention an external reference would round-trip through Coco
//! as `<f>=[1]Sheet1!A1</f><v>0</v>`, silently losing the cached value.
//!
//! The #176 fix re-emits the cached value via `set_formula_result` for
//! external-reference formula cells. This test asserts that BOTH the formula
//! *text* and the cached *value* survive a full Coco round-trip
//! (snapshot -> export xlsx -> re-import + on-disk calamine check), and that
//! a normal formula in the same sheet is left to recalc (no spurious result).
//!
//! Blob-level external-link preservation (`xl/externalLinks/*` parts +
//! workbook wiring) is covered separately by
//! `xlsx_external_link_preservation.rs`.

use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use std::path::Path;
use tempfile::TempDir;

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn external_reference_formula_and_cached_value_round_trip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("ext_ref.xlsx");
    let exported = tmp.path().join("ext_ref_out.xlsx");

    // ---- Build a plain fixture and import it to obtain a real Coco snapshot.
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Main").expect("set name");
        ws.write_string(0, 0, "seed").expect("a1");
        wb.save(&fixture).expect("save fixture");
    }
    let imported = import_xlsx_core(path_str(&fixture)).expect("import fixture");
    let snapshot_json = imported
        .handle
        .snapshot_json
        .clone()
        .expect("snapshot present on import");
    let mut snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse snapshot");

    // ---- Inject external-reference formula cells into the Main sheet.
    // We splice them straight into the snapshot's cellData (the same shape
    // `import_xlsx_core` produces for a formula cell: { f, v, ... }) so the
    // export path's `set_formula_result` handling is exercised directly,
    // without depending on a hand-crafted externalLinks fixture.
    //
    // B1: external ref with a NUMERIC cached value.
    // C1: external ref with a STRING cached value.
    // D1: a NORMAL formula — must be left for Univer to recalc (no result
    //     re-emission), so calamine should read its cached value as 0.
    let sheet_id = {
        let order = snapshot["sheetOrder"]
            .as_array()
            .expect("sheetOrder array");
        order[0].as_str().expect("sheet id").to_string()
    };
    let cell_data = snapshot["sheets"][&sheet_id]["cellData"]
        .as_object_mut()
        .expect("cellData object");
    cell_data.insert(
        "0".to_string(),
        json!({
            "0": { "v": "seed" },
            "1": { "f": "=[1]Sheet1!A1", "v": 42 },
            "2": { "f": "=[Other.xlsx]Sheet1!B2", "v": "cachedText" },
            "3": { "f": "=1+1", "v": 2 },
        }),
    );
    let patched_json = serde_json::to_string(&snapshot).expect("serialize patched snapshot");

    // ---- Export via Coco.
    let export = export_xlsx_core(path_str(&exported), patched_json).expect("export call");
    assert!(
        export.success,
        "export should succeed; error={:?}",
        export.error
    );

    // ---- Re-import the exported file: snapshot view.
    let re_imported = import_xlsx_core(path_str(&exported)).expect("re-import exported");
    let final_json = re_imported
        .handle
        .snapshot_json
        .expect("snapshot present on re-import");
    let final_snapshot: Value =
        serde_json::from_str(&final_json).expect("parse re-imported snapshot");
    let final_id = final_snapshot["sheetOrder"][0]
        .as_str()
        .expect("re-imported sheet id");
    let cells = &final_snapshot["sheets"][final_id]["cellData"]["0"];

    // B1: external-ref formula text + numeric cached value both survive.
    let b1 = &cells["1"];
    assert_eq!(
        b1.get("f").and_then(|v| v.as_str()),
        Some("=[1]Sheet1!A1"),
        "B1 external-reference formula text should round-trip; cell={b1}"
    );
    let b1_value_ok = match b1.get("v") {
        Some(Value::Number(n)) => n.as_f64() == Some(42.0),
        Some(Value::String(s)) => s == "42",
        _ => false,
    };
    assert!(
        b1_value_ok,
        "B1 cached value should round-trip as 42, got {b1}"
    );

    // C1: external-ref formula text + string cached value both survive.
    let c1 = &cells["2"];
    assert_eq!(
        c1.get("f").and_then(|v| v.as_str()),
        Some("=[Other.xlsx]Sheet1!B2"),
        "C1 external-reference formula text should round-trip; cell={c1}"
    );
    assert_eq!(
        c1.get("v").and_then(|v| v.as_str()),
        Some("cachedText"),
        "C1 cached string value should round-trip; cell={c1}"
    );

    // D1: a normal formula is left for Univer to recalc — rust_xlsxwriter's
    // default `0` result stands, so the cached value is NOT the original 2.
    let d1 = &cells["3"];
    assert_eq!(
        d1.get("f").and_then(|v| v.as_str()),
        Some("=1+1"),
        "D1 normal formula text should round-trip; cell={d1}"
    );
    let d1_value = match d1.get("v") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    };
    assert_ne!(
        d1_value,
        Some(2.0),
        "normal formula should NOT have its result re-emitted (Univer recalcs); cell={d1}"
    );

    // ---- On-disk calamine check: confirm the exported xlsx carries the
    // external-reference formula text AND the cached value in `<v>`.
    let mut wb_out: Xlsx<_> = open_workbook(&exported).expect("calamine open exported");
    let formulas = wb_out
        .worksheet_formula("Main")
        .expect("formula range on Main");
    let f_b1 = formulas.get_value((0, 1)).cloned().unwrap_or_default();
    assert!(
        f_b1.contains("[1]Sheet1!A1"),
        "exported xlsx B1 formula text should carry the external ref, got {f_b1:?}"
    );

    let values = wb_out
        .worksheet_range("Main")
        .expect("value range on Main");
    // B1 cached value on disk must be 42 (the #176 fix's re-emitted result),
    // not rust_xlsxwriter's default 0.
    match values.get_value((0, 1)) {
        Some(Data::Float(n)) => assert_eq!(*n, 42.0, "B1 on-disk cached value should be 42"),
        Some(Data::Int(n)) => assert_eq!(*n, 42, "B1 on-disk cached value should be 42"),
        Some(Data::String(s)) => assert_eq!(s, "42", "B1 on-disk cached value should be 42"),
        other => panic!("B1 on-disk cached value should be 42, got {other:?}"),
    }
    match values.get_value((0, 2)) {
        Some(Data::String(s)) => {
            assert_eq!(s, "cachedText", "C1 on-disk cached value should be cachedText")
        }
        other => panic!("C1 on-disk cached value should be 'cachedText', got {other:?}"),
    }
}

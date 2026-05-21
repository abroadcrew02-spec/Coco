//! issue #175: 3D reference (`=SUM(Sheet1:Sheet3!A1)`) round-trip.
//!
//! A 3D reference spans the same range across a contiguous run of sheets.
//! Univer 0.5.x's formula engine does NOT evaluate 3D references: its lexer
//! tokenizes `Sheet1:Sheet3!A1` as a single reference whose "sheet name" is
//! the literal string `Sheet1:Sheet3`, which `getSheetBySheetName` then fails
//! to resolve (no sheet is named that), so evaluation yields `#REF!`/empty.
//! The engine has no sheet-range expansion logic at all (no `acrossSheets` /
//! `startSheet` / `endSheet` concept anywhere in `@univerjs/engine-formula`).
//!
//! Because of that, evaluation is out of scope for the Rust side and unsupported
//! by Univer. What the Rust xlsx layer IS responsible for is *not corrupting the
//! formula text*: both import (`worksheet_formula` -> `cell["f"]`) and export
//! (`write_formula`) treat the formula as an opaque string, so a 3D reference
//! must survive a full Coco round-trip (import xlsx -> export xlsx -> re-import)
//! verbatim, exactly like every other formula in `xlsx_p0_formulas.rs`.
//!
//! This test asserts that text-preservation guarantee for the canonical 3D
//! reference forms.

use calamine::{open_workbook, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::Workbook;
use serde_json::Value;
use std::path::Path;
use tempfile::TempDir;

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// (row, col, formula text written verbatim to xlsx, marker fragments that must
/// appear in the round-tripped text on the Coco snapshot and the re-exported
/// xlsx).
struct FormulaCase {
    row: u32,
    col: u16,
    name: &'static str,
    formula: &'static str,
    markers: &'static [&'static str],
}

fn cases() -> Vec<FormulaCase> {
    // Every formula lives on the first sheet (`Sheet1`), column C (col=2).
    // It references cell A1 across the Sheet1:Sheet3 span.
    vec![
        // Plain 3D reference into an accumulator function.
        FormulaCase {
            row: 0,
            col: 2,
            name: "SUM 3D single-cell",
            formula: "=SUM(Sheet1:Sheet3!A1)",
            markers: &["SUM", "Sheet1:Sheet3", "A1"],
        },
        // 3D reference spanning a multi-cell range.
        FormulaCase {
            row: 1,
            col: 2,
            name: "SUM 3D range",
            formula: "=SUM(Sheet1:Sheet3!A1:B2)",
            markers: &["SUM", "Sheet1:Sheet3", "A1:B2"],
        },
        // AVERAGE accumulator with a 3D reference.
        FormulaCase {
            row: 2,
            col: 2,
            name: "AVERAGE 3D",
            formula: "=AVERAGE(Sheet1:Sheet3!A1)",
            markers: &["AVERAGE", "Sheet1:Sheet3", "A1"],
        },
        // COUNT accumulator with a 3D reference.
        FormulaCase {
            row: 3,
            col: 2,
            name: "COUNT 3D",
            formula: "=COUNT(Sheet1:Sheet3!A1)",
            markers: &["COUNT", "Sheet1:Sheet3", "A1"],
        },
        // Quoted sheet names (spaces) — Excel wraps the whole span in one pair
        // of single quotes: 'Sheet1:Sheet 3'!A1 is invalid; the quotes go
        // around each name in the span as Excel writes 'Sheet1:Sheet3'!A1
        // when either endpoint needs quoting.
        FormulaCase {
            row: 4,
            col: 2,
            name: "SUM 3D quoted span",
            formula: "=SUM('Sheet1:Sheet3'!A1)",
            markers: &["SUM", "Sheet1:Sheet3", "A1"],
        },
    ]
}

#[test]
fn three_d_reference_text_round_trips() {
    let cases = cases();
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("threed_ref.xlsx");
    let exported = tmp.path().join("threed_ref_out.xlsx");

    // ---- Build fixture: 3 sheets so a Sheet1:Sheet3 span is meaningful ----
    {
        let mut wb = Workbook::new();
        for sheet_name in ["Sheet1", "Sheet2", "Sheet3"] {
            let ws = wb.add_worksheet();
            ws.set_name(sheet_name).expect("set name");
            // A1:B2 numeric operands on every sheet so the span has data.
            ws.write_number(0, 0, 10.0).expect("A1");
            ws.write_number(0, 1, 20.0).expect("B1");
            ws.write_number(1, 0, 30.0).expect("A2");
            ws.write_number(1, 1, 40.0).expect("B2");
        }

        // Formulas all go on the first worksheet (Sheet1).
        let ws1 = wb.worksheet_from_name("Sheet1").expect("Sheet1 handle");
        for c in &cases {
            ws1.write_formula(c.row, c.col, c.formula)
                .unwrap_or_else(|e| panic!("write_formula for {} failed: {e}", c.name));
        }

        wb.save(&fixture).expect("save fixture");
    }

    // ---- Import via Coco ----
    let imported = import_xlsx_core(path_str(&fixture)).expect("import fixture");
    let snapshot_json = imported
        .handle
        .snapshot_json
        .clone()
        .expect("snapshot present on import");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse imported snapshot");

    // Every 3D-reference formula must survive the IMPORT step.
    let mut import_failures: Vec<String> = Vec::new();
    for c in &cases {
        let cell = &snapshot["sheets"]["sheet-1"]["cellData"][c.row.to_string()][c.col.to_string()];
        let f = cell.get("f").and_then(|v| v.as_str()).unwrap_or("");
        if f.is_empty() {
            import_failures.push(format!(
                "[import] {} at ({},{}): formula field missing or empty, cell={cell}",
                c.name, c.row, c.col
            ));
            continue;
        }
        for marker in c.markers {
            if !f.contains(marker) {
                import_failures.push(format!(
                    "[import] {} at ({},{}): formula text {:?} missing marker {:?}",
                    c.name, c.row, c.col, f, marker
                ));
            }
        }
    }
    assert!(
        import_failures.is_empty(),
        "imported 3D-reference formulas failed to preserve markers:\n  - {}",
        import_failures.join("\n  - ")
    );

    // ---- Export via Coco ----
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export call");
    assert!(
        export.success,
        "export should succeed; error={:?}",
        export.error
    );

    // ---- Re-import the exported file: snapshot view ----
    let re_imported = import_xlsx_core(path_str(&exported)).expect("re-import exported");
    let final_snapshot: Value = serde_json::from_str(
        &re_imported
            .handle
            .snapshot_json
            .expect("snapshot present on re-import"),
    )
    .expect("parse re-imported snapshot");

    let mut snapshot_failures: Vec<String> = Vec::new();
    for c in &cases {
        let cell =
            &final_snapshot["sheets"]["sheet-1"]["cellData"][c.row.to_string()][c.col.to_string()];
        let f = cell.get("f").and_then(|v| v.as_str()).unwrap_or("");
        if f.is_empty() {
            snapshot_failures.push(format!(
                "[snapshot-after-export] {} at ({},{}): formula field missing or empty, cell={cell}",
                c.name, c.row, c.col
            ));
            continue;
        }
        for marker in c.markers {
            if !f.contains(marker) {
                snapshot_failures.push(format!(
                    "[snapshot-after-export] {} at ({},{}): formula text {:?} missing marker {:?}",
                    c.name, c.row, c.col, f, marker
                ));
            }
        }
    }
    assert!(
        snapshot_failures.is_empty(),
        "re-imported 3D-reference formulas failed to preserve markers:\n  - {}",
        snapshot_failures.join("\n  - ")
    );

    // ---- Re-open exported xlsx with calamine: confirms the formula text on
    // disk still carries the sheet-span (`Sheet1:Sheet3`) and range. ----
    let mut wb_out: Xlsx<_> = open_workbook(&exported).expect("calamine open exported");
    let formulas = wb_out
        .worksheet_formula("Sheet1")
        .expect("formula range on Sheet1");

    let mut disk_failures: Vec<String> = Vec::new();
    for c in &cases {
        match formulas.get_value((c.row, c.col as u32)) {
            Some(text) if !text.is_empty() => {
                for marker in c.markers {
                    if !text.contains(marker) {
                        disk_failures.push(format!(
                            "[xlsx-on-disk] {} at ({},{}): formula text {:?} missing marker {:?}",
                            c.name, c.row, c.col, text, marker
                        ));
                    }
                }
            }
            other => disk_failures.push(format!(
                "[xlsx-on-disk] {} at ({},{}): expected non-empty formula text, got {:?}",
                c.name, c.row, c.col, other
            )),
        }
    }
    assert!(
        disk_failures.is_empty(),
        "exported xlsx 3D-reference cells failed to preserve markers:\n  - {}",
        disk_failures.join("\n  - ")
    );
}

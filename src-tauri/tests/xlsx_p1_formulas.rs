//! requirements.md §15.3 Phase 2 (P1 数式拡充): high-value P1 formula round-trip.
//!
//! Sibling to `xlsx_p0_formulas.rs`. Asserts that the formula *text* for the
//! commonly-used P1 functions (criteria aggregates, error handlers, string
//! helpers) survives a full Coco round-trip (import xlsx -> export xlsx ->
//! re-import) verbatim. Cached-value correctness is not asserted here for the
//! same reasons documented in the P0 suite: the Rust side does not host a
//! formula engine.
//!
//! Coverage (one cell per P1 function):
//!   条件集計: SUMIF, COUNTIF, AVERAGEIF, SUMIFS, COUNTIFS
//!   エラー:   IFERROR, IFNA
//!   文字列:   CONCATENATE, TEXT, TRIM, UPPER, LOWER, SUBSTITUTE
//!
//! That's 13 functions; we plant one formula per function and assert the
//! function name + a distinguishing argument fragment both survive.

use calamine::{open_workbook, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::Workbook;
use serde_json::Value;
use std::path::Path;
use tempfile::TempDir;

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// (row, col, formula text written verbatim to xlsx, marker fragments that
/// must appear in the round-tripped text on both the Coco snapshot and the
/// re-exported xlsx).
struct FormulaCase {
    row: u32,
    col: u16,
    name: &'static str,
    formula: &'static str,
    markers: &'static [&'static str],
}

fn cases() -> Vec<FormulaCase> {
    // Layout: column C (col=2) holds every formula. Columns A/B hold operand
    // data shaped to support criteria-style functions.
    //
    // A1:A6 numeric column (10, 20, 30, 10, 20, 30) — repeats so SUMIF /
    // COUNTIF / AVERAGEIF have something to match.
    // B1:B6 string column ("apple","banana","apple","cherry","banana","apple")
    // — repeats so COUNTIF on strings has something to match. Also includes
    // padded "  hello  " at B10 for TRIM, and "Mixed Case" at B11 for
    // UPPER/LOWER/SUBSTITUTE.
    vec![
        // 条件集計
        FormulaCase {
            row: 0,
            col: 2,
            name: "SUMIF",
            formula: "=SUMIF(A1:A6,\">15\",A1:A6)",
            markers: &["SUMIF", "A1", "15"],
        },
        FormulaCase {
            row: 1,
            col: 2,
            name: "COUNTIF",
            formula: "=COUNTIF(B1:B6,\"apple\")",
            markers: &["COUNTIF", "B1", "apple"],
        },
        FormulaCase {
            row: 2,
            col: 2,
            name: "AVERAGEIF",
            formula: "=AVERAGEIF(A1:A6,\">15\",A1:A6)",
            markers: &["AVERAGEIF", "A1", "15"],
        },
        FormulaCase {
            row: 3,
            col: 2,
            name: "SUMIFS",
            formula: "=SUMIFS(A1:A6,B1:B6,\"apple\",A1:A6,\">5\")",
            markers: &["SUMIFS", "A1", "B1", "apple"],
        },
        FormulaCase {
            row: 4,
            col: 2,
            name: "COUNTIFS",
            formula: "=COUNTIFS(B1:B6,\"apple\",A1:A6,\">5\")",
            markers: &["COUNTIFS", "B1", "apple"],
        },
        // エラー
        FormulaCase {
            row: 5,
            col: 2,
            name: "IFERROR",
            formula: "=IFERROR(1/0,\"err\")",
            markers: &["IFERROR", "err"],
        },
        FormulaCase {
            row: 6,
            col: 2,
            name: "IFNA",
            formula: "=IFNA(NA(),\"na\")",
            markers: &["IFNA", "na"],
        },
        // 文字列
        FormulaCase {
            row: 7,
            col: 2,
            name: "CONCATENATE",
            formula: "=CONCATENATE(\"foo\",\"-\",\"bar\")",
            markers: &["CONCATENATE", "foo", "bar"],
        },
        FormulaCase {
            row: 8,
            col: 2,
            name: "TEXT",
            formula: "=TEXT(A1,\"0.00\")",
            markers: &["TEXT", "A1", "0.00"],
        },
        FormulaCase {
            row: 9,
            col: 2,
            name: "TRIM",
            formula: "=TRIM(B10)",
            markers: &["TRIM", "B10"],
        },
        FormulaCase {
            row: 10,
            col: 2,
            name: "UPPER",
            formula: "=UPPER(B11)",
            markers: &["UPPER", "B11"],
        },
        FormulaCase {
            row: 11,
            col: 2,
            name: "LOWER",
            formula: "=LOWER(B11)",
            markers: &["LOWER", "B11"],
        },
        FormulaCase {
            row: 12,
            col: 2,
            name: "SUBSTITUTE",
            formula: "=SUBSTITUTE(B11,\"Mixed\",\"Plain\")",
            markers: &["SUBSTITUTE", "B11", "Mixed", "Plain"],
        },
    ]
}

#[test]
fn every_p1_formula_round_trips() {
    let cases = cases();
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("p1_formulas.xlsx");
    let exported = tmp.path().join("p1_formulas_out.xlsx");

    // ---- Build fixture ----
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("P1").expect("set name");

        // Numeric A1:A6 (10,20,30,10,20,30) — repeats so criteria aggregates
        // have multiple matches.
        let nums = [10.0, 20.0, 30.0, 10.0, 20.0, 30.0];
        for (r, v) in nums.iter().enumerate() {
            ws.write_number(r as u32, 0, *v).expect("A col");
        }
        // String B1:B6 with repeats so COUNTIF/SUMIFS/COUNTIFS have multiple
        // matches.
        let strs = ["apple", "banana", "apple", "cherry", "banana", "apple"];
        for (r, s) in strs.iter().enumerate() {
            ws.write_string(r as u32, 1, *s).expect("B col");
        }
        // Padded string for TRIM at B10 (row 9).
        ws.write_string(9, 1, "  hello  ").unwrap();
        // Mixed-case string for UPPER/LOWER/SUBSTITUTE at B11 (row 10).
        ws.write_string(10, 1, "Mixed Case").unwrap();

        for c in &cases {
            ws.write_formula(c.row, c.col, c.formula)
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

    // Every formula must survive the IMPORT step.
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
        "imported formulas failed to preserve markers:\n  - {}",
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
        "re-imported formulas failed to preserve markers:\n  - {}",
        snapshot_failures.join("\n  - ")
    );

    // ---- Re-open exported xlsx with calamine: confirms the formula text on
    // disk matches Excel-compatible form (function name + markers). ----
    let mut wb_out: Xlsx<_> = open_workbook(&exported).expect("calamine open exported");
    let formulas = wb_out
        .worksheet_formula("P1")
        .expect("formula range on P1 sheet");

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
        "exported xlsx formula cells failed to preserve markers:\n  - {}",
        disk_failures.join("\n  - ")
    );
}

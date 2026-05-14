//! FR-003 / requirements.md §4.4: P0 formula round-trip.
//!
//! Asserts that the formula *text* for every P0 function in §4.4 survives a
//! full Coco round-trip (import xlsx -> export xlsx -> re-import) verbatim
//! (modulo the leading `=`, which calamine strips on read). The cached value
//! is intentionally not asserted here: rust_xlsxwriter has no formula engine
//! and the runtime engine (Univer) only fires up inside the renderer, so this
//! test focuses on what the Rust side is responsible for: *not corrupting the
//! formula text*. Cached-value correctness is exercised separately in the
//! frontend via Univer's facade API.
//!
//! Coverage (one cell per P0 function from §4.4):
//!   集計: SUM, AVERAGE, COUNT, COUNTA, MIN, MAX
//!   条件: IF, AND, OR, NOT
//!   参照: VLOOKUP, INDEX, MATCH
//!   文字列: CONCAT, LEFT, RIGHT, MID, LEN
//!   日付:   TODAY, DATE, YEAR, MONTH, DAY
//!   数値:   ROUND, ROUNDUP, ROUNDDOWN, ABS
//!
//! That's 26 functions; we plant one formula per function and assert the
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
    // Layout: column C (col=2) holds every formula. Columns A/B hold the
    // operand data used by aggregates and lookups.
    //
    // A1:A6 = 1..6 numeric column (for SUM/AVERAGE/COUNT/MIN/MAX).
    // B1:B6 = "x","y","",1,2,"" mixed (for COUNTA).
    // Lookup table planted at A20:B21 for VLOOKUP / INDEX / MATCH.
    vec![
        // 集計
        FormulaCase { row: 0,  col: 2, name: "SUM",       formula: "=SUM(A1:A6)",                  markers: &["SUM", "A1"] },
        FormulaCase { row: 1,  col: 2, name: "AVERAGE",   formula: "=AVERAGE(A1:A6)",              markers: &["AVERAGE", "A1"] },
        FormulaCase { row: 2,  col: 2, name: "COUNT",     formula: "=COUNT(A1:A6)",                markers: &["COUNT", "A1"] },
        FormulaCase { row: 3,  col: 2, name: "COUNTA",    formula: "=COUNTA(B1:B6)",               markers: &["COUNTA", "B1"] },
        FormulaCase { row: 4,  col: 2, name: "MIN",       formula: "=MIN(A1:A6)",                  markers: &["MIN", "A1"] },
        FormulaCase { row: 5,  col: 2, name: "MAX",       formula: "=MAX(A1:A6)",                  markers: &["MAX", "A1"] },
        // 条件
        FormulaCase { row: 6,  col: 2, name: "IF",        formula: "=IF(A1>0,\"pos\",\"neg\")",  markers: &["IF", "pos", "neg"] },
        FormulaCase { row: 7,  col: 2, name: "AND",       formula: "=AND(A1>0,A2>0)",              markers: &["AND", "A1", "A2"] },
        FormulaCase { row: 8,  col: 2, name: "OR",        formula: "=OR(A1>0,A2<0)",               markers: &["OR", "A1", "A2"] },
        FormulaCase { row: 9,  col: 2, name: "NOT",       formula: "=NOT(A1>0)",                   markers: &["NOT", "A1"] },
        // 参照
        FormulaCase { row: 10, col: 2, name: "VLOOKUP",   formula: "=VLOOKUP(2,A20:B21,2,FALSE)",  markers: &["VLOOKUP", "A20"] },
        FormulaCase { row: 11, col: 2, name: "INDEX",     formula: "=INDEX(A20:B21,2,2)",          markers: &["INDEX", "A20"] },
        FormulaCase { row: 12, col: 2, name: "MATCH",     formula: "=MATCH(2,A20:A21,0)",          markers: &["MATCH", "A20"] },
        // 文字列
        FormulaCase { row: 13, col: 2, name: "CONCAT",    formula: "=CONCAT(\"foo\",\"bar\")",   markers: &["CONCAT", "foo", "bar"] },
        FormulaCase { row: 14, col: 2, name: "LEFT",      formula: "=LEFT(\"abcdef\",3)",        markers: &["LEFT", "abcdef"] },
        FormulaCase { row: 15, col: 2, name: "RIGHT",     formula: "=RIGHT(\"abcdef\",3)",       markers: &["RIGHT", "abcdef"] },
        FormulaCase { row: 16, col: 2, name: "MID",       formula: "=MID(\"abcdef\",2,3)",       markers: &["MID", "abcdef"] },
        FormulaCase { row: 17, col: 2, name: "LEN",       formula: "=LEN(\"abcdef\")",           markers: &["LEN", "abcdef"] },
        // 日付
        FormulaCase { row: 18, col: 2, name: "TODAY",     formula: "=TODAY()",                     markers: &["TODAY"] },
        FormulaCase { row: 19, col: 2, name: "DATE",      formula: "=DATE(2024,1,31)",             markers: &["DATE", "2024"] },
        FormulaCase { row: 20, col: 2, name: "YEAR",      formula: "=YEAR(DATE(2024,1,31))",       markers: &["YEAR", "2024"] },
        FormulaCase { row: 21, col: 2, name: "MONTH",     formula: "=MONTH(DATE(2024,1,31))",      markers: &["MONTH", "2024"] },
        FormulaCase { row: 22, col: 2, name: "DAY",       formula: "=DAY(DATE(2024,1,31))",        markers: &["DAY", "2024"] },
        // 数値
        FormulaCase { row: 23, col: 2, name: "ROUND",     formula: "=ROUND(1.2345,2)",             markers: &["ROUND", "1.2345"] },
        FormulaCase { row: 24, col: 2, name: "ROUNDUP",   formula: "=ROUNDUP(1.2345,2)",           markers: &["ROUNDUP", "1.2345"] },
        FormulaCase { row: 25, col: 2, name: "ROUNDDOWN", formula: "=ROUNDDOWN(1.2345,2)",         markers: &["ROUNDDOWN", "1.2345"] },
        FormulaCase { row: 26, col: 2, name: "ABS",       formula: "=ABS(-3.14)",                  markers: &["ABS", "3.14"] },
    ]
}

#[test]
fn every_p0_formula_round_trips() {
    let cases = cases();
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("p0_formulas.xlsx");
    let exported = tmp.path().join("p0_formulas_out.xlsx");

    // ---- Build fixture ----
    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("P0").expect("set name");

        // Numeric column A1:A6 for aggregates.
        for r in 0..6u32 {
            ws.write_number(r, 0, (r as f64) + 1.0).expect("A col");
        }
        // Mixed column B1:B6 for COUNTA (3 non-empty cells: strings + numbers).
        ws.write_string(0, 1, "x").unwrap();
        ws.write_string(1, 1, "y").unwrap();
        // B3 left blank
        ws.write_number(3, 1, 1.0).unwrap();
        ws.write_number(4, 1, 2.0).unwrap();
        // B6 left blank

        // Lookup table at A20:B21 (rows 19..=20 in 0-indexed).
        ws.write_number(19, 0, 1.0).unwrap();
        ws.write_string(19, 1, "one").unwrap();
        ws.write_number(20, 0, 2.0).unwrap();
        ws.write_string(20, 1, "two").unwrap();

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
    let snapshot: Value =
        serde_json::from_str(&snapshot_json).expect("parse imported snapshot");

    // Every formula must survive the IMPORT step.
    let mut import_failures: Vec<String> = Vec::new();
    for c in &cases {
        let cell = &snapshot["sheets"]["sheet-1"]["cellData"]
            [c.row.to_string()][c.col.to_string()];
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
        let cell = &final_snapshot["sheets"]["sheet-1"]["cellData"]
            [c.row.to_string()][c.col.to_string()];
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
        .worksheet_formula("P0")
        .expect("formula range on P0 sheet");

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

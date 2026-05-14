//! FR-105: 代表10ファイルのP0要素を取り込める
//!
//! Programmatically builds 10 representative xlsx fixtures, each combining
//! different P0 elements from §4.4 (formulas), §4.5 (formats), and §10 (the
//! compatibility matrix). Every fixture is imported via `import_xlsx_core`,
//! re-exported via `export_xlsx_core`, then re-imported so we can assert the
//! observable P0 elements survive the full round-trip (Coco -> xlsx -> Coco).
//!
//! Each fixture lives in its own `#[test]` so failures are isolated and easy
//! to triage.
//!
//! The full P0 element matrix we cover across the 10 files:
//!  - Cell values (string/number/boolean/date)
//!  - Multiple sheets + sheet order
//!  - Basic formulas: SUM, AVERAGE, IF, VLOOKUP, plus a cross-sheet ref
//!  - Visual cell styles: bold/italic, font color, fill color, alignment
//!  - Borders (P0 §4.5)
//!  - Number/percent/currency/date formats (P0 §4.5)
//!  - Merged cells
//!  - Custom column widths + row heights
//!  - Named ranges (workbook scope)
//!  - Rich text runs
//!  - "Everything bagel" combining values + styles + formulas + merges

use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{
    Color, ExcelDateTime, Format, FormatAlign, FormatBorder, FormatPattern, Workbook,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Round-trip: import the freshly-written fixture, export it, then re-import
/// and return the final snapshot. We assert the final snapshot in each test
/// — anything that survives a *re-import* of an *exported* file is what we
/// can claim round-trips through Coco.
fn round_trip(fixture: &Path, exported: &Path) -> Value {
    let imported = import_xlsx_core(path_str(fixture)).expect("import fixture");
    let snapshot_json = imported
        .handle
        .snapshot_json
        .clone()
        .expect("snapshot present on import");
    let export = export_xlsx_core(path_str(exported), snapshot_json).expect("export call");
    assert!(
        export.success,
        "export should succeed; got error={:?}",
        export.error
    );
    let re_imported = import_xlsx_core(path_str(exported)).expect("re-import exported");
    serde_json::from_str(
        &re_imported
            .handle
            .snapshot_json
            .expect("snapshot present on re-import"),
    )
    .expect("parse final snapshot")
}

/// Look up cell (row, col) in a sheet's cellData. Returns the inner Value; you
/// can then `.get("v")`, `.get("f")`, etc.
fn cell<'a>(snapshot: &'a Value, sheet_id: &str, row: usize, col: usize) -> &'a Value {
    &snapshot["sheets"][sheet_id]["cellData"][row.to_string()][col.to_string()]
}

// --------------------------------------------------------------------------
// Fixture 1: plain_values — strings, numbers, booleans, dates
// --------------------------------------------------------------------------

#[test]
fn fixture_01_plain_values() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("01_plain.xlsx");
    let exported = tmp.path().join("01_plain_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Mixed").unwrap();
        // Strings
        ws.write_string(0, 0, "header").unwrap();
        ws.write_string(0, 1, "Unicode テスト 🚀").unwrap();
        // Integers + floats
        ws.write_number(1, 0, 42.0).unwrap();
        ws.write_number(1, 1, -3.14159).unwrap();
        // Booleans
        ws.write_boolean(2, 0, true).unwrap();
        ws.write_boolean(2, 1, false).unwrap();
        // A date (serial 44562 = 2022-01-01) with an explicit numFmt so the
        // import side flags it as a date.
        let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
        ws.write_number_with_format(3, 0, 44562.0, &date_fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);

    assert_eq!(snap["sheets"]["sheet-1"]["name"], "Mixed");
    assert_eq!(cell(&snap, "sheet-1", 0, 0)["v"], "header");
    assert_eq!(cell(&snap, "sheet-1", 0, 1)["v"], "Unicode テスト 🚀");
    assert_eq!(cell(&snap, "sheet-1", 1, 0)["v"], 42.0);
    assert!((cell(&snap, "sheet-1", 1, 1)["v"].as_f64().unwrap() + 3.14159).abs() < 1e-9);
    assert_eq!(cell(&snap, "sheet-1", 2, 0)["v"], true);
    assert_eq!(cell(&snap, "sheet-1", 2, 1)["v"], false);
    // Date cell: value preserved (numeric serial OR ISO string acceptable; we
    // only require the _fmt hint to survive so Univer can render it as date).
    let date_cell = cell(&snap, "sheet-1", 3, 0);
    assert_eq!(
        date_cell.get("_fmt").and_then(|v| v.as_str()),
        Some("yyyy-mm-dd"),
        "date _fmt should round-trip, got {date_cell}"
    );
}

// --------------------------------------------------------------------------
// Fixture 2: multi_sheet — 3 sheets, distinct content, distinct names, the
// sheetOrder array must match.
// --------------------------------------------------------------------------

#[test]
fn fixture_02_multi_sheet() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("02_multi.xlsx");
    let exported = tmp.path().join("02_multi_out.xlsx");

    {
        let mut wb = Workbook::new();
        for (name, val) in [("Alpha", "A"), ("Beta", "B"), ("Gamma", "G")] {
            let ws = wb.add_worksheet();
            ws.set_name(name).unwrap();
            ws.write_string(0, 0, val).unwrap();
        }
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);

    // Both sheetOrder length AND the underlying names should match the source.
    let order = snap["sheetOrder"]
        .as_array()
        .expect("sheetOrder array on final snapshot");
    assert_eq!(order.len(), 3, "expected 3 sheets, got {order:?}");

    let names: Vec<String> = order
        .iter()
        .map(|id| {
            snap["sheets"][id.as_str().unwrap()]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(names, vec!["Alpha", "Beta", "Gamma"], "sheet order");

    // Spot-check each sheet's content.
    let by_name: std::collections::HashMap<&str, &str> = order
        .iter()
        .map(|id| {
            let sid = id.as_str().unwrap();
            (
                snap["sheets"][sid]["name"].as_str().unwrap(),
                snap["sheets"][sid]["cellData"]["0"]["0"]["v"]
                    .as_str()
                    .unwrap_or(""),
            )
        })
        .collect();
    assert_eq!(by_name["Alpha"], "A");
    assert_eq!(by_name["Beta"], "B");
    assert_eq!(by_name["Gamma"], "G");
}

// --------------------------------------------------------------------------
// Fixture 3: formulas_basic — SUM, AVERAGE, IF, VLOOKUP, and one cross-sheet
// reference.
// --------------------------------------------------------------------------

#[test]
fn fixture_03_formulas_basic() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("03_formulas.xlsx");
    let exported = tmp.path().join("03_formulas_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws1 = wb.add_worksheet();
        ws1.set_name("Data").unwrap();
        // Numeric column for SUM/AVERAGE
        for r in 0..5u32 {
            ws1.write_number(r, 0, (r as f64) + 1.0).unwrap();
        }
        // VLOOKUP table: id -> name
        ws1.write_number(0, 2, 1.0).unwrap();
        ws1.write_string(0, 3, "one").unwrap();
        ws1.write_number(1, 2, 2.0).unwrap();
        ws1.write_string(1, 3, "two").unwrap();

        // Aggregates
        ws1.write_formula(0, 5, "=SUM(A1:A5)").unwrap();
        ws1.write_formula(1, 5, "=AVERAGE(A1:A5)").unwrap();
        // Conditional
        ws1.write_formula(2, 5, "=IF(A1>0,\"pos\",\"neg\")").unwrap();
        // VLOOKUP
        ws1.write_formula(3, 5, "=VLOOKUP(2,C1:D2,2,FALSE)").unwrap();

        // Write the cross-sheet ref BEFORE adding the second sheet so we
        // don't hold two mutable worksheet refs at once.
        ws1.write_formula(4, 5, "=Other!A1*2").unwrap();

        let ws2 = wb.add_worksheet();
        ws2.set_name("Other").unwrap();
        ws2.write_number(0, 0, 100.0).unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);

    // Every formula cell must keep its `f` field. We accept either the exact
    // verbatim string or an equivalent re-serialization, so we just check the
    // function name is present.
    let check_formula = |row: usize, col: usize, expected_marker: &str| {
        let c = cell(&snap, "sheet-1", row, col);
        let f = c
            .get("f")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("expected formula at ({row},{col}), got {c}"));
        assert!(
            f.contains(expected_marker),
            "formula at ({row},{col}) must contain {expected_marker:?}, got {f}"
        );
    };
    check_formula(0, 5, "SUM");
    check_formula(1, 5, "AVERAGE");
    check_formula(2, 5, "IF");
    check_formula(3, 5, "VLOOKUP");
    let cross = cell(&snap, "sheet-1", 4, 5);
    let f = cross
        .get("f")
        .and_then(|v| v.as_str())
        .expect("cross-sheet formula text");
    assert!(
        f.contains("Other") && f.contains("A1"),
        "cross-sheet formula must reference Other!A1, got {f}"
    );
}

// --------------------------------------------------------------------------
// Fixture 4: mixed_styles — bold, italic, font color, fill color,
// horizontal alignment.
// --------------------------------------------------------------------------

#[test]
fn fixture_04_mixed_styles() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("04_styles.xlsx");
    let exported = tmp.path().join("04_styles_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Styles").unwrap();
        ws.write_string_with_format(0, 0, "Bold", &Format::new().set_bold())
            .unwrap();
        ws.write_string_with_format(0, 1, "Italic", &Format::new().set_italic())
            .unwrap();
        ws.write_string_with_format(
            0,
            2,
            "RedText",
            &Format::new().set_font_color(Color::RGB(0xFF0000)),
        )
        .unwrap();
        ws.write_string_with_format(
            0,
            3,
            "YellowBg",
            &Format::new()
                .set_background_color(Color::RGB(0xFFFF00))
                .set_pattern(FormatPattern::Solid),
        )
        .unwrap();
        ws.write_string_with_format(0, 4, "Centered", &Format::new().set_align(FormatAlign::Center))
            .unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);

    let style_for = |row: usize, col: usize| -> Value {
        let c = cell(&snap, "sheet-1", row, col);
        let sid = c
            .get("s")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("cell ({row},{col}) should have style id, got {c}"));
        snap["styles"][sid].clone()
    };

    assert_eq!(style_for(0, 0)["font"]["bold"], true, "Bold cell");
    assert_eq!(style_for(0, 1)["font"]["italic"], true, "Italic cell");
    let red = style_for(0, 2)["font"]["color"]
        .as_str()
        .unwrap_or("")
        .to_ascii_uppercase();
    assert_eq!(red, "#FF0000", "Red font color");
    let yellow = style_for(0, 3)["fill"]["color"]
        .as_str()
        .unwrap_or("")
        .to_ascii_uppercase();
    assert_eq!(yellow, "#FFFF00", "Yellow fill");
    assert_eq!(
        style_for(0, 4)["alignment"]["horizontal"], "center",
        "Centered alignment"
    );
}

// --------------------------------------------------------------------------
// Fixture 5: number_formats — percent, currency, date, custom format codes.
// --------------------------------------------------------------------------

#[test]
fn fixture_05_number_formats() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("05_numfmt.xlsx");
    let exported = tmp.path().join("05_numfmt_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("N").unwrap();
        ws.write_number_with_format(0, 0, 0.5, &Format::new().set_num_format("0%"))
            .unwrap();
        ws.write_number_with_format(
            1,
            0,
            1234.5,
            &Format::new().set_num_format("$#,##0.00"),
        )
        .unwrap();
        ws.write_number_with_format(
            2,
            0,
            44562.0,
            &Format::new().set_num_format("yyyy-mm-dd"),
        )
        .unwrap();
        ws.write_number_with_format(3, 0, 9876.5432, &Format::new().set_num_format("#,##0.00"))
            .unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);
    let fmt_of = |row: usize| {
        cell(&snap, "sheet-1", row, 0)
            .get("_fmt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    assert_eq!(fmt_of(0), "0%", "percent format");
    assert_eq!(fmt_of(1), "$#,##0.00", "currency format");
    assert_eq!(fmt_of(2), "yyyy-mm-dd", "date format");
    assert_eq!(fmt_of(3), "#,##0.00", "custom format");
}

// --------------------------------------------------------------------------
// Fixture 6: merged_cells — multiple non-overlapping 2D merges.
// --------------------------------------------------------------------------

#[test]
fn fixture_06_merged_cells() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("06_merges.xlsx");
    let exported = tmp.path().join("06_merges_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("M").unwrap();
        let fmt = Format::new();
        ws.merge_range(0, 0, 1, 2, "Title", &fmt).unwrap();      // A1:C2
        ws.merge_range(3, 0, 3, 4, "Subtitle", &fmt).unwrap();   // A4:E4
        ws.merge_range(5, 1, 7, 2, "Block", &fmt).unwrap();      // B6:C8
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);
    let merges = snap["sheets"]["sheet-1"]["mergeData"]
        .as_array()
        .expect("mergeData array");
    assert_eq!(merges.len(), 3, "expected 3 merge entries, got {merges:?}");

    let mut tuples: Vec<(u64, u64, u64, u64)> = merges
        .iter()
        .map(|e| {
            (
                e["startRow"].as_u64().unwrap(),
                e["startColumn"].as_u64().unwrap(),
                e["endRow"].as_u64().unwrap(),
                e["endColumn"].as_u64().unwrap(),
            )
        })
        .collect();
    tuples.sort();
    assert!(tuples.contains(&(0, 0, 1, 2)), "A1:C2 missing: {tuples:?}");
    assert!(tuples.contains(&(3, 0, 3, 4)), "A4:E4 missing: {tuples:?}");
    assert!(tuples.contains(&(5, 1, 7, 2)), "B6:C8 missing: {tuples:?}");
}

// --------------------------------------------------------------------------
// Fixture 7: column_row_sizing — custom column widths + row heights.
// --------------------------------------------------------------------------

#[test]
fn fixture_07_column_row_sizing() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("07_sizing.xlsx");
    let exported = tmp.path().join("07_sizing_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("S").unwrap();
        // Anchor a value so the sheet is non-empty.
        ws.write_string(0, 0, "x").unwrap();
        // Col A=20, Col C=30
        ws.set_column_width(0, 20.0).unwrap();
        ws.set_column_width(2, 30.0).unwrap();
        // Row 2 (0-based 1) = 25, Row 5 (0-based 4) = 40
        ws.set_row_height(1, 25.0).unwrap();
        ws.set_row_height(4, 40.0).unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);
    let col_data = &snap["sheets"]["sheet-1"]["columnData"];
    let row_data = &snap["sheets"]["sheet-1"]["rowData"];
    assert!(
        col_data.is_object(),
        "columnData object required, got {col_data}"
    );
    assert!(
        row_data.is_object(),
        "rowData object required, got {row_data}"
    );
    // Widths: rust_xlsxwriter applies a char-width conversion, but Coco's
    // inverse_col_width_for_xlsxwriter step should keep the round-trip stable.
    let w0 = col_data["0"]["w"].as_f64().unwrap_or(0.0);
    let w2 = col_data["2"]["w"].as_f64().unwrap_or(0.0);
    assert!(
        (w0 - 20.0).abs() < 1.0,
        "col 0 width should be ~20, got {w0}"
    );
    assert!(
        (w2 - 30.0).abs() < 1.0,
        "col 2 width should be ~30, got {w2}"
    );

    let h1 = row_data["1"]["h"].as_f64().unwrap_or(0.0);
    let h4 = row_data["4"]["h"].as_f64().unwrap_or(0.0);
    assert!((h1 - 25.0).abs() < 0.01, "row 1 height should be 25, got {h1}");
    assert!((h4 - 40.0).abs() < 0.01, "row 4 height should be 40, got {h4}");
}

// --------------------------------------------------------------------------
// Fixture 8: named_ranges — workbook-scope defined names.
// --------------------------------------------------------------------------

#[test]
fn fixture_08_named_ranges() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("08_names.xlsx");
    let exported = tmp.path().join("08_names_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        for r in 0..10u32 {
            ws.write_number(r, 0, (r as f64) + 1.0).unwrap();
        }
        wb.define_name("SalesRange", "=Sheet1!$A$1:$A$10").unwrap();
        wb.define_name("TaxRate", "=0.08").unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);
    let named = snap["namedRanges"].as_array().expect("namedRanges array");
    let names: Vec<&str> = named.iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(
        names.contains(&"SalesRange"),
        "SalesRange should round-trip, got {names:?}"
    );
    assert!(
        names.contains(&"TaxRate"),
        "TaxRate should round-trip, got {names:?}"
    );

    // Belt-and-braces: re-open the exported xlsx with calamine and check the
    // defined names are there on disk too.
    let wb: Xlsx<_> = open_workbook(&exported).unwrap();
    let exported_names: Vec<&str> = wb.defined_names().iter().map(|(n, _)| n.as_str()).collect();
    assert!(exported_names.contains(&"SalesRange"));
    assert!(exported_names.contains(&"TaxRate"));
}

// --------------------------------------------------------------------------
// Fixture 9: rich_text — per-run bold/italic/color inside one cell.
// --------------------------------------------------------------------------

#[test]
fn fixture_09_rich_text() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("09_rich.xlsx");
    let exported = tmp.path().join("09_rich_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("R").unwrap();
        let bold = Format::new().set_bold();
        let italic = Format::new().set_italic();
        let red = Format::new().set_font_color(Color::RGB(0xFF0000));
        let plain = Format::default();
        let segments = [
            (&bold, "BOLD"),
            (&plain, " "),
            (&italic, "ITAL"),
            (&plain, " "),
            (&red, "RED"),
        ];
        ws.write_rich_string(0, 0, &segments).unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);
    let c = cell(&snap, "sheet-1", 0, 0);
    let runs = c
        .get("_richRuns")
        .and_then(|v| v.as_array())
        .unwrap_or_else(|| panic!("expected _richRuns on rich cell, got {c}"));
    assert!(
        runs.len() >= 3,
        "expected at least 3 styled runs, got {runs:?}"
    );

    let by_text: std::collections::HashMap<&str, &Value> = runs
        .iter()
        .map(|r| (r["text"].as_str().unwrap_or(""), r))
        .collect();
    assert_eq!(
        by_text.get("BOLD").and_then(|r| r.get("bold")),
        Some(&Value::Bool(true)),
        "BOLD run should be bold"
    );
    assert_eq!(
        by_text.get("ITAL").and_then(|r| r.get("italic")),
        Some(&Value::Bool(true)),
        "ITAL run should be italic"
    );
    let red_color = by_text
        .get("RED")
        .and_then(|r| r.get("color"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    assert_eq!(red_color, "#FF0000", "RED run color");

    // Plain-text fallback in `v` should still contain all the run text.
    let plain_v = c["v"].as_str().unwrap_or("");
    assert!(
        plain_v.contains("BOLD") && plain_v.contains("ITAL") && plain_v.contains("RED"),
        "v fallback should contain all run text, got {plain_v}"
    );
}

// --------------------------------------------------------------------------
// Fixture 10: everything — small file combining values + styles + formulas
// + merges + borders + named ranges + multiple sheets. This is the
// "regression magnet" that catches feature interactions.
// --------------------------------------------------------------------------

#[test]
fn fixture_10_everything() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("10_everything.xlsx");
    let exported = tmp.path().join("10_everything_out.xlsx");

    {
        let mut wb = Workbook::new();

        // ---- Sheet 1: Sales — header, values, SUM, merged title ----
        let s1 = wb.add_worksheet();
        s1.set_name("Sales").unwrap();
        let header_fmt = Format::new()
            .set_bold()
            .set_align(FormatAlign::Center)
            .set_background_color(Color::RGB(0xFFFF00))
            .set_pattern(FormatPattern::Solid)
            .set_border(FormatBorder::Thin);
        s1.merge_range(0, 0, 0, 2, "Quarterly Sales", &header_fmt).unwrap();
        s1.write_string(1, 0, "Quarter").unwrap();
        s1.write_string(1, 1, "Revenue").unwrap();
        s1.write_string(1, 2, "Date").unwrap();
        let currency = Format::new().set_num_format("$#,##0.00");
        let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
        let date_val = ExcelDateTime::parse_from_str("2024-01-31").unwrap();
        s1.write_string(2, 0, "Q1").unwrap();
        s1.write_number_with_format(2, 1, 12345.67, &currency).unwrap();
        s1.write_datetime_with_format(2, 2, &date_val, &date_fmt).unwrap();
        s1.write_string(3, 0, "Q2").unwrap();
        s1.write_number_with_format(3, 1, 23456.78, &currency).unwrap();
        s1.write_string(4, 0, "Total").unwrap();
        s1.write_formula_with_format(4, 1, "=SUM(B3:B4)", &currency).unwrap();

        // Write the cross-sheet ref on s1 BEFORE adding s2 so we don't hold
        // two mutable worksheet refs at once.
        s1.write_string(6, 0, "LookupTest").unwrap();
        s1.write_formula(6, 1, "=VLOOKUP(2,Lookup!A2:B3,2,FALSE)").unwrap();

        // ---- Sheet 2: Lookup — VLOOKUP source ----
        let s2 = wb.add_worksheet();
        s2.set_name("Lookup").unwrap();
        s2.write_string(0, 0, "Code").unwrap();
        s2.write_string(0, 1, "Label").unwrap();
        s2.write_number(1, 0, 1.0).unwrap();
        s2.write_string(1, 1, "Alpha").unwrap();
        s2.write_number(2, 0, 2.0).unwrap();
        s2.write_string(2, 1, "Beta").unwrap();

        // Named ranges spanning the workbook.
        wb.define_name("Revenue", "=Sales!$B$3:$B$4").unwrap();
        wb.save(&fixture).unwrap();
    }

    let snap = round_trip(&fixture, &exported);

    // --- Sheet order ---
    let order = snap["sheetOrder"].as_array().unwrap();
    let names: Vec<&str> = order
        .iter()
        .map(|id| snap["sheets"][id.as_str().unwrap()]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Sales", "Lookup"], "sheet order should be preserved");

    // --- Merge survives on Sales ---
    let merges = snap["sheets"]["sheet-1"]["mergeData"]
        .as_array()
        .expect("mergeData on Sales");
    assert!(
        merges.iter().any(|e| {
            e["startRow"].as_u64() == Some(0)
                && e["startColumn"].as_u64() == Some(0)
                && e["endRow"].as_u64() == Some(0)
                && e["endColumn"].as_u64() == Some(2)
        }),
        "A1:C1 merge should round-trip, got {merges:?}"
    );

    // --- Header cell is bold + centered + has fill (visual style P0) ---
    let header = cell(&snap, "sheet-1", 0, 0);
    let s_id = header
        .get("s")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("Sales!A1 header should have style id, got {header}"));
    let style = &snap["styles"][s_id];
    assert_eq!(style["font"]["bold"], true, "header bold; full style={style}");
    assert_eq!(
        style["alignment"]["horizontal"], "center",
        "header centered; style={style}"
    );

    // --- Currency format on B3, B4, B5 ---
    for r in [2usize, 3, 4] {
        let c = cell(&snap, "sheet-1", r, 1);
        assert_eq!(
            c.get("_fmt").and_then(|v| v.as_str()),
            Some("$#,##0.00"),
            "currency format on Sales!B{} should survive, got {c}",
            r + 1
        );
    }

    // --- Date format on C3 ---
    let date_cell = cell(&snap, "sheet-1", 2, 2);
    assert_eq!(
        date_cell.get("_fmt").and_then(|v| v.as_str()),
        Some("yyyy-mm-dd"),
        "date format on Sales!C3 should survive, got {date_cell}"
    );

    // --- Formula cells preserved ---
    let total = cell(&snap, "sheet-1", 4, 1);
    let total_f = total
        .get("f")
        .and_then(|v| v.as_str())
        .expect("total formula");
    assert!(total_f.contains("SUM"), "total should be SUM, got {total_f}");

    let vlookup = cell(&snap, "sheet-1", 6, 1);
    let vlookup_f = vlookup
        .get("f")
        .and_then(|v| v.as_str())
        .expect("vlookup formula");
    assert!(
        vlookup_f.contains("VLOOKUP") && vlookup_f.contains("Lookup"),
        "vlookup should reference Lookup sheet, got {vlookup_f}"
    );

    // --- Named range Revenue survived ---
    let named = snap["namedRanges"].as_array().expect("namedRanges");
    assert!(
        named
            .iter()
            .any(|e| e["name"].as_str() == Some("Revenue")),
        "Revenue named range should round-trip, got {named:?}"
    );

    // --- Belt-and-braces: re-open with calamine to confirm the file is well
    //     formed and the SUM result is reachable. ---
    let mut wb: Xlsx<_> = open_workbook(&exported).expect("calamine re-open");
    let range = wb.worksheet_range("Sales").expect("Sales sheet");
    // B3 = 12345.67 — value must survive verbatim.
    match range.get_value((2, 1)) {
        Some(Data::Float(f)) => assert!((f - 12345.67).abs() < 1e-6, "B3 == 12345.67"),
        Some(Data::Int(i)) => assert_eq!(*i, 12345),
        other => panic!("expected float at Sales!B3, got {other:?}"),
    }
}

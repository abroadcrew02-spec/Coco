use calamine::{open_workbook, Data, Reader, Xlsx};
use nicel_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Format, Workbook};
use serde_json::json;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Pull `xl/styles.xml` from an xlsx and return it as a string. Used to assert
/// that a particular `formatCode` is registered after export.
fn read_styles_xml(path: &PathBuf) -> String {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;
    let f = File::open(path).expect("open xlsx");
    let mut z = ZipArchive::new(f).expect("zip");
    let mut s = String::new();
    z.by_name("xl/styles.xml")
        .expect("styles.xml")
        .read_to_string(&mut s)
        .expect("read");
    s
}

#[test]
fn custom_num_format_round_trips() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("custom.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("N").unwrap();
        let fmt = Format::new().set_num_format("#,##0.00");
        ws.write_number_with_format(0, 0, 1234.5, &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.clone().unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("#,##0.00"),
        "expected _fmt='#,##0.00' on imported cell, got {}",
        cell
    );
    assert!((cell["v"].as_f64().unwrap() - 1234.5).abs() < 1e-9);

    let export_result =
        export_xlsx_core(path_str(&exported), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(
        export_result.success,
        "export failed: {:?}",
        export_result.error
    );

    // The exported xlsx must register the same formatCode.
    let styles = read_styles_xml(&exported);
    assert!(
        styles.contains("#,##0.00"),
        "exported styles.xml missing formatCode '#,##0.00': {}",
        styles
    );

    // And the value must still be 1234.5.
    let mut wb: Xlsx<_> = open_workbook(&exported).unwrap();
    let range = wb.worksheet_range("N").unwrap();
    let v = range.get_value((0, 0)).unwrap();
    match v {
        Data::Float(f) => assert!((f - 1234.5).abs() < 1e-9),
        Data::Int(i) => assert_eq!(*i, 1234),
        other => panic!("expected number after round-trip, got {:?}", other),
    }
}

#[test]
fn builtin_percent_format_id_9_maps_to_zero_percent() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("pct.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("P").unwrap();
        // "0%" is built-in numFmtId 9 — rust_xlsxwriter will recognize and reuse it.
        let fmt = Format::new().set_num_format("0%");
        ws.write_number_with_format(0, 0, 0.5, &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("0%"),
        "expected built-in id 9 to map to '0%', got {}",
        cell
    );
    assert!((cell["v"].as_f64().unwrap() - 0.5).abs() < 1e-9);
}

#[test]
fn cell_without_num_format_has_no_fmt() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("plain.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("S").unwrap();
        ws.write_number(0, 0, 42.0).unwrap();
        ws.write_string(0, 1, "hello").unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.unwrap()).unwrap();

    let num_cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let str_cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["1"];
    assert!(
        num_cell.get("_fmt").is_none(),
        "plain number should have no _fmt, got {}",
        num_cell
    );
    assert!(
        str_cell.get("_fmt").is_none(),
        "plain string should have no _fmt, got {}",
        str_cell
    );
}

#[test]
fn date_format_still_round_trips_regression() {
    // Regression check: the existing DateTime fallback in data_to_cell must
    // remain — even when the new code path runs, dates without an explicit
    // numFmt should still get a date _fmt hint.
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("date.xlsx");
    let exported = tmp.path().join("exported_date.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("D").unwrap();
        let fmt = Format::new().set_num_format("yyyy-mm-dd");
        ws.write_number_with_format(0, 0, 44562.0, &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.clone().unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("yyyy-mm-dd"),
        "expected date _fmt preserved, got {}",
        cell
    );

    let export_result =
        export_xlsx_core(path_str(&exported), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(export_result.success);

    let mut wb: Xlsx<_> = open_workbook(&exported).unwrap();
    let range = wb.worksheet_range("D").unwrap();
    let cell = range.get_value((0, 0)).unwrap();
    match cell {
        Data::DateTime(dt) => {
            assert!((dt.as_f64() - 44562.0).abs() < 1e-9);
        }
        other => panic!("expected DateTime after round-trip, got {:?}", other),
    }
}

#[test]
fn text_format_at_sign_round_trips() {
    // Built-in id 49 = "@" (text). Ensure cells with explicit text format
    // are flagged on import.
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("text.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("T").unwrap();
        let fmt = Format::new().set_num_format("@");
        ws.write_string_with_format(0, 0, "0123", &fmt).unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&imported.handle.snapshot_json.unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(
        cell.get("_fmt").and_then(|v| v.as_str()),
        Some("@"),
        "expected '@' text format, got {}",
        cell
    );
    assert_eq!(cell["v"].as_str(), Some("0123"));
}

#[test]
fn import_does_not_warn_about_number_formats() {
    let tmp = TempDir::new().unwrap();
    let fixture = tmp.path().join("any.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("X").unwrap();
        ws.write_string(0, 0, "hi").unwrap();
        wb.save(&fixture).unwrap();
    }

    let imported = import_xlsx_core(path_str(&fixture)).unwrap();
    // Number formats are preserved, so no import notice may mention them (the
    // unconditional XLSX_POC_IMPORT banner that used to list them is gone).
    assert!(
        !imported.warnings.iter().any(|w| w.code == "XLSX_POC_IMPORT"),
        "the unconditional PoC banner must not come back: {:?}",
        imported.warnings
    );
    assert!(
        !imported
            .warnings
            .iter()
            .any(|w| w.message.contains("number formats")),
        "no import warning should mention number formats: {:?}",
        imported.warnings
    );
}

// ── #343(b): style `n.pattern` vs per-cell `_fmt` precedence on export ─────
//
// These build snapshot JSON directly (rather than round-tripping a real
// xlsx) so the style's `n.pattern` and the cell's `_fmt` can be set to
// different, conflicting values — the case that never arises on a fresh
// xlsx import (both come from the same xf there) but does arise once the
// app's own number-format dialog/buttons have touched a cell. The rule
// mirrors `resolveCellNumberFormat` in src/store/numberFormat.ts (commit
// 57f43a64): see `effective_num_format` in xlsx_io.rs for the exact
// precedence this pins.

#[test]
fn fmt_wins_when_style_has_no_num_format_pattern() {
    // Style carries bold only (no `n` at all) — nothing to decide the format,
    // so `_fmt` counts.
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("fmt_wins_no_style_pattern.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": { "0": { "v": 0.5, "_fmt": "0%", "s": "st1" } }
                }
            }
        },
        "styles": { "st1": { "bl": 1 } }
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        styles.contains("0%"),
        "expected '0%' numFmt in styles.xml: {}",
        styles
    );
    assert!(
        styles.contains("<b/>") || styles.contains("<b "),
        "expected bold font entry in styles.xml: {}",
        styles
    );
}

#[test]
fn general_style_pattern_beats_stale_fmt() {
    // Style's own `n.pattern` is "General" -- that decides "no format"
    // outright, and the stale `_fmt` (as left behind by Univer's "clear
    // format", which doesn't yet clear `_fmt` itself — see #343 in
    // CHANGELOG's Known issues) must not resurrect the old percent format.
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("general_style_beats_fmt.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": { "0": { "v": 0.5, "_fmt": "0%", "s": "st1" } }
                }
            }
        },
        "styles": { "st1": { "n": { "pattern": "General" } } }
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        !styles.contains("0%"),
        "General style pattern must suppress the stale `_fmt`, got styles.xml: {}",
        styles
    );
}

#[test]
fn non_general_style_pattern_beats_fmt() {
    // Style's own `n.pattern` is a real, non-General format -- it decides
    // the outcome outright, `_fmt` is never consulted.
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("style_pattern_beats_fmt.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": { "0": { "v": 1234.5, "_fmt": "0%", "s": "st1" } }
                }
            }
        },
        "styles": { "st1": { "n": { "pattern": "#,##0.00" } } }
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        styles.contains("#,##0.00"),
        "expected the style's own '#,##0.00' pattern in styles.xml: {}",
        styles
    );
    assert!(
        !styles.contains("0%"),
        "style pattern must win over the stale `_fmt`, got styles.xml: {}",
        styles
    );
}

#[test]
fn known_issue_343a_stale_fmt_with_no_style_still_exports() {
    // Known issue, tracked separately as #343 (a) in CHANGELOG's Known
    // issues: Univer's "clear format" removes the cell's style but not the
    // per-cell `_fmt` sidecar, so a cleared number format can still come
    // back in the exported xlsx. With no style at all on the cell,
    // `effective_num_format` has nothing to override `_fmt` with, so the
    // stale percent formatting exports as-is. #343(b) (this file's other
    // tests) does not fix this half of #343 -- that needs the frontend's
    // clear-format path to also clear `_fmt` (see `clearPatternFor` in
    // src/store/numberFormat.ts). Pinned here so a future fix updates this
    // test deliberately instead of silently changing behavior.
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("known_issue_343a.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": { "0": { "v": 0.5, "_fmt": "0%" } }
                }
            }
        },
        "styles": {}
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        styles.contains("0%"),
        "known issue #343(a): a stale `_fmt` with no style at all still exports; got styles.xml: {}",
        styles
    );
}

#[test]
fn fmt_general_alone_means_no_format() {
    // A cell with only `_fmt: "General"` (no style at all) must not emit any
    // custom numFmt -- General means "no format" on the `_fmt` side too.
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("fmt_general_alone.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": { "0": { "v": 42.0, "_fmt": "General" } }
                }
            }
        },
        "styles": {}
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        !styles.contains("formatCode=\"General\""),
        "General _fmt must not register a custom numFmt entry, got styles.xml: {}",
        styles
    );
}

#[test]
fn blank_or_unknown_style_pattern_falls_through_to_fmt() {
    // Three ways a style ends up with no usable `n.pattern`, all of which
    // must fall through to `_fmt`:
    //   (0,0) inline `s` object whose own pattern ("0.0") is non-blank --
    //         not a fallback case itself, but proves the inline-object path
    //         (#352) decides the format directly without a styles-table id.
    //   (0,1) `s` is a styles-table id that doesn't exist ("missing").
    //   (0,2) `s` points to a style whose `n.pattern` is whitespace-only.
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("blank_or_unknown_style_pattern.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": {
                        "0": { "v": 0.25, "s": { "n": { "pattern": "0.0" } } },
                        "1": { "v": 0.5, "_fmt": "0%", "s": "missing" },
                        "2": { "v": 0.5, "_fmt": "0%", "s": "st-blank" }
                    }
                }
            }
        },
        "styles": { "st-blank": { "n": { "pattern": "  " } } }
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        styles.contains("0.0"),
        "expected the inline style's own '0.0' pattern in styles.xml: {}",
        styles
    );
    assert!(
        styles.contains("0%"),
        "expected `_fmt` '0%' to win for an unknown/blank style pattern, got styles.xml: {}",
        styles
    );
}

#[test]
fn lowercase_general_style_pattern_means_no_format() {
    // "general" in any letter case on the style's own pattern means "no
    // format", same as the canonical "General".
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("lowercase_general_style.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": { "0": { "v": 42.0, "s": "st1" } }
                }
            }
        },
        "styles": { "st1": { "n": { "pattern": "general" } } }
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        !styles.contains("formatCode=\"general\""),
        "lowercase 'general' must not register a custom numFmt entry, got styles.xml: {}",
        styles
    );
}

#[test]
fn inline_style_object_applies_bold_fill_and_num_format() {
    // #352: `s` as an inline style object (not a styles-table id) must not
    // silently drop its bold/fill/etc. formatting on export. Exercises the
    // xlsx_io.rs fix that parses an inline `s` object via
    // `CellStyle::from_json` when building the cell's `Format`, alongside
    // `effective_num_format` (which already read `n.pattern` off an inline
    // object directly).
    let tmp = TempDir::new().unwrap();
    let exported = tmp.path().join("inline_style_object.xlsx");
    let snapshot = json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": {
            "sheet-1": {
                "name": "Sheet1",
                "cellData": {
                    "0": {
                        "0": {
                            "v": 0.5,
                            "s": { "bl": 1, "bg": { "rgb": "#FFFF00" }, "n": { "pattern": "0%" } }
                        }
                    }
                }
            }
        },
        "styles": {}
    })
    .to_string();

    let result = export_xlsx_core(path_str(&exported), snapshot).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let styles = read_styles_xml(&exported);
    assert!(
        styles.contains("<b/>") || styles.contains("<b "),
        "expected a bold font entry for the inline style object, got: {}",
        styles
    );
    assert!(
        styles.contains("FFFF00"),
        "expected the yellow fill for the inline style object, got: {}",
        styles
    );
    assert!(
        styles.contains("0%"),
        "expected '0%' numFmt for the inline style object, got: {}",
        styles
    );
}

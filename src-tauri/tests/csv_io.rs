//! Cross-cutting CSV/TSV I/O tests that exercise the import_csv_core ↔
//! workbook_export_csv pair as a unit. These complement the more granular
//! tests in csv_import.rs / csv_export.rs by hitting round-trip edge cases:
//!
//!   - encoding round-trips (UTF-8, UTF-8 BOM, Shift_JIS)
//!   - structural quirks (single cell, ragged rows, trailing empty cells,
//!     very long single field, mixed CRLF/LF)
//!   - explicit error paths (empty workbook, unknown encoding)
//!   - TSV write → read round-trip
//!
//! Pattern mirrors xlsx_roundtrip.rs: TempDir + write fixture (or snapshot)
//! + call *_core (or the Tauri command which doesn't require AppHandle) +
//! assert against serde_json::Value.

use coco_lib::commands::csv_io::{
    import_csv_core, list_sheet_names, read_sqlite_columns, read_sqlite_rows, read_sqlite_tables,
    workbook_export_csv,
};
use rusqlite::Connection;
use std::fs;
use tempfile::TempDir;

fn path_in(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        &bytes[3..]
    } else {
        bytes
    }
}

// ---------- Round-trip: import → snapshot → export ----------

#[test]
fn import_then_export_preserves_basic_values() {
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "in.csv");
    let out_path = path_in(&dir, "out.csv");
    fs::write(
        &in_path,
        "Name,Score,Pass\r\nAlice,92.5,TRUE\r\nBob,58,FALSE\r\n",
    )
    .unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snapshot_json = result.handle.snapshot_json.unwrap();
    let export = workbook_export_csv(out_path.clone(), snapshot_json, None, None).unwrap();
    assert!(export.success, "export failed: {:?}", export.error);
    assert_eq!(export.rows_written, 3);

    let bytes = fs::read(&out_path).unwrap();
    let body = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let lines: Vec<&str> = body.split("\r\n").filter(|l| !l.is_empty()).collect();
    assert_eq!(lines[0], "Name,Score,Pass");
    assert_eq!(lines[1], "Alice,92.5,TRUE");
    assert_eq!(lines[2], "Bob,58,FALSE");
}

#[test]
fn shift_jis_export_then_import_preserves_japanese() {
    // CP932 (Shift_JIS) round-trip: export -> re-import -> values unchanged.
    let dir = TempDir::new().unwrap();
    let out_path = path_in(&dir, "rt.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": { "0": { "v": "氏名" }, "1": { "v": "得点" } },
                    "1": { "0": { "v": "山田太郎" }, "1": { "v": 90 } },
                    "2": { "0": { "v": "佐藤花子" }, "1": { "v": 85 } }
                }
            }
        }
    }"#;

    let export = workbook_export_csv(
        out_path.clone(),
        snapshot.to_string(),
        None,
        Some("shift_jis".to_string()),
    )
    .unwrap();
    assert!(export.success, "export err: {:?}", export.error);

    // Auto-detect should pick up Shift_JIS on re-import.
    let reimport = import_csv_core(out_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&reimport.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cd["0"]["0"]["v"], "氏名");
    assert_eq!(cd["0"]["1"]["v"], "得点");
    assert_eq!(cd["1"]["0"]["v"], "山田太郎");
    assert_eq!(cd["1"]["1"]["v"], 90);
    assert_eq!(cd["2"]["0"]["v"], "佐藤花子");
    assert_eq!(cd["2"]["1"]["v"], 85);

    // Re-import should flag the encoding as Shift_JIS (non-UTF-8 → warning).
    let enc = reimport
        .warnings
        .iter()
        .find(|w| w.code == "CSV_ENCODING_DETECTED")
        .expect("expected encoding warning");
    assert!(
        enc.message.contains("Shift_JIS"),
        "expected Shift_JIS in: {:?}",
        enc.message
    );
    assert_eq!(enc.severity, "warning");
}

#[test]
fn utf8_bom_default_export_then_import_strips_bom_back() {
    // Default encoding writes BOM; re-import should not surface the BOM as
    // a leading character in the first cell.
    let dir = TempDir::new().unwrap();
    let out_path = path_in(&dir, "bom.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": { "s1": { "name": "S", "cellData": { "0": { "0": { "v": "héllo" } } } } }
    }"#;
    let export = workbook_export_csv(out_path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(export.success);

    // Confirm the file starts with the BOM.
    let raw = fs::read(&out_path).unwrap();
    assert_eq!(&raw[..3], &[0xEF, 0xBB, 0xBF]);

    // Re-import: first cell value must be "héllo" verbatim (no BOM smuggled in).
    let reimport = import_csv_core(out_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&reimport.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(
        snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"],
        "héllo"
    );
}

#[test]
fn tsv_export_then_import_roundtrip() {
    // Write a .tsv, ensure the export uses tabs, then re-import via the
    // .tsv extension which forces tab delimiting.
    let dir = TempDir::new().unwrap();
    let out_path = path_in(&dir, "rt.tsv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": { "0": { "v": "first" }, "1": { "v": "has,comma" }, "2": { "v": "last" } },
                    "1": { "0": { "v": 1 }, "1": { "v": 2 }, "2": { "v": 3 } }
                }
            }
        }
    }"#;
    let export = workbook_export_csv(out_path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(export.success, "export err: {:?}", export.error);

    let raw = fs::read(&out_path).unwrap();
    let body = std::str::from_utf8(strip_bom(&raw)).unwrap();
    // Tabs as separator; the comma inside "has,comma" must NOT be escaped
    // because it isn't the delimiter for TSV.
    assert!(body.contains("first\thas,comma\tlast"), "got: {:?}", body);

    let reimport = import_csv_core(out_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&reimport.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cd["0"]["0"]["v"], "first");
    assert_eq!(cd["0"]["1"]["v"], "has,comma");
    assert_eq!(cd["0"]["2"]["v"], "last");
    assert_eq!(cd["1"]["0"]["v"], 1);
    assert_eq!(cd["1"]["2"]["v"], 3);
}

// ---------- Structural edge cases ----------

#[test]
fn single_cell_file_imports_and_exports() {
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "one.csv");
    fs::write(&in_path, "solo\n").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snapshot_json = result.handle.snapshot_json.unwrap();
    let snap: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"], "solo");

    let out_path = path_in(&dir, "one_out.csv");
    let export = workbook_export_csv(out_path.clone(), snapshot_json, None, None).unwrap();
    assert!(export.success);
    assert_eq!(
        export.rows_written, 1,
        "single-cell sheet → exactly one row written"
    );

    let raw = fs::read(&out_path).unwrap();
    let body = std::str::from_utf8(strip_bom(&raw)).unwrap();
    assert_eq!(body, "solo\r\n");
}

#[test]
fn ragged_rows_pad_to_max_column_width() {
    // The csv crate's flexible(true) lets us accept rows of varying width.
    // Shorter rows must not crash, and the snapshot should leave the missing
    // columns as sparse (no entry rather than an empty-string cell).
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "ragged.csv");
    fs::write(&in_path, "a,b,c\n1,2\nx\n7,8,9,10\n").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];

    // Row 0: full three columns.
    assert_eq!(cd["0"]["0"]["v"], "a");
    assert_eq!(cd["0"]["1"]["v"], "b");
    assert_eq!(cd["0"]["2"]["v"], "c");

    // Row 1: only two cells; col 2 must be absent (sparse).
    assert_eq!(cd["1"]["0"]["v"], 1);
    assert_eq!(cd["1"]["1"]["v"], 2);
    assert!(
        cd["1"].as_object().unwrap().get("2").is_none(),
        "row 1 col 2 should be sparse, got: {:?}",
        cd["1"]
    );

    // Row 2: single cell.
    assert_eq!(cd["2"]["0"]["v"], "x");
    assert!(cd["2"].as_object().unwrap().get("1").is_none());

    // Row 3: an EXTRA fourth cell — must be accepted, not truncated, and
    // should bump the sheet column dimension.
    assert_eq!(cd["3"]["0"]["v"], 7);
    assert_eq!(cd["3"]["3"]["v"], 10);
}

#[test]
fn trailing_empty_cells_in_row_are_sparse_on_import_and_padded_on_export() {
    // "a,b,,\n" has two trailing empties. On import they're sparse (skipped).
    // On export, the row dimension is determined by the rightmost populated
    // cell, so the trailing empties are NOT re-emitted — only the populated
    // columns appear, plus any cells in between.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "trailing.csv");
    fs::write(&in_path, "a,b,,\n,x,,y\n").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];

    // Row 0: only cols 0 and 1 have content; cols 2 and 3 are sparse.
    let row0 = cd["0"].as_object().unwrap();
    assert!(row0.contains_key("0"));
    assert!(row0.contains_key("1"));
    assert!(!row0.contains_key("2"));
    assert!(!row0.contains_key("3"));

    // Row 1: col 0 empty, col 1 = x, col 2 empty, col 3 = y.
    let row1 = cd["1"].as_object().unwrap();
    assert!(!row1.contains_key("0"));
    assert_eq!(row1["1"]["v"], "x");
    assert!(!row1.contains_key("2"));
    assert_eq!(row1["3"]["v"], "y");

    // Export round-trip: max col is 3 (from "y"), so each row must have 4
    // comma-separated fields with the unpopulated ones being empty strings.
    let dir2 = TempDir::new().unwrap();
    let out_path = path_in(&dir2, "out.csv");
    let snap_str = serde_json::to_string(&snap).unwrap();
    let _ = workbook_export_csv(out_path.clone(), snap_str, None, None).unwrap();
    let body_bytes = fs::read(&out_path).unwrap();
    let body = std::str::from_utf8(strip_bom(&body_bytes)).unwrap();
    let lines: Vec<&str> = body.split("\r\n").filter(|l| !l.is_empty()).collect();
    assert_eq!(
        lines.len(),
        2,
        "should have exactly two rows, got: {:?}",
        lines
    );
    // Each line must have exactly 4 fields (= max_col + 1 = 4) including blanks.
    for line in &lines {
        assert_eq!(
            line.split(',').count(),
            4,
            "row should have 4 fields padded with empties: {:?}",
            line
        );
    }
    assert_eq!(lines[0], "a,b,,");
    assert_eq!(lines[1], ",x,,y");
}

#[test]
fn very_long_single_field_imports_intact() {
    // Make sure the csv crate doesn't truncate a giant single cell. 100KB
    // is well above any default buffer size (csv's default is 8KB).
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "long.csv");
    let huge: String = "a".repeat(100_000);
    fs::write(&in_path, format!("{},next\n", huge)).unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    let v = cd["0"]["0"]["v"].as_str().expect("should be a string");
    assert_eq!(v.len(), 100_000, "cell length should be 100k chars");
    assert!(v.chars().all(|c| c == 'a'));
    assert_eq!(cd["0"]["1"]["v"], "next");
}

#[test]
fn mixed_crlf_and_lf_import_preserves_row_separation() {
    // Heterogeneous line endings. Already covered in csv_import.rs, but
    // we add a round-trip variant here that also checks export normalizes
    // to CRLF.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "mixed.csv");
    fs::write(&in_path, b"a,b\r\nc,d\ne,f\r").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cd["0"]["0"]["v"], "a");
    assert_eq!(cd["0"]["1"]["v"], "b");
    assert_eq!(cd["1"]["0"]["v"], "c");
    assert_eq!(cd["1"]["1"]["v"], "d");
    assert_eq!(cd["2"]["0"]["v"], "e");
    assert_eq!(cd["2"]["1"]["v"], "f");

    // Export should emit CRLF only — no lone LF or lone CR anywhere.
    let snap_str = serde_json::to_string(&snap).unwrap();
    let out_dir = TempDir::new().unwrap();
    let out_path = path_in(&out_dir, "out.csv");
    let export = workbook_export_csv(out_path.clone(), snap_str, None, None).unwrap();
    assert!(export.success);
    let raw = fs::read(&out_path).unwrap();
    let body = std::str::from_utf8(strip_bom(&raw)).unwrap();
    // strip CRLFs and confirm no stragglers.
    let no_crlf = body.replace("\r\n", "");
    assert!(
        !no_crlf.contains('\r'),
        "lone CR found in export: {:?}",
        body
    );
    assert!(
        !no_crlf.contains('\n'),
        "lone LF found in export: {:?}",
        body
    );
}

// ---------- Error paths ----------

#[test]
fn empty_workbook_export_returns_csv_empty_workbook() {
    // No sheetOrder => CSV_EMPTY_WORKBOOK code is surfaced.
    let dir = TempDir::new().unwrap();
    let out_path = path_in(&dir, "empty.csv");
    let snapshot = r#"{ "sheets": {} }"#;
    let result = workbook_export_csv(out_path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("CSV_EMPTY_WORKBOOK"));
    assert!(
        !std::path::Path::new(&out_path).exists(),
        "no file should have been created on error"
    );
}

#[test]
fn export_with_no_cells_writes_zero_rows() {
    // Sheet exists but has empty cellData. Should be a successful export
    // with rows_written = 0 (not an error).
    let dir = TempDir::new().unwrap();
    let out_path = path_in(&dir, "norows.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": { "s1": { "name": "S", "cellData": {} } }
    }"#;
    let result = workbook_export_csv(out_path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(
        result.success,
        "expected success even with no rows; got error: {:?}",
        result.error
    );
    assert_eq!(result.rows_written, 0);

    let raw = fs::read(&out_path).unwrap();
    // BOM only (no body) for UTF-8 BOM default.
    assert_eq!(raw, vec![0xEF, 0xBB, 0xBF]);
}

#[test]
fn list_sheet_names_uses_synthesized_placeholder_for_non_string_entries() {
    // sheetOrder contains a non-string element. The code path generates a
    // "sheet-{i+1}" placeholder so the array length stays aligned.
    let snapshot = r#"{
        "sheetOrder": ["s1", 42, "s3"],
        "sheets": {
            "s1": { "name": "First" },
            "s3": { "name": "Third" }
        }
    }"#;
    let sheets = list_sheet_names(snapshot.to_string()).unwrap();
    assert_eq!(sheets.len(), 3, "synthesized entry should preserve length");
    assert_eq!(sheets[0].id, "s1");
    assert_eq!(sheets[0].name, "First");
    // Synthesized entry: id "sheet-2", name "Sheet2" (1-based positional).
    assert_eq!(sheets[1].id, "sheet-2");
    assert_eq!(sheets[1].name, "Sheet2");
    assert_eq!(sheets[2].id, "s3");
    assert_eq!(sheets[2].name, "Third");
}

#[test]
fn list_sheet_names_falls_back_to_positional_name_when_sheet_missing() {
    // sheetOrder lists an id whose record isn't in `sheets`. The fallback
    // name follows the same Sheet{n} positional pattern.
    let snapshot = r#"{
        "sheetOrder": ["ghost"],
        "sheets": {}
    }"#;
    let sheets = list_sheet_names(snapshot.to_string()).unwrap();
    assert_eq!(sheets.len(), 1);
    assert_eq!(sheets[0].id, "ghost");
    assert_eq!(sheets[0].name, "Sheet1");
}

// ---------- Encoding override edge cases ----------

#[test]
fn export_with_utf8_no_bom_writes_multibyte_chars_intact() {
    // Sanity: UTF-8 (no BOM) export of Japanese should produce the canonical
    // multibyte sequence for "氏名" (E6 B0 8F E5 90 8D) and "あ" (E3 81 82).
    let dir = TempDir::new().unwrap();
    let out_path = path_in(&dir, "u8.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": { "s1": { "name": "S", "cellData": { "0": { "0": { "v": "氏名あ" } } } } }
    }"#;
    let result = workbook_export_csv(
        out_path.clone(),
        snapshot.to_string(),
        None,
        Some("utf8".to_string()),
    )
    .unwrap();
    assert!(result.success);
    let raw = fs::read(&out_path).unwrap();
    // No BOM.
    assert_ne!(&raw[..raw.len().min(3)], &[0xEF, 0xBB, 0xBF]);
    // Should start with E6 B0 8F (氏).
    assert!(
        raw.starts_with(&[0xE6, 0xB0, 0x8F, 0xE5, 0x90, 0x8D, 0xE3, 0x81, 0x82]),
        "unexpected UTF-8 prefix: {:?}",
        &raw[..raw.len().min(12)]
    );
}

#[test]
fn import_with_explicit_utf8_when_file_actually_sjis_produces_replacement_chars() {
    // Edge: user forces UTF-8 but the file is really Shift_JIS. The decoder
    // uses from_utf8_lossy so we get U+FFFD replacement chars rather than
    // an error — verify the path doesn't crash and the replacement char
    // appears in the cell.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "mismatch.csv");
    // SJIS "名前" — invalid as UTF-8.
    fs::write(&in_path, [0x96u8, 0xBC, 0x91, 0x4F, b'\n']).unwrap();

    let result = import_csv_core(in_path, Some("utf8".to_string())).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let v = snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"]
        .as_str()
        .expect("expected string cell");
    assert!(
        v.contains('\u{FFFD}'),
        "expected U+FFFD replacement char in lossy UTF-8 decode of SJIS bytes, got: {:?}",
        v
    );

    let enc = result
        .warnings
        .iter()
        .find(|w| w.code == "CSV_ENCODING_DETECTED")
        .expect("CSV_ENCODING_DETECTED missing");
    assert!(enc.message.contains("forced"));
}

// ---------- Low tier edge cases (low-csv-import-edge-cases) ----------

#[test]
fn single_cell_without_trailing_newline_imports_one_row() {
    // RFC 4180 doesn't require a trailing newline. Excel and Numbers both
    // accept a single cell with no line terminator. Our import path must
    // surface this as exactly one row, one column.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "noeol.csv");
    fs::write(&in_path, b"solo").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cd["0"]["0"]["v"], "solo");
    // No second row.
    assert!(cd.as_object().unwrap().get("1").is_none());
}

#[test]
fn bom_only_file_imports_as_empty_sheet() {
    // A file consisting solely of the UTF-8 BOM has no cell content. The
    // import must not crash and must produce an empty cellData object —
    // exporting the snapshot back out should round-trip cleanly.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "bomonly.csv");
    fs::write(&in_path, [0xEFu8, 0xBB, 0xBF]).unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert!(
        cd.as_object().map(|o| o.is_empty()).unwrap_or(false),
        "cellData should be empty, got: {:?}",
        cd
    );
}

#[test]
fn truly_empty_file_imports_as_empty_sheet() {
    // Zero-byte input. The import path must not panic or treat the file as
    // an error — an empty CSV is a valid (degenerate) workbook with one
    // empty sheet.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "empty.csv");
    fs::write(&in_path, b"").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert!(cd.as_object().map(|o| o.is_empty()).unwrap_or(false));
    // SheetOrder still produced so the workbook can be displayed in the UI.
    assert_eq!(snap["sheetOrder"].as_array().unwrap().len(), 1);
}

#[test]
fn quoted_field_with_quotes_comma_and_newline_combined() {
    // RFC 4180 hardest case: a single quoted field that contains the
    // delimiter (,), an escaped quote (""), AND an embedded newline.
    // All three must be unescaped/preserved correctly inside one cell.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "rfc4180.csv");
    fs::write(
        &in_path,
        b"\"He said: \"\"hi, world\"\",\nand left.\",tail\n",
    )
    .unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(
        cd["0"]["0"]["v"], "He said: \"hi, world\",\nand left.",
        "quoted field must contain literal comma, escaped quotes, and embedded newline"
    );
    assert_eq!(cd["0"]["1"]["v"], "tail");
    // Critically: one logical row, not two (the embedded \n was inside quotes).
    assert!(!cd.as_object().unwrap().contains_key("1"));
}

#[test]
fn locale_decimal_comma_stays_as_string() {
    // We DO NOT implement locale-aware decimal-comma parsing. A value like
    // "1,23" should NOT silently be coerced to 1.23 — it's two CSV fields
    // ("1" and "23") under the default comma delimiter. Pin the current
    // behavior so a future change is forced through a deliberate review.
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "locale.csv");
    fs::write(&in_path, b"price\n1,23\n3,14\n").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    // Two separate integer columns, NOT one float.
    assert_eq!(cd["1"]["0"]["v"], 1);
    assert_eq!(cd["1"]["1"]["v"], 23);
    assert_eq!(cd["2"]["0"]["v"], 3);
    assert_eq!(cd["2"]["1"]["v"], 14);
}

#[test]
fn locale_decimal_comma_in_quoted_field_stays_text() {
    // A quoted "1,23" is one field. We must NOT parse it as 1.23 — the
    // period-vs-comma convention is locale-specific and we don't track
    // locale. The value stays as the literal string "1,23".
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "locale_quoted.csv");
    fs::write(&in_path, b"price\n\"1,23\"\n\"3,14\"\n").unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(
        cd["1"]["0"]["v"], "1,23",
        "decimal-comma string must not be coerced to float"
    );
    assert_eq!(cd["2"]["0"]["v"], "3,14");
    // Only one column populated.
    assert!(cd["1"].as_object().unwrap().get("1").is_none());
}

#[test]
fn field_at_32k_chars_imports_intact() {
    // Excel's per-cell text cap is 32,767 chars. Exactly at the cap must
    // import without truncation. (The 100k version is already tested in
    // very_long_single_field_imports_intact; this fixes the boundary at
    // the Excel-documented limit.)
    let dir = TempDir::new().unwrap();
    let in_path = path_in(&dir, "32k.csv");
    let big: String = "x".repeat(32_767);
    fs::write(&in_path, format!("{},next\n", big)).unwrap();

    let result = import_csv_core(in_path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cd = &snap["sheets"]["sheet-1"]["cellData"];
    let v = cd["0"]["0"]["v"].as_str().expect("string cell");
    assert_eq!(
        v.len(),
        32_767,
        "value at the 32,767 Excel cap must survive intact"
    );
    assert_eq!(cd["0"]["1"]["v"], "next");
}

// ---------------------------------------------------------------------------
// #310 — SQLite source commands
// ---------------------------------------------------------------------------

/// Helper: create a minimal SQLite DB with two tables and return its path.
fn make_sqlite_db(dir: &TempDir) -> String {
    let db_path = dir.path().join("test.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE stocks (ticker TEXT, price REAL, industry TEXT);
         INSERT INTO stocks VALUES ('MSFT', 420.0, 'Technology');
         INSERT INTO stocks VALUES ('AAPL', 185.5, 'Technology');
         INSERT INTO stocks VALUES ('Toyota', 3200.0, 'Automotive');
         CREATE TABLE metadata (key TEXT, value TEXT);
         INSERT INTO metadata VALUES ('version', '1');",
    )
    .unwrap();
    db_path.to_string_lossy().into_owned()
}

#[test]
fn read_sqlite_tables_returns_user_tables() {
    let dir = TempDir::new().unwrap();
    let db_path = make_sqlite_db(&dir);

    let tables = read_sqlite_tables(db_path).unwrap();
    // Both user tables must be present; system tables must be absent.
    assert!(tables.contains(&"stocks".to_string()), "missing: stocks");
    assert!(tables.contains(&"metadata".to_string()), "missing: metadata");
    assert!(
        tables.iter().all(|t| !t.starts_with("sqlite_")),
        "system table leaked: {:?}",
        tables
    );
}

#[test]
fn read_sqlite_columns_returns_column_names() {
    let dir = TempDir::new().unwrap();
    let db_path = make_sqlite_db(&dir);

    let cols = read_sqlite_columns(db_path, "stocks".to_string()).unwrap();
    assert_eq!(cols, vec!["ticker", "price", "industry"]);
}

#[test]
fn read_sqlite_columns_errors_on_missing_table() {
    let dir = TempDir::new().unwrap();
    let db_path = make_sqlite_db(&dir);

    let err = read_sqlite_columns(db_path, "nonexistent".to_string()).unwrap_err();
    assert!(
        err.contains("テーブルが見つかりません"),
        "unexpected error: {}",
        err
    );
}

#[test]
fn read_sqlite_rows_returns_all_data_as_strings() {
    let dir = TempDir::new().unwrap();
    let db_path = make_sqlite_db(&dir);

    let rows = read_sqlite_rows(db_path, "stocks".to_string(), None).unwrap();
    assert_eq!(rows.len(), 3, "expected 3 rows, got {}", rows.len());

    let msft = rows.iter().find(|r| r.get("ticker").map(|s| s.as_str()) == Some("MSFT"));
    assert!(msft.is_some(), "MSFT row not found");
    let msft = msft.unwrap();
    assert_eq!(msft["industry"], "Technology");
    // REAL 420.0 → "420" (fract == 0, stored as integer)
    assert_eq!(msft["price"], "420");

    let aapl = rows.iter().find(|r| r.get("ticker").map(|s| s.as_str()) == Some("AAPL"));
    let aapl = aapl.unwrap();
    // 185.5 has fractional part.
    assert_eq!(aapl["price"], "185.5");
}

#[test]
fn read_sqlite_rows_respects_max_rows_cap() {
    let dir = TempDir::new().unwrap();
    let db_path = make_sqlite_db(&dir);

    // stocks has 3 rows; cap at 2.
    let rows = read_sqlite_rows(db_path, "stocks".to_string(), Some(2)).unwrap();
    assert_eq!(rows.len(), 2, "max_rows=2 should limit result to 2");
}

#[test]
fn read_sqlite_tables_errors_on_nonexistent_path() {
    let err = read_sqlite_tables("/no/such/file.db".to_string()).unwrap_err();
    assert!(!err.is_empty());
}

#[test]
fn read_sqlite_columns_rejects_injection_attempt() {
    let dir = TempDir::new().unwrap();
    let db_path = make_sqlite_db(&dir);

    // Table name contains a semicolon — should be rejected by the validation guard.
    let err = read_sqlite_columns(db_path, "stocks; DROP TABLE stocks".to_string()).unwrap_err();
    assert!(
        err.contains("テーブル名が不正です"),
        "unexpected error: {}",
        err
    );
}

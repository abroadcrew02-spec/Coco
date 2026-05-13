use coco_lib::commands::csv_io::import_csv_core;
use std::fs;
use tempfile::TempDir;

fn path_in(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

#[test]
fn bad_extension_rejected() {
    let result = import_csv_core("not_a_csv.xlsx".to_string(), None);
    assert!(result.is_err());
    let err = result.err().unwrap();
    assert!(
        err.contains("CSV_INVALID_EXTENSION"),
        "expected CSV_INVALID_EXTENSION, got: {:?}",
        err
    );
}

#[test]
fn simple_values_roundtrip_through_snapshot() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "values.csv");
    fs::write(&path, "Name,Score,Pass\nAlice,92.5,TRUE\nBob,58,FALSE\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snapshot_str = result.handle.snapshot_json.clone().unwrap();
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_str).unwrap();

    assert_eq!(snapshot["sheets"]["sheet-1"]["name"], "values");
    assert_eq!(snapshot["sheetOrder"].as_array().unwrap().len(), 1);

    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cell_data["0"]["0"]["v"], "Name");
    assert_eq!(cell_data["1"]["1"]["v"].as_f64(), Some(92.5));
    assert_eq!(cell_data["2"]["1"]["v"], 58);
    assert!(
        cell_data["2"]["1"]["v"].is_i64(),
        "expected i64, got: {:?}",
        cell_data["2"]["1"]["v"]
    );
    assert_eq!(cell_data["1"]["2"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["2"]["2"]["v"].as_bool(), Some(false));

    assert!(result.warnings.iter().any(|w| w.code == "CSV_POC_IMPORT"));
}

#[test]
fn bom_stripped() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "bom.csv");
    fs::write(&path, [0xEF, 0xBB, 0xBF, b'a', b',', b'b', b'\n']).unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], "a");
    assert_eq!(cell_data["0"]["1"]["v"], "b");
}

#[test]
fn injection_guard_unescape() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "injection.csv");
    fs::write(&path, "'=cmd(),'+ATTACK,'-DROP,'@HOST,'plain\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], "=cmd()");
    assert_eq!(cell_data["0"]["1"]["v"], "+ATTACK");
    assert_eq!(cell_data["0"]["2"]["v"], "-DROP");
    assert_eq!(cell_data["0"]["3"]["v"], "@HOST");
    assert_eq!(cell_data["0"]["4"]["v"], "'plain");
}

#[test]
fn empty_cells_are_sparse() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "sparse.csv");
    fs::write(&path, "a,,c\n,,\n,e,\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    let row0 = cell_data["0"].as_object().unwrap();
    assert!(row0.contains_key("0"));
    assert!(row0.contains_key("2"));
    assert!(!row0.contains_key("1"), "empty cell should be skipped");

    let root_obj = cell_data.as_object().unwrap();
    assert!(!root_obj.contains_key("1"), "all-empty row should be omitted");

    let row2 = cell_data["2"].as_object().unwrap();
    assert_eq!(row2.len(), 1);
    assert!(row2.contains_key("1"));
}

#[test]
fn numbers_prefer_integer_over_float() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "numbers.csv");
    fs::write(&path, "42\n42.0\n-7\n3.14\n1e5\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], 42);
    assert!(cell_data["0"]["0"]["v"].is_i64());

    assert_eq!(cell_data["1"]["0"]["v"].as_f64(), Some(42.0));
    assert_eq!(cell_data["2"]["0"]["v"], -7);
    assert!(cell_data["2"]["0"]["v"].is_i64());
    assert_eq!(cell_data["3"]["0"]["v"].as_f64(), Some(3.14));
    assert_eq!(cell_data["4"]["0"]["v"].as_f64(), Some(100000.0));
}

#[test]
fn case_insensitive_bool() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "bools.csv");
    fs::write(&path, "true,TRUE,True,false,False,FALSE\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["0"]["1"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["0"]["2"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["0"]["3"]["v"].as_bool(), Some(false));
    assert_eq!(cell_data["0"]["4"]["v"].as_bool(), Some(false));
    assert_eq!(cell_data["0"]["5"]["v"].as_bool(), Some(false));
}

#[test]
fn default_dimensions_minimum() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "small.csv");
    fs::write(&path, "a,b\nc,d\ne,f\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let sheet = &snapshot["sheets"]["sheet-1"];

    assert_eq!(sheet["rowCount"], 1000);
    assert_eq!(sheet["columnCount"], 100);
}

#[test]
fn shift_jis_csv_decoded_and_warned() {
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("sjis.csv");
    // "名前,得点" + CRLF + "山田,90" in Shift_JIS bytes.
    let sjis_bytes: Vec<u8> = vec![
        0x96, 0xBC, 0x91, 0x4F, // 名前
        0x2C,                   // ,
        0x93, 0xBE, 0x93, 0x5F, // 得点
        0x0D, 0x0A,             // CRLF
        0x8E, 0x52, 0x93, 0x63, // 山田
        0x2C,                   // ,
        0x39, 0x30,             // 90
        0x0D, 0x0A,             // CRLF
    ];
    std::fs::write(&path, &sjis_bytes).expect("write sjis file");

    let result = import_csv_core(path.to_string_lossy().into_owned(), None).expect("import sjis");
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();

    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"], "名前");
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["0"]["1"]["v"], "得点");
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["1"]["0"]["v"], "山田");
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["1"]["1"]["v"], 90);

    let enc_warn = result
        .warnings
        .iter()
        .find(|w| w.code == "CSV_ENCODING_DETECTED")
        .expect("expected CSV_ENCODING_DETECTED");
    assert!(enc_warn.message.contains("Shift_JIS"));
    assert_eq!(enc_warn.severity, "warning");
}

#[test]
fn utf8_csv_warned_as_info_severity() {
    let tmp = TempDir::new().expect("tempdir");
    let path = tmp.path().join("utf8.csv");
    std::fs::write(&path, "名前,得点\n山田,90\n").expect("write utf8 file");

    let result = import_csv_core(path.to_string_lossy().into_owned(), None).expect("import");
    let enc_warn = result
        .warnings
        .iter()
        .find(|w| w.code == "CSV_ENCODING_DETECTED")
        .expect("expected CSV_ENCODING_DETECTED");
    assert!(enc_warn.message.contains("UTF-8"));
    assert!(!enc_warn.message.contains("lossy"));
    assert_eq!(enc_warn.severity, "info");
}

#[test]
fn explicit_shift_jis_override_decodes_correctly() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("override.csv");
    let sjis_bytes: Vec<u8> = vec![0x96, 0xBC, 0x91, 0x4F, 0x0D, 0x0A]; // "名前\r\n"
    std::fs::write(&path, &sjis_bytes).unwrap();

    let result = import_csv_core(
        path.to_string_lossy().into_owned(),
        Some("shift_jis".to_string()),
    )
    .unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"], "名前");

    let enc = result
        .warnings
        .iter()
        .find(|w| w.code == "CSV_ENCODING_DETECTED")
        .unwrap();
    assert!(enc.message.contains("Shift_JIS (forced)"));
}

#[test]
fn explicit_utf8_override_strips_bom() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("forced_utf8.csv");
    let mut bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("a,b\n".as_bytes());
    std::fs::write(&path, &bytes).unwrap();

    let result = import_csv_core(
        path.to_string_lossy().into_owned(),
        Some("utf8".to_string()),
    )
    .unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"], "a");

    let enc = result
        .warnings
        .iter()
        .find(|w| w.code == "CSV_ENCODING_DETECTED")
        .unwrap();
    assert!(enc.message.contains("forced"));
}

#[test]
fn unknown_encoding_override_falls_back_to_auto() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("unknown.csv");
    std::fs::write(&path, "a,b\n").unwrap();

    // "klingon" isn't recognized — should fall back to auto-detect (UTF-8).
    let result = import_csv_core(
        path.to_string_lossy().into_owned(),
        Some("klingon".to_string()),
    )
    .unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"], "a");
}

#[test]
fn trailing_empty_rows_do_not_extend_used_dimensions() {
    // Many real CSVs end with a couple of blank lines. They should not
    // inflate the used row count.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "trailing.csv");
    fs::write(&path, "a,b,c\n1,2,3\n\n\n\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let sheet = &snap["sheets"]["sheet-1"];
    let cell_data = sheet["cellData"].as_object().unwrap();
    // Only rows 0 and 1 have any cells; the empty trailing rows are sparse.
    assert!(cell_data.contains_key("0"));
    assert!(cell_data.contains_key("1"));
    assert!(!cell_data.contains_key("2"));
    assert!(!cell_data.contains_key("3"));
    assert!(!cell_data.contains_key("4"));
}

#[test]
fn nonexistent_file_returns_err() {
    let result = import_csv_core("/does/not/exist.csv".to_string(), None);
    assert!(result.is_err());
}

#[test]
#[ignore = "slow: writes a ~80MB CSV to disk to exercise the near-cap branch"]
fn near_cap_warning_fires_above_4m_cells() {
    // Generating a 4M+ cell CSV at runtime is slow. The test is marked
    // #[ignore] but kept callable via `cargo test -- --ignored` for ad-hoc
    // verification. It exercises the CSV_NEAR_CAP warning path that fires
    // when total_cells > 80% of the 5M cap.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("big.csv");
    // 20 cols × 220,000 rows = 4.4M cells (well past the 4M warning threshold).
    let mut file = fs::File::create(&path).unwrap();
    use std::io::Write;
    let cols = 20usize;
    let rows = 220_000usize;
    let line: String = (0..cols)
        .map(|i| format!("{}", i))
        .collect::<Vec<_>>()
        .join(",");
    for _ in 0..rows {
        writeln!(file, "{}", line).unwrap();
    }
    drop(file);

    let result =
        import_csv_core(path.to_string_lossy().into_owned(), None).unwrap();
    assert!(
        result.warnings.iter().any(|w| w.code == "CSV_NEAR_CAP"),
        "expected CSV_NEAR_CAP warning, got: {:?}",
        result.warnings.iter().map(|w| &w.code).collect::<Vec<_>>()
    );
}

#[test]
fn small_file_does_not_emit_near_cap_warning() {
    // Regression: typical-size CSVs shouldn't show the warning.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "small.csv");
    fs::write(&path, "a,b,c\n1,2,3\n").unwrap();
    let result = import_csv_core(path, None).unwrap();
    assert!(
        !result.warnings.iter().any(|w| w.code == "CSV_NEAR_CAP"),
        "small file should not trigger near-cap warning"
    );
}

#[test]
fn iso_dates_become_serial_with_yyyy_mm_dd_format() {
    // Recognize unambiguous ISO YYYY-MM-DD and emit a date cell whose v is
    // the Excel serial — matches the xlsx_io DateTime cell shape so Univer
    // treats the value as a real date.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "dates.csv");
    fs::write(&path, "2026-05-13\n1900-03-01\nnot a date\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    // 2026-05-13: 46155 (verified against Excel)
    let c0 = &cell_data["0"]["0"];
    assert!(c0["v"].is_f64(), "expected f64 serial, got {:?}", c0);
    assert_eq!(c0["v"].as_f64(), Some(46155.0));
    assert_eq!(c0["_fmt"], "yyyy-mm-dd");

    // 1900-03-01 is the first post-leap-bug date; Excel says serial 61.
    let c1 = &cell_data["1"]["0"];
    assert_eq!(c1["v"].as_f64(), Some(61.0));
    assert_eq!(c1["_fmt"], "yyyy-mm-dd");

    // "not a date" stays as a string and has no _fmt attribute.
    let c2 = &cell_data["2"]["0"];
    assert_eq!(c2["v"], "not a date");
    assert!(c2.get("_fmt").is_none());
}

#[test]
fn slash_separated_dates_also_detected() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "jp_dates.csv");
    fs::write(&path, "2026/05/13\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let v = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(v["v"].as_f64(), Some(46155.0));
    assert_eq!(v["_fmt"], "yyyy-mm-dd");
}

#[test]
fn ambiguous_date_formats_stay_as_strings() {
    // MM/DD/YYYY and DD/MM/YYYY are regionally ambiguous; we don't guess.
    // The values fall through to the string branch.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "ambig.csv");
    fs::write(&path, "5/13/2026\n13/5/2026\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cell_data["0"]["0"]["v"], "5/13/2026");
    assert_eq!(cell_data["1"]["0"]["v"], "13/5/2026");
    assert!(cell_data["0"]["0"].get("_fmt").is_none());
}

#[test]
fn invalid_date_strings_stay_as_strings() {
    // 2026-02-30 is not a real date; chrono rejects it so the cell stays a string.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "bad.csv");
    fs::write(&path, "2026-02-30\n2026-13-01\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cell_data["0"]["0"]["v"], "2026-02-30");
    assert_eq!(cell_data["1"]["0"]["v"], "2026-13-01");
}

#[test]
fn numeric_strings_that_look_like_dates_still_parse_as_numbers_when_unambiguous() {
    // "20260513" parses as an integer (not a date — there's no separator).
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "num.csv");
    fs::write(&path, "20260513\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    assert_eq!(snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["v"], 20260513);
}

#[test]
fn iso_datetime_strings_become_fractional_serial_with_datetime_format() {
    // "2026-05-13 12:00:00" → 46155.5 (half a day past midnight on 2026-05-13).
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "dt.csv");
    fs::write(&path, "2026-05-13 12:00:00\n2026-05-13T06:00:00\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    let c0 = &cell_data["0"]["0"];
    assert!((c0["v"].as_f64().unwrap() - 46155.5).abs() < 1e-9);
    assert_eq!(c0["_fmt"], "yyyy-mm-dd hh:mm:ss");

    // T separator (ISO 8601) at 06:00 → 0.25 fraction.
    let c1 = &cell_data["1"]["0"];
    assert!((c1["v"].as_f64().unwrap() - 46155.25).abs() < 1e-9);
    assert_eq!(c1["_fmt"], "yyyy-mm-dd hh:mm:ss");
}

#[test]
fn leading_zero_strings_are_preserved_as_strings() {
    // Account / postal / part numbers must not be coerced to integers,
    // which would strip the leading zeros.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "ids.csv");
    fs::write(&path, "0001234\n0900\n00\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], "0001234");
    assert_eq!(cell_data["1"]["0"]["v"], "0900");
    assert_eq!(cell_data["2"]["0"]["v"], "00");
}

#[test]
fn single_zero_and_decimal_zero_still_parse_as_numbers() {
    // Regression: "0" is just zero (integer). "0.5" and "0e3" are decimals
    // that should keep their numeric type.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "z.csv");
    fs::write(&path, "0\n0.5\n0e3\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], 0);
    assert!(cell_data["0"]["0"]["v"].is_i64());
    assert_eq!(cell_data["1"]["0"]["v"].as_f64(), Some(0.5));
    assert_eq!(cell_data["2"]["0"]["v"].as_f64(), Some(0.0));
}

#[test]
fn percent_strings_become_fractional_value_with_percent_format() {
    // "50%" → 0.5 with "0%" fmt. "12.5%" → 0.125 with "0.00%" fmt.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "pct.csv");
    fs::write(&path, "50%\n12.5%\n-3%\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"].as_f64(), Some(0.5));
    assert_eq!(cell_data["0"]["0"]["_fmt"], "0%");
    assert_eq!(cell_data["1"]["0"]["v"].as_f64(), Some(0.125));
    assert_eq!(cell_data["1"]["0"]["_fmt"], "0.00%");
    assert_eq!(cell_data["2"]["0"]["v"].as_f64(), Some(-0.03));
}

#[test]
fn percent_with_embedded_garbage_stays_string() {
    // "50% off" is not a clean percent — stays as a plain string.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "bad_pct.csv");
    fs::write(&path, "50% off\nnot%anumber%\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], "50% off");
    assert_eq!(cell_data["1"]["0"]["v"], "not%anumber%");
}

#[test]
fn tsv_extension_uses_tab_delimiter() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "data.tsv");
    // Three columns separated by tabs; a comma inside a cell must survive intact.
    fs::write(&path, "a\tb,c\td\n1\t2\t3\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], "a");
    // Comma is part of the cell value, not a separator.
    assert_eq!(cell_data["0"]["1"]["v"], "b,c");
    assert_eq!(cell_data["0"]["2"]["v"], "d");
    assert_eq!(cell_data["1"]["0"]["v"], 1);
    assert_eq!(cell_data["1"]["1"]["v"], 2);
    assert_eq!(cell_data["1"]["2"]["v"], 3);
}

#[test]
fn csv_with_mostly_tabs_falls_back_to_tab_delimiter() {
    // User saved a TSV with the wrong extension. We detect by counting
    // tabs vs commas on the first non-empty line; if tabs dominate AND
    // there are at least 2, we switch.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "mislabeled.csv");
    fs::write(&path, "a\tb\tc\n1\t2\t3\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cell_data["0"]["0"]["v"], "a");
    assert_eq!(cell_data["0"]["1"]["v"], "b");
    assert_eq!(cell_data["0"]["2"]["v"], "c");
}

#[test]
fn csv_with_single_tab_still_uses_comma_delimiter() {
    // One tab in a field shouldn't trigger TSV fallback — legit comma data
    // with a stray tab character must continue to parse as CSV.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "single_tab.csv");
    fs::write(&path, "a,b\tcontains tab,c\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cell_data["0"]["0"]["v"], "a");
    assert_eq!(cell_data["0"]["1"]["v"], "b\tcontains tab");
    assert_eq!(cell_data["0"]["2"]["v"], "c");
}

#[test]
fn time_only_strings_become_fractional_value_with_time_format() {
    // "12:00" → 0.5, "00:00:00" → 0.0, "06:30" → 0.27083... etc.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "time.csv");
    fs::write(&path, "12:00\n00:00:00\n06:30\n23:59:59\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];

    assert!((cell_data["0"]["0"]["v"].as_f64().unwrap() - 0.5).abs() < 1e-9);
    assert_eq!(cell_data["0"]["0"]["_fmt"], "hh:mm:ss");
    assert_eq!(cell_data["1"]["0"]["v"].as_f64(), Some(0.0));
    assert!((cell_data["2"]["0"]["v"].as_f64().unwrap() - 6.5 / 24.0).abs() < 1e-9);
    // 23:59:59 = (23*3600 + 59*60 + 59) / 86400 = 86399 / 86400
    assert!((cell_data["3"]["0"]["v"].as_f64().unwrap() - 86399.0 / 86400.0).abs() < 1e-9);
}

#[test]
fn invalid_time_strings_stay_as_strings() {
    // 24:00 is out of our accepted range; 12:60 has out-of-range minutes.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "bad_time.csv");
    fs::write(&path, "24:00\n12:60\n9:99\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snap["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cell_data["0"]["0"]["v"], "24:00");
    assert_eq!(cell_data["1"]["0"]["v"], "12:60");
    assert_eq!(cell_data["2"]["0"]["v"], "9:99");
}

#[test]
fn date_only_strings_do_not_match_the_datetime_branch() {
    // Regression: an empty time portion should still go through the
    // date-only branch (yyyy-mm-dd format), not the datetime branch.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "d.csv");
    fs::write(&path, "2026-05-13\n").unwrap();

    let result = import_csv_core(path, None).unwrap();
    let snap: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let c = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(c["_fmt"], "yyyy-mm-dd");
    assert_eq!(c["v"].as_f64(), Some(46155.0));
}

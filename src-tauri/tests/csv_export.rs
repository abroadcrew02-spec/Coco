use coco_lib::commands::csv_io::{list_sheet_names, workbook_export_csv};
use std::fs;
use tempfile::TempDir;

fn path_in(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    assert!(
        bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF,
        "file must start with UTF-8 BOM"
    );
    &bytes[3..]
}

#[test]
fn bom_and_crlf_format() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "id": "s1",
                "name": "S",
                "cellData": {
                    "0": { "0": { "v": "hello" }, "1": { "v": 42 } }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);
    assert_eq!(result.rows_written, 1);

    let bytes = fs::read(&path).unwrap();
    assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "missing BOM");
    let body = std::str::from_utf8(&bytes[3..]).unwrap();
    assert!(body.contains("\r\n"), "missing CRLF; got: {:?}", body);
    assert!(!body.replace("\r\n", "").contains('\n'), "found lone LF");
}

#[test]
fn sparse_far_cell_export_returns_too_large_error() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "far.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "1048575": { "16383": { "v": "far" } }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(!result.success);
    assert_eq!(result.rows_written, 0);
    assert_eq!(result.error, Some("CSV_EXPORT_TOO_LARGE".to_string()));
    assert!(
        !std::path::Path::new(&path).exists(),
        "file should not be created"
    );
}

#[test]
fn failed_export_preserves_existing_file() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "existing.csv");
    fs::write(&path, b"keep me\r\n").unwrap();
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "1048575": { "16383": { "v": "far" } }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(!result.success);
    assert_eq!(result.error, Some("CSV_EXPORT_TOO_LARGE".to_string()));
    assert_eq!(fs::read(&path).unwrap(), b"keep me\r\n");
}

#[test]
fn successful_export_replaces_existing_file() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "existing.csv");
    fs::write(&path, b"old\r\n").unwrap();
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": { "0": { "v": "new" } }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    assert_eq!(s, "new\r\n");
}

#[test]
fn csv_injection_escape() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": "=cmd()" },
                        "1": { "v": "+ATTACK" },
                        "2": { "v": "-DROP" },
                        "3": { "v": "@HOST" },
                        "4": { "v": "safe" }
                    }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    let cells: Vec<&str> = first_line.split(',').collect();
    assert_eq!(
        cells,
        vec!["'=cmd()", "'+ATTACK", "'-DROP", "'@HOST", "safe"]
    );
}

#[test]
fn csv_injection_escape_ignores_leading_whitespace_and_control() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": " \t=cmd()" },
                        "1": { "v": "\u0001+ATTACK" },
                        "2": { "v": "\r\n-DROP" },
                        "3": { "v": "\u0000@HOST" },
                        "4": { "v": " safe" }
                    }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success);

    let bytes = fs::read(&path).unwrap();
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(strip_bom(&bytes));
    let row = rdr.records().next().unwrap().unwrap();
    assert_eq!(row.get(0), Some("' \t=cmd()"));
    assert_eq!(row.get(1), Some("'\u{0001}+ATTACK"));
    assert_eq!(row.get(2), Some("'\r\n-DROP"));
    assert_eq!(row.get(3), Some("'\u{0000}@HOST"));
    assert_eq!(row.get(4), Some(" safe"));
}

#[test]
fn rfc4180_escaping() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": "has, comma" },
                        "1": { "v": "has \"quote\"" },
                        "2": { "v": "has\nnewline" },
                        "3": { "v": "safe" }
                    }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();

    assert!(s.contains("\"has, comma\""), "comma not quoted: {:?}", s);
    assert!(
        s.contains("\"has \"\"quote\"\"\""),
        "quote not doubled: {:?}",
        s
    );
    assert!(
        s.contains("\"has\nnewline\""),
        "newline not quoted: {:?}",
        s
    );
    assert!(s.contains(",safe"), "safe missing or modified: {:?}", s);
}

#[test]
fn integer_vs_float_format() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 42.0 },
                        "1": { "v": 3.14 },
                        "2": { "v": 1e10 }
                    }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    assert_eq!(first_line, "42,3.14,10000000000", "got: {:?}", first_line);
}

#[test]
fn boolean_format() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": true },
                        "1": { "v": false }
                    }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    assert_eq!(first_line, "TRUE,FALSE");
}

#[test]
fn formula_fallback_warning() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "f": "=SUM(A1:A3)" }
                    }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success);
    assert!(!result.warnings.is_empty(), "expected formula warning");
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.message.to_lowercase().contains("formula")),
        "expected formula-related warning, got: {:?}",
        result.warnings
    );
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.code == "CSV_FORMULA_FALLBACK"),
        "expected CSV_FORMULA_FALLBACK code, got: {:?}",
        result.warnings
    );

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    assert!(
        s.contains("'=SUM(A1:A3)"),
        "missing escaped formula text: {:?}",
        s
    );
}

#[test]
fn multi_sheet_select() {
    let dir = TempDir::new().unwrap();
    let snapshot = r#"{
        "sheetOrder": ["sheet-1", "sheet-2"],
        "sheets": {
            "sheet-1": { "name": "First", "cellData": { "0": { "0": { "v": "F" } } } },
            "sheet-2": { "name": "Second", "cellData": { "0": { "0": { "v": "S" } } } }
        }
    }"#;

    let sheets = list_sheet_names(snapshot.to_string()).unwrap();
    assert_eq!(sheets.len(), 2);
    assert_eq!(sheets[0].id, "sheet-1");
    assert_eq!(sheets[0].name, "First");
    assert_eq!(sheets[1].id, "sheet-2");
    assert_eq!(sheets[1].name, "Second");

    let p1 = path_in(&dir, "second.csv");
    let result = workbook_export_csv(
        p1.clone(),
        snapshot.to_string(),
        Some("sheet-2".to_string()),
        None,
    )
    .unwrap();
    assert!(result.success, "export failed: {:?}", result.error);
    let bytes = fs::read(&p1).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    assert!(s.contains('S'), "missing sheet-2 content: {:?}", s);
    assert!(!s.contains('F'), "sheet-1 content leaked: {:?}", s);

    let p2 = path_in(&dir, "missing.csv");
    let result = workbook_export_csv(
        p2.clone(),
        snapshot.to_string(),
        Some("does-not-exist".to_string()),
        None,
    )
    .unwrap();
    assert!(!result.success);
    let err = result.error.unwrap_or_default();
    assert!(
        err.to_lowercase().contains("not found"),
        "expected 'not found' error, got: {:?}",
        err
    );
}

#[test]
fn bad_extension_rejected() {
    let result =
        workbook_export_csv("output.xlsx".to_string(), "{}".to_string(), None, None).unwrap();
    assert!(!result.success);
    assert_eq!(result.error, Some("CSV_INVALID_EXTENSION".to_string()));
    assert!(
        !std::path::Path::new("output.xlsx").exists(),
        "file should not be created"
    );
}

#[test]
fn shift_jis_export_writes_sjis_bytes() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "sjis.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": { "0": { "v": "名前" }, "1": { "v": "得点" } },
                    "1": { "0": { "v": "山田" }, "1": { "v": 90 } }
                }
            }
        }
    }"#;

    let result = workbook_export_csv(
        path.clone(),
        snapshot.to_string(),
        None,
        Some("shift_jis".to_string()),
    )
    .unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let bytes = fs::read(&path).unwrap();
    // No BOM in SJIS output.
    assert_ne!(&bytes[..3.min(bytes.len())], &[0xEF, 0xBB, 0xBF]);
    // "名前" in SJIS = 0x96 0xBC 0x91 0x4F. Verify a known prefix.
    assert!(
        bytes.starts_with(&[0x96, 0xBC, 0x91, 0x4F]),
        "expected SJIS '名前' prefix, got first bytes {:?}",
        &bytes[..bytes.len().min(8)]
    );
    // Decoding back with encoding_rs should round-trip the values.
    let (decoded, _, had_errors) = encoding_rs::SHIFT_JIS.decode(&bytes);
    assert!(!had_errors);
    assert!(decoded.contains("名前"));
    assert!(decoded.contains("山田"));
    assert!(decoded.contains("90"));
}

#[test]
fn utf8_no_bom_export_skips_bom() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "utf8.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": { "s1": { "name": "S", "cellData": { "0": { "0": { "v": "hello" } } } } }
    }"#;

    let result = workbook_export_csv(
        path.clone(),
        snapshot.to_string(),
        None,
        Some("utf8".to_string()),
    )
    .unwrap();
    assert!(result.success);

    let bytes = fs::read(&path).unwrap();
    assert_ne!(
        &bytes[..3.min(bytes.len())],
        &[0xEF, 0xBB, 0xBF],
        "should not have BOM"
    );
    assert!(bytes.starts_with(b"hello"));
}

#[test]
fn shift_jis_export_warns_on_unrepresentable_chars() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "emoji.csv");
    // 🍣 is outside the SJIS repertoire.
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": { "s1": { "name": "S", "cellData": { "0": { "0": { "v": "🍣" } } } } }
    }"#;

    let result = workbook_export_csv(
        path.clone(),
        snapshot.to_string(),
        None,
        Some("shift_jis".to_string()),
    )
    .unwrap();
    assert!(result.success);
    assert!(
        result.warnings.iter().any(|w| w.code == "CSV_SJIS_LOSSY"),
        "expected CSV_SJIS_LOSSY warning, got {:?}",
        result.warnings.iter().map(|w| &w.code).collect::<Vec<_>>()
    );
}

#[test]
fn date_cells_export_as_yyyy_mm_dd() {
    // Cells whose _fmt looks like a date should render as YYYY-MM-DD on
    // export so that an import → export round-trip preserves the date.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "dates.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 46155.0, "_fmt": "yyyy-mm-dd" },
                        "1": { "v": 61.0, "_fmt": "yyyy-mm-dd" },
                        "2": { "v": 12345.0 }
                    }
                }
            }
        }
    }"#;
    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    let cells: Vec<&str> = first_line.split(',').collect();
    // 46155 → 2026-05-13, 61 → 1900-03-01, untagged 12345 stays numeric.
    assert_eq!(cells, vec!["2026-05-13", "1900-03-01", "12345"]);
}

#[test]
fn unrecognized_format_strings_fall_through_to_plain_number() {
    // Format codes that don't match any of the date / datetime / time /
    // percent / currency / text branches still render as plain numbers.
    // `0.00`, `0.0E+00`, `??/??` aren't yet honored by the format-aware
    // renderer — they pass through unchanged.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "fmt.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 1000.0, "_fmt": "0.00" },
                        "1": { "v": 1.5, "_fmt": "0.0E+00" }
                    }
                }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    assert_eq!(first_line, "1000,1.5");
}

#[test]
fn tsv_extension_writes_tab_separated_output() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.tsv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": "a" },
                        "1": { "v": "b,c" },
                        "2": { "v": "d" }
                    }
                }
            }
        }
    }"#;
    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success, "expected success: {:?}", result.error);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    // Comma inside a cell does NOT need quoting in TSV (the delimiter is tab).
    assert_eq!(first_line, "a\tb,c\td");
}

#[test]
fn tsv_extension_quotes_fields_containing_tabs() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "out.tsv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": "has\ttab" },
                        "1": { "v": "plain" }
                    }
                }
            }
        }
    }"#;
    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    assert!(result.success);
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    // Tab-containing field is wrapped in double quotes.
    assert_eq!(first_line, "\"has\ttab\"\tplain");
}

#[test]
fn time_only_cells_export_as_hh_mm_ss() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "t.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 0.5, "_fmt": "hh:mm:ss" },
                        "1": { "v": 0.0, "_fmt": "hh:mm:ss" },
                        "2": { "v": 0.27083333333, "_fmt": "h:mm" }
                    }
                }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    // 0.5 → 12:00:00, 0.0 → 00:00:00, 0.270833... → 06:30:00.
    assert_eq!(first_line, "12:00:00,00:00:00,06:30:00");
}

#[test]
fn percent_cells_export_with_percent_sign() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "pct.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 0.5, "_fmt": "0%" },
                        "1": { "v": 0.125, "_fmt": "0.00%" },
                        "2": { "v": -0.03, "_fmt": "0%" }
                    }
                }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    assert_eq!(first_line, "50%,12.50%,-3%");
}

#[test]
fn us_style_slash_date_format_emits_slash_separated() {
    // `m/d/yyyy` is the canonical US locale date format. Per §4.7 FR-303 the
    // exported representation must follow the format code, not be coerced to
    // ISO 8601. 2024-01-31 = serial 45322.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "us.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 45322.0, "_fmt": "m/d/yyyy" },
                        "1": { "v": 45322.0, "_fmt": "mm/dd/yyyy" }
                    }
                }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    // m/d → no zero padding; mm/dd → zero-padded.
    assert_eq!(first_line, "1/31/2024,01/31/2024");
}

#[test]
fn text_format_at_emits_raw_number_without_grouping() {
    // `@` is the Excel "text" format code: render the underlying value
    // verbatim as text. We treat numeric cells with `_fmt: "@"` as plain
    // numbers so the CSV value matches the displayed text.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "text.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 12345.0, "_fmt": "@" },
                        "1": { "v": "hello", "_fmt": "@" }
                    }
                }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    // No date interpretation, no thousands separators, string passes through.
    assert_eq!(first_line, "12345,hello");
}

#[test]
fn currency_format_emits_symbol_and_thousands_separators() {
    // Excel currency formats: `$#,##0.00`, `¥#,##0`, locale-tagged variants.
    // We honor the symbol + decimal precision + comma grouping.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "cur.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 1234.5, "_fmt": "$#,##0.00" },
                        "1": { "v": 1000000.0, "_fmt": "¥#,##0" },
                        "2": { "v": -50.25, "_fmt": "$#,##0.00" }
                    }
                }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    // Comma escaping: each currency cell contains a comma, so the field is
    // wrapped in double quotes per RFC 4180.
    // Only fields containing the delimiter (",") need RFC4180 quoting; the
    // negative cell "-$50.25" has no comma so it stays bare.
    assert_eq!(first_line, "\"$1,234.50\",\"¥1,000,000\",-$50.25");
}

#[test]
fn time_only_short_format_still_emits_hh_mm_ss() {
    // The `h:mm` format on 0.5 (noon) — currently we always emit HH:MM:SS.
    // Confirm the existing behavior is preserved alongside the new branches.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "hm.csv");
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": { "0": { "0": { "v": 0.5, "_fmt": "h:mm" } } }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    assert_eq!(first_line, "12:00:00");
}

#[test]
fn datetime_cells_export_as_yyyy_mm_dd_hh_mm_ss() {
    // Cells whose _fmt mentions both date and hour render as the full
    // YYYY-MM-DD HH:MM:SS string so CSV round-trip preserves both halves.
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "dt.csv");
    // 46155.5 = 2026-05-13 12:00:00 (half a day past midnight on 2026-05-13).
    let snapshot = r#"{
        "sheetOrder": ["s1"],
        "sheets": {
            "s1": {
                "name": "S",
                "cellData": {
                    "0": {
                        "0": { "v": 46155.5, "_fmt": "yyyy-mm-dd hh:mm:ss" }
                    }
                }
            }
        }
    }"#;
    let _ = workbook_export_csv(path.clone(), snapshot.to_string(), None, None).unwrap();
    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    // CSV escapes any field containing a comma; spaces are fine.
    assert_eq!(first_line, "2026-05-13 12:00:00");
}

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

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);
    assert_eq!(result.rows_written, 1);

    let bytes = fs::read(&path).unwrap();
    assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "missing BOM");
    let body = std::str::from_utf8(&bytes[3..]).unwrap();
    assert!(body.contains("\r\n"), "missing CRLF; got: {:?}", body);
    assert!(!body.replace("\r\n", "").contains('\n'), "found lone LF");
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

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None).unwrap();
    assert!(result.success);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    let first_line = s.split("\r\n").next().unwrap();
    let cells: Vec<&str> = first_line.split(',').collect();
    assert_eq!(cells, vec!["'=cmd()", "'+ATTACK", "'-DROP", "'@HOST", "safe"]);
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

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None).unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();

    assert!(s.contains("\"has, comma\""), "comma not quoted: {:?}", s);
    assert!(s.contains("\"has \"\"quote\"\"\""), "quote not doubled: {:?}", s);
    assert!(s.contains("\"has\nnewline\""), "newline not quoted: {:?}", s);
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

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None).unwrap();
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

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None).unwrap();
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

    let result = workbook_export_csv(path.clone(), snapshot.to_string(), None).unwrap();
    assert!(result.success);
    assert!(!result.warnings.is_empty(), "expected formula warning");
    assert!(
        result.warnings.iter().any(|w| w.message.to_lowercase().contains("formula")),
        "expected formula-related warning, got: {:?}",
        result.warnings
    );
    assert!(
        result.warnings.iter().any(|w| w.code == "CSV_FORMULA_FALLBACK"),
        "expected CSV_FORMULA_FALLBACK code, got: {:?}",
        result.warnings
    );

    let bytes = fs::read(&path).unwrap();
    let s = std::str::from_utf8(strip_bom(&bytes)).unwrap();
    assert!(s.contains("'=SUM(A1:A3)"), "missing escaped formula text: {:?}", s);
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
    let result =
        workbook_export_csv(p1.clone(), snapshot.to_string(), Some("sheet-2".to_string())).unwrap();
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
    let result = workbook_export_csv("output.xlsx".to_string(), "{}".to_string(), None).unwrap();
    assert!(!result.success);
    assert_eq!(result.error, Some("CSV_INVALID_EXTENSION".to_string()));
    assert!(!std::path::Path::new("output.xlsx").exists(), "file should not be created");
}

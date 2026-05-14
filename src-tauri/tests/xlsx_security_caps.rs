//! requirements.md §5.3.2 row / column / formula caps. Builds synthetic xlsx
//! ZIPs whose `xl/worksheets/sheet1.xml` claims a dimension or formula count
//! beyond the §5.3.2 thresholds, and asserts `security_scan_xlsx` issues the
//! right verdict.
//!
//! We deliberately don't build *actually* 1M-row sheets here — the scanner is
//! a streaming byte-level scan of the worksheet XML, so it only needs the
//! `<dimension>` element / `<f>` tag counts to be present. Generating a
//! literal 1M-row body would balloon test time for no benefit.

use coco_lib::commands::security::security_scan_xlsx;
use std::io::Write;
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

fn build_zip(tmp: &TempDir, name: &str, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
    let path = tmp.path().join(name);
    let file = std::fs::File::create(&path).expect("create zip");
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions = FileOptions::default();
    for (entry, body) in entries {
        zip.start_file(*entry, opts).expect("start_file");
        zip.write_all(body).expect("write entry");
    }
    zip.finish().expect("finish zip");
    path
}

#[test]
fn row_limit_exceeded_via_dimension_blocks_import() {
    let tmp = TempDir::new().expect("tempdir");
    // Dimension declares row 1,000,001 — one past the §5.3.2 cap.
    let sheet_xml =
        b"<worksheet><dimension ref=\"A1:A1000001\"/><sheetData/></worksheet>";
    let path = build_zip(
        &tmp,
        "rowcap.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );

    let r = security_scan_xlsx(path_str(&path)).expect("scan ok");
    assert!(r.blocked, "1,000,001-row sheet should be blocked, got {:?}", r);
    assert!(
        r.issues.iter().any(|m| m.contains("XLSX_ROW_LIMIT")),
        "expected XLSX_ROW_LIMIT issue, got {:?}",
        r.issues
    );
}

#[test]
fn col_limit_exceeded_via_dimension_blocks_import() {
    let tmp = TempDir::new().expect("tempdir");
    // 16,385 is one past XFD (16,384). `XFE1` is the next column letter triple.
    let sheet_xml = b"<worksheet><dimension ref=\"A1:XFE1\"/><sheetData/></worksheet>";
    let path = build_zip(
        &tmp,
        "colcap.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );

    let r = security_scan_xlsx(path_str(&path)).expect("scan ok");
    assert!(r.blocked, "XFE-column sheet should be blocked, got {:?}", r);
    assert!(
        r.issues.iter().any(|m| m.contains("XLSX_COL_LIMIT")),
        "expected XLSX_COL_LIMIT issue, got {:?}",
        r.issues
    );
}

#[test]
fn formula_heavy_sheet_warns_but_does_not_block() {
    // 1.5M `<f>` formula tags. We construct a single worksheet body large enough
    // to expose >1M formula tags through the 16 MiB scan window, while staying
    // under the 50 MiB per-XML cap.
    let tmp = TempDir::new().expect("tempdir");

    // Each "<f>=1</f>" is 10 bytes. 1.5M copies = 15 MB — within the scanner's
    // 16 MiB cap and under the 50 MiB single-XML cap and 300 MiB total cap.
    let unit: &[u8] = b"<f>=1</f>";
    let copies: usize = 1_500_000;
    let mut body: Vec<u8> = Vec::with_capacity(unit.len() * copies + 128);
    body.extend_from_slice(b"<worksheet><dimension ref=\"A1:A1\"/><sheetData>");
    for _ in 0..copies {
        body.extend_from_slice(unit);
    }
    body.extend_from_slice(b"</sheetData></worksheet>");

    let path = build_zip(
        &tmp,
        "formula_heavy.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", &body),
        ],
    );

    let r = security_scan_xlsx(path_str(&path)).expect("scan ok");
    assert!(
        !r.blocked,
        "formula count > 1M should warn, not block (§5.3.2), got {:?}",
        r
    );
    assert!(
        r.warnings.iter().any(|m| m.contains("XLSX_FORMULA_HEAVY")),
        "expected XLSX_FORMULA_HEAVY warning, got {:?}",
        r.warnings
    );
}

#[test]
fn row_limit_exactly_at_cap_is_allowed() {
    // 1,000,000 rows is the cap itself — must NOT block. Boundary check.
    let tmp = TempDir::new().expect("tempdir");
    let sheet_xml =
        b"<worksheet><dimension ref=\"A1:A1000000\"/><sheetData/></worksheet>";
    let path = build_zip(
        &tmp,
        "rowboundary.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );
    let r = security_scan_xlsx(path_str(&path)).expect("scan ok");
    assert!(!r.blocked, "exactly 1M rows should be allowed, got {:?}", r);
}

#[test]
fn col_limit_exactly_at_cap_is_allowed() {
    // 16,384 columns (XFD) is the cap itself — must NOT block.
    let tmp = TempDir::new().expect("tempdir");
    let sheet_xml = b"<worksheet><dimension ref=\"A1:XFD1\"/><sheetData/></worksheet>";
    let path = build_zip(
        &tmp,
        "colboundary.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );
    let r = security_scan_xlsx(path_str(&path)).expect("scan ok");
    assert!(!r.blocked, "exactly 16,384 cols should be allowed, got {:?}", r);
}

#[test]
fn streaming_row_fallback_detects_overflow_without_dimension() {
    // No `<dimension>` element — scanner must fall back to `<row r="N">`.
    let tmp = TempDir::new().expect("tempdir");
    let body = b"<worksheet><sheetData><row r=\"1000001\"><c r=\"A1000001\"/></row></sheetData></worksheet>";
    let path = build_zip(
        &tmp,
        "no_dimension.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", body),
        ],
    );
    let r = security_scan_xlsx(path_str(&path)).expect("scan ok");
    assert!(
        r.blocked,
        "streaming fallback should detect row overflow when <dimension> absent, got {:?}",
        r
    );
    assert!(
        r.issues.iter().any(|m| m.contains("XLSX_ROW_LIMIT")),
        "expected XLSX_ROW_LIMIT issue from streaming fallback, got {:?}",
        r.issues
    );
}

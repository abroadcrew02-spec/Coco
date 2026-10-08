//! .xls import: contract and hardening tests that sit next to `xls_import.rs`.
//!
//! - Acceptance 6: after Save As the original .xls is byte-identical, and the
//!   exported .xlsx opens again with the same values and formulas.
//! - Acceptance 4 / the Rust-to-TypeScript boundary: the exact error strings and
//!   the camelCase JSON shape that `src/store/errorMessages.ts` and
//!   `useWorkbookStore.ts` depend on.
//! - Chart-sheet handling (skipped sheets, `XLS_NO_WORKSHEETS`).
//! - Compound-file header values (`cfb.rs` bounds 20/21 in NICEL_PATCH.md).
//!
//! Corrupted variants are made by patching record bytes of basic.xls; every
//! patch asserts that it found its target.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use nicel_lib::commands::workbook::ImportWorkbookResult;
use nicel_lib::commands::xls_io::{import_xls_core, XLS_MAX_FILE_SIZE};
use nicel_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("xls")
        .join(name)
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    std::fs::read(fixture(name)).unwrap()
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn import_bytes(name: &str, bytes: &[u8]) -> Result<ImportWorkbookResult, String> {
    let dir = TempDir::new().unwrap();
    let p = dir.path().join(name);
    std::fs::write(&p, bytes).unwrap();
    import_xls_core(path_str(&p))
}

fn snapshot(r: &ImportWorkbookResult) -> Value {
    serde_json::from_str(r.handle.snapshot_json.as_deref().unwrap()).unwrap()
}

fn sheet<'a>(snap: &'a Value, name: &str) -> &'a Value {
    snap["sheets"]
        .as_object()
        .unwrap()
        .values()
        .find(|s| s["name"] == json!(name))
        .unwrap_or_else(|| panic!("sheet {name} not found"))
}

fn sheet_names(snap: &Value) -> Vec<String> {
    snap["sheetOrder"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            snap["sheets"][id.as_str().unwrap()]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

fn cell<'a>(sheet: &'a Value, row: u32, col: u32) -> &'a Value {
    &sheet["cellData"][row.to_string()][col.to_string()]
}

fn sha256(p: &Path) -> Vec<u8> {
    Sha256::digest(std::fs::read(p).unwrap()).to_vec()
}

fn read_u16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

const BOF_GLOBALS: [u8; 8] = [0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x05, 0x00];

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Offsets of every record of `typ` in the substream that starts with `bof`,
/// up to its EOF record. Excel writes the Workbook stream contiguously, so the
/// walk stays on record boundaries.
fn find_records(bytes: &[u8], bof: &[u8; 8], typ: u16) -> Vec<usize> {
    let mut out = Vec::new();
    let Some(mut off) = find(bytes, bof) else {
        return out;
    };
    while off + 4 <= bytes.len() {
        let t = read_u16(bytes, off);
        let len = read_u16(bytes, off + 2) as usize;
        if t == typ {
            out.push(off);
        }
        if t == 0x000A {
            break;
        }
        off += 4 + len;
    }
    out
}

/// Runs `f` on its own thread and fails the test if it does not finish, so a
/// crafted file that makes the reader loop forever shows up as a failure
/// instead of a hung test run.
fn within_seconds<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(secs))
        .unwrap_or_else(|_| panic!("did not finish within {secs}s"))
}

// ── Acceptance 6: Save As leaves the original .xls alone ────────────────────

#[test]
fn save_as_xlsx_after_import_leaves_the_xls_untouched_and_reopens() {
    let dir = TempDir::new().unwrap();
    let xls = dir.path().join("basic.xls");
    std::fs::write(&xls, fixture_bytes("basic.xls")).unwrap();
    let before = sha256(&xls);

    let imported = import_xls_core(path_str(&xls)).unwrap();
    let out = dir.path().join("basic.xlsx");
    let exported = export_xlsx_core(
        path_str(&out),
        imported.handle.snapshot_json.clone().unwrap(),
    )
    .unwrap();
    assert!(exported.success, "export failed: {:?}", exported.error);
    assert!(out.exists(), "Save As did not create the .xlsx");
    assert_eq!(sha256(&xls), before, "the original .xls changed");

    // The new file opens as a normal xlsx and keeps values and formulas.
    let reopened = import_xlsx_core(path_str(&out)).unwrap();
    let snap = snapshot(&reopened);
    assert_eq!(
        sheet_names(&snap)[..2],
        ["売上".to_string(), "集計".to_string()]
    );
    let s = sheet(&snap, "売上");
    assert_eq!(cell(s, 1, 0)["v"], json!("りんご"));
    assert_eq!(cell(s, 1, 1)["v"].as_f64(), Some(10.0));
    assert_eq!(cell(s, 3, 1)["f"], json!("=SUM(B2:B3)"));
    let t = sheet(&snap, "集計");
    assert_eq!(cell(t, 0, 0)["f"], json!("=売上!B4"));
    // The exporter writes 0 as every ordinary formula's cached result and
    // leaves the recalculation to the editor, so no cached value is asserted.
}

#[test]
fn export_refuses_a_path_that_is_not_xlsx_so_the_xls_cannot_be_overwritten() {
    // Save As maps foo.xls to foo.xlsx on the TypeScript side; this is the Rust
    // backstop if a .xls path ever reached the exporter.
    let dir = TempDir::new().unwrap();
    let xls = dir.path().join("basic.xls");
    std::fs::write(&xls, fixture_bytes("basic.xls")).unwrap();
    let before = sha256(&xls);
    let imported = import_xls_core(path_str(&xls)).unwrap();

    let r = export_xlsx_core(path_str(&xls), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(!r.success);
    assert_eq!(r.error.as_deref(), Some("XLSX_INVALID_EXTENSION"));
    assert_eq!(sha256(&xls), before);
}

// ── Rust to TypeScript boundary ─────────────────────────────────────────────

#[test]
fn result_serializes_with_the_camel_case_keys_the_frontend_reads() {
    let r = import_xls_core(path_str(&fixture("shared_formula.xls"))).unwrap();
    let v = serde_json::to_value(&r).unwrap();
    let handle = &v["handle"];
    assert!(handle["workbookId"].is_string());
    assert_eq!(handle["sourceType"], json!("xlsx"));
    assert!(handle["snapshotJson"].is_string());
    assert_eq!(handle["requiresSaveAsOnFirstSave"], json!(true));
    assert!(handle["path"]
        .as_str()
        .unwrap()
        .ends_with("shared_formula.xls"));
    let w = &v["warnings"][0];
    assert_eq!(w["severity"], json!("warning"));
    assert_eq!(w["code"], json!("XLS_LEGACY_FORMAT"));
    assert!(w["message"].is_string());
    assert_eq!(w["affectedSheets"], json!(["共有"]));
    // snake_case spellings must not leak through.
    assert!(handle.get("snapshot_json").is_none());
    assert!(w.get("affected_sheets").is_none());
}

#[test]
fn error_strings_match_the_table_the_frontend_translates() {
    // The same literals are fed to friendlyError() in
    // src/store/xlsContract.test.ts. Change both sides together.
    let dir = TempDir::new().unwrap();

    // XLS_TOO_LARGE: one decimal, megabytes, no unit.
    let big = dir.path().join("huge.xls");
    {
        let mut f = std::fs::File::create(&big).unwrap();
        f.write_all(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
            .unwrap();
        f.set_len(XLS_MAX_FILE_SIZE + 1024 * 1024).unwrap();
    }
    assert_eq!(
        import_xls_core(path_str(&big)).unwrap_err(),
        "XLS_TOO_LARGE: 51.0"
    );

    assert_eq!(
        import_xls_core(path_str(&fixture("password.xls"))).unwrap_err(),
        "XLS_PASSWORD_PROTECTED"
    );

    let bytes = fixture_bytes("basic.xls");
    let corrupt = import_bytes("half.xls", &bytes[..bytes.len() / 2]).unwrap_err();
    assert!(corrupt.starts_with("XLS_CORRUPT: "), "{corrupt}");
    assert!(
        !corrupt.contains('\n'),
        "detail must be one line: {corrupt}"
    );

    assert_eq!(
        import_bytes("page.xls", b"<html><body></body></html>").unwrap_err(),
        "XLS_NOT_EXCEL97: html"
    );
    assert_eq!(
        import_bytes("empty.xls", b"").unwrap_err(),
        "XLS_NOT_EXCEL97: empty"
    );
    assert_eq!(
        import_bytes(
            "noise.xls",
            &[0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]
        )
        .unwrap_err(),
        "XLS_NOT_EXCEL97: unknown"
    );

    let missing = import_xls_core(path_str(&dir.path().join("nope.xls"))).unwrap_err();
    assert!(missing.starts_with("XLS_READ_FAILED: "), "{missing}");

    // Exact code, no tail: three sheets each using A1:IV65536.
    assert_eq!(
        import_xls_core(path_str(&fixture("corners3.xls"))).unwrap_err(),
        "XLS_TOO_MANY_CELLS"
    );
}

// ── Chart sheets (skipped_sheets / XLS_NO_WORKSHEETS) ───────────────────────

/// BOUNDSHEET: lbPlyPos (4), hsState (1), dt (1). dt 0 = worksheet, 2 = chart.
fn set_sheet_kind(bytes: &mut [u8], which: &[usize], dt: u8) {
    let sheets = find_records(bytes, &BOF_GLOBALS, 0x0085);
    assert!(sheets.len() >= 4, "BOUNDSHEET records not found");
    for &i in which {
        let at = sheets[i] + 4 + 5;
        assert_eq!(bytes[at], 0, "sheet {i} should start as a worksheet");
        bytes[at] = dt;
    }
}

#[test]
fn a_chart_sheet_is_skipped_and_counted_in_the_warning() {
    let mut bytes = fixture_bytes("basic.xls");
    // 隠し (index 2) becomes a chart sheet.
    set_sheet_kind(&mut bytes, &[2], 2);
    let r = import_bytes("chart.xls", &bytes).unwrap();
    let snap = snapshot(&r);
    assert_eq!(sheet_names(&snap), vec!["売上", "集計", "R5"]);
    assert_eq!(r.warnings.len(), 1);
    assert!(
        r.warnings[0]
            .message
            .ends_with("グラフシートなど 1 枚は読み込みません。"),
        "{}",
        r.warnings[0].message
    );
}

#[test]
fn a_workbook_with_no_worksheet_reports_xls_no_worksheets() {
    let mut bytes = fixture_bytes("basic.xls");
    set_sheet_kind(&mut bytes, &[0, 1, 2, 3], 2);
    assert_eq!(
        import_bytes("charts.xls", &bytes).unwrap_err(),
        "XLS_NO_WORKSHEETS"
    );
}

// ── Compound-file header (cfb.rs bounds) ────────────────────────────────────

fn assert_clean_outcome(label: &str, outcome: Result<ImportWorkbookResult, String>) {
    match outcome {
        Ok(r) => assert_eq!(r.warnings[0].code, "XLS_LEGACY_FORMAT", "{label}"),
        Err(e) => {
            assert!(e.starts_with("XLS_CORRUPT:"), "{label}: {e}");
            assert_ne!(
                e, "XLS_CORRUPT: parser panic",
                "{label}: guard did not fire"
            );
        }
    }
}

#[test]
fn header_fat_sector_count_past_the_file_is_not_trusted() {
    let mut bytes = fixture_bytes("basic.xls");
    // Header offset 44: number of FAT sectors.
    bytes[44..48].copy_from_slice(&u32::MAX.to_le_bytes());
    let outcome = within_seconds(30, move || import_bytes("fat.xls", &bytes));
    assert_clean_outcome("fat count", outcome);
}

#[test]
fn header_difat_chain_that_loops_ends_with_an_error_not_a_hang() {
    let mut bytes = fixture_bytes("basic.xls");
    // Header offset 68: first DIFAT sector, 72: number of DIFAT sectors.
    bytes[68..72].copy_from_slice(&0u32.to_le_bytes());
    bytes[72..76].copy_from_slice(&u32::MAX.to_le_bytes());
    let outcome = within_seconds(30, move || import_bytes("difat.xls", &bytes));
    assert_clean_outcome("difat loop", outcome);
}

#[test]
fn header_sector_shift_that_is_not_512_or_4096_is_rejected_cleanly() {
    let mut bytes = fixture_bytes("basic.xls");
    // Header offset 30: sector shift (9 = 512-byte, 12 = 4096-byte sectors).
    bytes[30..32].copy_from_slice(&31u16.to_le_bytes());
    let outcome = within_seconds(30, move || import_bytes("shift.xls", &bytes));
    assert_clean_outcome("sector shift", outcome);
}

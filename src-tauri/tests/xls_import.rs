//! .xls (Excel 97-2003) import.
//!
//! Fixtures in tests/fixtures/xls/ are produced by Excel itself through
//! tests/fixtures/xls/make_fixtures.ps1 and make_more_fixtures.ps1 (SaveAs
//! FileFormat 56). Corrupted
//! variants are made inside the tests by patching record bytes of basic.xls;
//! every patch asserts that it found its target so a test cannot pass by
//! patching nothing.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use nicel_lib::commands::workbook::ImportWorkbookResult;
use nicel_lib::commands::xls_io::{import_xls_core, XLS_MAX_FILE_SIZE};
use rust_xlsxwriter::Workbook;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const LEGACY_BASE: &str = "値と数式だけ読み込みました。書式・セル結合・列幅・コメント・画像は読み込まれません。保存すると .xlsx になります。";

/// Tests that go through the "really xlsx" path create `nicel-xls-*` temp
/// directories; run them one at a time so each can check it cleaned up.
static ZIP_PATH_LOCK: Mutex<()> = Mutex::new(());

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

fn write_temp(dir: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.path().join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

fn import_bytes(name: &str, bytes: &[u8]) -> Result<ImportWorkbookResult, String> {
    let dir = TempDir::new().unwrap();
    let p = write_temp(&dir, name, bytes);
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

/// BOF record of the workbook globals / of a worksheet (BIFF8).
const BOF_GLOBALS: [u8; 8] = [0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x05, 0x00];
const BOF_WORKSHEET: [u8; 8] = [0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x10, 0x00];

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Offset of the first record of one of `types`, walking record headers from
/// the substream that starts with `bof` up to its EOF record. Excel writes the
/// Workbook stream contiguously, so the walk stays on record boundaries.
fn find_record(bytes: &[u8], bof: &[u8; 8], types: &[u16]) -> Option<usize> {
    let mut off = find(bytes, bof)?;
    while off + 4 <= bytes.len() {
        let typ = read_u16(bytes, off);
        let len = read_u16(bytes, off + 2) as usize;
        if types.contains(&typ) {
            return Some(off);
        }
        if typ == 0x000A {
            return None;
        }
        off += 4 + len;
    }
    None
}

fn zip_temp_dirs() -> HashSet<PathBuf> {
    std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map_or(false, |n| n.starts_with("nicel-xls-"))
        })
        .collect()
}

fn small_xlsx_bytes() -> Vec<u8> {
    let dir = TempDir::new().unwrap();
    let p = dir.path().join("src.xlsx");
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("データ").unwrap();
    ws.write_string(0, 0, "中身はxlsx").unwrap();
    ws.write_number(1, 0, 42.0).unwrap();
    wb.save(&p).unwrap();
    std::fs::read(&p).unwrap()
}

/// Copies every entry of an xlsx package and adds `extra` stored entries.
fn xlsx_with_extra_entries(xlsx: &[u8], extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut src = zip::ZipArchive::new(std::io::Cursor::new(xlsx)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for i in 0..src.len() {
        let mut e = src.by_index(i).unwrap();
        let name = e.name().to_string();
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).unwrap();
        out.start_file(name, opts).unwrap();
        out.write_all(&buf).unwrap();
    }
    for (name, data) in extra {
        out.start_file(*name, opts).unwrap();
        out.write_all(data).unwrap();
    }
    out.finish().unwrap().into_inner()
}

fn legacy_count(r: &ImportWorkbookResult) -> usize {
    r.warnings
        .iter()
        .filter(|w| w.code == "XLS_LEGACY_FORMAT")
        .count()
}

// ── basic.xls ────────────────────────────────────────────────────────────────

#[test]
fn basic_sheet_order_and_names() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    let snap = snapshot(&r);
    assert_eq!(sheet_names(&snap), vec!["売上", "集計", "隠し", "R5"]);
    assert_eq!(
        snap["sheetOrder"],
        json!(["sheet-1", "sheet-2", "sheet-3", "sheet-4"])
    );
}

#[test]
fn basic_values() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "売上");
    assert_eq!(cell(s, 0, 0)["v"], json!("品名"));
    assert_eq!(cell(s, 0, 3)["v"], json!(true));
    assert_eq!(cell(s, 1, 0)["v"], json!("りんご"));
    assert_eq!(cell(s, 1, 1)["v"].as_f64(), Some(10.0));
    assert_eq!(cell(s, 1, 2)["v"].as_f64(), Some(120.5));
    let t = sheet(&snap, "集計");
    // =1/0 keeps the error value next to its formula.
    assert_eq!(cell(t, 4, 0)["v"], Value::Null);
    assert_eq!(cell(t, 4, 0)["t"], json!("e"));
    assert_eq!(cell(t, 4, 0)["f"], json!("=1/0"));
}

#[test]
fn basic_formulas_match_excel_input_at_their_cells() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "売上");
    let expect = [
        (1, 4, "=IF(B2>5,\"多い\",\"少ない\")"),
        (1, 5, "=$B$2*C2"),
        (1, 6, "=B2+C2"),
        (1, 7, "=$B2+B$2"),
        (3, 1, "=SUM(B2:B3)"),
        (3, 2, "=SUM($C$2:$C$3)"),
        (8, 0, "=A6+1"),
    ];
    for (r, c, f) in expect {
        assert_eq!(cell(s, r, c)["f"], json!(f), "売上 ({r},{c})");
    }
    // The formula range starts at row 1 while the value range starts at row 0;
    // each must use its own start.
    assert_eq!(cell(s, 1, 4)["v"], json!("多い"));
    assert!(cell(s, 0, 4).is_null());

    let t = sheet(&snap, "集計");
    let expect = [
        (0, 0, "=売上!B4"),
        (1, 0, "=SUM(売上!B2:B3)"),
        (2, 0, "=売上!$C$2"),
        (3, 0, "=合計数量"),
        (5, 0, "=売上!A2&\"です\""),
        (6, 0, "=SUM(売上!$B$2:$B$3)"),
        // A sheet named like a cell address is quoted.
        (7, 0, "='R5'!A1*2"),
    ];
    for (r, c, f) in expect {
        assert_eq!(cell(t, r, c)["f"], json!(f), "集計 ({r},{c})");
    }
}

#[test]
fn basic_formula_cells_carry_cached_values() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    let snap = snapshot(&r);
    let t = sheet(&snap, "集計");
    assert_eq!(cell(t, 0, 0)["v"].as_f64(), Some(15.0));
    assert_eq!(cell(t, 3, 0)["v"].as_f64(), Some(15.0));
    assert_eq!(cell(t, 5, 0)["v"], json!("りんごです"));
    assert_eq!(cell(t, 7, 0)["v"].as_f64(), Some(6.0));
}

#[test]
fn basic_defined_names_skip_builtins() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    let snap = snapshot(&r);
    assert_eq!(
        snap["namedRanges"],
        json!([{ "name": "合計数量", "formula": "売上!$B$4" }])
    );
}

#[test]
fn basic_dates_get_default_formats() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "売上");
    assert_eq!(cell(s, 5, 0)["v"].as_f64(), Some(45306.0));
    assert_eq!(cell(s, 5, 0)["_fmt"], json!("yyyy/m/d"));
    assert_eq!(cell(s, 6, 0)["_fmt"], json!("h:mm:ss"));
    assert_eq!(cell(s, 7, 0)["_fmt"], json!("yyyy/m/d h:mm:ss"));
    assert_eq!(cell(s, 9, 0)["v"].as_f64(), Some(1.0));
    assert_eq!(cell(s, 9, 0)["_fmt"], json!("[h]:mm:ss"));
}

#[test]
fn basic_hidden_sheet_state_and_absolute_keys() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    let snap = snapshot(&r);
    let h = sheet(&snap, "隠し");
    assert_eq!(h["_sheetState"], json!("hidden"));
    assert_eq!(cell(h, 4, 2)["v"], json!("offset"));
    assert_eq!(cell(h, 5, 3)["v"].as_f64(), Some(42.0));
    assert!(sheet(&snap, "売上").get("_sheetState").is_none());
    assert_eq!(h["rowCount"], json!(1000));
    assert_eq!(h["columnCount"], json!(100));
    assert_eq!(h["defaultColumnWidth"], json!(64));
    assert_eq!(h["defaultRowHeight"], json!(20));
    assert_eq!(h["mergeData"], json!([]));
}

#[test]
fn basic_handle_keeps_xls_path_and_requires_save_as() {
    let p = path_str(&fixture("basic.xls"));
    let r = import_xls_core(p.clone()).unwrap();
    assert_eq!(r.handle.path.as_deref(), Some(p.as_str()));
    assert!(r.handle.requires_save_as_on_first_save);
    assert_eq!(r.handle.source_type, "xlsx");
}

#[test]
fn basic_emits_exactly_one_legacy_warning() {
    let r = import_xls_core(path_str(&fixture("basic.xls"))).unwrap();
    assert_eq!(r.warnings.len(), 1);
    let w = &r.warnings[0];
    assert_eq!(w.code, "XLS_LEGACY_FORMAT");
    assert_eq!(w.severity, "warning");
    assert_eq!(w.message, LEGACY_BASE);
    assert!(w.affected_sheets.is_none());
}

#[test]
fn import_does_not_modify_the_original() {
    let dir = TempDir::new().unwrap();
    let p = write_temp(&dir, "basic.xls", &fixture_bytes("basic.xls"));
    let before = sha256(&p);
    let modified_before = std::fs::metadata(&p).unwrap().modified().unwrap();
    import_xls_core(path_str(&p)).unwrap();
    assert_eq!(sha256(&p), before);
    assert_eq!(
        std::fs::metadata(&p).unwrap().modified().unwrap(),
        modified_before
    );
    // Nothing new appears next to the original.
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("basic.xls")]);
}

// ── .xls that is really xlsx ─────────────────────────────────────────────────

#[test]
fn zip_disguised_as_xls_opens_and_requires_save_as() {
    let _g = ZIP_PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let before = zip_temp_dirs();
    let dir = TempDir::new().unwrap();
    let p = write_temp(&dir, "really.xls", &small_xlsx_bytes());
    let original = sha256(&p);

    let r = import_xls_core(path_str(&p)).unwrap();
    assert_eq!(r.handle.path.as_deref(), Some(path_str(&p).as_str()));
    assert!(r.handle.requires_save_as_on_first_save);
    assert_eq!(legacy_count(&r), 1);
    assert_eq!(r.warnings[0].code, "XLS_LEGACY_FORMAT");
    assert_eq!(
        r.warnings[0].message,
        "拡張子は .xls ですが中身は .xlsx 形式でした。保存すると .xlsx になります。"
    );
    let snap = snapshot(&r);
    let s = sheet(&snap, "データ");
    assert_eq!(cell(s, 0, 0)["v"], json!("中身はxlsx"));
    assert_eq!(cell(s, 1, 0)["v"].as_f64(), Some(42.0));
    // The snapshot never names the temporary copy.
    let raw = r.handle.snapshot_json.as_deref().unwrap();
    assert!(!raw.contains("nicel-xls-"));
    assert!(!raw.contains("workbook.xlsx"));

    assert_eq!(sha256(&p), original);
    assert!(
        zip_temp_dirs().is_subset(&before),
        "temp directory left behind"
    );
}

#[test]
fn zip_disguised_with_vba_mentions_macros() {
    let _g = ZIP_PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = xlsx_with_extra_entries(&small_xlsx_bytes(), &[("xl/vbaProject.bin", b"vba")]);
    let r = import_bytes("macro.xls", &bytes).unwrap();
    assert_eq!(legacy_count(&r), 1);
    assert_eq!(r.warnings[0].code, "XLS_LEGACY_FORMAT");
    assert!(r.warnings[0]
        .message
        .ends_with("マクロは読み込まれません。"));
}

#[test]
fn zip_disguised_blocked_by_security_scan_passes_through() {
    let _g = ZIP_PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let before = zip_temp_dirs();
    // More than 2,000 entries trips the xlsx security scan.
    let names: Vec<String> = (0..2001).map(|i| format!("pad/{i}.bin")).collect();
    let extra: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
    let bytes = xlsx_with_extra_entries(&small_xlsx_bytes(), &extra);
    let dir = TempDir::new().unwrap();
    let p = write_temp(&dir, "blocked.xls", &bytes);

    let r = import_xls_core(path_str(&p)).unwrap();
    assert!(r
        .warnings
        .iter()
        .any(|w| w.severity == "blocking" && w.code == "XLSX_SECURITY_BLOCKED"));
    assert_eq!(legacy_count(&r), 0);
    assert_eq!(r.handle.path.as_deref(), Some(path_str(&p).as_str()));
    assert!(r.handle.requires_save_as_on_first_save);
    assert!(
        zip_temp_dirs().is_subset(&before),
        "temp directory left behind"
    );
}

#[test]
fn zip_disguised_corrupt_returns_xlsx_error_unchanged() {
    let _g = ZIP_PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let before = zip_temp_dirs();
    let mut bytes = small_xlsx_bytes();
    bytes.truncate(bytes.len() / 2);
    let err = import_bytes("broken.xls", &bytes).unwrap_err();
    assert!(!err.contains("nicel-xls-"), "temp path leaked: {err}");
    assert!(
        !err.starts_with("XLS_"),
        "xlsx error should pass through: {err}"
    );
    assert!(
        zip_temp_dirs().is_subset(&before),
        "temp directory left behind"
    );
}

// ── Not Excel 97-2003 ────────────────────────────────────────────────────────

#[test]
fn non_excel_content_is_named() {
    let html = import_bytes(
        "page.xls",
        b"<html><body><table><tr><td>1</td></tr></table></body></html>",
    )
    .unwrap_err();
    assert_eq!(html, "XLS_NOT_EXCEL97: html");

    let xml = import_bytes(
        "ss2003.xls",
        b"<?xml version=\"1.0\"?>\r\n<?mso-application progid=\"Excel.Sheet\"?>\r\n<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\"></Workbook>",
    )
    .unwrap_err();
    assert_eq!(xml, "XLS_NOT_EXCEL97: xml");

    assert_eq!(
        import_bytes("empty.xls", b"").unwrap_err(),
        "XLS_NOT_EXCEL97: empty"
    );

    // "PK," is a CSV header, not a zip signature.
    assert_eq!(
        import_bytes("pk.xls", b"PK,Name\n1,a\n").unwrap_err(),
        "XLS_NOT_EXCEL97: text"
    );
}

#[test]
fn password_protected_is_reported() {
    let err = import_xls_core(path_str(&fixture("password.xls"))).unwrap_err();
    assert_eq!(err, "XLS_PASSWORD_PROTECTED");
}

#[test]
fn truncated_file_is_corrupt_not_a_crash() {
    let bytes = fixture_bytes("basic.xls");
    let err = import_bytes("half.xls", &bytes[..bytes.len() / 2]).unwrap_err();
    assert!(err.starts_with("XLS_CORRUPT:"), "{err}");
}

#[test]
fn oversized_file_is_rejected_before_reading() {
    let dir = TempDir::new().unwrap();
    let p = dir.path().join("huge.xls");
    {
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
            .unwrap();
        f.set_len(XLS_MAX_FILE_SIZE + 1024 * 1024).unwrap();
    }
    let err = import_xls_core(path_str(&p)).unwrap_err();
    assert!(err.starts_with("XLS_TOO_LARGE: "), "{err}");
}

#[test]
fn missing_file_is_a_read_failure() {
    let dir = TempDir::new().unwrap();
    let err = import_xls_core(path_str(&dir.path().join("nope.xls"))).unwrap_err();
    assert!(err.starts_with("XLS_READ_FAILED: "), "{err}");
}

// ── Shared formulas and external references ─────────────────────────────────

#[test]
fn shared_formulas_keep_values_and_are_reported() {
    let r = import_xls_core(path_str(&fixture("shared_formula.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "共有");
    // The first cell of a FillDown keeps its formula; the rest are stored as
    // shared-formula references and come in as values only.
    assert_eq!(cell(s, 1, 2)["f"], json!("=B2*3"));
    assert_eq!(cell(s, 1, 2)["v"].as_f64(), Some(3.0));
    for row in 2..=11u32 {
        let c = cell(s, row, 2);
        assert_eq!(c["v"].as_f64(), Some(row as f64 * 3.0), "row {row}");
        assert!(c.get("f").is_none(), "row {row} should have no formula");
    }
    assert_eq!(r.warnings.len(), 1);
    let w = &r.warnings[0];
    assert_eq!(w.code, "XLS_LEGACY_FORMAT");
    assert_eq!(
        w.message,
        format!("{LEGACY_BASE}読み取れない数式 10 個は計算結果の値で読み込みました。これらのセルは、元になるセルを変えても再計算されません。")
    );
    assert_eq!(w.affected_sheets, Some(vec!["共有".to_string()]));
}

#[test]
fn external_references_do_not_turn_into_local_ones() {
    let r = import_xls_core(path_str(&fixture("external_ref.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "参照");
    // =[other.xls]Data!A1 and =SUM([other.xls]Data!A1:A2): value only.
    assert_eq!(cell(s, 0, 0)["v"].as_f64(), Some(5.0));
    assert!(cell(s, 0, 0).get("f").is_none(), "{}", cell(s, 0, 0));
    assert_eq!(cell(s, 2, 0)["v"].as_f64(), Some(12.0));
    assert!(cell(s, 2, 0).get("f").is_none(), "{}", cell(s, 2, 0));
    // A reference into this workbook still resolves.
    assert_eq!(cell(s, 1, 0)["f"], json!("=内部!A1"));
    assert_eq!(cell(s, 1, 0)["v"].as_f64(), Some(11.0));

    assert_eq!(
        snap["namedRanges"],
        json!([{ "name": "内部名", "formula": "内部!$A$1" }])
    );
    let w = &r.warnings[0];
    assert_eq!(r.warnings.len(), 1);
    assert!(w.message.contains("読み取れない数式 2 個"), "{}", w.message);
    assert!(
        w.message.contains("定義名 1 個は読み込めませんでした"),
        "{}",
        w.message
    );
    assert_eq!(w.affected_sheets, Some(vec!["参照".to_string()]));
}

// ── Crafted files must not abort the process (C1, ruling 6) ─────────────────

/// Cell records the column/row patches can target.
const CELL_RECORDS: [u16; 3] = [
    0x027E, /* RK */
    0x0203, /* NUMBER */
    0x00FD, /* LABELSST */
];

#[test]
fn column_past_iv_is_rejected_before_allocation() {
    let mut bytes = fixture_bytes("basic.xls");
    let off = find_record(&bytes, &BOF_WORKSHEET, &CELL_RECORDS).expect("cell record not found");
    // Header (4) + row (2): the column.
    bytes[off + 6..off + 8].copy_from_slice(&300u16.to_le_bytes());
    let err = import_bytes("wide.xls", &bytes).unwrap_err();
    assert!(err.starts_with("XLS_CORRUPT:"), "{err}");
    assert_ne!(
        err, "XLS_CORRUPT: parser panic",
        "guard must reject before the parser panics"
    );
}

#[test]
fn huge_dimensions_record_is_only_a_hint() {
    let mut bytes = fixture_bytes("basic.xls");
    let off = find_record(&bytes, &BOF_WORKSHEET, &[0x0200]).expect("DIMENSIONS not found");
    assert_eq!(
        read_u16(&bytes, off + 2),
        14,
        "BIFF8 DIMENSIONS is 14 bytes"
    );
    // rwMac (u32) follows rwMic.
    bytes[off + 8..off + 12].copy_from_slice(&u32::MAX.to_le_bytes());
    let r = import_bytes("dims.xls", &bytes).unwrap();
    let snap = snapshot(&r);
    assert_eq!(cell(sheet(&snap, "売上"), 1, 0)["v"], json!("りんご"));
}

/// Debug builds catch the row underflow in `Range::from_sparse` as a panic;
/// release builds would wrap it into a huge allocation and abort. The result
/// must be Ok with the cell at its patched row in both.
#[test]
fn out_of_order_rows_are_read_in_place() {
    let mut bytes = fixture_bytes("basic.xls");
    let off = find_record(
        &bytes,
        &BOF_WORKSHEET,
        &[0x027E, 0x0203, 0x00FD, 0x0204, 0x0205, 0x00BD, 0x0006],
    )
    .expect("first cell record not found");
    assert_eq!(
        read_u16(&bytes, off),
        0x00FD,
        "first cell of 売上 should be A1 (LABELSST)"
    );
    assert_eq!(read_u16(&bytes, off + 4), 0, "A1 is on row 0");
    bytes[off + 4..off + 6].copy_from_slice(&100u16.to_le_bytes());
    let r = import_bytes("rows.xls", &bytes).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "売上");
    assert_eq!(cell(s, 100, 0)["v"], json!("品名"));
    assert!(cell(s, 0, 0).is_null());
    assert_eq!(cell(s, 1, 0)["v"], json!("りんご"));
    assert_eq!(s["rowCount"], json!(1000));
}

#[test]
fn huge_shared_string_count_is_corrupt() {
    let mut bytes = fixture_bytes("basic.xls");
    let off = find_record(&bytes, &BOF_GLOBALS, &[0x00FC]).expect("SST not found");
    // cstTotal (4) then cstUnique (4): the count the parser trusts.
    bytes[off + 8..off + 12].copy_from_slice(&0x7FFF_FFFFu32.to_le_bytes());
    let err = import_bytes("sst.xls", &bytes).unwrap_err();
    assert!(err.starts_with("XLS_CORRUPT:"), "{err}");
    assert_ne!(err, "XLS_CORRUPT: parser panic", "guard did not fire");
}

#[test]
fn negative_shared_string_count_is_corrupt() {
    let mut bytes = fixture_bytes("basic.xls");
    let off = find_record(&bytes, &BOF_GLOBALS, &[0x00FC]).expect("SST not found");
    bytes[off + 8..off + 12].copy_from_slice(&(-1i32).to_le_bytes());
    let err = import_bytes("sst_neg.xls", &bytes).unwrap_err();
    assert!(err.starts_with("XLS_CORRUPT:"), "{err}");
    assert_ne!(err, "XLS_CORRUPT: parser panic");
}

#[test]
fn huge_stream_length_in_directory_does_not_crash() {
    let mut bytes = fixture_bytes("basic.xls");
    // Directory entry: UTF-16 name (64 bytes), name length (2) = 18 for
    // "Workbook" + NUL, ..., stream size at +120 (u32 for 512-byte sectors).
    let name: Vec<u8> = "Workbook"
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let entry = (0..bytes.len().saturating_sub(128))
        .find(|&i| bytes[i..].starts_with(&name) && read_u16(&bytes, i + 64) == 18)
        .expect("Workbook directory entry not found");
    bytes[entry + 120..entry + 124].copy_from_slice(&u32::MAX.to_le_bytes());
    match import_bytes("dir.xls", &bytes) {
        Ok(r) => assert_eq!(legacy_count(&r), 1),
        Err(e) => {
            assert!(e.starts_with("XLS_CORRUPT:"), "{e}");
            assert_ne!(e, "XLS_CORRUPT: parser panic", "guard did not fire");
        }
    }
}

#[test]
fn sector_id_past_end_of_file_is_corrupt() {
    let mut bytes = fixture_bytes("basic.xls");
    // Header: first directory sector id at offset 48.
    bytes[48..52].copy_from_slice(&0x00FF_FFFFu32.to_le_bytes());
    let err = import_bytes("sector.xls", &bytes).unwrap_err();
    assert!(err.starts_with("XLS_CORRUPT:"), "{err}");
    assert_ne!(err, "XLS_CORRUPT: parser panic");
}

// ── Formula decoding, second round (columns.xls, span3d.xls, new_functions.xls) ──

#[test]
fn columns_past_z_keep_both_letters() {
    let r = import_xls_core(path_str(&fixture("columns.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "Data");
    // (row, col, formula, Excel's cached value)
    let expect = [
        (2, 0, "=AA1", 2.0),
        (3, 0, "=IV1", 5.0),
        (4, 0, "=$AA$1", 2.0),
        (5, 0, "=SUM(Z1:AB1)", 6.0),
        (6, 0, "=Z1", 1.0),
        (9, 0, "=ABS(-Z1)", 1.0),
    ];
    for (row, col, f, v) in expect {
        assert_eq!(cell(s, row, col)["f"], json!(f), "({row},{col})");
        assert_eq!(cell(s, row, col)["v"].as_f64(), Some(v), "({row},{col})");
    }
    assert_eq!(cell(s, 0, 255)["v"].as_f64(), Some(5.0), "IV1 itself");
    assert_eq!(r.warnings.len(), 1);
    assert_eq!(r.warnings[0].message, LEGACY_BASE);
}

#[test]
fn quotes_inside_string_literals_are_doubled() {
    let r = import_xls_core(path_str(&fixture("columns.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "Data");
    assert_eq!(cell(s, 7, 0)["f"], json!("=\"say \"\"hi\"\"\""));
    assert_eq!(cell(s, 7, 0)["v"], json!("say \"hi\""));
    assert_eq!(cell(s, 8, 0)["f"], json!("=A8&\"\"\"\""));
    assert_eq!(cell(s, 8, 0)["v"], json!("say \"hi\"\""));
}

#[test]
fn sheet_span_reference_keeps_the_value_and_is_reported() {
    let r = import_xls_core(path_str(&fixture("span3d.xls"))).unwrap();
    let snap = snapshot(&r);
    let t = sheet(&snap, "集計");
    // =SUM('1月:3月'!B2): Excel's 60 stays, without a formula that would
    // read only one of the three sheets.
    assert_eq!(cell(t, 0, 0)["v"].as_f64(), Some(60.0));
    assert!(cell(t, 0, 0).get("f").is_none(), "{}", cell(t, 0, 0));
    // A reference to a single sheet still resolves.
    assert_eq!(cell(t, 1, 0)["f"], json!("='2月'!B2"));
    assert_eq!(cell(t, 1, 0)["v"].as_f64(), Some(20.0));
    // The span name is dropped, the single-sheet one kept.
    assert_eq!(
        snap["namedRanges"],
        json!([{ "name": "Feb", "formula": "'2月'!$B$2" }])
    );
    let w = &r.warnings[0];
    assert_eq!(r.warnings.len(), 1);
    assert!(w.message.contains("読み取れない数式 1 個"), "{}", w.message);
    assert!(
        w.message.contains("定義名 1 個は読み込めませんでした"),
        "{}",
        w.message
    );
    assert_eq!(w.affected_sheets, Some(vec!["集計".to_string()]));
}

#[test]
fn post_2003_functions_stay_live_formulas() {
    let r = import_xls_core(path_str(&fixture("new_functions.xls"))).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "S");
    // A1=1, A2=2, B1="a", B2="b". Each cached value is what the formula
    // computes from those inputs.
    assert_eq!(cell(s, 0, 2)["f"], json!("=IFERROR(1/0,\"x\")"));
    assert_eq!(cell(s, 0, 2)["v"], json!("x"));
    assert_eq!(cell(s, 1, 2)["f"], json!("=SUMIFS(A1:A2,B1:B2,\"a\")"));
    assert_eq!(cell(s, 1, 2)["v"].as_f64(), Some(1.0));
    assert_eq!(cell(s, 2, 2)["f"], json!("=COUNTIFS(B1:B2,\"b\")"));
    assert_eq!(cell(s, 2, 2)["v"].as_f64(), Some(1.0));
    assert_eq!(cell(s, 3, 2)["f"], json!("=IFERROR(A1/A2,0)+1"));
    assert_eq!(cell(s, 3, 2)["v"].as_f64(), Some(1.5));
    // FILTERXML is not evaluated by Nicel: value only, and counted.
    assert!(cell(s, 4, 2).get("f").is_none(), "{}", cell(s, 4, 2));
    assert!(!cell(s, 4, 2)["v"].is_null(), "cached value kept");

    // The hidden _xlfn.* names are neither imported nor counted as dropped.
    assert_eq!(snap["namedRanges"], json!([]));
    let w = &r.warnings[0];
    assert_eq!(r.warnings.len(), 1);
    assert_eq!(
        w.message,
        format!("{LEGACY_BASE}読み取れない数式 1 個は計算結果の値で読み込みました。これらのセルは、元になるセルを変えても再計算されません。")
    );
    assert_eq!(w.affected_sheets, Some(vec!["S".to_string()]));
}

#[test]
fn a_user_function_that_is_not_xlfn_keeps_its_value() {
    // Rename the hidden name behind C5 so the call looks like a VBA or
    // add-in function (User(MyFunc..., ...)) rather than a post-2003 one.
    let mut bytes = fixture_bytes("new_functions.xls");
    let at = find(&bytes, b"_xlfn.FILTERXML").expect("_xlfn.FILTERXML name not found");
    assert!(
        find(&bytes[at + 1..], b"_xlfn.FILTERXML").is_none(),
        "name found twice"
    );
    bytes[at..at + 6].copy_from_slice(b"MyFunc");
    let r = import_bytes("udf.xls", &bytes).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "S");
    assert!(cell(s, 4, 2).get("f").is_none(), "{}", cell(s, 4, 2));
    assert!(!cell(s, 4, 2)["v"].is_null());
    assert_eq!(cell(s, 0, 2)["f"], json!("=IFERROR(1/0,\"x\")"));
    assert!(r.warnings[0].message.contains("読み取れない数式 1 個"));
}

#[test]
fn function_index_at_the_table_end_is_unreadable_not_a_panic() {
    // =ABS(-Z1) is PtgFuncV (0x41) with iftab 24; 485 is one past FTAB.
    let mut bytes = fixture_bytes("columns.xls");
    let at = find(&bytes, &[0x41, 0x18, 0x00]).expect("PtgFuncV ABS not found");
    bytes[at + 1..at + 3].copy_from_slice(&485u16.to_le_bytes());
    let r = import_bytes("iftab.xls", &bytes).unwrap();
    let snap = snapshot(&r);
    let s = sheet(&snap, "Data");
    assert!(cell(s, 9, 0).get("f").is_none(), "{}", cell(s, 9, 0));
    assert_eq!(cell(s, 9, 0)["v"].as_f64(), Some(1.0));
    assert!(r.warnings[0].message.contains("読み取れない数式 1 個"));
}

#[test]
fn excel4_macro_sheet_is_skipped_without_losing_worksheet() {
    let r = import_xls_core(path_str(&fixture("xlm.xls"))).unwrap();
    let snap = snapshot(&r);
    assert_eq!(sheet_names(&snap), vec!["S"]);
    assert_eq!(cell(sheet(&snap, "S"), 0, 0)["v"].as_f64(), Some(5.0));
    assert!(
        r.warnings[0]
            .message
            .contains("グラフシートなど 1 枚は読み込みません。"),
        "{}",
        r.warnings[0].message
    );
}

// ── Macros: presence only ────────────────────────────────────────────────────

#[test]
fn vba_storage_is_detected_without_being_parsed() {
    // Rename the "\u{5}SummaryInformation" directory entry to _VBA_PROJECT_CUR.
    // It then holds none of the streams a VBA project needs, so parsing it
    // would fail; an Ok result shows that it is only detected.
    let mut bytes = fixture_bytes("basic.xls");
    let old: Vec<u8> = "\u{5}SummaryInformation"
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let entry = (0..bytes.len().saturating_sub(128))
        .find(|&i| bytes[i..].starts_with(&old) && read_u16(&bytes, i + 64) == 40)
        .expect("SummaryInformation directory entry not found");
    let new: Vec<u8> = "_VBA_PROJECT_CUR"
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    bytes[entry..entry + 64].fill(0);
    bytes[entry..entry + new.len()].copy_from_slice(&new);
    bytes[entry + 64..entry + 66].copy_from_slice(&((new.len() + 2) as u16).to_le_bytes());
    let r = import_bytes("macro.xls", &bytes).unwrap();
    assert_eq!(r.warnings.len(), 1);
    assert!(
        r.warnings[0]
            .message
            .ends_with("マクロは読み込まれません。"),
        "{}",
        r.warnings[0].message
    );
}

// ── Cell budget (XLS_TOO_MANY_CELLS) ─────────────────────────────────────────

/// Offsets of every BOUNDSHEET record in the workbook globals.
fn boundsheets(bytes: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut off = find(bytes, &BOF_GLOBALS).expect("globals BOF not found");
    while off + 4 <= bytes.len() {
        let typ = read_u16(bytes, off);
        if typ == 0x0085 {
            out.push(off);
        }
        if typ == 0x000A {
            break;
        }
        off += 4 + read_u16(bytes, off + 2) as usize;
    }
    out
}

#[test]
fn one_full_size_sheet_opens() {
    // "Big" has values in A1 and IV65536: the largest range BIFF8 allows.
    let r = import_xls_core(path_str(&fixture("corner.xls"))).unwrap();
    let snap = snapshot(&r);
    let b = sheet(&snap, "Big");
    assert_eq!(cell(b, 0, 0)["v"].as_f64(), Some(1.0));
    assert_eq!(cell(b, 65535, 255)["v"].as_f64(), Some(2.0));
    assert_eq!(b["rowCount"], json!(65536));
    assert_eq!(b["columnCount"], json!(256));
    assert_eq!(cell(sheet(&snap, "S3"), 0, 0)["v"].as_f64(), Some(4.0));
}

#[test]
fn several_full_size_sheets_are_refused_as_too_large() {
    let err = import_xls_core(path_str(&fixture("corners3.xls"))).unwrap_err();
    assert_eq!(err, "XLS_TOO_MANY_CELLS");
}

#[test]
fn boundsheets_pointing_at_one_large_sheet_are_refused() {
    let mut bytes = fixture_bytes("corner.xls");
    let sheets = boundsheets(&bytes);
    assert_eq!(sheets.len(), 3, "Big, S2, S3");
    // Without the patch the file opens (one_full_size_sheet_opens). Now the
    // lbPlyPos of S2 and S3 point at Big's substream.
    let big_pos = bytes[sheets[0] + 4..sheets[0] + 8].to_vec();
    for &s in &sheets[1..] {
        bytes[s + 4..s + 8].copy_from_slice(&big_pos);
    }
    let err = import_bytes("dup.xls", &bytes).unwrap_err();
    assert_eq!(err, "XLS_TOO_MANY_CELLS");
}

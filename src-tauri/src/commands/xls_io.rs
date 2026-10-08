//! Excel 97-2003 (.xls, BIFF8) import.
//!
//! Reads values, formulas, dates, sheet names/visibility and workbook-level
//! defined names into the same snapshot shape `import_xlsx_core` produces.
//! Formatting, merges, sizes, comments and images are not read.
//!
//! Parsing uses `calamine_xls`, a copy of calamine 0.24.0 with fixes to the
//! BIFF8 formula decoder and allocation bounds (see
//! `vendor/calamine-xls/NICEL_PATCH.md`). xlsx import keeps using the registry
//! `calamine`.
//!
//! Safety rules:
//! - The original file is only ever read. The one write is a temporary copy
//!   for `.xls` files that are really xlsx, inside a private temp directory
//!   that is removed afterwards.
//! - Every `Ok` result goes through `finalize_xls_handle`, so the handle keeps
//!   the original `.xls` path and always requires Save As (the save path then
//!   writes `.xlsx`, never the original file).
//! - Parser panics are caught and turned into `XLS_CORRUPT: parser panic`.

use std::any::Any;
use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use calamine_xls::{
    Data, ExcelDateTime, ExcelDateTimeType, Reader, SheetType, SheetVisible, Xls, XlsError,
};
use serde_json::{json, Map, Value};

use crate::commands::workbook::{CompatibilityWarning, ImportWorkbookResult, WorkbookHandle};
use crate::commands::xlsx_io::{
    import_xlsx_core, EXCEL_DEFAULT_COL_WIDTH_PX, EXCEL_DEFAULT_ROW_HEIGHT_PX, MIN_COLS, MIN_ROWS,
};

/// Same value as `security.rs` `MAX_FILE_SIZE` (the xlsx import limit).
pub const XLS_MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

const OLE_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const ZIP_MAGIC: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];
/// How much of a non-Excel file is inspected to name what it is.
const SNIFF_WINDOW: usize = 4096;
/// Days between the 1904 and 1900 date systems.
const DAYS_1904_TO_1900: f64 = 1462.0;

// Warning and error codes. The frontend (`src/store/errorMessages.ts`)
// translates errors by these prefixes. `XLS_PASSWORD_PROTECTED` and
// `XLS_NO_WORKSHEETS` are returned as-is; every other error is
// `"<CODE>: <detail>"`.
pub const XLS_LEGACY_FORMAT: &str = "XLS_LEGACY_FORMAT";
pub const XLS_NOT_EXCEL97: &str = "XLS_NOT_EXCEL97";
pub const XLS_PASSWORD_PROTECTED: &str = "XLS_PASSWORD_PROTECTED";
pub const XLS_TOO_LARGE: &str = "XLS_TOO_LARGE";
pub const XLS_CORRUPT: &str = "XLS_CORRUPT";
pub const XLS_NO_WORKSHEETS: &str = "XLS_NO_WORKSHEETS";
pub const XLS_READ_FAILED: &str = "XLS_READ_FAILED";

const LEGACY_BASE_MESSAGE: &str = "値と数式だけ読み込みました。書式・セル結合・列幅・コメント・画像は読み込まれません。保存すると .xlsx になります。";
const LEGACY_ZIP_MESSAGE: &str =
    "拡張子は .xls ですが中身は .xlsx 形式でした。保存すると .xlsx になります。";
const MACROS_NOT_LOADED: &str = "マクロは読み込まれません。";

/// Tauri command. Runs off the main thread because a large .xls can take a
/// while to parse. Records the file in recent files only when it actually
/// opened (no blocking warning).
#[tauri::command(async)]
pub fn workbook_import_xls(
    app: tauri::AppHandle,
    path: String,
) -> Result<ImportWorkbookResult, String> {
    let result = import_xls_core(path.clone())?;
    let blocked = result.warnings.iter().any(|w| w.severity == "blocking");
    if !blocked {
        let recent_name = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path)
            .to_string();
        if let Ok(app_conn) = crate::db::app_db::open_app_db(&app) {
            let _ = crate::db::operations::record_recent_file(&app_conn, &path, &recent_name);
        }
    }
    Ok(result)
}

/// Pure-Rust import logic, callable from tests without Tauri.
pub fn import_xls_core(path: String) -> Result<ImportWorkbookResult, String> {
    let bytes = read_limited(Path::new(&path))?;
    let mut result = match sniff(&bytes) {
        Sniffed::Ole => import_ole(bytes)?,
        Sniffed::Zip => import_zip_disguised(&bytes)?,
        Sniffed::NotExcel97(hint) => return Err(format!("{XLS_NOT_EXCEL97}: {hint}")),
    };
    finalize_xls_handle(&mut result, &path);
    Ok(result)
}

/// Reads the whole file, refusing anything over the size limit. The read is
/// capped too, so a file that grows after the size check cannot push past it.
fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    let too_large = |len: u64| format!("{XLS_TOO_LARGE}: {:.1}", len as f64 / 1024.0 / 1024.0);
    let meta = std::fs::metadata(path).map_err(|e| format!("{XLS_READ_FAILED}: {e}"))?;
    if meta.len() > XLS_MAX_FILE_SIZE {
        return Err(too_large(meta.len()));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("{XLS_READ_FAILED}: {e}"))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(XLS_MAX_FILE_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{XLS_READ_FAILED}: {e}"))?;
    if bytes.len() as u64 > XLS_MAX_FILE_SIZE {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(bytes)
}

// ── Format detection ─────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum Sniffed {
    Ole,
    Zip,
    /// "html" | "xml" | "text" | "empty" | "unknown"
    NotExcel97(&'static str),
}

fn sniff(bytes: &[u8]) -> Sniffed {
    if bytes.starts_with(&OLE_MAGIC) {
        return Sniffed::Ole;
    }
    // Four bytes, not two: a CSV starting with "PK," must not be taken for xlsx.
    if bytes.starts_with(&ZIP_MAGIC) {
        return Sniffed::Zip;
    }
    if bytes.is_empty() {
        return Sniffed::NotExcel97("empty");
    }
    let window = &bytes[..bytes.len().min(SNIFF_WINDOW)];
    let text: Option<String> = if let Some(rest) = window.strip_prefix(&[0xFF, 0xFE]) {
        Some(
            encoding_rs::UTF_16LE
                .decode_without_bom_handling(rest)
                .0
                .into_owned(),
        )
    } else if let Some(rest) = window.strip_prefix(&[0xFE, 0xFF]) {
        Some(
            encoding_rs::UTF_16BE
                .decode_without_bom_handling(rest)
                .0
                .into_owned(),
        )
    } else {
        let rest = window.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(window);
        match std::str::from_utf8(rest) {
            Ok(s) => Some(s.to_string()),
            // A multi-byte character cut by the window edge is still text.
            Err(e) if e.error_len().is_none() => {
                Some(String::from_utf8_lossy(&rest[..e.valid_up_to()]).into_owned())
            }
            Err(_) => None,
        }
    };
    let Some(text) = text else {
        // Not UTF-8 / UTF-16, but markup in a legacy code page (Shift_JIS HTML
        // saved by old Excel) still starts with ASCII `<`.
        let head = window
            .iter()
            .position(|b| !b.is_ascii_whitespace())
            .map(|i| window[i]);
        return if head == Some(b'<') {
            Sniffed::NotExcel97("html")
        } else {
            Sniffed::NotExcel97("unknown")
        };
    };
    let lower = text.trim_start().to_lowercase();
    if lower.starts_with("<?xml") {
        if lower.contains("urn:schemas-microsoft-com:office:spreadsheet") {
            return Sniffed::NotExcel97("xml");
        }
        return Sniffed::NotExcel97("html");
    }
    if lower.starts_with('<') {
        return Sniffed::NotExcel97("html");
    }
    let is_text = text
        .chars()
        .all(|c| !c.is_control() || c == '\t' || c == '\n' || c == '\r');
    if is_text {
        Sniffed::NotExcel97("text")
    } else {
        Sniffed::NotExcel97("unknown")
    }
}

// ── Handle finalization ──────────────────────────────────────────────────────

/// The single exit for every successful import. Keeps the original `.xls`
/// path and forces Save As, whatever path produced the result. Without this
/// a `.xls` that is really xlsx would come back from `import_xlsx_core` with
/// `requires_save_as_on_first_save: false`, and a later Ctrl+S could write
/// over the original file.
fn finalize_xls_handle(result: &mut ImportWorkbookResult, original_path: &str) {
    result.handle.path = Some(original_path.to_string());
    result.handle.requires_save_as_on_first_save = true;
    // source_type stays "xlsx": the frontend does not branch on it for paths
    // that exist, and saving is decided by path + requires_save_as.
}

// ── OLE (BIFF8) path ─────────────────────────────────────────────────────────

fn import_ole(bytes: Vec<u8>) -> Result<ImportWorkbookResult, String> {
    match catch_unwind(AssertUnwindSafe(move || import_ole_inner(bytes))) {
        Ok(r) => r,
        Err(payload) => {
            log::error!("xls parser panic: {}", panic_message(payload.as_ref()));
            Err(format!("{XLS_CORRUPT}: parser panic"))
        }
    }
}

#[derive(Default)]
struct OleCounters {
    formulas_as_values: usize,
    dropped_names: usize,
    skipped_sheets: usize,
    has_vba: bool,
    affected_sheets: Vec<String>,
}

fn import_ole_inner(bytes: Vec<u8>) -> Result<ImportWorkbookResult, String> {
    let workbook_id = uuid::Uuid::new_v4().to_string();
    let mut wb: Xls<_> = Xls::new(Cursor::new(bytes)).map_err(map_xls_error)?;
    let mut counters = OleCounters {
        has_vba: wb.vba_project().is_some(),
        ..Default::default()
    };

    let named_ranges = collect_defined_names(wb.defined_names(), &mut counters.dropped_names);

    // sheets_metadata() keeps the workbook's tab order; worksheets() would
    // return them sorted by name.
    let metadata: Vec<(String, SheetType, SheetVisible)> = wb
        .sheets_metadata()
        .iter()
        .map(|s| (s.name.clone(), s.typ, s.visible))
        .collect();

    let mut sheet_order: Vec<String> = Vec::new();
    let mut sheets_map: Map<String, Value> = Map::new();
    let mut seen_names: HashSet<String> = HashSet::new();

    for (name, typ, visible) in metadata {
        if typ != SheetType::WorkSheet || !seen_names.insert(name.clone()) {
            counters.skipped_sheets += 1;
            continue;
        }
        let range = wb
            .worksheet_range(&name)
            .map_err(|e| format!("{XLS_CORRUPT}: {e}"))?;
        let formulas = wb.worksheet_formula(&name).ok();

        // Keys are absolute (row, col). Values and formulas each use their own
        // range's start: the two ranges usually begin at different cells.
        let mut cells: BTreeMap<(u32, u32), Map<String, Value>> = BTreeMap::new();
        if let Some((r0, c0)) = range.start() {
            for (r, c, v) in range.used_cells() {
                if let Some(Value::Object(obj)) = xls_value_to_cell(v) {
                    cells.insert((r0 + r as u32, c0 + c as u32), obj);
                }
            }
        }
        let mut sheet_affected = false;
        if let Some(fr) = formulas.as_ref() {
            if let Some((r0, c0)) = fr.start() {
                for (r, c, f) in fr.used_cells() {
                    if f.is_empty() {
                        continue;
                    }
                    let pos = (r0 + r as u32, c0 + c as u32);
                    if is_unusable_formula(f) {
                        // Keep Excel's cached value; the formula is lost.
                        counters.formulas_as_values += 1;
                        sheet_affected = true;
                        continue;
                    }
                    cells
                        .entry(pos)
                        .or_default()
                        .insert("f".into(), Value::String(format!("={f}")));
                }
            }
        }
        if sheet_affected {
            counters.affected_sheets.push(name.clone());
        }

        let sheet_id = format!("sheet-{}", sheet_order.len() + 1);
        let sheet_obj = build_sheet(&sheet_id, &name, visible, cells);
        sheet_order.push(sheet_id.clone());
        sheets_map.insert(sheet_id, sheet_obj);
    }

    if sheet_order.is_empty() {
        return Err(XLS_NO_WORKSHEETS.to_string());
    }

    let snapshot = json!({
        "id": workbook_id,
        "name": "Imported Workbook",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": {},
        "sheetOrder": sheet_order,
        "sheets": Value::Object(sheets_map),
        "namedRanges": named_ranges,
    });
    let snapshot_json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

    Ok(ImportWorkbookResult {
        handle: WorkbookHandle {
            workbook_id,
            path: None,
            source_type: "xlsx".to_string(),
            snapshot_json: Some(snapshot_json),
            requires_save_as_on_first_save: true,
        },
        warnings: vec![legacy_warning_ole(&counters)],
    })
}

fn build_sheet(
    sheet_id: &str,
    name: &str,
    visible: SheetVisible,
    cells: BTreeMap<(u32, u32), Map<String, Value>>,
) -> Value {
    let mut max_row: usize = 0;
    let mut max_col: usize = 0;
    let mut cell_data: Map<String, Value> = Map::new();
    for ((r, c), obj) in cells {
        max_row = max_row.max(r as usize + 1);
        max_col = max_col.max(c as usize + 1);
        let row = cell_data
            .entry(r.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(row) = row {
            row.insert(c.to_string(), Value::Object(obj));
        }
    }
    let mut sheet_obj = json!({
        "id": sheet_id,
        "name": name,
        "rowCount": max_row.max(MIN_ROWS),
        "columnCount": max_col.max(MIN_COLS),
        "cellData": Value::Object(cell_data),
        "defaultColumnWidth": EXCEL_DEFAULT_COL_WIDTH_PX,
        "defaultRowHeight": EXCEL_DEFAULT_ROW_HEIGHT_PX,
        "mergeData": [],
    });
    match visible {
        SheetVisible::Visible => {}
        SheetVisible::Hidden => sheet_obj["_sheetState"] = json!("hidden"),
        SheetVisible::VeryHidden => sheet_obj["_sheetState"] = json!("veryHidden"),
    }
    sheet_obj
}

/// Workbook-level defined names in the xlsx import shape
/// (`{ "name", "formula" }`, no leading `=`). Built-in names (Print_Area,
/// _FilterDatabase, ...) arrive as a one-character control code and are left
/// out without counting. Names that cannot be used (unsupported or external
/// references) and case-insensitive duplicates (sheet-scoped names flattened
/// to workbook scope; the first one wins) are counted in `dropped`.
fn collect_defined_names(names: &[(String, String)], dropped: &mut usize) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (name, formula) in names {
        if name.trim().is_empty() || name.chars().any(|c| c.is_control()) {
            continue;
        }
        if formula.trim().is_empty() || is_unusable_formula(formula) {
            *dropped += 1;
            continue;
        }
        if !seen.insert(name.to_lowercase()) {
            *dropped += 1;
            continue;
        }
        out.push(json!({ "name": name, "formula": formula }));
    }
    out
}

/// Text calamine produces for formulas it could not decode, or references it
/// could not resolve. Such a formula would recalculate to something other
/// than Excel's result, so the cached value is kept instead.
fn is_unusable_formula(f: &str) -> bool {
    f.starts_with("Unrecognised formula")
        || f.contains("[PtgNameX]")
        || f.contains("{PtgArray}")
        || f.contains("Unsupported ptg")
        || f.contains("empty rgce")
        || f.contains("#REF!")
        || f.contains("'#REF'!")
}

fn legacy_warning_ole(c: &OleCounters) -> CompatibilityWarning {
    let mut message = String::from(LEGACY_BASE_MESSAGE);
    if c.formulas_as_values > 0 {
        message.push_str(&format!(
            "読み取れない数式 {} 個は計算結果の値で読み込みました。これらのセルは、元になるセルを変えても再計算されません。",
            c.formulas_as_values
        ));
    }
    if c.dropped_names > 0 {
        message.push_str(&format!(
            "定義名 {} 個は読み込めませんでした。これを使う数式は再計算で #NAME? になることがあります。",
            c.dropped_names
        ));
    }
    if c.skipped_sheets > 0 {
        message.push_str(&format!(
            "グラフシートなど {} 枚は読み込みません。",
            c.skipped_sheets
        ));
    }
    if c.has_vba {
        message.push_str(MACROS_NOT_LOADED);
    }
    CompatibilityWarning {
        severity: "warning".to_string(),
        code: XLS_LEGACY_FORMAT.to_string(),
        message,
        affected_sheets: if c.affected_sheets.is_empty() {
            None
        } else {
            Some(c.affected_sheets.clone())
        },
    }
}

fn xls_value_to_cell(v: &Data) -> Option<Value> {
    match v {
        Data::Empty => None,
        Data::Int(n) => Some(json!({ "v": n })),
        Data::Float(f) => Some(json!({ "v": f })),
        Data::String(s) => Some(json!({ "v": s })),
        Data::Bool(b) => Some(json!({ "v": b })),
        Data::Error(_) => Some(json!({ "v": Value::Null, "t": "e" })),
        Data::DateTime(dt) => {
            let (is_duration, is_1904) = classify_datetime(dt);
            let mut serial = dt.as_f64();
            // Nicel works in the 1900 date system; shift 1904-system dates so
            // they show (and save) as the same calendar day. Durations are
            // lengths of time and need no shift.
            // Known gap: a formula's cached value never carries a date format
            // in calamine, so a 1904 date produced by a formula is not shifted.
            if is_1904 && !is_duration {
                serial += DAYS_1904_TO_1900;
            }
            Some(json!({ "v": serial, "_fmt": default_date_format(serial, is_duration) }))
        }
        // The Xls reader does not produce these; keep the text if it ever does.
        Data::DateTimeIso(s) | Data::DurationIso(s) => Some(json!({ "v": s })),
    }
}

/// Returns (is_duration, is_1904). calamine only exposes these through its
/// `dates` feature, so compare against the four possible constructions
/// instead (`ExcelDateTime` derives `PartialEq`). NaN matches none and falls
/// back to a 1900-system date.
fn classify_datetime(dt: &ExcelDateTime) -> (bool, bool) {
    let v = dt.as_f64();
    if *dt == ExcelDateTime::new(v, ExcelDateTimeType::TimeDelta, false) {
        (true, false)
    } else if *dt == ExcelDateTime::new(v, ExcelDateTimeType::TimeDelta, true) {
        (true, true)
    } else if *dt == ExcelDateTime::new(v, ExcelDateTimeType::DateTime, true) {
        (false, true)
    } else {
        (false, false)
    }
}

/// .xls cells only say "date" or "duration", not which format. Pick the
/// ja-JP Excel defaults and keep seconds so no information is hidden.
fn default_date_format(serial: f64, is_duration: bool) -> &'static str {
    if is_duration {
        "[h]:mm:ss"
    } else if serial.fract() == 0.0 {
        "yyyy/m/d"
    } else if serial < 1.0 {
        "h:mm:ss"
    } else {
        "yyyy/m/d h:mm:ss"
    }
}

fn map_xls_error(e: XlsError) -> String {
    match e {
        XlsError::Password => XLS_PASSWORD_PROTECTED.to_string(),
        other => format!("{XLS_CORRUPT}: {other}"),
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

// ── ZIP path (.xls that is really xlsx) ──────────────────────────────────────

/// Removes the private temp directory on every exit, including panics.
struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `import_xlsx_core` only accepts `.xlsx` / `.xlsm` paths, so the bytes go
/// through a temporary `.xlsx` copy. The original file is not touched.
fn import_zip_disguised(bytes: &[u8]) -> Result<ImportWorkbookResult, String> {
    let dir = std::env::temp_dir().join(format!("nicel-xls-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|e| format!("{XLS_READ_FAILED}: {e}"))?;
    let guard = TempDirGuard(dir);
    let temp_path = guard.0.join("workbook.xlsx");
    std::fs::write(&temp_path, bytes).map_err(|e| format!("{XLS_READ_FAILED}: {e}"))?;
    let temp_str = temp_path.to_string_lossy().into_owned();

    let has_vba = zip_has_vba(bytes);
    let outcome = catch_unwind(AssertUnwindSafe(|| import_xlsx_core(temp_str.clone())));
    drop(guard);

    let mut result = match outcome {
        Ok(Ok(r)) => r,
        // Errors pass through unchanged so the existing xlsx messages apply;
        // only the temp path is scrubbed in case a message ever carries it.
        Ok(Err(e)) => return Err(e.replace(&temp_str, "<temp>")),
        Err(payload) => {
            log::error!(
                "xlsx parser panic (.xls path): {}",
                panic_message(payload.as_ref())
            );
            return Err(format!("{XLS_CORRUPT}: parser panic"));
        }
    };
    for w in result.warnings.iter_mut() {
        if w.message.contains(&temp_str) {
            w.message = w.message.replace(&temp_str, "<temp>");
        }
    }

    let blocked = result.warnings.iter().any(|w| w.severity == "blocking");
    if !blocked {
        let mut message = String::from(LEGACY_ZIP_MESSAGE);
        if has_vba {
            message.push_str(MACROS_NOT_LOADED);
        }
        // First, so the banner (which shows the first few) always has it.
        result.warnings.insert(
            0,
            CompatibilityWarning {
                severity: "warning".to_string(),
                code: XLS_LEGACY_FORMAT.to_string(),
                message,
                affected_sheets: None,
            },
        );
    }
    Ok(result)
}

/// True when the xlsx package carries a VBA project. The copy is saved as
/// `.xlsx`, so `import_xlsx_core` would not mention the macros on its own.
fn zip_has_vba(bytes: &[u8]) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        zip::ZipArchive::new(Cursor::new(bytes))
            .map(|mut a| {
                let found = a.by_name("xl/vbaProject.bin").is_ok();
                found
            })
            .unwrap_or(false)
    }))
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_recognizes_containers() {
        let mut ole = OLE_MAGIC.to_vec();
        ole.extend_from_slice(&[0; 8]);
        assert_eq!(sniff(&ole), Sniffed::Ole);
        assert_eq!(sniff(b"PK\x03\x04rest"), Sniffed::Zip);
    }

    #[test]
    fn sniff_names_non_excel_content() {
        assert_eq!(sniff(b""), Sniffed::NotExcel97("empty"));
        assert_eq!(
            sniff(b"<html><body><table></table></body></html>"),
            Sniffed::NotExcel97("html")
        );
        assert_eq!(
            sniff(b"\xEF\xBB\xBF  <!DOCTYPE html><html></html>"),
            Sniffed::NotExcel97("html")
        );
        assert_eq!(
            sniff(b"<table><tr><td>1</td></tr></table>"),
            Sniffed::NotExcel97("html")
        );
        assert_eq!(
            sniff(b"<?xml version=\"1.0\"?>\n<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\">"),
            Sniffed::NotExcel97("xml")
        );
        assert_eq!(
            sniff(b"<?xml version=\"1.0\"?><foo/>"),
            Sniffed::NotExcel97("html")
        );
        // "PK," is a CSV header, not a zip.
        assert_eq!(sniff(b"PK,Name\n1,a\n"), Sniffed::NotExcel97("text"));
        assert_eq!(
            sniff("名前\t値\r\nりんご\t1\r\n".as_bytes()),
            Sniffed::NotExcel97("text")
        );
        assert_eq!(
            sniff(&[0x00, 0x01, 0x02, 0xFF, 0xFE]),
            Sniffed::NotExcel97("unknown")
        );
        // UTF-16LE HTML with BOM.
        let utf16: Vec<u8> = [0xFFu8, 0xFE]
            .into_iter()
            .chain("<html>".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        assert_eq!(sniff(&utf16), Sniffed::NotExcel97("html"));
        // A multi-byte character cut by the sniff window is still text.
        let mut long = "あ".repeat(SNIFF_WINDOW).into_bytes();
        long.truncate(SNIFF_WINDOW + 1);
        assert_eq!(sniff(&long), Sniffed::NotExcel97("text"));
    }

    #[test]
    fn classify_datetime_covers_all_four_kinds() {
        use ExcelDateTimeType::{DateTime, TimeDelta};
        assert_eq!(
            classify_datetime(&ExcelDateTime::new(1.0, TimeDelta, false)),
            (true, false)
        );
        assert_eq!(
            classify_datetime(&ExcelDateTime::new(1.0, TimeDelta, true)),
            (true, true)
        );
        assert_eq!(
            classify_datetime(&ExcelDateTime::new(1.0, DateTime, true)),
            (false, true)
        );
        assert_eq!(
            classify_datetime(&ExcelDateTime::new(1.0, DateTime, false)),
            (false, false)
        );
        assert_eq!(
            classify_datetime(&ExcelDateTime::new(f64::NAN, TimeDelta, true)),
            (false, false)
        );
    }

    #[test]
    fn default_date_format_boundaries() {
        assert_eq!(default_date_format(0.0, false), "yyyy/m/d");
        assert_eq!(default_date_format(0.5, false), "h:mm:ss");
        assert_eq!(default_date_format(45306.0, false), "yyyy/m/d");
        assert_eq!(default_date_format(45306.5, false), "yyyy/m/d h:mm:ss");
        assert_eq!(default_date_format(45306.5, true), "[h]:mm:ss");
    }

    #[test]
    fn date_1904_is_shifted_but_duration_is_not() {
        use ExcelDateTimeType::{DateTime, TimeDelta};
        let d = xls_value_to_cell(&Data::DateTime(ExcelDateTime::new(43844.0, DateTime, true)))
            .unwrap();
        assert_eq!(d["v"], json!(45306.0));
        assert_eq!(d["_fmt"], json!("yyyy/m/d"));
        let t =
            xls_value_to_cell(&Data::DateTime(ExcelDateTime::new(1.5, TimeDelta, true))).unwrap();
        assert_eq!(t["v"], json!(1.5));
        assert_eq!(t["_fmt"], json!("[h]:mm:ss"));
    }

    #[test]
    fn unusable_formulas() {
        assert!(is_unusable_formula(
            "Unrecognised formula for cell (2, 10): Unrecognized { typ: \"ptg\", val: 1 }"
        ));
        assert!(is_unusable_formula("[PtgNameX]+1"));
        assert!(is_unusable_formula("SUM({PtgArray})"));
        assert!(is_unusable_formula("Unsupported ptg: 1c"));
        assert!(is_unusable_formula("empty rgce"));
        assert!(is_unusable_formula("'#REF'!A1*2"));
        assert!(is_unusable_formula("Sheet1!#REF!"));
        assert!(!is_unusable_formula("SUM(B2:B3)"));
        assert!(!is_unusable_formula("IF(B2>5,\"多い\",\"少ない\")"));
        assert!(!is_unusable_formula("'R5'!A1"));
    }

    #[test]
    fn defined_names_drop_builtins_unusable_and_duplicates() {
        let names = vec![
            ("\r".to_string(), "売上!$A$1:$C$3".to_string()),
            ("合計数量".to_string(), "売上!$B$4".to_string()),
            ("外部".to_string(), "'#REF'!$A$1".to_string()),
            ("Total".to_string(), "売上!$B$4".to_string()),
            ("TOTAL".to_string(), "集計!$A$1".to_string()),
            ("空".to_string(), "".to_string()),
        ];
        let mut dropped = 0;
        let out = collect_defined_names(&names, &mut dropped);
        assert_eq!(
            out,
            vec![
                json!({"name": "合計数量", "formula": "売上!$B$4"}),
                json!({"name": "Total", "formula": "売上!$B$4"}),
            ]
        );
        assert_eq!(dropped, 3);
    }

    #[test]
    fn finalize_forces_save_as_and_original_path() {
        let mut r = ImportWorkbookResult {
            handle: WorkbookHandle {
                workbook_id: "x".into(),
                path: Some("C:/tmp/nicel-xls-1/workbook.xlsx".into()),
                source_type: "xlsx".into(),
                snapshot_json: None,
                requires_save_as_on_first_save: false,
            },
            warnings: vec![],
        };
        finalize_xls_handle(&mut r, "C:/data/book.xls");
        assert_eq!(r.handle.path.as_deref(), Some("C:/data/book.xls"));
        assert!(r.handle.requires_save_as_on_first_save);
        assert_eq!(r.handle.source_type, "xlsx");
    }
}

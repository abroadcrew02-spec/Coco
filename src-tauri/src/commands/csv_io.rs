use chrono::Timelike;
use serde_json::{json, Map, Value};
use std::fs::File;
use std::io::{BufWriter, Write};

use crate::commands::workbook::{CompatibilityWarning, ImportWorkbookResult, WorkbookHandle};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvExportResult {
    pub success: bool,
    pub path: String,
    pub rows_written: u32,
    pub warnings: Vec<CompatibilityWarning>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub id: String,
    pub name: String,
}

fn escape_csv_field(s: &str, delimiter: char) -> String {
    if s.contains(delimiter) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        let escaped = s.replace('"', "\"\"");
        format!("\"{escaped}\"")
    } else {
        s.to_string()
    }
}

fn needs_injection_guard(s: &str) -> bool {
    matches!(s.chars().next(), Some('=') | Some('+') | Some('-') | Some('@'))
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Inverse of excel_serial_from_date: convert a date serial back to a
/// chrono::NaiveDate, handling the 1900-leap-year quirk. Returns None for
/// values outside chrono's representable range (negative or extremely large
/// serials, which shouldn't appear in real workbooks).
fn excel_serial_to_date(serial: f64) -> Option<chrono::NaiveDate> {
    // Reverse the adjustment used on import. Dates >= 1900-03-01 had +1 added
    // to skip the bogus 1900-02-29.
    let leap_bug_serial = 61.0;
    let days = if serial >= leap_bug_serial {
        serial as i64 - 1
    } else {
        serial as i64
    };
    let epoch = chrono::NaiveDate::from_ymd_opt(1899, 12, 31)?;
    epoch.checked_add_signed(chrono::Duration::days(days))
}

/// Returns true if the cell's `_fmt` looks like a date-only format we should
/// stringify as YYYY-MM-DD on export. Datetime / time-only formats aren't
/// recognized yet — those round-trip as raw serials.
fn is_date_only_format(fmt: &str) -> bool {
    let lower = fmt.to_ascii_lowercase();
    // Common date-only formats: "yyyy-mm-dd", "yyyy/mm/dd", "yyyy年m月d日".
    // Match any format that mentions year + month + day without hours.
    let has_year = lower.contains('y');
    let has_month = lower.contains('m');
    let has_day = lower.contains('d');
    let has_time = lower.contains('h') || lower.contains('s');
    has_year && has_month && has_day && !has_time
}

#[tauri::command]
pub fn list_sheet_names(snapshot_json: String) -> Result<Vec<SheetInfo>, String> {
    let root: Value = serde_json::from_str(&snapshot_json).map_err(|e| e.to_string())?;
    let sheet_order = root
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sheets = root.get("sheets");

    let mut result = Vec::with_capacity(sheet_order.len());
    for (i, id_v) in sheet_order.iter().enumerate() {
        let id = match id_v.as_str() {
            Some(s) => s.to_string(),
            None => {
                // sheetOrder entry isn't a string — synthesize a placeholder so the index
                // stays aligned with the array.
                result.push(SheetInfo {
                    id: format!("sheet-{}", i + 1),
                    name: format!("Sheet{}", i + 1),
                });
                continue;
            }
        };
        let name = sheets
            .and_then(|s| s.get(&id))
            .and_then(|sh| sh.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Sheet{}", i + 1));
        result.push(SheetInfo { id, name });
    }
    Ok(result)
}

/// CSV export encoding selection. "utf8-bom" is the default (Excel/Sheets
/// friendly). "utf8" skips the BOM. "shift_jis" encodes to Shift_JIS for legacy
/// Japanese tools — characters outside the SJIS repertoire become `?`, and a
/// warning is emitted listing how many characters were replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CsvEncoding {
    Utf8Bom,
    Utf8,
    ShiftJis,
}

impl CsvEncoding {
    fn parse(s: Option<&str>) -> Self {
        match s.unwrap_or("utf8-bom").to_ascii_lowercase().as_str() {
            "utf8" => CsvEncoding::Utf8,
            "shift_jis" | "shift-jis" | "sjis" => CsvEncoding::ShiftJis,
            _ => CsvEncoding::Utf8Bom,
        }
    }
}

#[tauri::command]
pub fn workbook_export_csv(
    path: String,
    snapshot_json: String,
    sheet_id: Option<String>,
    encoding: Option<String>,
) -> Result<CsvExportResult, String> {
    let encoding = CsvEncoding::parse(encoding.as_deref());
    let path_lower = path.to_lowercase();
    let is_tsv = path_lower.ends_with(".tsv");
    if !path_lower.ends_with(".csv") && !is_tsv {
        return Ok(CsvExportResult {
            success: false,
            path,
            rows_written: 0,
            warnings: Vec::new(),
            error: Some("CSV_INVALID_EXTENSION".into()),
        });
    }
    let field_separator = if is_tsv { "\t" } else { "," };

    let root: Value = serde_json::from_str(&snapshot_json).map_err(|e| e.to_string())?;

    let sheets = root.get("sheets");

    let resolved_sheet_id: String = match &sheet_id {
        Some(id) => id.clone(),
        None => {
            let sheet_order = root.get("sheetOrder").and_then(|v| v.as_array());
            match sheet_order.and_then(|arr| arr.first()).and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => {
                    return Ok(CsvExportResult {
                        success: false,
                        path,
                        rows_written: 0,
                        warnings: Vec::new(),
                        error: Some("CSV_EMPTY_WORKBOOK".into()),
                    });
                }
            }
        }
    };

    let sheet = match sheets.and_then(|s| s.get(&resolved_sheet_id)) {
        Some(s) => s,
        None => {
            return Ok(CsvExportResult {
                success: false,
                path,
                rows_written: 0,
                warnings: Vec::new(),
                error: Some(format!("Sheet not found: {}", resolved_sheet_id)),
            });
        }
    };

    let mut warnings: Vec<CompatibilityWarning> = Vec::new();
    let mut formula_warning_emitted = false;

    let cell_data = sheet.get("cellData").and_then(|v| v.as_object());

    let mut max_row: usize = 0;
    let mut max_col: usize = 0;
    let mut any_cell = false;

    if let Some(rows_map) = cell_data {
        for (r_key, r_val) in rows_map.iter() {
            let r = match r_key.parse::<usize>() {
                Ok(n) => n,
                Err(_) => continue,
            };
            let cols_map = match r_val.as_object() {
                Some(m) => m,
                None => continue,
            };
            for (c_key, _c_val) in cols_map.iter() {
                let c = match c_key.parse::<usize>() {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                if !any_cell {
                    max_row = r;
                    max_col = c;
                    any_cell = true;
                } else {
                    if r > max_row {
                        max_row = r;
                    }
                    if c > max_col {
                        max_col = c;
                    }
                }
            }
        }
    }

    let (n_rows, n_cols) = if any_cell { (max_row + 1, max_col + 1) } else { (0, 0) };

    let mut rows: Vec<Vec<String>> = vec![vec![String::new(); n_cols]; n_rows];

    if let Some(rows_map) = cell_data {
        for (r_key, r_val) in rows_map.iter() {
            let r = match r_key.parse::<usize>() {
                Ok(n) => n,
                Err(_) => continue,
            };
            let cols_map = match r_val.as_object() {
                Some(m) => m,
                None => continue,
            };
            for (c_key, cell) in cols_map.iter() {
                let c = match c_key.parse::<usize>() {
                    Ok(n) => n,
                    Err(_) => continue,
                };

                let v_field = cell.get("v");
                let f_field = cell.get("f").and_then(|f| f.as_str());
                let fmt_field = cell.get("_fmt").and_then(|f| f.as_str());

                let (raw, is_string_kind) = if let Some(v) = v_field {
                    match v {
                        Value::Null => (String::new(), false),
                        Value::Bool(b) => (
                            if *b { "TRUE".to_string() } else { "FALSE".to_string() },
                            false,
                        ),
                        Value::Number(n) => {
                            let serial = n.as_f64();
                            // Format-aware rendering for known _fmt families
                            // so import → export preserves the cell's meaning.
                            // Checked in specificity order: datetime > date >
                            // percent > plain numeric.
                            let s = if let (Some(f), Some(fmt)) = (serial, fmt_field) {
                                if is_text_format(fmt) {
                                    // "@" text format: emit the number verbatim
                                    // (no thousands separators, no formatting).
                                    format_number(f)
                                } else if is_datetime_format(fmt) {
                                    match excel_serial_to_datetime(f) {
                                        Some(dt) => format_date_or_datetime(dt, fmt, true),
                                        None => format_number(f),
                                    }
                                } else if is_date_only_format(fmt) {
                                    match excel_serial_to_date(f) {
                                        Some(d) => format_date_or_datetime(
                                            d.and_hms_opt(0, 0, 0).unwrap(),
                                            fmt,
                                            false,
                                        ),
                                        None => format_number(f),
                                    }
                                } else if is_time_only_format(fmt) {
                                    format_time(f)
                                } else if is_percent_format(fmt) {
                                    format_percent(f, fmt)
                                } else if is_currency_format(fmt) {
                                    format_currency(f, fmt)
                                } else {
                                    format_number(f)
                                }
                            } else if let Some(f) = serial {
                                format_number(f)
                            } else {
                                n.to_string()
                            };
                            (s, false)
                        }
                        Value::String(s) => (s.clone(), true),
                        other => (other.to_string(), false),
                    }
                } else if let Some(f) = f_field {
                    if !formula_warning_emitted {
                        warnings.push(CompatibilityWarning {
                            severity: "info".to_string(),
                            code: "CSV_FORMULA_FALLBACK".to_string(),
                            message:
                                "Some formula cells lack cached values; formula text exported instead"
                                    .to_string(),
                            affected_sheets: None,
                        });
                        formula_warning_emitted = true;
                    }
                    (f.to_string(), true)
                } else {
                    (String::new(), false)
                };

                let guarded = if is_string_kind && needs_injection_guard(&raw) {
                    format!("'{}", raw)
                } else {
                    raw
                };

                if r < rows.len() && c < rows[r].len() {
                    rows[r][c] = guarded;
                }
            }
        }
    }

    let file = File::create(&path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(file);

    if encoding == CsvEncoding::Utf8Bom {
        writer.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
    }

    // Build the entire CSV body as UTF-8 first, then transcode to the chosen
    // encoding on write. Keeps the escaping/newline logic in one place.
    let delim_char = field_separator.chars().next().unwrap_or(',');
    let mut body = String::new();
    for row in rows.iter() {
        let line: Vec<String> = row.iter().map(|s| escape_csv_field(s, delim_char)).collect();
        body.push_str(&line.join(field_separator));
        body.push_str("\r\n");
    }

    match encoding {
        CsvEncoding::Utf8 | CsvEncoding::Utf8Bom => {
            writer.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        }
        CsvEncoding::ShiftJis => {
            // encoding_rs replaces un-encodable chars with the encoder's
            // fallback (usually "?"). had_errors == true tells us at least
            // one char was lossy.
            let (encoded, _enc, had_errors) = encoding_rs::SHIFT_JIS.encode(&body);
            writer.write_all(&encoded).map_err(|e| e.to_string())?;
            if had_errors {
                warnings.push(CompatibilityWarning {
                    severity: "warning".to_string(),
                    code: "CSV_SJIS_LOSSY".to_string(),
                    message:
                        "Shift_JIS で表現できない文字が含まれていたため、一部が置換されました（通常 ? 等）。データ保全のためには UTF-8 BOM を推奨します。"
                            .to_string(),
                    affected_sheets: None,
                });
            }
        }
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(CsvExportResult {
        success: true,
        path,
        rows_written: rows.len() as u32,
        warnings,
        error: None,
    })
}

const CSV_MIN_ROWS: usize = 1000;
const CSV_MIN_COLS: usize = 100;
const CSV_MAX_CELLS: usize = 5_000_000;

/// Convert a calendar date to Excel's serial-date number system. Excel
/// historically treats 1900 as a leap year (it isn't), so dates on or after
/// 1900-03-01 need a +1 adjustment. This matches the format produced by
/// xlsx_io's calamine Data::DateTime branch, so round-tripping through CSV
/// and xlsx stays consistent.
fn excel_serial_from_date(date: chrono::NaiveDate) -> f64 {
    let epoch = chrono::NaiveDate::from_ymd_opt(1899, 12, 31).unwrap();
    let days = (date - epoch).num_days();
    let leap_bug_threshold = chrono::NaiveDate::from_ymd_opt(1900, 3, 1).unwrap();
    let adjusted = if date >= leap_bug_threshold { days + 1 } else { days };
    adjusted as f64
}

/// Best-effort parse of a CSV cell string as a calendar date. Accepts only
/// unambiguous formats:
///   - YYYY-MM-DD (ISO 8601)
///   - YYYY/MM/DD (common in Japanese CSVs)
/// Region-dependent formats like MM/DD/YYYY or DD/MM/YYYY are NOT recognized
/// — too risky to guess. Validates the date so 2026-02-30 etc. fall through.
fn parse_csv_date(s: &str) -> Option<chrono::NaiveDate> {
    for fmt in &["%Y-%m-%d", "%Y/%m/%d"] {
        if let Ok(d) = chrono::NaiveDate::parse_from_str(s, fmt) {
            return Some(d);
        }
    }
    None
}

/// Same idea as parse_csv_date but for datetime strings:
///   - YYYY-MM-DDTHH:MM:SS (ISO 8601)
///   - YYYY-MM-DD HH:MM:SS (ISO with space separator)
///   - YYYY/MM/DD HH:MM:SS (Japanese-style)
/// Sub-second precision is not preserved (Excel serials only carry seconds).
fn parse_csv_datetime(s: &str) -> Option<chrono::NaiveDateTime> {
    for fmt in &[
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
    ] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Some(dt);
        }
    }
    None
}

/// Convert a NaiveDateTime to Excel's fractional-day serial. Time portion is
/// hours/86400 + minutes/1440 + seconds/86400.
fn excel_serial_from_datetime(dt: chrono::NaiveDateTime) -> f64 {
    let date_serial = excel_serial_from_date(dt.date());
    let time = dt.time();
    let seconds = time.hour() as i64 * 3600 + time.minute() as i64 * 60 + time.second() as i64;
    date_serial + (seconds as f64) / 86400.0
}

/// Inverse of excel_serial_from_datetime. Returns None for serials outside
/// chrono's range.
fn excel_serial_to_datetime(serial: f64) -> Option<chrono::NaiveDateTime> {
    let whole_days = serial.floor();
    let fractional = serial - whole_days;
    let date = excel_serial_to_date(whole_days)?;
    // Round to nearest second to avoid drift from floating-point error.
    let total_seconds = (fractional * 86400.0).round() as i64;
    let hours = (total_seconds / 3600) as u32;
    let minutes = ((total_seconds % 3600) / 60) as u32;
    let seconds = (total_seconds % 60) as u32;
    let time = chrono::NaiveTime::from_hms_opt(hours, minutes, seconds)?;
    Some(date.and_time(time))
}

/// Returns true if the cell's `_fmt` includes hours — used to distinguish
/// datetime from date-only formats on export.
fn is_datetime_format(fmt: &str) -> bool {
    let lower = fmt.to_ascii_lowercase();
    lower.contains('y')
        && lower.contains('m')
        && lower.contains('d')
        && lower.contains('h')
}

/// Parses a time-only string into the Excel fractional-day representation:
/// 00:00 → 0.0, 12:00 → 0.5, 23:59:59 → ~0.999988. Accepts HH:MM and
/// HH:MM:SS (24-hour clock). Rejects 24+ hour values to avoid being too
/// liberal on duration-shaped strings.
fn parse_csv_time(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let sec: u32 = if parts.len() == 3 { parts[2].parse().ok()? } else { 0 };
    if h >= 24 || m >= 60 || sec >= 60 {
        return None;
    }
    let total = h * 3600 + m * 60 + sec;
    Some(total as f64 / 86400.0)
}

/// Returns true if the cell's `_fmt` is a time-only format (h/m, no y/d).
fn is_time_only_format(fmt: &str) -> bool {
    let lower = fmt.to_ascii_lowercase();
    let has_hour = lower.contains('h');
    let has_year = lower.contains('y');
    let has_day = lower.contains('d');
    has_hour && !has_year && !has_day
}

/// Render a time-fractional value (0.0..1.0) as HH:MM:SS, rounding to whole
/// seconds. Values outside the range are clamped via wrap (modulo 1) since
/// Excel time semantics treat the integer part as days.
fn format_time(value: f64) -> String {
    let frac = value - value.floor();
    let total_seconds = (frac * 86400.0).round() as i64;
    let h = (total_seconds / 3600) % 24;
    let m = (total_seconds % 3600) / 60;
    let s = total_seconds % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

/// Parses a percentage string like "50%" or "-3.5%" → (0.5, fmt).
/// Returns None for malformed input (multiple %, embedded spaces, etc.).
fn parse_csv_percent(s: &str) -> Option<(f64, &'static str)> {
    let trimmed = s.trim();
    let rest = trimmed.strip_suffix('%')?;
    // No second % allowed.
    if rest.contains('%') {
        return None;
    }
    let n: f64 = rest.parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    // Choose 0% vs 0.00% based on whether the source had a decimal point.
    let fmt = if rest.contains('.') { "0.00%" } else { "0%" };
    Some((n / 100.0, fmt))
}

/// Returns true if the cell's `_fmt` is a percent format ("0%", "0.00%", ...).
fn is_percent_format(fmt: &str) -> bool {
    fmt.contains('%')
}

/// Render an Excel-style percent value back as a CSV-friendly string.
/// Preserves the precision implied by the format string: "0%" rounds to int,
/// "0.00%" keeps two decimals.
fn format_percent(value: f64, fmt: &str) -> String {
    let pct = value * 100.0;
    let lower = fmt.to_ascii_lowercase();
    // Count fractional zeroes in patterns like "0.00%". Cap at 6 to avoid
    // pathological format strings.
    let mut decimals = 0usize;
    if let Some(dot_idx) = lower.find('.') {
        for c in lower[dot_idx + 1..].chars() {
            if c == '0' {
                decimals += 1;
                if decimals >= 6 {
                    break;
                }
            } else {
                break;
            }
        }
    }
    if decimals == 0 {
        format!("{}%", pct.round() as i64)
    } else {
        format!("{:.*}%", decimals, pct)
    }
}

/// Returns true if the cell's `_fmt` is the literal Excel text-format code
/// `@`. Text-formatted numeric cells are emitted verbatim (no thousands
/// separators, no special date interpretation).
fn is_text_format(fmt: &str) -> bool {
    fmt.trim() == "@"
}

/// Returns true if the cell's `_fmt` looks like a currency format. Heuristic:
/// any pattern containing `$`, `¥`, `€`, `£` outside of a literal-quote.
/// Doesn't validate the full Excel format-code grammar — that's a TODO.
fn is_currency_format(fmt: &str) -> bool {
    // Allow leading `[$X-409]` etc. — common in Excel locale-tagged currency.
    fmt.contains('$') || fmt.contains('¥') || fmt.contains('€') || fmt.contains('£')
}

/// Render `value` as a currency string using the given `fmt` code. Supports
/// the common patterns: "$#,##0.00", "$#,##0", "¥#,##0", "[$$-409]#,##0.00".
/// Falls back to plain numeric formatting if the format is unrecognized.
fn format_currency(value: f64, fmt: &str) -> String {
    // Extract symbol: first non-digit, non-#, non-comma, non-period, non-bracket char.
    let symbol = pick_currency_symbol(fmt).unwrap_or('$');
    // Decimal count: zeros after the `.` in the format string, capped at 6.
    let mut decimals = 0usize;
    if let Some(dot_idx) = fmt.find('.') {
        for c in fmt[dot_idx + 1..].chars() {
            if c == '0' {
                decimals += 1;
                if decimals >= 6 {
                    break;
                }
            } else {
                break;
            }
        }
    }
    let uses_thousands = fmt.contains("#,##");
    let abs_value = value.abs();
    let formatted = if uses_thousands {
        format_thousands(abs_value, decimals)
    } else if decimals == 0 {
        format!("{}", abs_value.round() as i64)
    } else {
        format!("{:.*}", decimals, abs_value)
    };
    let sign = if value < 0.0 { "-" } else { "" };
    format!("{}{}{}", sign, symbol, formatted)
}

/// First currency-looking glyph in the format string. Handles bare symbols
/// and the `[$SYMBOL-LOCALE]` form. Returns None if none found.
fn pick_currency_symbol(fmt: &str) -> Option<char> {
    // Look for [$...-...] first.
    if let Some(start) = fmt.find("[$") {
        let rest = &fmt[start + 2..];
        if let Some(end) = rest.find('-').or_else(|| rest.find(']')) {
            for c in rest[..end].chars() {
                if !c.is_ascii_alphanumeric() {
                    return Some(c);
                }
            }
            // Fallback to first char in the bracket if no special glyph.
            if let Some(c) = rest[..end].chars().next() {
                return Some(c);
            }
        }
    }
    for c in fmt.chars() {
        if matches!(c, '$' | '¥' | '€' | '£') {
            return Some(c);
        }
    }
    None
}

/// Format a positive value with thousands separators and the given decimals.
fn format_thousands(value: f64, decimals: usize) -> String {
    let raw = if decimals == 0 {
        format!("{}", value.round() as i64)
    } else {
        format!("{:.*}", decimals, value)
    };
    let (int_part, frac_part) = match raw.find('.') {
        Some(i) => (&raw[..i], Some(&raw[i + 1..])),
        None => (raw.as_str(), None),
    };
    let mut grouped = String::new();
    for (i, c) in int_part.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let int_grouped: String = grouped.chars().rev().collect();
    match frac_part {
        Some(f) => format!("{}.{}", int_grouped, f),
        None => int_grouped,
    }
}

/// Render a date / datetime using the format code's literal-by-literal
/// substitution of `yyyy/yy/mm/m/dd/d/hh/h/mm/m/ss/s`. Falls back to
/// ISO 8601 if the format code doesn't yield any token replacements.
/// `is_datetime` controls whether time tokens are emitted; when false we
/// stop after the date portion so a pure date format stays date-only.
fn format_date_or_datetime(
    dt: chrono::NaiveDateTime,
    fmt: &str,
    is_datetime: bool,
) -> String {
    use chrono::{Datelike, Timelike};
    let lower = fmt.to_ascii_lowercase();
    // Tokens are matched longest-first to avoid `m` swallowing `mm` etc.
    // Months can collide with minutes — in Excel the disambiguator is
    // adjacency to `h` / `s`. We approximate: after an `h` or `:` token,
    // `mm` / `m` mean minutes; otherwise they mean months.
    let mut out = String::with_capacity(fmt.len());
    let bytes = lower.as_bytes();
    let mut i = 0;
    let mut after_hour = false;
    while i < bytes.len() {
        let rest = &bytes[i..];
        let starts = |s: &[u8]| rest.starts_with(s);
        if starts(b"yyyy") {
            out.push_str(&format!("{:04}", dt.year()));
            i += 4;
        } else if starts(b"yy") {
            out.push_str(&format!("{:02}", dt.year() % 100));
            i += 2;
        } else if is_datetime && starts(b"hh") {
            out.push_str(&format!("{:02}", dt.hour()));
            i += 2;
            after_hour = true;
        } else if is_datetime && starts(b"h") {
            out.push_str(&format!("{}", dt.hour()));
            i += 1;
            after_hour = true;
        } else if is_datetime && starts(b"ss") {
            out.push_str(&format!("{:02}", dt.second()));
            i += 2;
        } else if is_datetime && starts(b"s") {
            out.push_str(&format!("{}", dt.second()));
            i += 1;
        } else if starts(b"mm") {
            if after_hour {
                out.push_str(&format!("{:02}", dt.minute()));
            } else {
                out.push_str(&format!("{:02}", dt.month()));
            }
            i += 2;
        } else if starts(b"m") {
            if after_hour {
                out.push_str(&format!("{}", dt.minute()));
            } else {
                out.push_str(&format!("{}", dt.month()));
            }
            i += 1;
        } else if starts(b"dd") {
            out.push_str(&format!("{:02}", dt.day()));
            i += 2;
        } else if starts(b"d") {
            out.push_str(&format!("{}", dt.day()));
            i += 1;
        } else {
            // Pass-through for separators (- / : space etc.) and any other
            // literal characters. Use the original-case byte from `fmt` so
            // that we don't lower-case user separators (rare but possible).
            let ch = fmt.as_bytes()[i] as char;
            out.push(ch);
            i += 1;
        }
    }
    // If we couldn't match any tokens (out == fmt verbatim, no digits added),
    // fall back to ISO so the cell is still meaningful.
    if !out.chars().any(|c| c.is_ascii_digit()) {
        if is_datetime {
            return dt.format("%Y-%m-%d %H:%M:%S").to_string();
        }
        return dt.format("%Y-%m-%d").to_string();
    }
    out
}

fn infer_csv_cell(raw: &str) -> Option<Value> {
    if raw.is_empty() {
        return None;
    }

    // CSV injection guard reversal: "'=foo" / "'+foo" / "'-foo" / "'@foo" -> strip leading '
    let unescaped: String =
        if let Some(rest) = raw.strip_prefix('\'') {
            if matches!(rest.chars().next(), Some('=') | Some('+') | Some('-') | Some('@')) {
                rest.to_string()
            } else {
                raw.to_string()
            }
        } else {
            raw.to_string()
        };

    // Preserve leading-zero strings as strings rather than parsing as ints:
    // account numbers, postal codes, phone numbers like "0001234" lose
    // meaning if "0001234" becomes 1234. Skip only when the value is a clear
    // decimal ("0.5") or scientific ("0e10").
    let looks_like_id_with_leading_zero = unescaped.len() > 1
        && unescaped.starts_with('0')
        && !unescaped.starts_with("0.")
        && !unescaped.starts_with("0e")
        && !unescaped.starts_with("0E");
    if !looks_like_id_with_leading_zero {
        if let Ok(n) = unescaped.parse::<i64>() {
            return Some(json!({ "v": n }));
        }
        if let Ok(f) = unescaped.parse::<f64>() {
            if f.is_finite() {
                return Some(json!({ "v": f }));
            }
        }
    }
    // Percent strings — "50%" → 0.5 stored with a percent _fmt so that
    // export round-trips back to "50%" and Excel/Univer treat it as a real
    // percentage (multiplied by 100 for display, halves arithmetically).
    if let Some((value, fmt)) = parse_csv_percent(&unescaped) {
        return Some(json!({ "v": value, "_fmt": fmt }));
    }
    // Datetime is more specific than date — try it first to capture the
    // time portion. Strict parsing (full-string match) means a date-only
    // string won't accidentally hit this branch.
    if let Some(dt) = parse_csv_datetime(&unescaped) {
        return Some(json!({
            "v": excel_serial_from_datetime(dt),
            "_fmt": "yyyy-mm-dd hh:mm:ss",
        }));
    }
    // Date detection before boolean / string fallthrough so YYYY-MM-DD doesn't
    // get stuck as a plain string. Matches xlsx_io's DateTime cell shape so
    // Univer treats it as a real date for arithmetic + formula purposes.
    if let Some(date) = parse_csv_date(&unescaped) {
        return Some(json!({ "v": excel_serial_from_date(date), "_fmt": "yyyy-mm-dd" }));
    }
    // Time-only strings (HH:MM or HH:MM:SS) become fractional-day values.
    // Excel stores time as the fraction of a day; "12:00" → 0.5.
    if let Some(t) = parse_csv_time(&unescaped) {
        return Some(json!({ "v": t, "_fmt": "hh:mm:ss" }));
    }
    let lower = unescaped.to_ascii_lowercase();
    if lower == "true" {
        return Some(json!({ "v": true }));
    }
    if lower == "false" {
        return Some(json!({ "v": false }));
    }
    Some(json!({ "v": unescaped }))
}

/// Detect the CSV file's encoding. Returns (decoded_text, encoding_name).
/// Strategy (auto):
///   1. UTF-8 BOM → UTF-8 (BOM stripped).
///   2. Valid UTF-8 from raw bytes → UTF-8.
///   3. Else try Shift_JIS (very common for Japanese business CSVs).
///   4. Else decode as UTF-8 with replacement chars (lossy).
///
/// When `override_enc` is Some, skip detection and force the given encoding:
///   - "utf8" / "utf-8" → UTF-8 (BOM stripped if present)
///   - "shift_jis" / "shift-jis" / "sjis" → Shift_JIS (lossy if not valid)
fn detect_and_decode(bytes: &[u8], override_enc: Option<&str>) -> (String, &'static str) {
    if let Some(raw) = override_enc {
        let normalized = raw.to_ascii_lowercase();
        match normalized.as_str() {
            "utf8" | "utf-8" => {
                let body = if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
                    &bytes[3..]
                } else {
                    bytes
                };
                return (
                    String::from_utf8_lossy(body).into_owned(),
                    "UTF-8 (forced)",
                );
            }
            "shift_jis" | "shift-jis" | "sjis" => {
                let (cow, _enc, _) = encoding_rs::SHIFT_JIS.decode(bytes);
                return (cow.into_owned(), "Shift_JIS (forced)");
            }
            _ => {
                // Unknown override — fall through to auto-detect.
            }
        }
    }
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        if let Ok(s) = std::str::from_utf8(&bytes[3..]) {
            return (s.to_string(), "UTF-8 (BOM)");
        }
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "UTF-8");
    }
    // Try Shift_JIS — if the result has zero replacement chars, accept it.
    let (cow, _enc, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if !had_errors {
        return (cow.into_owned(), "Shift_JIS");
    }
    // Fallback: UTF-8 lossy. Replacement chars will appear as U+FFFD.
    (
        String::from_utf8_lossy(bytes).into_owned(),
        "UTF-8 (lossy fallback)",
    )
}

/// Pick the field delimiter from the file's extension and a quick scan of the
/// first non-empty line. `.tsv` always means tab; `.csv` defaults to comma
/// but will switch to tab if the first non-empty line has noticeably more
/// tabs than commas (common when users mislabel exports).
fn infer_delimiter(path_lower: &str, text: &str) -> u8 {
    if path_lower.ends_with(".tsv") {
        return b'\t';
    }
    let first_line = text.lines().find(|l| !l.is_empty()).unwrap_or("");
    let commas = first_line.matches(',').count();
    let tabs = first_line.matches('\t').count();
    // Tabs win only when they're a clear majority — otherwise stick with the
    // CSV-standard comma so legit comma data isn't reinterpreted.
    if tabs > commas && tabs >= 2 {
        b'\t'
    } else {
        b','
    }
}

/// Pure-Rust CSV import. `encoding_override` is None for auto-detect.
/// Accepts `.csv` and `.tsv` extensions; the delimiter is inferred from the
/// extension first, then from the content as a fallback.
pub fn import_csv_core(path: String, encoding_override: Option<String>) -> Result<ImportWorkbookResult, String> {
    let lower = path.to_lowercase();
    if !lower.ends_with(".csv") && !lower.ends_with(".tsv") {
        return Err("CSV_INVALID_EXTENSION".into());
    }

    let workbook_id = uuid::Uuid::new_v4().to_string();

    // Read the whole file (CSV size capped at ~5M cells later anyway).
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    let (text, encoding_name) = detect_and_decode(&raw, encoding_override.as_deref());

    let delimiter = infer_delimiter(&lower, &text);
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes());

    let mut cell_data: Map<String, Value> = Map::new();
    let mut max_row: usize = 0;
    let mut max_col: usize = 0;
    let mut any_cell = false;
    let mut total_cells: usize = 0;

    for (row_idx, record_result) in rdr.records().enumerate() {
        let record = record_result.map_err(|e| e.to_string())?;
        let mut row_map: Map<String, Value> = Map::new();
        for (col_idx, field) in record.iter().enumerate() {
            let cell = match infer_csv_cell(field) {
                Some(c) => c,
                None => continue,
            };
            row_map.insert(col_idx.to_string(), cell);
            total_cells += 1;
            if !any_cell {
                max_row = row_idx;
                max_col = col_idx;
                any_cell = true;
            } else {
                if row_idx > max_row {
                    max_row = row_idx;
                }
                if col_idx > max_col {
                    max_col = col_idx;
                }
            }
            if total_cells > CSV_MAX_CELLS {
                return Err("CSV_TOO_LARGE: more than 5M cells".into());
            }
        }
        if !row_map.is_empty() {
            cell_data.insert(row_idx.to_string(), Value::Object(row_map));
        }
    }

    let (used_rows, used_cols) = if any_cell {
        (max_row + 1, max_col + 1)
    } else {
        (0, 0)
    };
    let row_count = used_rows.max(CSV_MIN_ROWS);
    let col_count = used_cols.max(CSV_MIN_COLS);

    let sheet_name = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Sheet1")
        .to_string();

    let sheet_obj = json!({
        "id": "sheet-1",
        "name": sheet_name,
        "rowCount": row_count,
        "columnCount": col_count,
        "cellData": Value::Object(cell_data),
    });

    let mut sheets_map: Map<String, Value> = Map::new();
    sheets_map.insert("sheet-1".to_string(), sheet_obj);

    let snapshot = json!({
        "id": workbook_id,
        "name": "Imported CSV",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": {},
        "sheetOrder": ["sheet-1"],
        "sheets": Value::Object(sheets_map),
    });

    let snapshot_json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

    let mut warnings = vec![CompatibilityWarning {
        severity: "info".to_string(),
        code: "CSV_POC_IMPORT".to_string(),
        message:
            "CSV PoC インポート: 全セルを文字列/数値/真偽値のヒューリスティクスで判定しています。書式や型注釈は保存されません。"
                .to_string(),
        affected_sheets: None,
    }];

    // Warn when the imported workbook is approaching the 5M cell cap so the
    // user knows the file is large and might bump into the hard limit on a
    // future edit. 80% threshold = 4M cells.
    let near_cap_threshold = CSV_MAX_CELLS * 4 / 5;
    if total_cells > near_cap_threshold {
        let percent = (total_cells * 100) / CSV_MAX_CELLS;
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "CSV_NEAR_CAP".to_string(),
            message: format!(
                "セル数が上限の {}% ({}/{} セル) に達しています。これ以上行を増やすと上限超過でインポートが失敗します。",
                percent, total_cells, CSV_MAX_CELLS
            ),
            affected_sheets: None,
        });
    }

    // Surface the detected encoding so the user knows what we did. Promote to
    // "warning" severity for non-UTF-8 paths so it's not just a passing note.
    let enc_severity = if encoding_name.starts_with("UTF-8") && !encoding_name.contains("lossy") {
        "info"
    } else {
        "warning"
    };
    warnings.push(CompatibilityWarning {
        severity: enc_severity.to_string(),
        code: "CSV_ENCODING_DETECTED".to_string(),
        message: format!("文字コード判定: {}", encoding_name),
        affected_sheets: None,
    });

    Ok(ImportWorkbookResult {
        handle: WorkbookHandle {
            workbook_id,
            path: Some(path),
            source_type: "csv".to_string(),
            snapshot_json: Some(snapshot_json),
        },
        warnings,
    })
}

/// Tauri command wrapper that records the file in recent_files.
#[tauri::command]
pub fn workbook_import_csv(
    app: tauri::AppHandle,
    path: String,
    encoding: Option<String>,
) -> Result<ImportWorkbookResult, String> {
    let result = import_csv_core(path.clone(), encoding)?;
    let recent_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path)
        .to_string();
    if let Ok(app_conn) = crate::db::app_db::open_app_db(&app) {
        let _ = crate::db::operations::record_recent_file(&app_conn, &path, &recent_name);
    }
    Ok(result)
}

use std::fs::File;
use std::io::Read;
use zip::ZipArchive;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanResult {
    pub safe: bool,
    pub blocked: bool,
    pub warnings: Vec<String>,
    pub issues: Vec<String>,
}

const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED: u64 = 300 * 1024 * 1024;
const MAX_ENTRY_COUNT: usize = 2_000;
const MAX_XML_ENTRY_SIZE: u64 = 50 * 1024 * 1024;
const SHEET_WARN_THRESHOLD: usize = 100;
const SHEET_BLOCK_THRESHOLD: usize = 200;

/// §5.3.2 row/column/formula caps.
///
/// Per requirements.md §5.3.2:
/// - 行数: 1シート100万行を超える場合は拒否 → ROW_LIMIT = 1,000,000
/// - 列数: 16,384列を超える場合は拒否 → COL_LIMIT = 16,384 (XFD)
/// - 数式数: 100万を超える場合は警告 → FORMULA_WARN_THRESHOLD = 1,000,000
pub const ROW_LIMIT: u64 = 1_000_000;
pub const COL_LIMIT: u64 = 16_384;
pub const FORMULA_WARN_THRESHOLD: u64 = 1_000_000;

/// Mirrors the existing chunked-scanner cap in xlsx_io::worksheet_contains_marker
/// so a 500 MB worksheet can't OOM the security pass either.
const WORKSHEET_SCAN_CAP_BYTES: u64 = 16 * 1024 * 1024;
const WORKSHEET_SCAN_CHUNK: usize = 65_536;
/// Trailing overlap kept between chunks so a tag straddling the 64 KiB boundary
/// is still detected. Must exceed the longest token we look for; a `<dimension`
/// element with a ref like `A1:XFD1048576` fits comfortably under 64 bytes.
const WORKSHEET_SCAN_OVERLAP: usize = 64;

fn bytes_to_mb(n: u64) -> u64 {
    n / (1024 * 1024)
}

#[tauri::command]
pub fn security_scan_xlsx(path: String) -> Result<SecurityScanResult, String> {
    let mut warnings: Vec<String> = Vec::new();
    let mut issues: Vec<String> = Vec::new();

    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let file_size = metadata.len();
    if file_size > MAX_FILE_SIZE {
        // Hard-block: don't try to ZIP-parse a file we've already rejected by size.
        // Otherwise a hostile actor's 51 MB blob of random bytes would surface as a
        // confusing "Invalid xlsx (zip)" error instead of the intended size verdict.
        issues.push(format!(
            "Input file size {} MB exceeds the {} MB limit",
            bytes_to_mb(file_size),
            bytes_to_mb(MAX_FILE_SIZE)
        ));
        return Ok(SecurityScanResult {
            safe: false,
            blocked: true,
            warnings: Vec::new(),
            issues,
        });
    }

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;

    let entry_count = archive.len();
    if entry_count > MAX_ENTRY_COUNT {
        issues.push(format!(
            "ZIP entry count {} exceeds the {} limit",
            entry_count, MAX_ENTRY_COUNT
        ));
    }

    let mut total_uncompressed: u64 = 0;
    let mut largest_xml: u64 = 0;
    let mut largest_xml_name = String::new();
    let mut sheet_count: usize = 0;
    let mut worksheet_indices: Vec<usize> = Vec::new();

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let size = entry.size();
        total_uncompressed = total_uncompressed.saturating_add(size);

        let is_xml = name.ends_with(".xml") || name.ends_with(".rels");
        if is_xml && size > largest_xml {
            largest_xml = size;
            largest_xml_name = name.clone();
        }

        if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            sheet_count += 1;
            worksheet_indices.push(i);
        }
    }

    if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
        issues.push(format!(
            "Total uncompressed size {} MB exceeds the {} MB limit",
            bytes_to_mb(total_uncompressed),
            bytes_to_mb(MAX_TOTAL_UNCOMPRESSED)
        ));
    }

    if largest_xml > MAX_XML_ENTRY_SIZE {
        issues.push(format!(
            "Largest XML entry '{}' size {} MB exceeds the {} MB limit",
            largest_xml_name,
            bytes_to_mb(largest_xml),
            bytes_to_mb(MAX_XML_ENTRY_SIZE)
        ));
    }

    if sheet_count > SHEET_BLOCK_THRESHOLD {
        issues.push(format!(
            "Sheet count {} exceeds the {} hard limit",
            sheet_count, SHEET_BLOCK_THRESHOLD
        ));
    } else if sheet_count > SHEET_WARN_THRESHOLD {
        warnings.push(format!(
            "Sheet count {} exceeds the soft limit of {} (importable with confirmation)",
            sheet_count, SHEET_WARN_THRESHOLD
        ));
    }

    // §5.3.2 row / column / formula caps. Per-sheet streaming scan capped at
    // WORKSHEET_SCAN_CAP_BYTES so a 500 MB worksheet body can't OOM the pass.
    let mut total_formulas: u64 = 0;
    for idx in worksheet_indices {
        let stats = match scan_worksheet_dimensions(&mut archive, idx) {
            Ok(s) => s,
            // Read errors during the scan are non-fatal: we already accept that
            // the cap may truncate the read, and downstream import will surface
            // any real parse errors. Skip the sheet and continue.
            Err(_) => continue,
        };

        if stats.max_row > ROW_LIMIT {
            issues.push(format!(
                "Sheet '{}' row count {} exceeds the {} row limit (XLSX_ROW_LIMIT)",
                stats.sheet_name, stats.max_row, ROW_LIMIT
            ));
        }
        if stats.max_col > COL_LIMIT {
            issues.push(format!(
                "Sheet '{}' column count {} exceeds the {} column limit (XLSX_COL_LIMIT)",
                stats.sheet_name, stats.max_col, COL_LIMIT
            ));
        }
        total_formulas = total_formulas.saturating_add(stats.formula_count);
    }

    if total_formulas > FORMULA_WARN_THRESHOLD {
        warnings.push(format!(
            "Formula count {} exceeds the {} soft threshold (XLSX_FORMULA_HEAVY) — load may degrade",
            total_formulas, FORMULA_WARN_THRESHOLD
        ));
    }

    let blocked = !issues.is_empty();
    let safe = !blocked && warnings.is_empty();
    Ok(SecurityScanResult {
        safe,
        blocked,
        warnings,
        issues,
    })
}

#[derive(Default)]
struct SheetStats {
    sheet_name: String,
    /// Largest row index observed (1-based). Pulled from `<dimension ref=…/>` if
    /// present, otherwise from streaming `<row r="N">` tags.
    max_row: u64,
    /// Largest column index observed (1-based, A=1, XFD=16384). Same preference
    /// for `<dimension>`, fallback to scanning `<c r="…">` refs.
    max_col: u64,
    /// Count of `<f>` formula elements. Matches `<f>` and `<f …>` but rejects
    /// other tags starting with `f` (`<filter`, `<fill`, `<font>` etc.).
    formula_count: u64,
}

/// Stream a worksheet XML body in 64 KiB chunks and derive (max_row, max_col,
/// formula_count) without slurping the whole decompressed sheet into memory.
///
/// Preference order for dimensions:
/// 1. `<dimension ref="A1:XFD1048576"/>` — authoritative and cheap. Most
///    legitimate xlsx writers emit this near the top of the sheet body so we
///    usually hit it inside the first 64 KiB.
/// 2. Streaming `<row r="N">` and `<c r="XX">` scans as a fallback, which still
///    works on hand-crafted files that omit `<dimension>`.
///
/// The 16 MiB cap is intentional: if a malicious file pads past it without ever
/// emitting `<dimension>` we may under-count, but the per-XML 50 MiB cap and
/// total-uncompressed 300 MiB cap have already filtered the worst cases.
fn scan_worksheet_dimensions<R: std::io::Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
) -> Result<SheetStats, String> {
    let mut entry = archive.by_index(idx).map_err(|e| e.to_string())?;
    let sheet_name = entry.name().to_string();

    let mut stats = SheetStats {
        sheet_name,
        ..SheetStats::default()
    };
    let mut buf = [0u8; WORKSHEET_SCAN_CHUNK];
    let mut overlap: Vec<u8> = Vec::with_capacity(WORKSHEET_SCAN_OVERLAP);
    let mut total_read: u64 = 0;
    let mut dimension_found = false;

    loop {
        let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total_read = total_read.saturating_add(n as u64);

        let mut window: Vec<u8> = Vec::with_capacity(overlap.len() + n);
        window.extend_from_slice(&overlap);
        window.extend_from_slice(&buf[..n]);

        // Authoritative dimension lookup: parse once, then stop scanning for it.
        if !dimension_found {
            if let Some((r, c)) = parse_dimension(&window) {
                stats.max_row = stats.max_row.max(r);
                stats.max_col = stats.max_col.max(c);
                dimension_found = true;
            }
        }

        // Even when `<dimension>` is present we still count `<f>` for the
        // formula-warn threshold. Row / col streaming fallback only kicks in
        // when no dimension was seen.
        stats.formula_count = stats
            .formula_count
            .saturating_add(count_formula_tags(&window) as u64);

        if !dimension_found {
            let (r, c) = scan_row_col_refs(&window);
            stats.max_row = stats.max_row.max(r);
            stats.max_col = stats.max_col.max(c);
        }

        let keep = window.len().min(WORKSHEET_SCAN_OVERLAP);
        overlap.clear();
        overlap.extend_from_slice(&window[window.len() - keep..]);

        if total_read >= WORKSHEET_SCAN_CAP_BYTES {
            break;
        }
    }

    Ok(stats)
}

/// Find the first `<dimension ref="A1:XFD1048576"/>` (or single-cell variant)
/// and return its (max_row, max_col). Returns None if absent or unparseable.
/// Accepts both double- and single-quoted attributes (valid XML).
fn parse_dimension(window: &[u8]) -> Option<(u64, u64)> {
    let needle = b"<dimension";
    let start = window.windows(needle.len()).position(|w| w == needle)?;
    let tail = &window[start..];
    let value = extract_attr_value(tail, b"ref")?;
    let value_str = std::str::from_utf8(value).ok()?;

    // Dimension is either a single cell ("A1") or a range ("A1:XFD1048576").
    // We want the bottom-right corner.
    let (_, br) = value_str.split_once(':').unwrap_or((value_str, value_str));
    parse_cell_ref(br)
}

/// Locate `attr="value"` or `attr='value'` (with optional whitespace) inside
/// the given byte slice. Returns the raw value bytes.
fn extract_attr_value<'a>(tail: &'a [u8], attr: &[u8]) -> Option<&'a [u8]> {
    let mut i = 0;
    while i + attr.len() < tail.len() {
        if &tail[i..i + attr.len()] == attr {
            let mut j = i + attr.len();
            while j < tail.len() && (tail[j] == b' ' || tail[j] == b'\t' || tail[j] == b'\n') {
                j += 1;
            }
            if j >= tail.len() || tail[j] != b'=' {
                i += 1;
                continue;
            }
            j += 1;
            while j < tail.len() && (tail[j] == b' ' || tail[j] == b'\t' || tail[j] == b'\n') {
                j += 1;
            }
            if j >= tail.len() {
                return None;
            }
            let quote = tail[j];
            if quote != b'"' && quote != b'\'' {
                i += 1;
                continue;
            }
            let start = j + 1;
            let end = tail[start..].iter().position(|&b| b == quote)?;
            return Some(&tail[start..start + end]);
        }
        i += 1;
    }
    None
}

/// Parse a cell ref like "XFD1048576" or "A1" into (row, col). 1-based.
fn parse_cell_ref(s: &str) -> Option<(u64, u64)> {
    let split = s.bytes().position(|b| b.is_ascii_digit())?;
    let (col_part, row_part) = s.split_at(split);
    if col_part.is_empty() || row_part.is_empty() {
        return None;
    }
    let mut col: u64 = 0;
    for ch in col_part.bytes() {
        if !ch.is_ascii_alphabetic() {
            return None;
        }
        let v = (ch.to_ascii_uppercase() - b'A' + 1) as u64;
        col = col.saturating_mul(26).saturating_add(v);
    }
    let row: u64 = row_part.parse().ok()?;
    Some((row, col))
}

/// Count `<f>` and `<f ...>` formula tags. Naive byte scan; avoids matching
/// `<filter`, `<fill`, `<font>`, `<fonts>` etc. by requiring the next byte
/// after `<f` to be `>`, space, or `/`.
fn count_formula_tags(window: &[u8]) -> usize {
    let needle = b"<f";
    let mut count = 0;
    let mut i = 0;
    while i + needle.len() < window.len() {
        if &window[i..i + needle.len()] == needle {
            let next = window[i + needle.len()];
            if next == b'>' || next == b' ' || next == b'/' || next == b'\t' || next == b'\n' {
                count += 1;
            }
            i += needle.len();
        } else {
            i += 1;
        }
    }
    count
}

/// Fallback row/col scan: find `<row r="N"` / `<row r='N'` and `<c r="XX"` /
/// `<c r='XX'` refs. Cheap byte search; we don't need to be perfect here
/// because we only use this when `<dimension>` is absent.
fn scan_row_col_refs(window: &[u8]) -> (u64, u64) {
    let mut max_row: u64 = 0;
    let mut max_col: u64 = 0;

    // `<row r=` (quote-agnostic). After the `=`, allow optional whitespace before the quote.
    for prefix in [b"<row r=" as &[u8], b"<row r =" as &[u8]] {
        let mut i = 0;
        while let Some(pos) = window[i..]
            .windows(prefix.len())
            .position(|w| w == prefix)
        {
            let mut j = i + pos + prefix.len();
            while j < window.len() && (window[j] == b' ' || window[j] == b'\t') {
                j += 1;
            }
            if j >= window.len() || (window[j] != b'"' && window[j] != b'\'') {
                i = i + pos + prefix.len();
                continue;
            }
            let quote = window[j];
            let start = j + 1;
            let end = window[start..]
                .iter()
                .position(|&b| b == quote)
                .map(|p| start + p)
                .unwrap_or(start);
            if let Ok(s) = std::str::from_utf8(&window[start..end]) {
                if let Ok(n) = s.parse::<u64>() {
                    if n > max_row {
                        max_row = n;
                    }
                }
            }
            i = end.max(i + pos + prefix.len());
            if i >= window.len() {
                break;
            }
        }
    }

    // `<c r=` (quote-agnostic).
    for prefix in [b"<c r=" as &[u8], b"<c r =" as &[u8]] {
        let mut i = 0;
        while let Some(pos) = window[i..]
            .windows(prefix.len())
            .position(|w| w == prefix)
        {
            let mut j = i + pos + prefix.len();
            while j < window.len() && (window[j] == b' ' || window[j] == b'\t') {
                j += 1;
            }
            if j >= window.len() || (window[j] != b'"' && window[j] != b'\'') {
                i = i + pos + prefix.len();
                continue;
            }
            let quote = window[j];
            let start = j + 1;
            let end = window[start..]
                .iter()
                .position(|&b| b == quote)
                .map(|p| start + p)
                .unwrap_or(start);
            if let Ok(s) = std::str::from_utf8(&window[start..end]) {
                if let Some((_, col)) = parse_cell_ref(s) {
                    if col > max_col {
                        max_col = col;
                    }
                }
            }
            i = end.max(i + pos + prefix.len());
            if i >= window.len() {
                break;
            }
        }
    }

    (max_row, max_col)
}

// HTML export — render every sheet to a self-contained .html file with one
// `<table>` per sheet and inline CSS for the styles we can extract from the
// snapshot. The output is intended to be viewable directly in a browser and
// to print cleanly via the browser's print dialog (a `@media print` block is
// embedded so the user gets a usable PDF when they choose "Save as PDF" in
// their print sheet).
//
// Fidelity scope (best-effort, MVP):
//   - cell text + formula text (when no cached value present)
//   - bold / italic / font color from snapshot.styles entries
//   - background fill color
//   - basic borders (per-side style + color)
//   - column widths from `columnData.<col>.w` when set
//   - row heights from `rowData.<row>.h` when set
//   - header / footer text from `_pageSetup.header` / `_pageSetup.footer`
//   - sheet protection / data validation / conditional formatting are NOT
//     rendered visually here — they have no visual representation outside
//     the live grid.

use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::commands::workbook::CompatibilityWarning;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExportResult {
    pub success: bool,
    pub path: String,
    pub sheets_written: u32,
    pub warnings: Vec<CompatibilityWarning>,
    pub error: Option<String>,
}

const MAX_EXPORT_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXPORT_CELLS_PER_SHEET: usize = 1_000_000;

#[tauri::command]
pub fn workbook_export_html(
    snapshot_json: String,
    output_path: String,
) -> Result<HtmlExportResult, String> {
    let path_lower = output_path.to_lowercase();
    if !path_lower.ends_with(".html") && !path_lower.ends_with(".htm") {
        return Ok(HtmlExportResult {
            success: false,
            path: output_path,
            sheets_written: 0,
            warnings: Vec::new(),
            error: Some("HTML_INVALID_EXTENSION".into()),
        });
    }
    if snapshot_json.len() > MAX_EXPORT_SNAPSHOT_BYTES {
        return Ok(HtmlExportResult {
            success: false,
            path: output_path,
            sheets_written: 0,
            warnings: Vec::new(),
            error: Some("HTML_SNAPSHOT_TOO_LARGE".into()),
        });
    }

    let root: Value = match serde_json::from_str(&snapshot_json) {
        Ok(v) => v,
        Err(e) => {
            return Ok(HtmlExportResult {
                success: false,
                path: output_path,
                sheets_written: 0,
                warnings: Vec::new(),
                error: Some(format!("HTML_INVALID_SNAPSHOT: {e}")),
            });
        }
    };

    let workbook_name = root
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Workbook".to_string());

    let styles = root.get("styles").and_then(|v| v.as_object());
    let sheet_order = root
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sheets = root.get("sheets").and_then(|v| v.as_object());

    let mut warnings: Vec<CompatibilityWarning> = Vec::new();
    let mut html = String::with_capacity(4096);
    html.push_str("<!DOCTYPE html>\n<html lang=\"ja\">\n<head>\n");
    html.push_str("<meta charset=\"UTF-8\">\n");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n");
    html.push_str("<title>");
    html.push_str(&escape_html(&workbook_name));
    html.push_str("</title>\n");
    html.push_str("<style>\n");
    html.push_str(EMBEDDED_CSS);
    html.push_str("</style>\n");
    html.push_str("</head>\n<body>\n");
    html.push_str("<header class=\"workbook-header\"><h1>");
    html.push_str(&escape_html(&workbook_name));
    html.push_str("</h1></header>\n");
    html.push_str("<main>\n");

    let mut sheets_written: u32 = 0;
    for id_v in sheet_order.iter() {
        let Some(sheet_id) = id_v.as_str() else {
            continue;
        };
        let Some(sheet) = sheets.and_then(|s| s.get(sheet_id)) else {
            continue;
        };
        let sheet_name = sheet
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(sheet_id);
        let cell_data = sheet.get("cellData").and_then(|v| v.as_object());
        let (n_rows, n_cols) = compute_used_extent(cell_data);
        let cell_count = n_rows.saturating_mul(n_cols);
        if cell_count > MAX_EXPORT_CELLS_PER_SHEET {
            warnings.push(CompatibilityWarning {
                severity: "warning".into(),
                code: "HTML_SHEET_TRUNCATED".into(),
                message: format!(
                    "シート「{}」はセル数が多すぎるため省略されました ({} > {} セル)。",
                    sheet_name, cell_count, MAX_EXPORT_CELLS_PER_SHEET
                ),
                affected_sheets: Some(vec![sheet_name.to_string()]),
            });
            continue;
        }

        let column_data = sheet.get("columnData").and_then(|v| v.as_object());
        let row_data = sheet.get("rowData").and_then(|v| v.as_object());
        let page_setup = sheet.get("_pageSetup").and_then(|v| v.as_object());

        html.push_str("<section class=\"sheet\">\n");
        html.push_str("<h2>");
        html.push_str(&escape_html(sheet_name));
        html.push_str("</h2>\n");

        if let Some(ps) = page_setup {
            if let Some(h) = ps.get("header").and_then(|v| v.as_str()) {
                if !h.is_empty() {
                    html.push_str("<div class=\"page-header\">");
                    html.push_str(&escape_html(h));
                    html.push_str("</div>\n");
                }
            }
        }

        write_sheet_table(
            &mut html,
            n_rows,
            n_cols,
            cell_data,
            column_data,
            row_data,
            styles,
        );

        if let Some(ps) = page_setup {
            if let Some(f) = ps.get("footer").and_then(|v| v.as_str()) {
                if !f.is_empty() {
                    html.push_str("<div class=\"page-footer\">");
                    html.push_str(&escape_html(f));
                    html.push_str("</div>\n");
                }
            }
        }

        html.push_str("</section>\n");
        sheets_written += 1;
    }

    html.push_str("</main>\n</body>\n</html>\n");

    let target_path = Path::new(&output_path);
    let (temp_path, file) = create_temp_file(target_path)?;
    let write_result = (|| -> Result<(), String> {
        let mut writer = BufWriter::new(file);
        // UTF-8 BOM helps Windows tools recognize the encoding when the user
        // double-clicks the file. The `<meta charset>` already declares UTF-8,
        // but the BOM is a low-cost belt-and-braces measure.
        writer
            .write_all(&[0xEF, 0xBB, 0xBF])
            .map_err(|e| e.to_string())?;
        writer
            .write_all(html.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        writer.get_ref().sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    replace_temp_file(&temp_path, target_path)?;

    Ok(HtmlExportResult {
        success: true,
        path: output_path,
        sheets_written,
        warnings,
        error: None,
    })
}

fn compute_used_extent(cell_data: Option<&Map<String, Value>>) -> (usize, usize) {
    let mut max_row: usize = 0;
    let mut max_col: usize = 0;
    let mut any_cell = false;
    if let Some(rows_map) = cell_data {
        for (r_key, r_val) in rows_map.iter() {
            let Ok(r) = r_key.parse::<usize>() else {
                continue;
            };
            let Some(cols_map) = r_val.as_object() else {
                continue;
            };
            for (c_key, _) in cols_map.iter() {
                let Ok(c) = c_key.parse::<usize>() else {
                    continue;
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
    if any_cell {
        (max_row + 1, max_col + 1)
    } else {
        (0, 0)
    }
}

fn write_sheet_table(
    out: &mut String,
    n_rows: usize,
    n_cols: usize,
    cell_data: Option<&Map<String, Value>>,
    column_data: Option<&Map<String, Value>>,
    row_data: Option<&Map<String, Value>>,
    styles: Option<&Map<String, Value>>,
) {
    out.push_str("<table class=\"sheet-table\">\n");

    if let Some(col_map) = column_data {
        out.push_str("<colgroup>\n");
        for c in 0..n_cols {
            let key = c.to_string();
            let w = col_map
                .get(&key)
                .and_then(|v| v.get("w"))
                .and_then(|v| v.as_f64());
            match w {
                Some(width) if width > 0.0 => {
                    out.push_str(&format!(
                        "<col style=\"width:{:.1}px\">\n",
                        width.max(8.0).min(2000.0)
                    ));
                }
                _ => out.push_str("<col>\n"),
            }
        }
        out.push_str("</colgroup>\n");
    }

    out.push_str("<tbody>\n");
    for r in 0..n_rows {
        let row_height = row_data
            .and_then(|rd| rd.get(&r.to_string()))
            .and_then(|v| v.get("h"))
            .and_then(|v| v.as_f64());
        let row_attr = match row_height {
            Some(h) if h > 0.0 => format!(" style=\"height:{:.1}px\"", h.max(4.0).min(2000.0)),
            _ => String::new(),
        };
        out.push_str("<tr");
        out.push_str(&row_attr);
        out.push_str(">\n");

        let row_obj = cell_data
            .and_then(|rows_map| rows_map.get(&r.to_string()))
            .and_then(|row| row.as_object());

        for c in 0..n_cols {
            let cell = row_obj.and_then(|cols| cols.get(&c.to_string()));
            render_cell(out, cell, styles);
        }
        out.push_str("</tr>\n");
    }
    out.push_str("</tbody>\n</table>\n");
}

fn render_cell(out: &mut String, cell: Option<&Value>, styles: Option<&Map<String, Value>>) {
    let Some(cell) = cell else {
        out.push_str("<td></td>");
        return;
    };
    let text = render_cell_text(cell);
    let style_id = cell.get("s").and_then(|v| v.as_str());
    let style_obj = style_id
        .and_then(|id| styles.and_then(|m| m.get(id)))
        .and_then(|v| v.as_object());

    let mut style_str = String::new();
    let mut wrap_bold = false;
    let mut wrap_italic = false;

    if let Some(style) = style_obj {
        if let Some(font) = style.get("font").and_then(|v| v.as_object()) {
            if font.get("bold").and_then(|v| v.as_bool()).unwrap_or(false) {
                wrap_bold = true;
            }
            if font.get("italic").and_then(|v| v.as_bool()).unwrap_or(false) {
                wrap_italic = true;
            }
            if let Some(c) = font.get("color").and_then(|v| v.as_str()) {
                if is_safe_color(c) {
                    style_str.push_str(&format!("color:{};", c));
                }
            }
        }
        if let Some(fill) = style.get("fill").and_then(|v| v.as_object()) {
            if let Some(c) = fill.get("color").and_then(|v| v.as_str()) {
                if is_safe_color(c) {
                    style_str.push_str(&format!("background-color:{};", c));
                }
            }
        }
        if let Some(align) = style.get("alignment").and_then(|v| v.as_object()) {
            if let Some(h) = align.get("horizontal").and_then(|v| v.as_str()) {
                let mapped = match h {
                    "left" | "center" | "right" | "justify" => h,
                    _ => "",
                };
                if !mapped.is_empty() {
                    style_str.push_str(&format!("text-align:{};", mapped));
                }
            }
            if let Some(v) = align.get("vertical").and_then(|v| v.as_str()) {
                let mapped = match v {
                    "top" => "top",
                    "middle" => "middle",
                    "bottom" => "bottom",
                    _ => "",
                };
                if !mapped.is_empty() {
                    style_str.push_str(&format!("vertical-align:{};", mapped));
                }
            }
        }
        if let Some(borders) = style.get("borders").and_then(|v| v.as_object()) {
            for (key, css_key) in [
                ("top", "border-top"),
                ("bottom", "border-bottom"),
                ("left", "border-left"),
                ("right", "border-right"),
            ] {
                let Some(side) = borders.get(key).and_then(|v| v.as_object()) else {
                    continue;
                };
                let bstyle = side.get("style").and_then(|v| v.as_str()).unwrap_or("thin");
                let bcolor = side
                    .get("color")
                    .and_then(|v| v.as_str())
                    .filter(|c| is_safe_color(c))
                    .unwrap_or("#000000");
                let (width_px, css_style) = match bstyle {
                    "thick" => ("2px", "solid"),
                    "medium" => ("1.5px", "solid"),
                    "dotted" => ("1px", "dotted"),
                    "dashed" => ("1px", "dashed"),
                    "double" => ("3px", "double"),
                    _ => ("1px", "solid"),
                };
                style_str.push_str(&format!(
                    "{}:{} {} {};",
                    css_key, width_px, css_style, bcolor
                ));
            }
        }
    }

    out.push_str("<td");
    if !style_str.is_empty() {
        out.push_str(" style=\"");
        out.push_str(&style_str);
        out.push('"');
    }
    out.push('>');
    if wrap_bold {
        out.push_str("<b>");
    }
    if wrap_italic {
        out.push_str("<i>");
    }
    out.push_str(&escape_html(&text));
    if wrap_italic {
        out.push_str("</i>");
    }
    if wrap_bold {
        out.push_str("</b>");
    }
    out.push_str("</td>");
}

fn render_cell_text(cell: &Value) -> String {
    if let Some(v) = cell.get("v") {
        match v {
            Value::Null => String::new(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    i.to_string()
                } else if let Some(f) = n.as_f64() {
                    if f.fract() == 0.0 && f.abs() < 1e15 {
                        format!("{}", f as i64)
                    } else {
                        format!("{}", f)
                    }
                } else {
                    n.to_string()
                }
            }
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    } else if let Some(f) = cell.get("f").and_then(|v| v.as_str()) {
        // Formula without cached value — show the formula text so the user
        // sees something rather than an empty cell. We can't evaluate it here
        // without a formula engine.
        format!("={}", f)
    } else {
        String::new()
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '\n' => out.push_str("<br>"),
            _ => out.push(c),
        }
    }
    out
}

/// Restrict colors to `#RRGGBB` / `#RGB` to avoid CSS injection via a hostile
/// snapshot. Anything else is dropped silently.
fn is_safe_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes[0] != b'#' {
        return false;
    }
    let hex = &bytes[1..];
    if hex.len() != 3 && hex.len() != 6 && hex.len() != 8 {
        return false;
    }
    hex.iter()
        .all(|b| b.is_ascii_hexdigit())
}

const EMBEDDED_CSS: &str = "
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif; margin: 0; padding: 24px; background: #f7f7f8; color: #1a1a1a; }
.workbook-header { margin-bottom: 24px; }
.workbook-header h1 { font-size: 20px; font-weight: 600; margin: 0; }
.sheet { margin-bottom: 32px; background: white; padding: 16px; border: 1px solid #e2e2e6; border-radius: 4px; page-break-after: always; }
.sheet h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: #333; }
.page-header, .page-footer { color: #555; font-size: 11px; margin: 8px 0; text-align: center; }
.sheet-table { border-collapse: collapse; font-size: 12px; }
.sheet-table td { border: 1px solid #d4d4d8; padding: 2px 6px; min-width: 64px; vertical-align: bottom; }
@media print {
  body { background: white; padding: 0; }
  .sheet { border: none; border-radius: 0; padding: 0; margin: 0; box-shadow: none; }
  .sheet-table td { border-color: #888; }
}
";

fn create_temp_file(target_path: &Path) -> Result<(PathBuf, File), String> {
    let parent = target_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = target_path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_else(|| "export.html".into());
    for _ in 0..16 {
        let temp_path = parent.join(format!(
            ".{}.{}.tmp",
            file_name,
            uuid::Uuid::new_v4().simple()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.to_string()),
        }
    }
    Err("HTML_TEMP_CREATE_FAILED".into())
}

fn replace_temp_file(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let temp_wide: Vec<u16> = temp_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let target_wide: Vec<u16> = target_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let ok = unsafe {
            MoveFileExW(
                temp_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            let _ = fs::remove_file(temp_path);
            Err(err.to_string())
        } else {
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(temp_path, target_path).map_err(|err| {
            let _ = fs::remove_file(temp_path);
            err.to_string()
        })
    }
}

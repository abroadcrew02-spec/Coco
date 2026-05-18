// PDF export — render each sheet to A4 portrait pages with a fixed-width
// Helvetica font. Native generation via `printpdf` (BuiltinFont::Helvetica) is
// chosen over the alternative print-to-PDF-via-hidden-webview path because:
//   - no extra window plumbing, no UI flicker
//   - works headlessly (autosave / scheduled exports could reuse it later)
//   - deterministic output suitable for diffing / CI snapshot tests
//
// Fidelity caveats (MVP):
//   - text-only: no fill colors, borders, or images
//   - column widths use snapshot.columnData.<col>.w when present, otherwise a
//     fixed default; cell text is truncated (with `…`) when it would overflow
//     its assigned column width
//   - one column-width unit ≈ 0.5pt; the mapping is approximate because Excel
//     widths are measured in "characters of the default font" which varies
//     per workbook. Wide grids spill onto extra horizontal pages by chunking
//     columns rather than scaling down.
//   - sheet name shown as a heading at the top of each sheet's first page
//   - rows that overflow the bottom margin move to the next page
//   - bold / italic / colors / borders / number formats / merges are NOT
//     rendered visually — values appear in plain Helvetica regardless
//   - formulas without cached `v` are rendered as `=FORMULA_TEXT`

use printpdf::{BuiltinFont, IndirectFontRef, Mm, PdfDocument, PdfDocumentReference, PdfLayerReference};
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::commands::workbook::CompatibilityWarning;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportResult {
    pub success: bool,
    pub path: String,
    pub sheets_written: u32,
    pub pages_written: u32,
    pub warnings: Vec<CompatibilityWarning>,
    pub error: Option<String>,
}

const MAX_EXPORT_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXPORT_CELLS_PER_SHEET: usize = 500_000;

// A4 portrait page constants (millimetres).
const PAGE_WIDTH_MM: f64 = 210.0;
const PAGE_HEIGHT_MM: f64 = 297.0;
const MARGIN_MM: f64 = 12.0;
const HEADING_FONT_SIZE_PT: f64 = 14.0;
const CELL_FONT_SIZE_PT: f64 = 8.0;
const ROW_HEIGHT_MM: f64 = 4.5;
const HEADING_HEIGHT_MM: f64 = 8.0;
const DEFAULT_COL_WIDTH_MM: f64 = 22.0;
const MIN_COL_WIDTH_MM: f64 = 8.0;
const MAX_COL_WIDTH_MM: f64 = 80.0;

#[tauri::command]
pub fn workbook_export_pdf(
    snapshot_json: String,
    output_path: String,
) -> Result<PdfExportResult, String> {
    let path_lower = output_path.to_lowercase();
    if !path_lower.ends_with(".pdf") {
        return Ok(PdfExportResult {
            success: false,
            path: output_path,
            sheets_written: 0,
            pages_written: 0,
            warnings: Vec::new(),
            error: Some("PDF_INVALID_EXTENSION".into()),
        });
    }
    if snapshot_json.len() > MAX_EXPORT_SNAPSHOT_BYTES {
        return Ok(PdfExportResult {
            success: false,
            path: output_path,
            sheets_written: 0,
            pages_written: 0,
            warnings: Vec::new(),
            error: Some("PDF_SNAPSHOT_TOO_LARGE".into()),
        });
    }
    let root: Value = match serde_json::from_str(&snapshot_json) {
        Ok(v) => v,
        Err(e) => {
            return Ok(PdfExportResult {
                success: false,
                path: output_path,
                sheets_written: 0,
                pages_written: 0,
                warnings: Vec::new(),
                error: Some(format!("PDF_INVALID_SNAPSHOT: {e}")),
            });
        }
    };

    let workbook_name = root
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Workbook".to_string());

    let sheet_order = root
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sheets = root.get("sheets").and_then(|v| v.as_object());

    let mut warnings: Vec<CompatibilityWarning> = Vec::new();

    let (doc, first_page, first_layer) = PdfDocument::new(
        workbook_name.clone(),
        Mm(PAGE_WIDTH_MM as f32),
        Mm(PAGE_HEIGHT_MM as f32),
        "Layer 1",
    );
    let font = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(|e| format!("PDF_FONT_INIT_FAILED: {e}"))?;
    let font_bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(|e| format!("PDF_FONT_INIT_FAILED: {e}"))?;

    let mut current_layer = doc.get_page(first_page).get_layer(first_layer);
    let mut pages_written: u32 = 1;
    let mut sheets_written: u32 = 0;
    let mut first_sheet = true;

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
            .unwrap_or(sheet_id)
            .to_string();
        let cell_data = sheet.get("cellData").and_then(|v| v.as_object());
        let (n_rows, n_cols) = compute_used_extent(cell_data);
        if n_rows == 0 || n_cols == 0 {
            // Empty sheet — still emit the heading so the user knows the
            // sheet exists in the source workbook.
            if !first_sheet {
                let (new_layer, _new_page) = new_page(&doc);
                current_layer = new_layer;
                pages_written += 1;
            }
            draw_heading(&current_layer, &font_bold, &sheet_name);
            sheets_written += 1;
            first_sheet = false;
            continue;
        }
        let cell_count = n_rows.saturating_mul(n_cols);
        if cell_count > MAX_EXPORT_CELLS_PER_SHEET {
            warnings.push(CompatibilityWarning {
                severity: "warning".into(),
                code: "PDF_SHEET_TRUNCATED".into(),
                message: format!(
                    "シート「{}」はセル数が多すぎるため省略されました ({} > {} セル)。",
                    sheet_name, cell_count, MAX_EXPORT_CELLS_PER_SHEET
                ),
                affected_sheets: Some(vec![sheet_name.clone()]),
            });
            continue;
        }

        if !first_sheet {
            let (new_layer, _) = new_page(&doc);
            current_layer = new_layer;
            pages_written += 1;
        }
        first_sheet = false;

        let column_widths = collect_column_widths(sheet, n_cols);

        // Chunk columns into horizontal pages so a 200-column sheet doesn't
        // require an infinitely wide page. Each page covers as many columns as
        // fit between the left/right margins.
        let col_chunks = chunk_columns(&column_widths);

        let mut chunk_first_page_of_sheet = true;
        for chunk in &col_chunks {
            if !chunk_first_page_of_sheet {
                let (new_layer, _) = new_page(&doc);
                current_layer = new_layer;
                pages_written += 1;
            }
            chunk_first_page_of_sheet = false;

            let chunk_heading = if col_chunks.len() > 1 {
                format!(
                    "{} (列 {}-{} / {})",
                    sheet_name,
                    chunk.start_col + 1,
                    chunk.end_col,
                    n_cols
                )
            } else {
                sheet_name.clone()
            };
            draw_heading(&current_layer, &font_bold, &chunk_heading);

            let mut y_mm = PAGE_HEIGHT_MM - MARGIN_MM - HEADING_HEIGHT_MM;
            let bottom_y_mm = MARGIN_MM;

            for r in 0..n_rows {
                if y_mm - ROW_HEIGHT_MM < bottom_y_mm {
                    // Start a new page within the same sheet+chunk.
                    let (new_layer, _) = new_page(&doc);
                    current_layer = new_layer;
                    pages_written += 1;
                    draw_heading(
                        &current_layer,
                        &font_bold,
                        &format!("{} (続き)", chunk_heading),
                    );
                    y_mm = PAGE_HEIGHT_MM - MARGIN_MM - HEADING_HEIGHT_MM;
                }
                let row_obj = cell_data
                    .and_then(|rows_map| rows_map.get(&r.to_string()))
                    .and_then(|row| row.as_object());

                let mut x_mm = MARGIN_MM;
                for ci in chunk.start_col..chunk.end_col {
                    let col_w_mm = column_widths.get(ci).copied().unwrap_or(DEFAULT_COL_WIDTH_MM);
                    let cell = row_obj.and_then(|cols| cols.get(&ci.to_string()));
                    if let Some(cell) = cell {
                        let text = render_cell_text(cell);
                        if !text.is_empty() {
                            let truncated = truncate_to_width(&text, col_w_mm);
                            current_layer.use_text(
                                truncated,
                                CELL_FONT_SIZE_PT as f32,
                                Mm((x_mm + 0.5) as f32),
                                Mm((y_mm - 3.2) as f32),
                                &font,
                            );
                        }
                    }
                    x_mm += col_w_mm;
                }
                y_mm -= ROW_HEIGHT_MM;
            }
        }

        sheets_written += 1;
    }

    if first_sheet {
        // Workbook had no sheets at all — at least put the workbook title on
        // the page so the PDF isn't completely empty.
        draw_heading(&current_layer, &font_bold, &workbook_name);
    }

    let target_path = Path::new(&output_path);
    let (temp_path, file) = create_temp_file(target_path)?;
    let write_result = (|| -> Result<(), String> {
        let mut writer = BufWriter::new(file);
        doc.save(&mut writer)
            .map_err(|e| format!("PDF_SAVE_FAILED: {e}"))?;
        writer.flush().map_err(|e| e.to_string())?;
        writer.get_ref().sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    replace_temp_file(&temp_path, target_path)?;

    Ok(PdfExportResult {
        success: true,
        path: output_path,
        sheets_written,
        pages_written,
        warnings,
        error: None,
    })
}

struct ColChunk {
    start_col: usize,
    end_col: usize, // exclusive
}

fn chunk_columns(widths: &[f64]) -> Vec<ColChunk> {
    let usable = PAGE_WIDTH_MM - 2.0 * MARGIN_MM;
    let mut chunks: Vec<ColChunk> = Vec::new();
    let mut start = 0usize;
    let mut acc = 0.0f64;
    for (i, w) in widths.iter().enumerate() {
        if acc + w > usable && i > start {
            chunks.push(ColChunk {
                start_col: start,
                end_col: i,
            });
            start = i;
            acc = 0.0;
        }
        acc += w;
    }
    chunks.push(ColChunk {
        start_col: start,
        end_col: widths.len(),
    });
    chunks
}

fn collect_column_widths(sheet: &Value, n_cols: usize) -> Vec<f64> {
    let col_map = sheet.get("columnData").and_then(|v| v.as_object());
    (0..n_cols)
        .map(|c| {
            let raw = col_map
                .and_then(|m| m.get(&c.to_string()))
                .and_then(|v| v.get("w"))
                .and_then(|v| v.as_f64());
            match raw {
                Some(w) if w > 0.0 => {
                    // Univer / Excel column widths are roughly "character units of
                    // the default font", with one unit ≈ 7px ≈ 1.85mm. Bound the
                    // result so a malformed snapshot can't blow the page width.
                    let mm = (w * 7.0) / 3.78; // 1mm ≈ 3.78px at 96 DPI
                    mm.max(MIN_COL_WIDTH_MM).min(MAX_COL_WIDTH_MM)
                }
                _ => DEFAULT_COL_WIDTH_MM,
            }
        })
        .collect()
}

fn new_page(doc: &PdfDocumentReference) -> (PdfLayerReference, printpdf::PdfPageIndex) {
    let (page, layer) = doc.add_page(Mm(PAGE_WIDTH_MM as f32), Mm(PAGE_HEIGHT_MM as f32), "Layer 1");
    (doc.get_page(page).get_layer(layer), page)
}

fn draw_heading(layer: &PdfLayerReference, font: &IndirectFontRef, text: &str) {
    layer.use_text(
        text,
        HEADING_FONT_SIZE_PT as f32,
        Mm(MARGIN_MM as f32),
        Mm((PAGE_HEIGHT_MM - MARGIN_MM - 6.0) as f32),
        font,
    );
}

/// Approximate width of `s` in millimetres at CELL_FONT_SIZE_PT. Helvetica is
/// roughly 0.5em-wide on average; we treat every char as 1.6mm which works
/// well enough for Latin text and is conservative for CJK glyphs.
fn approx_text_width_mm(s: &str) -> f64 {
    let mut total = 0.0f64;
    for ch in s.chars() {
        let w = if ch.is_ascii() { 1.6 } else { 3.0 };
        total += w;
    }
    total
}

fn truncate_to_width(s: &str, max_mm: f64) -> String {
    if approx_text_width_mm(s) <= max_mm - 1.0 {
        return s.to_string();
    }
    // Reserve 2mm for an ellipsis.
    let target = (max_mm - 3.0).max(2.0);
    let mut acc = 0.0f64;
    let mut out = String::new();
    for ch in s.chars() {
        let w = if ch.is_ascii() { 1.6 } else { 3.0 };
        if acc + w > target {
            break;
        }
        acc += w;
        out.push(ch);
    }
    out.push('…');
    out
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
        format!("={}", f)
    } else {
        String::new()
    }
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

fn create_temp_file(target_path: &Path) -> Result<(PathBuf, File), String> {
    let parent = target_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = target_path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_else(|| "export.pdf".into());
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
    Err("PDF_TEMP_CREATE_FAILED".into())
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

//! Import individual sheets from an arbitrary xlsx file into the current
//! workbook. Two commands:
//!   - `workbook_extract_sheets_from_xlsx(path)` enumerates the source file's
//!     sheets so the picker UI can show name + cell-count + range.
//!   - `workbook_extract_sheet_as_snapshot(path, sheet_name)` returns the
//!     snapshot JSON fragment for a single sheet, which the frontend then
//!     splices into the live workbook's `sheetOrder` + `sheets` map.
//!
//! Both reuse `import_xlsx_core` from `xlsx_io` so number formats, styles,
//! merges, data validations, etc. round-trip identically to a full import.
//! That keeps style fidelity but means we briefly materialize the full
//! source workbook in memory — acceptable for the picker UX (file is usually
//! small) and avoids forking the heavy parser.

use serde::Serialize;
use serde_json::Value;

use crate::commands::xlsx_io::import_xlsx_core;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSummary {
    /// Display name of the sheet (as it appears in the source workbook tab).
    pub name: String,
    /// Number of non-empty cells. 0 for a fully blank sheet.
    pub cell_count: u32,
    /// A1-style used range, e.g. "A1:F128". Empty string when the sheet has no data.
    pub range: String,
}

/// Enumerate the sheets in an xlsx file so the user can pick which ones to import.
/// Returns names + cell-count + A1 range. Order matches the workbook's `sheetOrder`.
#[tauri::command]
pub fn workbook_extract_sheets_from_xlsx(path: String) -> Result<Vec<SheetSummary>, String> {
    let result = import_xlsx_core(path)?;
    let snapshot_json = result
        .handle
        .snapshot_json
        .ok_or_else(|| "no snapshot produced by importer".to_string())?;
    let root: Value = serde_json::from_str(&snapshot_json).map_err(|e| e.to_string())?;

    let order = root
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sheets = root.get("sheets");

    let mut out = Vec::with_capacity(order.len());
    for id_v in order.iter() {
        let id = match id_v.as_str() {
            Some(s) => s,
            None => continue,
        };
        let sheet = match sheets.and_then(|s| s.get(id)) {
            Some(s) => s,
            None => continue,
        };
        let name = sheet
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("Sheet")
            .to_string();
        let (cell_count, max_row, max_col, min_row, min_col) = scan_cell_bounds(sheet);
        let range = if cell_count == 0 {
            String::new()
        } else {
            format!(
                "{}{}:{}{}",
                col_to_letters(min_col),
                min_row + 1,
                col_to_letters(max_col),
                max_row + 1,
            )
        };
        out.push(SheetSummary {
            name,
            cell_count,
            range,
        });
    }
    Ok(out)
}

/// Extract a single sheet from the xlsx file as a snapshot fragment. The
/// returned JSON shape is `{ name, cellData, rowData, columnData, styles,
/// ...passthrough fields like mergeData / _hyperlinks }` — everything the
/// importer captured on the source sheet, plus the workbook-level `styles`
/// map so style ids referenced inside `cellData[*][*].s` still resolve when
/// merged into the destination workbook.
///
/// The destination side is responsible for renaming the sheet if it collides
/// with an existing tab and for re-keying style ids if the destination has
/// its own (currently the frontend prefixes them to avoid the collision).
#[tauri::command]
pub fn workbook_extract_sheet_as_snapshot(
    path: String,
    sheet_name: String,
) -> Result<String, String> {
    let result = import_xlsx_core(path)?;
    let snapshot_json = result
        .handle
        .snapshot_json
        .ok_or_else(|| "no snapshot produced by importer".to_string())?;
    let root: Value = serde_json::from_str(&snapshot_json).map_err(|e| e.to_string())?;

    let order = root
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sheets = root
        .get("sheets")
        .ok_or_else(|| "snapshot missing 'sheets'".to_string())?;

    // Locate the sheet by name (the user picked from the names returned by
    // workbook_extract_sheets_from_xlsx, so name lookup is the natural key).
    let mut found: Option<Value> = None;
    for id_v in order.iter() {
        let id = match id_v.as_str() {
            Some(s) => s,
            None => continue,
        };
        let sheet = match sheets.get(id) {
            Some(s) => s,
            None => continue,
        };
        let name = sheet.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name == sheet_name {
            found = Some(sheet.clone());
            break;
        }
    }
    let mut sheet = found.ok_or_else(|| format!("sheet not found: {sheet_name}"))?;

    // Carry the workbook-level `styles` map along so style references inside
    // the sheet's cellData can be resolved on the destination side. The
    // destination merger re-keys them to avoid collisions with its own styles.
    if let Some(obj) = sheet.as_object_mut() {
        if let Some(styles) = root.get("styles") {
            obj.insert("_sourceStyles".into(), styles.clone());
        }
    }

    serde_json::to_string(&sheet).map_err(|e| e.to_string())
}

/// Walk a sheet's `cellData` and tally (count, max_row, max_col, min_row, min_col).
/// Returns zeros when the sheet has no cell entries.
fn scan_cell_bounds(sheet: &Value) -> (u32, u32, u32, u32, u32) {
    let cell_data = match sheet.get("cellData").and_then(|v| v.as_object()) {
        Some(m) => m,
        None => return (0, 0, 0, 0, 0),
    };
    let mut count: u32 = 0;
    let mut any = false;
    let mut max_row: u32 = 0;
    let mut max_col: u32 = 0;
    let mut min_row: u32 = u32::MAX;
    let mut min_col: u32 = u32::MAX;
    for (r_key, r_val) in cell_data.iter() {
        let r: u32 = match r_key.parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let cols = match r_val.as_object() {
            Some(m) => m,
            None => continue,
        };
        for (c_key, _c_val) in cols.iter() {
            let c: u32 = match c_key.parse() {
                Ok(n) => n,
                Err(_) => continue,
            };
            count = count.saturating_add(1);
            if !any {
                any = true;
                max_row = r;
                max_col = c;
                min_row = r;
                min_col = c;
            } else {
                if r > max_row {
                    max_row = r;
                }
                if c > max_col {
                    max_col = c;
                }
                if r < min_row {
                    min_row = r;
                }
                if c < min_col {
                    min_col = c;
                }
            }
        }
    }
    if !any {
        (0, 0, 0, 0, 0)
    } else {
        (count, max_row, max_col, min_row, min_col)
    }
}

/// 0-based column index → Excel letters (0 -> "A", 25 -> "Z", 26 -> "AA").
fn col_to_letters(mut idx: u32) -> String {
    let mut out = String::new();
    loop {
        let rem = (idx % 26) as u8;
        out.insert(0, (b'A' + rem) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    out
}

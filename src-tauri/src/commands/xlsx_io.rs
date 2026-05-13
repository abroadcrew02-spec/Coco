use std::collections::HashMap;
use std::path::PathBuf;

use calamine::{open_workbook, Data, Reader, Xlsx};
use rust_xlsxwriter::{Format, Workbook};
use serde_json::{json, Map, Value};

use crate::commands::workbook::{
    rotate_backups, temp_save_path, CompatibilityWarning, ExportResult, ImportWorkbookResult,
    WorkbookHandle,
};

const MIN_ROWS: usize = 1000;
const MIN_COLS: usize = 100;
const LARGE_SHEET_THRESHOLD: usize = 100_000;

fn data_to_cell(d: &Data) -> Option<Value> {
    match d {
        Data::Empty => None,
        Data::Int(n) => Some(json!({ "v": n })),
        Data::Float(f) => Some(json!({ "v": f })),
        Data::String(s) => Some(json!({ "v": s })),
        Data::Bool(b) => Some(json!({ "v": b })),
        Data::DateTime(dt) => {
            let v = dt.as_f64();
            let fmt = if v.fract().abs() < f64::EPSILON {
                "yyyy-mm-dd"
            } else {
                "yyyy-mm-dd hh:mm:ss"
            };
            Some(json!({ "v": v, "_fmt": fmt }))
        }
        Data::DateTimeIso(s) => Some(json!({ "v": s, "_fmt": "@" })),
        Data::DurationIso(s) => Some(json!({ "v": s })),
        Data::Error(_) => Some(json!({ "v": Value::Null, "t": "e" })),
    }
}

/// Inspects the ZIP for unsupported feature directories and returns a list of
/// CompatibilityWarning entries describing what will be silently dropped on
/// save-back. Pure-Rust: takes the path so it's testable from cargo test.
pub fn detect_unsupported_features(path: &str) -> Result<Vec<CompatibilityWarning>, String> {
    use std::fs::File;
    use zip::ZipArchive;

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;

    let mut has_charts = false;
    let mut has_pivot = false;
    let mut has_external_links = false;
    let mut has_vba = false;
    let mut has_embeddings = false;
    let mut has_drawings = false;

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name();

        if name.starts_with("xl/charts/") {
            has_charts = true;
        }
        if name.starts_with("xl/pivotTables/") || name.starts_with("xl/pivotCache/") {
            has_pivot = true;
        }
        if name.starts_with("xl/externalLinks/") {
            has_external_links = true;
        }
        if name == "xl/vbaProject.bin" {
            has_vba = true;
        }
        if name.starts_with("xl/embeddings/") {
            has_embeddings = true;
        }
        if name.starts_with("xl/drawings/") || name.starts_with("xl/media/") {
            has_drawings = true;
        }
    }

    let mut warnings = Vec::new();

    if has_charts {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_CHARTS_DISCARDED".to_string(),
            message: "このファイルにはグラフが含まれていますが、Coco では保持されません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_pivot {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_PIVOT_DISCARDED".to_string(),
            message: "ピボットテーブルが含まれていますが、Coco では保持されません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_external_links {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_EXTERNAL_LINKS_DISCARDED".to_string(),
            message: "外部ブックへのリンクが含まれていますが、Coco では値のみ保持され、リンクは失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_vba {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_VBA_DISCARDED".to_string(),
            message: "VBA マクロが含まれていますが、Coco では実行も保持もされません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_embeddings {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_EMBEDDED_OBJECTS_DISCARDED".to_string(),
            message: "埋め込みオブジェクト（OLE 等）が含まれていますが、Coco では保持されません。".to_string(),
            affected_sheets: None,
        });
    }
    if has_drawings {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_DRAWINGS_DISCARDED".to_string(),
            message: "図形・画像が含まれていますが、Coco では保持されません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }

    Ok(warnings)
}

/// Tauri command wrapper. Calls the pure-Rust core and records the file in recent files.
#[tauri::command]
pub fn workbook_import_xlsx(
    app: tauri::AppHandle,
    path: String,
) -> Result<ImportWorkbookResult, String> {
    let result = import_xlsx_core(path.clone())?;
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

/// Pure-Rust import logic. Independent of Tauri so it's directly callable from tests.
pub fn import_xlsx_core(path: String) -> Result<ImportWorkbookResult, String> {
    let workbook_id = uuid::Uuid::new_v4().to_string();

    // Accept .xlsx and .xlsm. .xlsm is read identically (calamine handles both) but
    // we emit a macro-loss warning per AD-02b and req 5.3.2.
    let ext_lower = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let is_xlsx = ext_lower.as_deref() == Some("xlsx");
    let is_xlsm = ext_lower.as_deref() == Some("xlsm");

    if !is_xlsx && !is_xlsm {
        let empty_snapshot = json!({
            "id": workbook_id,
            "name": "Imported Workbook",
            "appVersion": "0.1.0",
            "locale": "enUS",
            "styles": {},
            "sheetOrder": [],
            "sheets": {},
        });
        return Ok(ImportWorkbookResult {
            handle: WorkbookHandle {
                workbook_id,
                path: Some(path.clone()),
                source_type: "xlsx".to_string(),
                snapshot_json: Some(
                    serde_json::to_string(&empty_snapshot).map_err(|e| e.to_string())?,
                ),
            },
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_INVALID_EXTENSION".to_string(),
                message: "対応していない拡張子です（.xlsx / .xlsm のみ受け付けます）".to_string(),
                affected_sheets: None,
            }],
        });
    }

    // Defense-in-depth: run security scan before touching the file with calamine.
    let scan = crate::commands::security::security_scan_xlsx(path.clone())
        .map_err(|e| format!("security scan failed: {e}"))?;
    if scan.blocked {
        let empty_snapshot = json!({
            "id": workbook_id,
            "name": "Imported Workbook",
            "appVersion": "0.1.0",
            "locale": "enUS",
            "styles": {},
            "sheetOrder": [],
            "sheets": {},
        });
        let mut warnings: Vec<CompatibilityWarning> = scan
            .issues
            .into_iter()
            .map(|m| CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_SECURITY_BLOCKED".to_string(),
                message: m,
                affected_sheets: None,
            })
            .collect();
        for w in scan.warnings {
            warnings.push(CompatibilityWarning {
                severity: "warning".to_string(),
                code: "XLSX_SECURITY_WARNING".to_string(),
                message: w,
                affected_sheets: None,
            });
        }
        return Ok(ImportWorkbookResult {
            handle: WorkbookHandle {
                workbook_id,
                path: Some(path),
                source_type: "xlsx".to_string(),
                snapshot_json: Some(
                    serde_json::to_string(&empty_snapshot).map_err(|e| e.to_string())?,
                ),
            },
            warnings,
        });
    }

    let prepended_warnings: Vec<CompatibilityWarning> = scan
        .warnings
        .into_iter()
        .map(|m| CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_SECURITY_WARNING".to_string(),
            message: m,
            affected_sheets: None,
        })
        .collect();

    let feature_warnings = detect_unsupported_features(&path).unwrap_or_default();

    let mut wb: Xlsx<_> =
        open_workbook(&path).map_err(|e| format!("Failed to open xlsx: {e}"))?;

    let sheet_names = wb.sheet_names().to_vec();
    let mut sheet_order: Vec<String> = Vec::new();
    let mut sheets_map: Map<String, Value> = Map::new();
    let mut large_sheets: Vec<String> = Vec::new();

    for (i, name) in sheet_names.iter().enumerate() {
        let sheet_id = format!("sheet-{}", i + 1);
        sheet_order.push(sheet_id.clone());

        let range = wb
            .worksheet_range(name)
            .map_err(|e| format!("Failed to read sheet '{name}': {e}"))?;

        // Try to extract formulas as a parallel range; ignore if unavailable.
        // calamine's worksheet_formula returns a *sparse* range whose start
        // matches the first cell with a formula — not necessarily (0, 0). So we
        // must look up cells with absolute sheet coordinates via get_value.
        let formula_range = wb.worksheet_formula(name).ok();
        let range_start = range.start().unwrap_or((0, 0));

        let (used_rows, used_cols) = range.get_size();
        let row_count = used_rows.max(MIN_ROWS);
        let col_count = used_cols.max(MIN_COLS);

        let mut cell_data: Map<String, Value> = Map::new();
        let mut non_empty_cells: usize = 0;

        for (r, row) in range.rows().enumerate() {
            let mut row_map: Map<String, Value> = Map::new();
            for (c, cell) in row.iter().enumerate() {
                let abs_r = range_start.0 + r as u32;
                let abs_c = range_start.1 + c as u32;
                // Prefer formula if present at this position.
                let formula_str = formula_range
                    .as_ref()
                    .and_then(|fr| fr.get_value((abs_r, abs_c)))
                    .and_then(|s: &String| {
                        if s.is_empty() {
                            None
                        } else {
                            Some(s.clone())
                        }
                    });

                if let Some(f) = formula_str {
                    let f = if f.starts_with('=') {
                        f
                    } else {
                        format!("={f}")
                    };
                    // Preserve the calamine-cached display value alongside the
                    // formula. Univer will recalc when it can, but if it can't
                    // (unsupported function, missing dependency) the user still
                    // sees the value Excel computed instead of an empty cell.
                    let mut cell_obj = json!({ "f": f });
                    if let Some(cached) = data_to_cell(cell) {
                        if let Value::Object(ref cached_map) = cached {
                            let target = cell_obj.as_object_mut().unwrap();
                            for (k, v) in cached_map.iter() {
                                target.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    row_map.insert(c.to_string(), cell_obj);
                    non_empty_cells += 1;
                    continue;
                }

                if let Some(v) = data_to_cell(cell) {
                    row_map.insert(c.to_string(), v);
                    non_empty_cells += 1;
                }
            }
            if !row_map.is_empty() {
                cell_data.insert(r.to_string(), Value::Object(row_map));
            }
        }

        if non_empty_cells > LARGE_SHEET_THRESHOLD {
            large_sheets.push(name.clone());
        }

        let sheet_obj = json!({
            "id": sheet_id,
            "name": name,
            "rowCount": row_count,
            "columnCount": col_count,
            "cellData": Value::Object(cell_data),
        });
        sheets_map.insert(sheet_id, sheet_obj);
    }

    let snapshot = json!({
        "id": workbook_id,
        "name": "Imported Workbook",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": {},
        "sheetOrder": sheet_order,
        "sheets": Value::Object(sheets_map),
    });

    let snapshot_json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

    let mut warnings: Vec<CompatibilityWarning> = prepended_warnings;
    warnings.extend(feature_warnings);
    warnings.push(CompatibilityWarning {
        severity: "info".to_string(),
        code: "XLSX_POC_IMPORT".to_string(),
        message:
            "xlsx PoC import: styles, merges, and named ranges are not yet preserved"
                .to_string(),
        affected_sheets: None,
    });

    if is_xlsm {
        // AD-02b / req 5.3.2: VBA macros are never loaded or persisted.
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSM_MACROS_DISCARDED".to_string(),
            message:
                ".xlsm を開きました。VBA マクロは読み込まれず、保存時は .xlsx 形式になります。"
                    .to_string(),
            affected_sheets: None,
        });
    }

    if !large_sheets.is_empty() {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_LARGE_SHEET".to_string(),
            message: format!(
                "One or more sheets exceed {LARGE_SHEET_THRESHOLD} non-empty cells; import may be slow."
            ),
            affected_sheets: Some(large_sheets),
        });
    }

    // For xlsm, derive a sibling .xlsx target so Ctrl+S overwrites the converted
    // copy without touching the macro-bearing original.
    let working_path = if is_xlsm {
        std::path::Path::new(&path)
            .with_extension("xlsx")
            .to_string_lossy()
            .into_owned()
    } else {
        path.clone()
    };

    if is_xlsm && std::path::Path::new(&working_path).exists() {
        let name = std::path::Path::new(&working_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSM_DERIVED_XLSX_EXISTS".to_string(),
            message: format!(
                "保存時の既定ターゲット {} がすでに存在します。Ctrl+S で上書きされる前に「名前を付けて保存」をご検討ください。",
                name
            ),
            affected_sheets: None,
        });
    }

    Ok(ImportWorkbookResult {
        handle: WorkbookHandle {
            workbook_id,
            path: Some(working_path),
            source_type: "xlsx".to_string(),
            snapshot_json: Some(snapshot_json),
        },
        warnings,
    })
}

fn sanitize_sheet_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            _ => c,
        })
        .collect();
    // Excel sheet name length limit is 31 chars (count by chars, not bytes).
    let truncated: String = cleaned.chars().take(31).collect();
    truncated
}

/// Tauri command wrapper: delegates to export_xlsx_core, then on success records
/// the saved path in recent_files so the Home screen lists it.
#[tauri::command]
pub fn workbook_export_xlsx(
    app: tauri::AppHandle,
    path: String,
    snapshot_json: String,
) -> Result<ExportResult, String> {
    let result = export_xlsx_core(path.clone(), snapshot_json)?;
    if result.success {
        let name = std::path::Path::new(&result.path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&result.path)
            .to_string();
        if let Ok(conn) = crate::db::app_db::open_app_db(&app) {
            let _ = crate::db::operations::record_recent_file(&conn, &result.path, &name);
        }
    }
    Ok(result)
}

/// Pure-Rust export core. Directly callable from cargo tests.
pub fn export_xlsx_core(
    path: String,
    snapshot_json: String,
) -> Result<ExportResult, String> {
    // Step 1: extension check
    let ext_ok = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(false);

    if !ext_ok {
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_INVALID_EXTENSION".to_string(),
                message: "Export path must end in .xlsx".to_string(),
                affected_sheets: None,
            }],
            error: Some("XLSX_INVALID_EXTENSION".to_string()),
        });
    }

    // Step 2: parse snapshot
    let snapshot: Value = match serde_json::from_str(&snapshot_json) {
        Ok(v) => v,
        Err(e) => {
            return Ok(ExportResult {
                success: false,
                path: path.clone(),
                warnings: vec![CompatibilityWarning {
                    severity: "blocking".to_string(),
                    code: "XLSX_INVALID_SNAPSHOT".to_string(),
                    message: format!("Failed to parse snapshot JSON: {e}"),
                    affected_sheets: None,
                }],
                error: Some(format!("XLSX_INVALID_SNAPSHOT: {e}")),
            });
        }
    };

    let sheet_order = snapshot
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if sheet_order.is_empty() {
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_EMPTY_SNAPSHOT".to_string(),
                message: "Snapshot has no sheets to export.".to_string(),
                affected_sheets: None,
            }],
            error: Some("XLSX_EMPTY_SNAPSHOT".to_string()),
        });
    }

    let sheets_obj = snapshot.get("sheets").and_then(|v| v.as_object());

    // Step 3: build workbook
    let mut workbook = Workbook::new();
    let mut sheet_count: usize = 0;
    let mut cell_count: usize = 0;
    let mut formula_count: usize = 0;
    let mut sanitized_names: Vec<String> = Vec::new();
    let mut format_cache: HashMap<String, Format> = HashMap::new();

    let build_result: Result<(), String> = (|| -> Result<(), String> {
        for (i, sheet_id_val) in sheet_order.iter().enumerate() {
            let sheet_id = match sheet_id_val.as_str() {
                Some(s) => s,
                None => continue,
            };

            let sheet_obj = sheets_obj.and_then(|m| m.get(sheet_id));

            let raw_name = sheet_obj
                .and_then(|s| s.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");

            let safe_name = if raw_name.is_empty() {
                format!("Sheet{}", i + 1)
            } else {
                let s = sanitize_sheet_name(raw_name);
                if s != raw_name {
                    sanitized_names.push(raw_name.to_string());
                }
                if s.is_empty() {
                    format!("Sheet{}", i + 1)
                } else {
                    s
                }
            };

            let worksheet = workbook.add_worksheet();
            worksheet
                .set_name(&safe_name)
                .map_err(|e| e.to_string())?;

            let cell_data = sheet_obj
                .and_then(|s| s.get("cellData"))
                .and_then(|c| c.as_object());

            if let Some(rows) = cell_data {
                for (row_key, row_val) in rows.iter() {
                    let row_idx: u32 = match row_key.parse().ok() {
                        Some(r) => r,
                        None => continue,
                    };
                    let row_cells = match row_val.as_object() {
                        Some(o) => o,
                        None => continue,
                    };
                    for (col_key, cell_val) in row_cells.iter() {
                        let col_idx: u16 = match col_key.parse().ok() {
                            Some(c) => c,
                            None => continue,
                        };

                        let fmt_str = cell_val.get("_fmt").and_then(|f| f.as_str());
                        let fmt_obj = fmt_str.map(|s| {
                            format_cache
                                .entry(s.to_string())
                                .or_insert_with(|| Format::new().set_num_format(s))
                                .clone()
                        });

                        // Formula takes precedence
                        if let Some(f) = cell_val.get("f").and_then(|f| f.as_str()) {
                            if let Some(ref fmt) = fmt_obj {
                                worksheet
                                    .write_formula_with_format(row_idx, col_idx, f, fmt)
                                    .map_err(|e| e.to_string())?;
                            } else {
                                worksheet
                                    .write_formula(row_idx, col_idx, f)
                                    .map_err(|e| e.to_string())?;
                            }
                            formula_count += 1;
                            cell_count += 1;
                            continue;
                        }

                        if let Some(v) = cell_val.get("v") {
                            match v {
                                Value::Null => continue,
                                Value::Bool(b) => {
                                    worksheet
                                        .write_boolean(row_idx, col_idx, *b)
                                        .map_err(|e| e.to_string())?;
                                }
                                Value::Number(n) => {
                                    let f = n.as_f64().unwrap_or(0.0);
                                    if let Some(ref fmt) = fmt_obj {
                                        worksheet
                                            .write_number_with_format(row_idx, col_idx, f, fmt)
                                            .map_err(|e| e.to_string())?;
                                    } else {
                                        worksheet
                                            .write_number(row_idx, col_idx, f)
                                            .map_err(|e| e.to_string())?;
                                    }
                                }
                                Value::String(s) => {
                                    worksheet
                                        .write_string(row_idx, col_idx, s)
                                        .map_err(|e| e.to_string())?;
                                }
                                Value::Array(_) | Value::Object(_) => {
                                    worksheet
                                        .write_string(row_idx, col_idx, &v.to_string())
                                        .map_err(|e| e.to_string())?;
                                }
                            }
                            cell_count += 1;
                        }
                    }
                }
            }

            sheet_count += 1;
        }
        Ok(())
    })();

    if let Err(e) = build_result {
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_BUILD_FAILED".to_string(),
                message: format!("Failed to build xlsx: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_BUILD_FAILED: {e}")),
        });
    }

    // Step 4: atomic save — rotate backups, write tmp, rename onto target
    let target_path = PathBuf::from(&path);
    let tmp_path = temp_save_path(&target_path);

    if target_path.exists() {
        if let Err(e) = rotate_backups(&target_path) {
            return Ok(ExportResult {
                success: false,
                path: path.clone(),
                warnings: vec![CompatibilityWarning {
                    severity: "blocking".to_string(),
                    code: "XLSX_WRITE_FAILED".to_string(),
                    message: format!("backup rotation failed: {e}"),
                    affected_sheets: None,
                }],
                error: Some(format!("backup rotation failed: {e}")),
            });
        }
    }

    if let Err(e) = workbook.save(&tmp_path) {
        let msg = e.to_string();
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_WRITE_FAILED".to_string(),
                message: format!("Failed to write xlsx: {msg}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_WRITE_FAILED: {msg}")),
        });
    }

    if let Err(e) = std::fs::rename(&tmp_path, &target_path) {
        let msg = e.to_string();
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_WRITE_FAILED".to_string(),
                message: format!("rename failed: {msg}"),
                affected_sheets: None,
            }],
            error: Some(format!("rename failed: {msg}")),
        });
    }

    // Step 5: build warnings
    let mut warnings: Vec<CompatibilityWarning> = Vec::new();
    warnings.push(CompatibilityWarning {
        severity: "info".to_string(),
        code: "XLSX_POC_EXPORT".to_string(),
        message: format!(
            "xlsx PoC export: {sheet_count} sheets, {cell_count} cells, {formula_count} formulas. Styles, merges, column widths, named ranges, and rich text are not yet preserved."
        ),
        affected_sheets: None,
    });

    if !sanitized_names.is_empty() {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_SHEET_NAME_SANITIZED".to_string(),
            message: "One or more sheet names contained illegal characters or exceeded 31 chars; they were sanitized.".to_string(),
            affected_sheets: Some(sanitized_names),
        });
    }

    Ok(ExportResult {
        success: true,
        path,
        warnings,
        error: None,
    })
}

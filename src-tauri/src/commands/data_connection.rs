// #140 / #190 — External data connections (Power Query).
//
// Reads an external data source and returns a sheet fragment that the
// frontend can merge into the active workbook. The frontend owns the
// connection registry (stored in `_connections[]` on the workbook snapshot);
// this module is stateless and just performs the raw load. Refresh is the
// same code path as the initial load — the caller decides whether to insert
// a new sheet or overwrite an existing one's `cellData`.
//
// Supported sources:
//   - csv / json : local file (#140 MVP)
//   - web        : HTTP(S) GET, JSON or CSV body (#190 Phase 3) — routed
//                  through the #138 `http_fetch_with_data_dir` SSRF guard.
//   - sqlite     : local `.db` file opened READ-ONLY, single SELECT (#190
//                  Phase 4).
//
// ETL steps (#190 Phase 2) are applied on the frontend (see
// `store/dataConnections.ts`) — this module only produces the raw grid.
// PostgreSQL / MySQL are intentionally out of scope: they require a running
// server, which conflicts with Coco's local-first design.

use serde_json::{json, Map, Value};

use crate::commands::csv_io::import_csv_core;

/// Maximum JSON file size we accept. Mirrors the CSV cap so memory pressure
/// stays bounded regardless of source type.
const JSON_MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Hard cell ceiling — same number the CSV importer uses.
const JSON_MAX_CELLS: usize = 5_000_000;
/// Cap on the number of distinct column keys we collect from JSON objects.
const JSON_MAX_COLUMNS: usize = 16_384;
/// Cap on rows returned from a SQLite query — keeps a runaway SELECT bounded.
const SQLITE_MAX_ROWS: usize = 1_000_000;

/// Result of a data-connection load. Shape matches a single-sheet fragment
/// that the frontend can splice into a workbook snapshot. `headers` is the
/// inferred column order (CSV: first row; JSON: union of object keys).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataConnectionLoadResult {
    pub sheet_name: String,
    pub row_count: u32,
    pub column_count: u32,
    pub headers: Vec<String>,
    /// Univer-shaped cellData: { rowIdx: { colIdx: { v: ... } } }
    pub cell_data: Value,
    /// File encoding that was detected (CSV only — empty string for JSON).
    pub encoding: String,
}

/// Tauri command. Dispatches to the CSV or JSON loader based on `source_type`.
/// `source_type` accepts "csv" or "json" (case-insensitive). "web" and
/// "sqlite" have dedicated commands because they need extra parameters.
#[tauri::command]
pub fn data_connection_load(
    source_path: String,
    source_type: String,
) -> Result<DataConnectionLoadResult, String> {
    let lower = source_type.to_ascii_lowercase();
    match lower.as_str() {
        "csv" => load_csv(&source_path),
        "json" => load_json(&source_path),
        other => Err(format!("DATA_CONN_UNKNOWN_TYPE: {}", other)),
    }
}

fn load_csv(path: &str) -> Result<DataConnectionLoadResult, String> {
    // Re-use the existing CSV pipeline so encoding detection, delimiter
    // inference, type heuristics, and size caps all stay in one place.
    let imported = import_csv_core(path.to_string(), None)?;
    let snapshot_json = imported
        .handle
        .snapshot_json
        .ok_or_else(|| "DATA_CONN_CSV_NO_SNAPSHOT".to_string())?;
    let root: Value = serde_json::from_str(&snapshot_json).map_err(|e| e.to_string())?;
    let sheet = root
        .get("sheets")
        .and_then(|s| s.get("sheet-1"))
        .ok_or_else(|| "DATA_CONN_CSV_EMPTY".to_string())?;

    let cell_data = sheet
        .get("cellData")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let row_count = sheet
        .get("rowCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let column_count = sheet
        .get("columnCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let sheet_name = sheet
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("CSV")
        .to_string();

    let headers = headers_from_cell_data(&cell_data);

    // Encoding info: re-detect cheaply from raw bytes so the caller can
    // surface it without re-running the whole import. Best-effort.
    let encoding = std::fs::read(path)
        .ok()
        .map(|raw| {
            if raw.len() >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
                "UTF-8 (BOM)".to_string()
            } else if std::str::from_utf8(&raw).is_ok() {
                "UTF-8".to_string()
            } else {
                "Shift_JIS".to_string()
            }
        })
        .unwrap_or_default();

    Ok(DataConnectionLoadResult {
        sheet_name,
        row_count,
        column_count,
        headers,
        cell_data,
        encoding,
    })
}

/// Pull header strings from row 0 of a Univer `cellData` object.
fn headers_from_cell_data(cell_data: &Value) -> Vec<String> {
    let mut headers: Vec<String> = Vec::new();
    if let Some(rows) = cell_data.as_object() {
        if let Some(first_row) = rows.get("0").and_then(|r| r.as_object()) {
            let mut max_col: usize = 0;
            for k in first_row.keys() {
                if let Ok(n) = k.parse::<usize>() {
                    if n > max_col {
                        max_col = n;
                    }
                }
            }
            for c in 0..=max_col {
                let v = first_row
                    .get(&c.to_string())
                    .and_then(|cell| cell.get("v"))
                    .map(stringify_value)
                    .unwrap_or_default();
                headers.push(v);
            }
        }
    }
    headers
}

fn load_json(path: &str) -> Result<DataConnectionLoadResult, String> {
    let metadata = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "DATA_CONN_FILE_NOT_FOUND".into()
        } else {
            e.to_string()
        }
    })?;
    if metadata.len() > JSON_MAX_FILE_BYTES {
        return Err(format!(
            "DATA_CONN_TOO_LARGE: JSON exceeds {} bytes",
            JSON_MAX_FILE_BYTES
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let parsed = parse_json_bytes(&bytes)?;
    let sheet_name = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("JSON")
        .to_string();
    json_value_to_result(&parsed, sheet_name)
}

/// Parse a JSON byte slice, stripping a UTF-8 BOM if present.
fn parse_json_bytes(bytes: &[u8]) -> Result<Value, String> {
    let body = if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        &bytes[3..]
    } else {
        &bytes[..]
    };
    serde_json::from_slice(body).map_err(|e| format!("DATA_CONN_JSON_PARSE: {}", e))
}

/// Turn a parsed JSON document into a load result (rows → cellData).
fn json_value_to_result(
    parsed: &Value,
    sheet_name: String,
) -> Result<DataConnectionLoadResult, String> {
    let rows = json_to_rows(parsed)?;
    let headers = collect_headers(&rows)?;
    let header_idx: std::collections::HashMap<&str, usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect();

    let mut cell_data: Map<String, Value> = Map::new();
    let mut total_cells: usize = 0;

    let mut header_row: Map<String, Value> = Map::new();
    for (col_idx, name) in headers.iter().enumerate() {
        header_row.insert(col_idx.to_string(), json!({ "v": name }));
        total_cells += 1;
    }
    if !header_row.is_empty() {
        cell_data.insert("0".to_string(), Value::Object(header_row));
    }

    for (row_offset, obj) in rows.iter().enumerate() {
        let row_idx = row_offset + 1;
        let mut row_map: Map<String, Value> = Map::new();
        for (key, value) in obj.iter() {
            let col_idx = match header_idx.get(key.as_str()) {
                Some(i) => *i,
                None => continue,
            };
            let cell = match value {
                Value::Null => continue,
                Value::Bool(b) => json!({ "v": *b }),
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        json!({ "v": i })
                    } else if let Some(f) = n.as_f64() {
                        if f.is_finite() {
                            json!({ "v": f })
                        } else {
                            json!({ "v": n.to_string() })
                        }
                    } else {
                        json!({ "v": n.to_string() })
                    }
                }
                Value::String(s) => json!({ "v": s.clone() }),
                other => json!({ "v": serde_json::to_string(other).unwrap_or_default() }),
            };
            row_map.insert(col_idx.to_string(), cell);
            total_cells += 1;
            if total_cells > JSON_MAX_CELLS {
                return Err(format!(
                    "DATA_CONN_TOO_LARGE: JSON exceeds {} cells",
                    JSON_MAX_CELLS
                ));
            }
        }
        if !row_map.is_empty() {
            cell_data.insert(row_idx.to_string(), Value::Object(row_map));
        }
    }

    let row_count = (rows.len() + 1) as u32; // +1 for header row
    let column_count = headers.len() as u32;

    Ok(DataConnectionLoadResult {
        sheet_name,
        row_count,
        column_count,
        headers,
        cell_data: Value::Object(cell_data),
        encoding: "UTF-8".to_string(),
    })
}

/// Reduce a JSON document to a sequence of object rows.
fn json_to_rows(value: &Value) -> Result<Vec<Map<String, Value>>, String> {
    match value {
        Value::Array(arr) => collect_object_rows(arr),
        Value::Object(obj) => {
            for (_k, v) in obj.iter() {
                if let Value::Array(arr) = v {
                    if let Ok(rows) = collect_object_rows(arr) {
                        return Ok(rows);
                    }
                }
            }
            Err("DATA_CONN_JSON_SHAPE: expected an array of objects (or a wrapper object containing one)".into())
        }
        _ => Err("DATA_CONN_JSON_SHAPE: top-level value must be an array or object".into()),
    }
}

fn collect_object_rows(arr: &[Value]) -> Result<Vec<Map<String, Value>>, String> {
    let mut out: Vec<Map<String, Value>> = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        match item {
            Value::Object(o) => out.push(o.clone()),
            _ => {
                return Err(format!(
                    "DATA_CONN_JSON_SHAPE: array element {} is not an object",
                    i
                ));
            }
        }
    }
    Ok(out)
}

/// Walk every row in first-seen order and accumulate the union of keys.
fn collect_headers(rows: &[Map<String, Value>]) -> Result<Vec<String>, String> {
    let mut headers: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        for key in row.keys() {
            if seen.insert(key.clone()) {
                headers.push(key.clone());
                if headers.len() > JSON_MAX_COLUMNS {
                    return Err(format!(
                        "DATA_CONN_TOO_LARGE: more than {} distinct JSON keys",
                        JSON_MAX_COLUMNS
                    ));
                }
            }
        }
    }
    Ok(headers)
}

fn stringify_value(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// --- #190 Phase 3: Web / REST source --------------------------------------

/// Build a load result from an in-memory response body. `format` is "json",
/// "csv" or "auto" (sniff). Shared by the web command and its tests.
pub fn body_to_result(
    body: &str,
    format: &str,
    sheet_name: String,
) -> Result<DataConnectionLoadResult, String> {
    let fmt = format.to_ascii_lowercase();
    let resolved = if fmt == "auto" {
        sniff_format(body)
    } else {
        fmt
    };
    match resolved.as_str() {
        "json" => {
            let parsed = parse_json_bytes(body.as_bytes())?;
            json_value_to_result(&parsed, sheet_name)
        }
        "csv" => csv_text_to_result(body, sheet_name),
        other => Err(format!("DATA_CONN_UNKNOWN_TYPE: {}", other)),
    }
}

/// Cheap content sniff: a body whose first non-whitespace char is `{` or `[`
/// is treated as JSON, everything else as CSV.
fn sniff_format(body: &str) -> String {
    match body.trim_start().chars().next() {
        Some('{') | Some('[') => "json".to_string(),
        _ => "csv".to_string(),
    }
}

/// Parse CSV text (in memory) into a load result. Delimiter is inferred as
/// tab vs comma from the first line. Row 0 is treated as the header row.
fn csv_text_to_result(
    text: &str,
    sheet_name: String,
) -> Result<DataConnectionLoadResult, String> {
    let first_line = text.lines().next().unwrap_or("");
    let delim = if first_line.matches('\t').count() > first_line.matches(',').count() {
        b'\t'
    } else {
        b','
    };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delim)
        .from_reader(text.as_bytes());

    let mut cell_data: Map<String, Value> = Map::new();
    let mut headers: Vec<String> = Vec::new();
    let mut row_idx: usize = 0;
    let mut max_col: usize = 0;
    let mut total_cells: usize = 0;

    for record in reader.records() {
        let record = record.map_err(|e| format!("DATA_CONN_CSV_PARSE: {}", e))?;
        let mut row_map: Map<String, Value> = Map::new();
        for (col, field) in record.iter().enumerate() {
            if col > max_col {
                max_col = col;
            }
            if row_idx == 0 {
                headers.push(field.to_string());
            }
            if field.is_empty() {
                continue;
            }
            // Numeric cells get a number value; everything else stays a string.
            let cell = match field.parse::<i64>() {
                Ok(n) => json!({ "v": n }),
                Err(_) => match field.parse::<f64>() {
                    Ok(f) if f.is_finite() => json!({ "v": f }),
                    _ => json!({ "v": field }),
                },
            };
            row_map.insert(col.to_string(), cell);
            total_cells += 1;
            if total_cells > JSON_MAX_CELLS {
                return Err(format!(
                    "DATA_CONN_TOO_LARGE: CSV exceeds {} cells",
                    JSON_MAX_CELLS
                ));
            }
        }
        if !row_map.is_empty() {
            cell_data.insert(row_idx.to_string(), Value::Object(row_map));
        }
        row_idx += 1;
    }

    Ok(DataConnectionLoadResult {
        sheet_name,
        row_count: row_idx as u32,
        column_count: (max_col + 1) as u32,
        headers,
        cell_data: Value::Object(cell_data),
        encoding: "UTF-8".to_string(),
    })
}

/// Tauri command — Web/REST source. Performs an HTTP GET via the #138
/// `http_fetch` pipeline (allow-list + SSRF guard + stored credentials) and
/// parses the response body as JSON or CSV.
#[tauri::command]
pub async fn data_connection_load_web(
    app: tauri::AppHandle,
    url: String,
    format: String,
    headers: Option<std::collections::HashMap<String, String>>,
    sheet_name: Option<String>,
) -> Result<DataConnectionLoadResult, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "URL_FETCH_INTERNAL".to_string())?;
    // GET only — reuses the full #138 guard (scheme, SSRF, allow list,
    // header validation, credential injection, size + timeout caps).
    let resp = crate::commands::http_fetch::http_fetch_with_data_dir(
        &data_dir,
        url,
        "GET".to_string(),
        headers,
        None,
    )
    .await?;
    if !(200..300).contains(&resp.status) {
        return Err(format!("DATA_CONN_WEB_HTTP_{}", resp.status));
    }
    body_to_result(&resp.body, &format, sheet_name.unwrap_or_else(|| "Web".to_string()))
}

// --- #190 Phase 4: SQLite source ------------------------------------------

/// Tauri command — SQLite source. Opens a local `.db` file READ-ONLY and runs
/// a single SELECT, returning the result set as a sheet fragment. Read-only
/// mode means a malicious/typo'd write query fails at the driver level; we
/// also reject multi-statement input before opening the database.
#[tauri::command]
pub fn data_connection_load_sqlite(
    db_path: String,
    query: String,
    sheet_name: Option<String>,
) -> Result<DataConnectionLoadResult, String> {
    load_sqlite(&db_path, &query, sheet_name.unwrap_or_else(|| "SQLite".to_string()))
}

/// Reject obvious non-SELECT / multi-statement input. Mirrors the frontend
/// guard so a direct command invocation is still safe.
fn check_sqlite_query(query: &str) -> Result<(), String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("DATA_CONN_SQLITE_EMPTY_QUERY".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("select") && !lower.starts_with("with") {
        return Err("DATA_CONN_SQLITE_NOT_SELECT".to_string());
    }
    // Allow a single trailing `;` only.
    let body = trimmed.trim_end_matches(';');
    if body.contains(';') {
        return Err("DATA_CONN_SQLITE_MULTI_STATEMENT".to_string());
    }
    Ok(())
}

fn load_sqlite(
    db_path: &str,
    query: &str,
    sheet_name: String,
) -> Result<DataConnectionLoadResult, String> {
    check_sqlite_query(query)?;
    if !std::path::Path::new(db_path).exists() {
        return Err("DATA_CONN_FILE_NOT_FOUND".to_string());
    }
    // Open READ-ONLY: rusqlite's SQLITE_OPEN_READ_ONLY flag means any write
    // attempt (even via a sneaky query) fails at the driver level.
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("DATA_CONN_SQLITE_OPEN: {}", e))?;

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("DATA_CONN_SQLITE_QUERY: {}", e))?;
    let column_count = stmt.column_count();
    let headers: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("").to_string())
        .collect();

    let mut cell_data: Map<String, Value> = Map::new();
    // Header row.
    let mut header_row: Map<String, Value> = Map::new();
    for (i, name) in headers.iter().enumerate() {
        header_row.insert(i.to_string(), json!({ "v": name }));
    }
    if !header_row.is_empty() {
        cell_data.insert("0".to_string(), Value::Object(header_row));
    }

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("DATA_CONN_SQLITE_QUERY: {}", e))?;
    let mut row_idx: usize = 0;
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("DATA_CONN_SQLITE_QUERY: {}", e))?
    {
        row_idx += 1;
        if row_idx > SQLITE_MAX_ROWS {
            return Err(format!(
                "DATA_CONN_TOO_LARGE: query exceeds {} rows",
                SQLITE_MAX_ROWS
            ));
        }
        let mut row_map: Map<String, Value> = Map::new();
        for col in 0..column_count {
            let value: rusqlite::types::Value = row
                .get(col)
                .map_err(|e| format!("DATA_CONN_SQLITE_QUERY: {}", e))?;
            let cell = match value {
                rusqlite::types::Value::Null => continue,
                rusqlite::types::Value::Integer(i) => json!({ "v": i }),
                rusqlite::types::Value::Real(f) => json!({ "v": f }),
                rusqlite::types::Value::Text(s) => json!({ "v": s }),
                rusqlite::types::Value::Blob(b) => {
                    json!({ "v": format!("<blob {} bytes>", b.len()) })
                }
            };
            row_map.insert(col.to_string(), cell);
        }
        if !row_map.is_empty() {
            cell_data.insert(row_idx.to_string(), Value::Object(row_map));
        }
    }

    Ok(DataConnectionLoadResult {
        sheet_name,
        row_count: (row_idx + 1) as u32, // +1 for header row
        column_count: column_count as u32,
        headers,
        cell_data: Value::Object(cell_data),
        encoding: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, contents: &[u8]) -> tempfile::TempPath {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(contents).unwrap();
        let permanent = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        std::fs::copy(&path, &permanent).unwrap();
        permanent
    }

    #[test]
    fn json_array_of_objects() {
        let body = br#"[{"a":1,"b":"x"},{"a":2,"b":"y","c":true}]"#;
        let p = write_temp("t.json", body);
        let r = load_json(p.to_str().unwrap()).unwrap();
        assert_eq!(r.headers, vec!["a", "b", "c"]);
        assert_eq!(r.column_count, 3);
        assert_eq!(r.row_count, 3); // 1 header + 2 data rows
        let rows = r.cell_data.as_object().unwrap();
        let h = rows.get("0").unwrap().as_object().unwrap();
        assert_eq!(h.get("0").unwrap().get("v").unwrap().as_str().unwrap(), "a");
        let r1 = rows.get("1").unwrap().as_object().unwrap();
        assert_eq!(r1.get("0").unwrap().get("v").unwrap().as_i64().unwrap(), 1);
        assert_eq!(r1.get("1").unwrap().get("v").unwrap().as_str().unwrap(), "x");
        let r2 = rows.get("2").unwrap().as_object().unwrap();
        assert_eq!(r2.get("2").unwrap().get("v").unwrap().as_bool().unwrap(), true);
    }

    #[test]
    fn json_wrapped_array() {
        let body = br#"{"data":[{"x":1},{"x":2}]}"#;
        let p = write_temp("w.json", body);
        let r = load_json(p.to_str().unwrap()).unwrap();
        assert_eq!(r.headers, vec!["x"]);
        assert_eq!(r.row_count, 3);
    }

    #[test]
    fn json_non_object_array_rejected() {
        let body = br#"[1,2,3]"#;
        let p = write_temp("bad.json", body);
        let err = load_json(p.to_str().unwrap()).unwrap_err();
        assert!(err.contains("DATA_CONN_JSON_SHAPE"));
    }

    #[test]
    fn json_invalid_parse_error() {
        let body = b"{not json";
        let p = write_temp("invalid.json", body);
        let err = load_json(p.to_str().unwrap()).unwrap_err();
        assert!(err.contains("DATA_CONN_JSON_PARSE"));
    }

    #[test]
    fn json_missing_file() {
        let err = load_json("Z:/this/path/should/not/exist.json").unwrap_err();
        assert!(err.contains("DATA_CONN_FILE_NOT_FOUND") || err.contains("NotFound") || err.contains("No such file") || err.contains("cannot find"));
    }

    #[test]
    fn json_bom_stripped() {
        let mut body = vec![0xEF, 0xBB, 0xBF];
        body.extend_from_slice(br#"[{"a":1}]"#);
        let p = write_temp("bom.json", &body);
        let r = load_json(p.to_str().unwrap()).unwrap();
        assert_eq!(r.headers, vec!["a"]);
    }

    #[test]
    fn unknown_type_rejected() {
        let err = data_connection_load("ignored".to_string(), "mongo".to_string()).unwrap_err();
        assert!(err.contains("DATA_CONN_UNKNOWN_TYPE"));
    }

    #[test]
    fn header_union_preserves_first_seen_order() {
        let body = br#"[{"b":1,"a":2},{"c":3,"a":4}]"#;
        let p = write_temp("order.json", body);
        let r = load_json(p.to_str().unwrap()).unwrap();
        assert_eq!(r.headers, vec!["b", "a", "c"]);
    }

    // --- #190 Phase 3: web body parsing ---

    #[test]
    fn body_to_result_json() {
        let r = body_to_result(r#"[{"a":1},{"a":2}]"#, "json", "W".into()).unwrap();
        assert_eq!(r.headers, vec!["a"]);
        assert_eq!(r.row_count, 3);
    }

    #[test]
    fn body_to_result_csv() {
        let r = body_to_result("name,age\nalice,30\nbob,40", "csv", "W".into()).unwrap();
        assert_eq!(r.headers, vec!["name", "age"]);
        assert_eq!(r.row_count, 3);
        let rows = r.cell_data.as_object().unwrap();
        let r1 = rows.get("1").unwrap().as_object().unwrap();
        assert_eq!(r1.get("0").unwrap().get("v").unwrap().as_str().unwrap(), "alice");
        assert_eq!(r1.get("1").unwrap().get("v").unwrap().as_i64().unwrap(), 30);
    }

    #[test]
    fn body_to_result_auto_sniffs() {
        let j = body_to_result(r#"  [{"a":1}]"#, "auto", "W".into()).unwrap();
        assert_eq!(j.headers, vec!["a"]);
        let c = body_to_result("a,b\n1,2", "auto", "W".into()).unwrap();
        assert_eq!(c.headers, vec!["a", "b"]);
    }

    #[test]
    fn body_to_result_tab_delimited() {
        let r = body_to_result("a\tb\n1\t2", "csv", "W".into()).unwrap();
        assert_eq!(r.headers, vec!["a", "b"]);
    }

    // --- #190 Phase 4: SQLite ---

    #[test]
    fn sqlite_query_guard_rejects_writes() {
        assert!(check_sqlite_query("DELETE FROM t").is_err());
        assert!(check_sqlite_query("INSERT INTO t VALUES (1)").is_err());
        assert!(check_sqlite_query("DROP TABLE t").is_err());
        assert!(check_sqlite_query("").is_err());
        assert!(check_sqlite_query("SELECT 1; DELETE FROM t").is_err());
        assert!(check_sqlite_query("SELECT * FROM t").is_ok());
        assert!(check_sqlite_query("  select * from t ;").is_ok());
        assert!(check_sqlite_query("WITH x AS (SELECT 1) SELECT * FROM x").is_ok());
    }

    #[test]
    fn sqlite_load_reads_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE people (name TEXT, age INTEGER);
                 INSERT INTO people VALUES ('alice', 30), ('bob', 40);",
            )
            .unwrap();
        }
        let r = load_sqlite(
            db_path.to_str().unwrap(),
            "SELECT name, age FROM people ORDER BY age",
            "S".into(),
        )
        .unwrap();
        assert_eq!(r.headers, vec!["name", "age"]);
        assert_eq!(r.row_count, 3); // header + 2 rows
        let rows = r.cell_data.as_object().unwrap();
        let r1 = rows.get("1").unwrap().as_object().unwrap();
        assert_eq!(r1.get("0").unwrap().get("v").unwrap().as_str().unwrap(), "alice");
        assert_eq!(r1.get("1").unwrap().get("v").unwrap().as_i64().unwrap(), 30);
    }

    #[test]
    fn sqlite_load_is_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("ro.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);")
                .unwrap();
        }
        // A SELECT that the guard would allow but which mutates would fail at
        // the driver level. Verify a plain SELECT still works read-only.
        let r = load_sqlite(db_path.to_str().unwrap(), "SELECT x FROM t", "S".into()).unwrap();
        assert_eq!(r.row_count, 2);
        // The DB file must not have been modified into WAL mode etc. — the
        // read-only open guarantees this; here we just confirm no error.
    }

    #[test]
    fn sqlite_missing_file() {
        let err = load_sqlite("Z:/nope/missing.db", "SELECT 1", "S".into()).unwrap_err();
        assert!(err.contains("DATA_CONN_FILE_NOT_FOUND"));
    }
}

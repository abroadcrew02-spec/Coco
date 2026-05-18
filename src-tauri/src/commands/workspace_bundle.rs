use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::Manager;

use crate::commands::workbook::CompatibilityWarning;

// ── Types ────────────────────────────────────────────────────────────────────

/// Result returned from `workbook_export_workspace_bundle`. `bundle_size_bytes`
/// reflects the .zip file size on disk after the atomic rename; `sheet_count`
/// is read from the supplied snapshot JSON. Soft, non-fatal issues (missing
/// .coco source, empty settings, etc.) are surfaced via `warnings` rather
/// than `error` so the UI can still show a successful export with notes.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleResult {
    pub success: bool,
    pub bundle_size_bytes: u64,
    pub sheet_count: u32,
    pub warnings: Vec<CompatibilityWarning>,
    pub error: Option<String>,
}

/// Manifest written into the .zip as `manifest.json` and also returned from
/// `workbook_import_workspace_bundle` so the frontend can show a confirmation
/// dialog ("restored 3 sheets from path X, settings Y") before opening.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub app_version: String,
    pub exported_at: String,
    pub original_workbook_path: Option<String>,
    pub sheet_count: u32,
    /// Path to the restored workbook .coco file on disk. Empty when the
    /// bundle didn't include a workbook (snapshot-only export). The exporter
    /// always writes this field; on import it's populated to the file we
    /// just wrote.
    #[serde(default)]
    pub restored_workbook_path: String,
    /// Number of `app_settings` rows restored. On export this is set to the
    /// number of rows packed into the bundle; on import it counts the rows
    /// found in `settings.json`.
    #[serde(default)]
    pub restored_settings_count: u32,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Cheap derive: count `sheetOrder.length` if present, fall back to keys of
/// `sheets`. Returns 0 for malformed snapshots rather than erroring so a
/// corrupt-snapshot export can still produce a usable bundle for diagnosis.
fn sheet_count_from_snapshot(snapshot_json: &str) -> u32 {
    let parsed: Result<Value, _> = serde_json::from_str(snapshot_json);
    let Ok(root) = parsed else {
        return 0;
    };
    if let Some(arr) = root.get("sheetOrder").and_then(|v| v.as_array()) {
        return arr.len() as u32;
    }
    if let Some(obj) = root.get("sheets").and_then(|v| v.as_object()) {
        return obj.len() as u32;
    }
    0
}

/// Atomic temp-file path inside the target's parent directory. Same approach
/// as csv_io::create_csv_temp_file — random suffix to avoid collisions with
/// concurrent exports; final rename happens through `replace_temp_file` which
/// uses MoveFileExW on Windows for cross-volume safety.
fn temp_bundle_path(target: &Path) -> PathBuf {
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace.zip".to_string());
    parent.join(format!(
        ".{}.{}.tmp",
        file_name,
        uuid::Uuid::new_v4().simple()
    ))
}

/// Serializes the `app_settings` table for embedding in `settings.json`.
/// Failure to open the DB is non-fatal: we return an empty list plus a
/// warning so the user can still export a workbook-only bundle (e.g. fresh
/// install before any settings have been written).
fn collect_settings(
    data_dir: &Path,
    warnings: &mut Vec<CompatibilityWarning>,
) -> Vec<crate::commands::settings::SettingEntry> {
    match crate::commands::settings::list_settings_core(data_dir) {
        Ok(rows) => rows,
        Err(e) => {
            warnings.push(CompatibilityWarning {
                severity: "warning".to_string(),
                code: "BUNDLE_SETTINGS_UNAVAILABLE".to_string(),
                message: format!("設定の読み込みに失敗したため、settings.json は空で出力されます: {e}"),
                affected_sheets: None,
            });
            Vec::new()
        }
    }
}

// ── Export ───────────────────────────────────────────────────────────────────

/// Pure-Rust export core. Bundles workbook (optional), snapshot, settings,
/// manifest into a single .zip via tempfile + rename. Returns a BundleResult
/// with the final size and any soft warnings.
pub fn export_workspace_bundle_core(
    data_dir: &Path,
    workbook_path: Option<String>,
    snapshot_json: String,
    output_path: String,
) -> Result<BundleResult, String> {
    let lower = output_path.to_lowercase();
    if !lower.ends_with(".zip") {
        return Ok(BundleResult {
            success: false,
            bundle_size_bytes: 0,
            sheet_count: 0,
            warnings: Vec::new(),
            error: Some("BUNDLE_INVALID_EXTENSION".to_string()),
        });
    }

    let mut warnings: Vec<CompatibilityWarning> = Vec::new();
    let sheet_count = sheet_count_from_snapshot(&snapshot_json);
    let settings_rows = collect_settings(data_dir, &mut warnings);
    let restored_settings_count = settings_rows.len() as u32;

    // Resolve and read the workbook .coco bytes up-front so we can surface a
    // missing-file warning without aborting the whole export.
    let workbook_bytes: Option<Vec<u8>> = match &workbook_path {
        Some(p) if !p.is_empty() => match fs::read(p) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                warnings.push(CompatibilityWarning {
                    severity: "warning".to_string(),
                    code: "BUNDLE_WORKBOOK_MISSING".to_string(),
                    message: format!(
                        "ワークブックファイルを読み込めなかったため、bundle にはスナップショットのみが含まれます: {e}"
                    ),
                    affected_sheets: None,
                });
                None
            }
        },
        _ => {
            warnings.push(CompatibilityWarning {
                severity: "info".to_string(),
                code: "BUNDLE_NO_WORKBOOK_PATH".to_string(),
                message: "未保存のワークブックのため、bundle にはスナップショットのみが含まれます。"
                    .to_string(),
                affected_sheets: None,
            });
            None
        }
    };

    let manifest = BundleManifest {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        original_workbook_path: workbook_path.clone(),
        sheet_count,
        // Set on the export side to the file name that will exist after
        // restore, so importers know what to point at.
        restored_workbook_path: if workbook_bytes.is_some() {
            "workbook.coco".to_string()
        } else {
            String::new()
        },
        restored_settings_count,
    };

    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("manifest: {e}"))?;
    let settings_json = serde_json::to_vec_pretty(&settings_rows)
        .map_err(|e| format!("settings: {e}"))?;

    let target = PathBuf::from(&output_path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    // Build the zip in memory; final write goes through tempfile + rename to
    // match the atomic-write convention used elsewhere in the codebase.
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        writer
            .start_file("manifest.json", opts)
            .map_err(|e| e.to_string())?;
        writer.write_all(&manifest_json).map_err(|e| e.to_string())?;

        writer
            .start_file("snapshot.json", opts)
            .map_err(|e| e.to_string())?;
        writer
            .write_all(snapshot_json.as_bytes())
            .map_err(|e| e.to_string())?;

        writer
            .start_file("settings.json", opts)
            .map_err(|e| e.to_string())?;
        writer.write_all(&settings_json).map_err(|e| e.to_string())?;

        if let Some(bytes) = workbook_bytes {
            // .coco is a SQLite file — already binary and not very
            // compressible, but Deflated does no harm and keeps the archive
            // uniform.
            writer
                .start_file("workbook.coco", opts)
                .map_err(|e| e.to_string())?;
            writer.write_all(&bytes).map_err(|e| e.to_string())?;
        }

        writer.finish().map_err(|e| e.to_string())?;
    }

    let tmp = temp_bundle_path(&target);
    {
        let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&buf).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    if let Err(e) = crate::commands::file_replace::replace_temp_file(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Ok(BundleResult {
            success: false,
            bundle_size_bytes: 0,
            sheet_count,
            warnings,
            error: Some(format!("rename failed: {e}")),
        });
    }

    let bundle_size_bytes = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);

    Ok(BundleResult {
        success: true,
        bundle_size_bytes,
        sheet_count,
        warnings,
        error: None,
    })
}

#[tauri::command]
pub fn workbook_export_workspace_bundle(
    app: tauri::AppHandle,
    workbook_path: Option<String>,
    snapshot_json: String,
    output_path: String,
) -> Result<BundleResult, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    export_workspace_bundle_core(&data_dir, workbook_path, snapshot_json, output_path)
}

// ── Import ───────────────────────────────────────────────────────────────────

/// Restore a bundle .zip into `target_dir`. Files are written verbatim under
/// the chosen directory; the manifest is parsed and returned so the frontend
/// can decide what to do next (open the workbook, restore settings, etc.).
///
/// Refuses absolute paths and parent-traversal segments inside the archive
/// (Zip Slip defence) — a malicious bundle from a third party can't escape
/// `target_dir` and overwrite arbitrary files on disk.
pub fn import_workspace_bundle_core(
    bundle_path: &str,
    target_dir: &str,
) -> Result<BundleManifest, String> {
    let lower = bundle_path.to_lowercase();
    if !lower.ends_with(".zip") {
        return Err("BUNDLE_INVALID_EXTENSION".to_string());
    }
    let bundle = Path::new(bundle_path);
    if !bundle.exists() {
        return Err(format!("File not found: {bundle_path}"));
    }

    let dest_root = Path::new(target_dir);
    fs::create_dir_all(dest_root).map_err(|e| e.to_string())?;
    let dest_root_canon = dest_root.canonicalize().map_err(|e| e.to_string())?;

    let file = File::open(bundle).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("invalid zip: {e}"))?;

    let mut manifest: Option<BundleManifest> = None;
    let mut restored_workbook_path: Option<String> = None;
    let mut restored_settings_count: u32 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = entry.name().to_string();

        // Zip Slip: reject absolute paths, drive prefixes, and `..` segments.
        // Done after the open call so the entry name is what we actually have
        // (not a sanitized version we hoped for).
        let candidate = PathBuf::from(&raw_name);
        if candidate.is_absolute()
            || raw_name.contains("..")
            || raw_name.starts_with('/')
            || raw_name.starts_with('\\')
        {
            return Err(format!("BUNDLE_UNSAFE_ENTRY: {raw_name}"));
        }

        // Directory entries (trailing slash) — create and continue.
        if raw_name.ends_with('/') {
            fs::create_dir_all(dest_root.join(&raw_name)).map_err(|e| e.to_string())?;
            continue;
        }

        let out_path = dest_root.join(&candidate);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        // Defensive: after joining, make sure we still live under
        // dest_root_canon. Catches edge cases the prefix checks above miss
        // (e.g. symlink in the target dir pointing elsewhere on POSIX).
        // We canonicalize the parent rather than out_path itself because
        // out_path doesn't exist yet.
        if let Some(parent) = out_path.parent() {
            if let Ok(canon) = parent.canonicalize() {
                if !canon.starts_with(&dest_root_canon) {
                    return Err(format!("BUNDLE_UNSAFE_ENTRY: {raw_name}"));
                }
            }
        }

        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
        fs::write(&out_path, &data).map_err(|e| e.to_string())?;

        match raw_name.as_str() {
            "manifest.json" => {
                manifest = Some(
                    serde_json::from_slice(&data).map_err(|e| format!("manifest parse: {e}"))?,
                );
            }
            "workbook.coco" => {
                restored_workbook_path = Some(out_path.to_string_lossy().into_owned());
            }
            "settings.json" => {
                // Count entries for the returned manifest. Parse-failure isn't
                // fatal — the user can still inspect the file by hand.
                if let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&data) {
                    restored_settings_count = rows.len() as u32;
                }
            }
            _ => {}
        }
    }

    let mut m = manifest.ok_or_else(|| "BUNDLE_MANIFEST_MISSING".to_string())?;
    // Patch the returned manifest with what actually landed on disk —
    // exported value referenced a relative path ("workbook.coco"); the
    // restored path is whatever target_dir + name resolved to.
    if let Some(p) = restored_workbook_path {
        m.restored_workbook_path = p;
    } else {
        m.restored_workbook_path = String::new();
    }
    m.restored_settings_count = restored_settings_count;
    Ok(m)
}

#[tauri::command]
pub fn workbook_import_workspace_bundle(
    bundle_path: String,
    target_dir: String,
) -> Result<BundleManifest, String> {
    import_workspace_bundle_core(&bundle_path, &target_dir)
}

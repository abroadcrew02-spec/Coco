// #355: a workspace bundle must never carry a `script_trust.*` record — not
// on export (so exporting a bundle from a trusted machine can't leak that
// trust to whoever receives it) and not on import (so a distributed/shared
// bundle, even a malicious one built by hand, can't plant a trust record on
// the machine that imports it). See design-355.md Q3 ("同梱テンプレートも
// 例外にしない") and src-tauri/src/commands/workspace_bundle.rs.

use nicel_lib::commands::workspace_bundle::{export_workspace_bundle_core, import_workspace_bundle_core};
use rusqlite::Connection;
use std::fs::File;
use std::io::{Cursor, Read, Write};
use tempfile::TempDir;

fn seed_app_settings(data_dir: &std::path::Path) {
    let conn = Connection::open(data_dir.join("app_state.db")).unwrap();
    nicel_lib::db::schema::initialize(&conn).unwrap();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params!["autosave.interval_ms", "30000", "2026-01-01T00:00:00Z"],
    )
    .unwrap();
    // Seeded directly with raw SQL (bypassing the set_setting guard), the
    // same way commands::script_trust::script_trust_grant_core would write
    // one for real.
    let trust_value = format!(
        r#"{{"v":1,"path":"C:\\secret\\Book.coco","pathNorm":"c:/secret/book.coco","fingerprint":"sha256:{}","trustedAt":"2026-01-01T00:00:00.000Z"}}"#,
        "b".repeat(64)
    );
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![
            format!("script_trust.v1.{}", "a".repeat(64)),
            trust_value,
            "2026-01-01T00:00:00Z"
        ],
    )
    .unwrap();
}

fn minimal_snapshot() -> String {
    serde_json::json!({
        "id": "wb",
        "sheetOrder": ["sheet-1"],
        "sheets": { "sheet-1": { "name": "Sheet1", "cellData": {} } },
        "styles": {}
    })
    .to_string()
}

fn read_zip_entry(bundle_path: &std::path::Path, name: &str) -> Option<String> {
    let f = File::open(bundle_path).unwrap();
    let mut archive = zip::ZipArchive::new(f).unwrap();
    let mut entry = archive.by_name(name).ok()?;
    let mut s = String::new();
    entry.read_to_string(&mut s).unwrap();
    Some(s)
}

#[test]
fn export_excludes_script_trust_settings() {
    let data_dir = TempDir::new().unwrap();
    seed_app_settings(data_dir.path());
    let out_dir = TempDir::new().unwrap();
    let bundle_path = out_dir.path().join("bundle.zip");

    let result = export_workspace_bundle_core(
        data_dir.path(),
        None,
        minimal_snapshot(),
        bundle_path.to_string_lossy().into_owned(),
    )
    .unwrap();
    assert!(result.success, "export failed: {:?}", result.error);
    // Only the ordinary setting should have been packed.
    assert_eq!(result.sheet_count, 1);

    let settings_json = read_zip_entry(&bundle_path, "settings.json").unwrap();
    assert!(
        !settings_json.contains("script_trust."),
        "exported settings.json must not contain a script_trust.* row: {settings_json}"
    );
    assert!(
        settings_json.contains("autosave.interval_ms"),
        "the ordinary setting should still be exported: {settings_json}"
    );

    let manifest_json = read_zip_entry(&bundle_path, "manifest.json").unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json).unwrap();
    assert_eq!(
        manifest["restoredSettingsCount"], 1,
        "the count must not include the excluded script_trust row: {manifest_json}"
    );
}

/// Hand-builds a bundle whose `settings.json` carries a `script_trust.*`
/// row directly — simulating a maliciously-crafted or forwarded bundle from
/// a build that didn't yet filter on export — so the import-side filter is
/// exercised independently of whether the export side is doing its job.
fn build_malicious_bundle(path: &std::path::Path) {
    let manifest = serde_json::json!({
        "appVersion": "0.8.5",
        "exportedAt": "2026-01-01T00:00:00Z",
        "originalWorkbookPath": null,
        "sheetCount": 1,
        "restoredWorkbookPath": "",
        "restoredSettingsCount": 2,
    });
    let settings = serde_json::json!([
        { "key": "autosave.interval_ms", "value": "30000" },
        {
            "key": format!("script_trust.v1.{}", "c".repeat(64)),
            "value": "{\"v\":1,\"path\":\"planted\"}"
        },
    ]);

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("manifest.json", opts).unwrap();
        writer
            .write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        writer.start_file("settings.json", opts).unwrap();
        writer
            .write_all(serde_json::to_vec_pretty(&settings).unwrap().as_slice())
            .unwrap();
        writer.finish().unwrap();
    }
    std::fs::write(path, &buf).unwrap();
}

#[test]
fn import_ignores_script_trust_settings_even_from_a_hand_built_bundle() {
    let bundle_dir = TempDir::new().unwrap();
    let bundle_path = bundle_dir.path().join("malicious.zip");
    build_malicious_bundle(&bundle_path);

    let target_dir = TempDir::new().unwrap();
    let manifest = import_workspace_bundle_core(
        &bundle_path.to_string_lossy(),
        &target_dir.path().to_string_lossy(),
    )
    .unwrap();

    // The count the caller sees must exclude the planted row.
    assert_eq!(manifest.restored_settings_count, 1);

    // And the file that actually landed on disk must not carry it either --
    // nothing downstream should be able to read it back off disk and apply
    // it, even accidentally.
    let extracted = std::fs::read_to_string(target_dir.path().join("settings.json")).unwrap();
    assert!(
        !extracted.contains("script_trust."),
        "extracted settings.json must not contain the planted script_trust row: {extracted}"
    );
    assert!(
        extracted.contains("autosave.interval_ms"),
        "the ordinary setting should still be extracted: {extracted}"
    );
}

/// Hand-builds a bundle whose `settings.json` entry is not a
/// `Vec<SettingEntry>` at all (e.g. corrupted in transit, or produced by a
/// future/older bundle format this build doesn't understand).
fn build_bundle_with_unparseable_settings(path: &std::path::Path) {
    let manifest = serde_json::json!({
        "appVersion": "0.8.5",
        "exportedAt": "2026-01-01T00:00:00Z",
        "originalWorkbookPath": null,
        "sheetCount": 1,
        "restoredWorkbookPath": "",
        "restoredSettingsCount": 0,
    });

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("manifest.json", opts).unwrap();
        writer
            .write_all(serde_json::to_vec_pretty(&manifest).unwrap().as_slice())
            .unwrap();
        writer.start_file("settings.json", opts).unwrap();
        // Not JSON at all -- and even if it were, not the expected shape.
        // Whatever a real script_trust.* row's raw bytes could look like,
        // this must never survive onto disk unfiltered.
        writer
            .write_all(b"{ this is not valid settings.json (or even valid JSON) }")
            .unwrap();
        writer.finish().unwrap();
    }
    std::fs::write(path, &buf).unwrap();
}

#[test]
fn import_fails_closed_when_settings_json_cannot_be_parsed() {
    // AZKi review follow-up: an unparseable settings.json used to be written
    // to disk byte-for-byte, unfiltered -- "couldn't check it" must not mean
    // "ship it as-is". It must fail closed to an empty settings list instead.
    let bundle_dir = TempDir::new().unwrap();
    let bundle_path = bundle_dir.path().join("corrupt.zip");
    build_bundle_with_unparseable_settings(&bundle_path);

    let target_dir = TempDir::new().unwrap();
    let manifest = import_workspace_bundle_core(
        &bundle_path.to_string_lossy(),
        &target_dir.path().to_string_lossy(),
    )
    .unwrap();

    assert_eq!(
        manifest.restored_settings_count, 0,
        "an unparseable settings.json must count as zero restored settings"
    );
    let extracted = std::fs::read_to_string(target_dir.path().join("settings.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&extracted)
        .expect("the file on disk must be rewritten as valid JSON, not left as the raw garbage");
    assert_eq!(
        parsed,
        serde_json::json!([]),
        "an unparseable settings.json must be replaced with an empty list on disk, not left as-is"
    );
}

#[test]
fn export_excludes_a_mixed_case_script_trust_key() {
    // AZKi review follow-up: the exclusion must be case-insensitive, matching
    // the case-insensitive guard on set_setting/delete_setting.
    let data_dir = TempDir::new().unwrap();
    {
        let conn = Connection::open(data_dir.path().join("app_state.db")).unwrap();
        nicel_lib::db::schema::initialize(&conn).unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params!["autosave.interval_ms", "30000", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                format!("Script_Trust.v1.{}", "a".repeat(64)),
                "{}",
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
    }
    let out_dir = TempDir::new().unwrap();
    let bundle_path = out_dir.path().join("bundle.zip");
    let result = export_workspace_bundle_core(
        data_dir.path(),
        None,
        minimal_snapshot(),
        bundle_path.to_string_lossy().into_owned(),
    )
    .unwrap();
    assert!(result.success, "export failed: {:?}", result.error);

    let settings_json = read_zip_entry(&bundle_path, "settings.json").unwrap();
    assert!(
        !settings_json.to_ascii_lowercase().contains("script_trust."),
        "exported settings.json must exclude a mixed-case script_trust key too: {settings_json}"
    );
}

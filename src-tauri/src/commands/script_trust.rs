//! #355 script trust store — Rust persistence layer for "may this workbook's
//! embedded scripts / auto-refreshing data connections run without asking".
//!
//! Contract (corrected 2026-09-29 once the TS side, `src/store/scriptTrust.ts`,
//! landed): TS owns path normalization and fingerprint hashing entirely.
//! This module is a **validated key/value store** scoped to `script_trust.*`
//! keys — it does not normalize a path or compute a hash itself.
//!
//! PM (Coco) was explicit about the shape of this regardless of that
//! correction: a `script_trust.*` row must only ever be written or erased by
//! the four commands in this file, never through the generic `set_setting` /
//! `delete_setting` (see the guard on those in `db::operations`) — otherwise
//! a script could grant itself execution by writing its own "always trust"
//! record. This file talks to `app_settings` with its own SQL rather than
//! calling into `db::operations::set_setting` et al., which is what makes
//! that guarantee hold even though both live in the same table.
//!
//! Validation performed here (everything else is TS's business):
//! - `key` must match `^script_trust\.v1\.[0-9a-f]{64}$` exactly (checked by
//!   hand below rather than pulling in the `regex` crate for one fixed
//!   pattern) — `script_trust_check` / `script_trust_grant` /
//!   `script_trust_revoke` all reject a key that doesn't.
//! - `value` (on `script_trust_grant` only) must parse as JSON, be an
//!   object, have `v == 1`, string `path` and `pathNorm`, a `fingerprint`
//!   matching `^sha256:[0-9a-f]{64}$`, a string `trustedAt`, and be no
//!   larger than `MAX_TRUST_VALUE_BYTES`. `summary` is not required and not
//!   otherwise validated — its shape is TS's concern.
//!
//! Records are ordinary `app_settings` rows, one per key, stored and
//! returned verbatim (Rust never re-serializes or reshapes the value string
//! TS hands it).

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use crate::db::app_db::open_app_db_at;

/// Every persisted trust key starts with this (see
/// `db::operations::SCRIPT_TRUST_KEY_PREFIX`, which is the same string —
/// duplicated as a `&str` constant here rather than imported, since the two
/// modules check it for different reasons and neither needs the other's).
const SCRIPT_TRUST_KEY_VERSION_PREFIX: &str = "script_trust.v1.";

/// PM's "例えば 8 KiB" — an upper bound on a single trust record, generous
/// enough for `path` + `pathNorm` + a handful of `summary` fields, tight
/// enough that `set_setting`'s ordinary (unbounded) values can't be smuggled
/// in as an oversized "trust" record.
const MAX_TRUST_VALUE_BYTES: usize = 8 * 1024;

/// What `script_trust_list` returns: the raw key and raw value string,
/// verbatim. No reshaping — TS is the one that knows how to interpret a
/// `TrustRecord`.
#[derive(Debug, Clone, Serialize)]
pub struct TrustListEntry {
    pub key: String,
    pub value: String,
}

// ---------------------------------------------------------------------------
// Key validation — `^script_trust\.v1\.[0-9a-f]{64}$`
// ---------------------------------------------------------------------------

fn is_lowercase_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_valid_trust_key(key: &str) -> bool {
    match key.strip_prefix(SCRIPT_TRUST_KEY_VERSION_PREFIX) {
        Some(hex) => is_lowercase_hex(hex, 64),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

fn is_valid_fingerprint(s: &str) -> bool {
    match s.strip_prefix("sha256:") {
        Some(hex) => is_lowercase_hex(hex, 64),
        None => false,
    }
}

/// Validates the shape PM specified (see module doc comment). Returns the
/// first violation found, as a short machine-and-human-readable reason —
/// this is surfaced verbatim to the TS caller via the command's `Err`.
fn validate_trust_value(value: &str) -> Result<(), String> {
    if value.len() > MAX_TRUST_VALUE_BYTES {
        return Err(format!(
            "script_trust value exceeds {MAX_TRUST_VALUE_BYTES} bytes"
        ));
    }
    let parsed: Value =
        serde_json::from_str(value).map_err(|e| format!("script_trust value is not valid JSON: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "script_trust value must be a JSON object".to_string())?;

    if obj.get("v").and_then(Value::as_i64) != Some(1) {
        return Err("script_trust value must have \"v\": 1".to_string());
    }
    if !matches!(obj.get("path"), Some(Value::String(_))) {
        return Err("script_trust value must have a string \"path\"".to_string());
    }
    if !matches!(obj.get("pathNorm"), Some(Value::String(_))) {
        return Err("script_trust value must have a string \"pathNorm\"".to_string());
    }
    let fingerprint = obj
        .get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| "script_trust value must have a string \"fingerprint\"".to_string())?;
    if !is_valid_fingerprint(fingerprint) {
        return Err(
            "script_trust value \"fingerprint\" must be \"sha256:\" followed by 64 lowercase hex characters"
                .to_string(),
        );
    }
    if !matches!(obj.get("trustedAt"), Some(Value::String(_))) {
        return Err("script_trust value must have a string \"trustedAt\"".to_string());
    }
    // `summary` is optional and not otherwise validated here — TS's concern.
    Ok(())
}

fn read_value(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// Pure-Rust cores
// ---------------------------------------------------------------------------

/// Returns the stored value string for `key`, or `None` if there is no
/// record. Errors only when `key` itself is malformed (not a valid
/// `script_trust.v1.<64 hex>` key) or the DB can't be opened — a missing
/// record is `Ok(None)`, not an error.
pub fn script_trust_check_core(data_dir: &Path, key: &str) -> Result<Option<String>, String> {
    if !is_valid_trust_key(key) {
        return Err(format!("invalid script trust key: {key}"));
    }
    let conn = open_app_db_at(data_dir)?;
    Ok(read_value(&conn, key))
}

/// Writes (or overwrites — one record per key) `value` under `key`. Rejects
/// a malformed key or a `value` that fails `validate_trust_value` outright,
/// before anything touches the DB.
pub fn script_trust_grant_core(data_dir: &Path, key: &str, value: &str) -> Result<(), String> {
    if !is_valid_trust_key(key) {
        return Err(format!("invalid script trust key: {key}"));
    }
    validate_trust_value(value)?;
    let now = chrono::Utc::now().to_rfc3339();
    let conn = open_app_db_at(data_dir)?;
    // Raw SQL, deliberately NOT `db::operations::set_setting` — see the
    // module doc comment for why.
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Lists every `script_trust.v1.*` row as `{ key, value }`, ordered by key.
/// Every row here was written by `script_trust_grant_core`, which already
/// validated both halves, so no re-validation is done on the way out — a
/// hand-edited/corrupt row (outside normal operation) is simply handed back
/// as-is for the caller to deal with, same as `script_trust_check_core`
/// never re-validates what it reads.
pub fn script_trust_list_core(data_dir: &Path) -> Result<Vec<TrustListEntry>, String> {
    let conn = open_app_db_at(data_dir)?;
    let like_pattern = format!("{SCRIPT_TRUST_KEY_VERSION_PREFIX}%");
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_settings WHERE key LIKE ?1 ORDER BY key")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![like_pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let (key, value) = r.map_err(|e| e.to_string())?;
        out.push(TrustListEntry { key, value });
    }
    Ok(out)
}

/// Deletes the record at `key`, if any. A no-op (not an error) when there is
/// no record — matches `delete_setting`'s existing "delete of a missing key
/// is fine" behavior. Still rejects a malformed key outright.
pub fn script_trust_revoke_core(data_dir: &Path, key: &str) -> Result<(), String> {
    if !is_valid_trust_key(key) {
        return Err(format!("invalid script trust key: {key}"));
    }
    let conn = open_app_db_at(data_dir)?;
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri wrappers
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn script_trust_check(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    script_trust_check_core(&data_dir, &key)
}

#[tauri::command]
pub fn script_trust_grant(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    script_trust_grant_core(&data_dir, &key, &value)
}

#[tauri::command]
pub fn script_trust_list(app: tauri::AppHandle) -> Result<Vec<TrustListEntry>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    script_trust_list_core(&data_dir)
}

#[tauri::command]
pub fn script_trust_revoke(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    script_trust_revoke_core(&data_dir, &key)
}

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
//! - `script_trust_grant` additionally checks that the key's 64 hex digits
//!   equal `sha256(value.pathNorm)` (AZKi review follow-up) — so a caller
//!   can't file a grant for path A's normalized form under a key that
//!   `script_trust_check` would only ever look up for path B. This hashes
//!   whatever `pathNorm` string the value already contains, verbatim; TS's
//!   `normalizeTrustPath` itself is deliberately NOT ported into Rust (see
//!   the contract note above — Rust only checks shape/consistency, TS is the
//!   one authority on what "normalized" means).
//!
//! Records are ordinary `app_settings` rows, one per key, stored and
//! returned verbatim (Rust never re-serializes or reshapes the value string
//! TS hands it).

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::db::app_db::open_app_db_at;

/// Every persisted trust key starts with this. Kept as its own literal
/// (rather than built from `SCRIPT_TRUST_KEY_PREFIX` with `concat!`, which
/// needs a literal on both sides and would still duplicate the "v1." text
/// here anyway) — `key_version_prefix_extends_the_reserved_prefix` in this
/// file's tests pins that the two stay consistent instead of just asserting
/// it in prose.
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
/// value's `pathNorm` on success — the one field `script_trust_grant_core`
/// needs again afterward (to cross-check it against the key), so this
/// doesn't leave the caller to re-parse the same JSON a second time. Returns
/// the first violation found, as a short machine-and-human-readable reason;
/// this is surfaced verbatim to the TS caller via the command's `Err`.
fn validate_trust_value(value: &str) -> Result<String, String> {
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
    let path_norm = obj
        .get("pathNorm")
        .and_then(Value::as_str)
        .ok_or_else(|| "script_trust value must have a string \"pathNorm\"".to_string())?;
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
    Ok(path_norm.to_string())
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// "script_trust.v1.<sha256hex(pathNorm)>" — the key `script_trust_grant_core`
/// requires the caller's `key` argument to equal, given the value's own
/// `pathNorm`. Hashes `path_norm` exactly as given; see the module doc
/// comment for why Rust doesn't normalize it itself.
fn expected_key_for_path_norm(path_norm: &str) -> String {
    format!("{SCRIPT_TRUST_KEY_VERSION_PREFIX}{}", sha256_hex(path_norm))
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
    let path_norm = validate_trust_value(value)?;
    // AZKi review follow-up: the key must actually be sha256(pathNorm), not
    // just any syntactically-valid key — otherwise a grant for one path's
    // normalized form could be filed under an unrelated key (or a key this
    // caller doesn't have any other reason to control), and `script_trust_
    // check` would then find it under the wrong lookup.
    let expected_key = expected_key_for_path_norm(&path_norm);
    if key != expected_key {
        return Err(
            "script_trust key does not match sha256(pathNorm) of the value's \"pathNorm\""
                .to_string(),
        );
    }
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
///
/// AZKi review follow-up: this used to be `key LIKE 'script_trust.v1.%'` —
/// same two problems as `db::operations::list_settings` had (`_` is a
/// wildcard in `LIKE`, and SQLite's `LIKE` is already ASCII
/// case-insensitive by accident). `substr(...) = ?1` with an explicit
/// `LOWER(...)` fixes both the same way: a plain, deliberately
/// case-insensitive byte comparison, no wildcard semantics, length taken
/// from `SCRIPT_TRUST_KEY_VERSION_PREFIX.len()` so it can't drift.
pub fn script_trust_list_core(data_dir: &Path) -> Result<Vec<TrustListEntry>, String> {
    let conn = open_app_db_at(data_dir)?;
    let prefix_len = SCRIPT_TRUST_KEY_VERSION_PREFIX.len();
    let sql = format!(
        "SELECT key, value FROM app_settings \
         WHERE LOWER(substr(key, 1, {prefix_len})) = ?1 ORDER BY key"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![SCRIPT_TRUST_KEY_VERSION_PREFIX], |row| {
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

#[cfg(test)]
mod prefix_consistency_tests {
    //! AZKi review follow-up: this file and `db::operations` each define a
    //! prefix constant (`SCRIPT_TRUST_KEY_VERSION_PREFIX` here,
    //! `SCRIPT_TRUST_KEY_PREFIX` there) rather than sharing one — a stale
    //! doc comment here used to claim they were "the same string", which was
    //! simply wrong (`"script_trust.v1."` != `"script_trust."`). This pins
    //! the relationship that's actually supposed to hold instead of just
    //! asserting it in prose: every key this module's `is_valid_trust_key`
    //! accepts must also be one `db::operations::has_script_trust_prefix`
    //! reserves, so the generic `set_setting`/`delete_setting` guard and
    //! `list_settings` exclusion can never miss a key this file would
    //! legitimately write.

    use super::{is_valid_trust_key, SCRIPT_TRUST_KEY_VERSION_PREFIX};
    use crate::db::operations::{has_script_trust_prefix, SCRIPT_TRUST_KEY_PREFIX};

    #[test]
    fn key_version_prefix_extends_the_reserved_prefix() {
        assert!(
            SCRIPT_TRUST_KEY_VERSION_PREFIX.starts_with(SCRIPT_TRUST_KEY_PREFIX),
            "{SCRIPT_TRUST_KEY_VERSION_PREFIX:?} must extend {SCRIPT_TRUST_KEY_PREFIX:?}"
        );
    }

    #[test]
    fn every_syntactically_valid_trust_key_is_reserved_by_the_generic_guard() {
        let key = format!("script_trust.v1.{}", "a".repeat(64));
        assert!(is_valid_trust_key(&key));
        assert!(has_script_trust_prefix(&key));
    }
}

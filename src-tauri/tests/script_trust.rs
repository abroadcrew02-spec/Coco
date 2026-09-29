// #355 script trust store — Rust side is a validated key/value store scoped
// to `script_trust.*` keys (see src-tauri/src/commands/script_trust.rs's
// module doc comment for the full contract). TS owns path normalization and
// fingerprint hashing; these tests only exercise the Rust-side validation +
// storage contract (including the AZKi follow-up that `key == sha256(value.
// pathNorm)`), not any path/hash logic that belongs to TS.

use nicel_lib::commands::script_trust::{
    script_trust_check_core, script_trust_grant_core, script_trust_list_core,
    script_trust_revoke_core,
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

// A syntactically valid key: "script_trust.v1." + 64 lowercase hex chars.
// Used ONLY in tests where the *value* is expected to fail validation before
// the key/pathNorm cross-check would ever run — it deliberately does not
// match sha256 of any pathNorm used here.
const VALID_KEY: &str = "script_trust.v1.0000000000000000000000000000000000000000000000000000000000000000";

const DEFAULT_PATH_NORM: &str = "c:/users/a/book.coco";
const OTHER_PATH_NORM: &str = "c:/users/a/other.coco";

/// Mirrors `expected_key_for_path_norm` in script_trust.rs so tests can
/// build a (key, value) pair that the cross-check actually accepts, without
/// hardcoding a precomputed hash that would silently go stale if the
/// algorithm ever changed.
fn key_for_path_norm(path_norm: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path_norm.as_bytes());
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    format!("script_trust.v1.{hex}")
}

fn valid_value_for(path: &str, path_norm: &str) -> String {
    // JSON-escape backslashes so a Windows-style `path` (e.g. "C:\Users\...")
    // round-trips as valid JSON rather than an invalid escape sequence.
    let escaped_path = path.replace('\\', "\\\\");
    format!(
        r#"{{"v":1,"path":"{escaped_path}","pathNorm":"{path_norm}","fingerprint":"sha256:{}","trustedAt":"2026-09-29T00:00:00.000Z"}}"#,
        "a".repeat(64)
    )
}

fn valid_value(path: &str) -> String {
    valid_value_for(path, DEFAULT_PATH_NORM)
}

fn matching_key() -> String {
    key_for_path_norm(DEFAULT_PATH_NORM)
}

#[test]
fn check_returns_none_for_unregistered_key() {
    let tmp = TempDir::new().unwrap();
    let v = script_trust_check_core(tmp.path(), &matching_key()).unwrap();
    assert_eq!(v, None);
}

#[test]
fn grant_then_check_roundtrips_the_exact_value_string() {
    let tmp = TempDir::new().unwrap();
    let key = matching_key();
    let value = valid_value("C:\\Users\\a\\Book.coco");
    script_trust_grant_core(tmp.path(), &key, &value).unwrap();
    let v = script_trust_check_core(tmp.path(), &key).unwrap();
    // Stored and returned byte-for-byte -- Rust never reshapes the value.
    assert_eq!(v.as_deref(), Some(value.as_str()));
}

#[test]
fn grant_overwrites_the_existing_record_for_the_same_key() {
    let tmp = TempDir::new().unwrap();
    let key = matching_key();
    script_trust_grant_core(tmp.path(), &key, &valid_value("first.coco")).unwrap();
    script_trust_grant_core(tmp.path(), &key, &valid_value("second.coco")).unwrap();
    let v = script_trust_check_core(tmp.path(), &key).unwrap().unwrap();
    assert!(v.contains("second.coco"));
    assert!(!v.contains("first.coco"));
    // One row per key, not one per grant.
    assert_eq!(script_trust_list_core(tmp.path()).unwrap().len(), 1);
}

#[test]
fn revoke_removes_the_record() {
    let tmp = TempDir::new().unwrap();
    let key = matching_key();
    script_trust_grant_core(tmp.path(), &key, &valid_value("book.coco")).unwrap();
    assert!(script_trust_check_core(tmp.path(), &key).unwrap().is_some());
    script_trust_revoke_core(tmp.path(), &key).unwrap();
    assert_eq!(script_trust_check_core(tmp.path(), &key).unwrap(), None);
}

#[test]
fn revoke_on_missing_key_is_a_noop() {
    let tmp = TempDir::new().unwrap();
    // Just shouldn't error, matching delete_setting's existing behavior.
    script_trust_revoke_core(tmp.path(), &matching_key()).unwrap();
}

#[test]
fn list_returns_every_granted_record_as_key_value_pairs() {
    let tmp = TempDir::new().unwrap();
    let key_a = key_for_path_norm(DEFAULT_PATH_NORM);
    let key_b = key_for_path_norm(OTHER_PATH_NORM);
    script_trust_grant_core(tmp.path(), &key_a, &valid_value_for("a.coco", DEFAULT_PATH_NORM))
        .unwrap();
    script_trust_grant_core(tmp.path(), &key_b, &valid_value_for("b.coco", OTHER_PATH_NORM))
        .unwrap();
    let mut entries = script_trust_list_core(tmp.path()).unwrap();
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    assert_eq!(entries.len(), 2);
    let mut keys: Vec<&str> = entries.iter().map(|e| e.key.as_str()).collect();
    keys.sort();
    let mut expected = vec![key_a.as_str(), key_b.as_str()];
    expected.sort();
    assert_eq!(keys, expected);
    assert!(entries.iter().any(|e| e.value.contains("a.coco")));
    assert!(entries.iter().any(|e| e.value.contains("b.coco")));
}

#[test]
fn list_is_empty_when_nothing_granted() {
    let tmp = TempDir::new().unwrap();
    assert!(script_trust_list_core(tmp.path()).unwrap().is_empty());
}

// ── Key validation: ^script_trust\.v1\.[0-9a-f]{64}$ ────────────────────────

#[test]
fn check_rejects_a_key_with_wrong_prefix() {
    let tmp = TempDir::new().unwrap();
    let bad = format!("script_trust.v2.{}", "a".repeat(64));
    assert!(script_trust_check_core(tmp.path(), &bad).is_err());
}

#[test]
fn check_rejects_a_key_with_too_short_hash() {
    let tmp = TempDir::new().unwrap();
    let bad = format!("script_trust.v1.{}", "a".repeat(63));
    assert!(script_trust_check_core(tmp.path(), &bad).is_err());
}

#[test]
fn check_rejects_a_key_with_uppercase_hash() {
    let tmp = TempDir::new().unwrap();
    let bad = format!("script_trust.v1.{}", "A".repeat(64));
    assert!(script_trust_check_core(tmp.path(), &bad).is_err());
}

#[test]
fn check_rejects_a_key_with_trailing_garbage() {
    let tmp = TempDir::new().unwrap();
    let bad = format!("script_trust.v1.{}extra", "a".repeat(64));
    assert!(script_trust_check_core(tmp.path(), &bad).is_err());
}

#[test]
fn check_rejects_a_completely_unrelated_key() {
    let tmp = TempDir::new().unwrap();
    assert!(script_trust_check_core(tmp.path(), "autosave.interval_ms").is_err());
}

#[test]
fn grant_rejects_a_malformed_key_without_writing_anything() {
    let tmp = TempDir::new().unwrap();
    let bad = "script_trust.v1.not-hex-at-all";
    assert!(script_trust_grant_core(tmp.path(), bad, &valid_value("x.coco")).is_err());
    assert!(script_trust_list_core(tmp.path()).unwrap().is_empty());
}

#[test]
fn revoke_rejects_a_malformed_key() {
    let tmp = TempDir::new().unwrap();
    assert!(script_trust_revoke_core(tmp.path(), "script_trust.v1.short").is_err());
}

// ── Value validation ─────────────────────────────────────────────────────────
// (VALID_KEY is fine here -- these all fail inside validate_trust_value,
// before the key/pathNorm cross-check would ever run.)

#[test]
fn grant_rejects_non_json_value() {
    let tmp = TempDir::new().unwrap();
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, "not json").is_err());
}

#[test]
fn grant_rejects_a_json_array_instead_of_an_object() {
    let tmp = TempDir::new().unwrap();
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, "[1,2,3]").is_err());
}

#[test]
fn grant_rejects_version_other_than_1() {
    let tmp = TempDir::new().unwrap();
    let value = format!(
        r#"{{"v":2,"path":"x","pathNorm":"x","fingerprint":"sha256:{}","trustedAt":"2026-01-01"}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, &value).is_err());
}

#[test]
fn grant_rejects_missing_path() {
    let tmp = TempDir::new().unwrap();
    let value = format!(
        r#"{{"v":1,"pathNorm":"x","fingerprint":"sha256:{}","trustedAt":"2026-01-01"}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, &value).is_err());
}

#[test]
fn grant_rejects_missing_path_norm() {
    let tmp = TempDir::new().unwrap();
    let value = format!(
        r#"{{"v":1,"path":"x","fingerprint":"sha256:{}","trustedAt":"2026-01-01"}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, &value).is_err());
}

#[test]
fn grant_rejects_missing_trusted_at() {
    let tmp = TempDir::new().unwrap();
    let value = format!(
        r#"{{"v":1,"path":"x","pathNorm":"x","fingerprint":"sha256:{}"}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, &value).is_err());
}

#[test]
fn grant_rejects_fingerprint_without_sha256_prefix() {
    let tmp = TempDir::new().unwrap();
    let value = format!(
        r#"{{"v":1,"path":"x","pathNorm":"x","fingerprint":"{}","trustedAt":"2026-01-01"}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, &value).is_err());
}

#[test]
fn grant_rejects_fingerprint_with_short_hash() {
    let tmp = TempDir::new().unwrap();
    let value = r#"{"v":1,"path":"x","pathNorm":"x","fingerprint":"sha256:abcd","trustedAt":"2026-01-01"}"#;
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, value).is_err());
}

#[test]
fn grant_rejects_oversized_value() {
    let tmp = TempDir::new().unwrap();
    // Pad well past the 8 KiB budget with an otherwise-valid shape.
    let padding = "x".repeat(9 * 1024);
    let value = format!(
        r#"{{"v":1,"path":"{padding}","pathNorm":"x","fingerprint":"sha256:{}","trustedAt":"2026-01-01"}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, &value).is_err());
}

#[test]
fn grant_accepts_an_optional_summary_field() {
    let tmp = TempDir::new().unwrap();
    let key = matching_key();
    let value = format!(
        r#"{{"v":1,"path":"x","pathNorm":"{DEFAULT_PATH_NORM}","fingerprint":"sha256:{}","trustedAt":"2026-01-01","summary":{{"scripts":2,"autoConnections":1}}}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), &key, &value).is_ok());
}

// ── Key/value cross-check: key must equal sha256(value.pathNorm) (AZKi) ─────

#[test]
fn grant_accepts_a_key_that_matches_sha256_of_path_norm() {
    let tmp = TempDir::new().unwrap();
    let key = matching_key();
    let value = valid_value("C:\\Users\\a\\Book.coco");
    assert!(script_trust_grant_core(tmp.path(), &key, &value).is_ok());
}

#[test]
fn grant_rejects_a_syntactically_valid_key_that_does_not_match_path_norm() {
    let tmp = TempDir::new().unwrap();
    // VALID_KEY passes the regex but is not sha256 of DEFAULT_PATH_NORM (or
    // of anything else used here).
    let value = valid_value("C:\\Users\\a\\Book.coco");
    let result = script_trust_grant_core(tmp.path(), VALID_KEY, &value);
    assert!(result.is_err());
    assert!(script_trust_list_core(tmp.path()).unwrap().is_empty());
}

#[test]
fn grant_rejects_a_key_that_matches_a_different_path_norm() {
    let tmp = TempDir::new().unwrap();
    // key_for(A) used with a value whose pathNorm is B: each half is
    // individually well-formed, but they don't agree with each other.
    let key_for_a = key_for_path_norm(DEFAULT_PATH_NORM);
    let value_for_b = valid_value_for("other.coco", OTHER_PATH_NORM);
    assert!(script_trust_grant_core(tmp.path(), &key_for_a, &value_for_b).is_err());
}

// ── list_core must not use LIKE's wildcard semantics (AZKi) ─────────────────

#[test]
fn list_does_not_include_a_row_whose_key_only_like_wildcards_would_match() {
    // Regression: `key LIKE 'script_trust.v1.%'` treats the `_` in
    // "script_trust" as "match any one character", so a row keyed
    // "scriptXtrust.v1.<hex>" used to come back from script_trust_list_core
    // even though it was never written by script_trust_grant_core (which
    // requires the literal "script_trust.v1." prefix). Seeded directly with
    // raw SQL since grant_core itself would reject this key outright.
    let tmp = TempDir::new().unwrap();
    {
        use rusqlite::Connection;
        let conn = Connection::open(tmp.path().join("app_state.db")).unwrap();
        nicel_lib::db::schema::initialize(&conn).unwrap();
        let key = format!("scriptXtrust.v1.{}", "a".repeat(64));
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, "{}", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
    }
    assert!(
        script_trust_list_core(tmp.path()).unwrap().is_empty(),
        "a key only LIKE's wildcard would match must not be listed"
    );
}

// ── #355: keys are isolated from the generic `app_settings` surface is
// covered in tests/settings.rs (set_setting_rejects_script_trust_prefixed_keys
// etc.), not duplicated here.

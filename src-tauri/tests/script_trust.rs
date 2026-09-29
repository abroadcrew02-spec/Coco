// #355 script trust store — Rust side is a validated key/value store scoped
// to `script_trust.*` keys (see src-tauri/src/commands/script_trust.rs's
// module doc comment for the full contract). TS owns path normalization and
// fingerprint hashing; these tests only exercise the Rust-side validation +
// storage contract, not any path/hash logic.

use nicel_lib::commands::script_trust::{
    script_trust_check_core, script_trust_grant_core, script_trust_list_core,
    script_trust_revoke_core,
};
use tempfile::TempDir;

// A syntactically valid key: "script_trust.v1." + 64 lowercase hex chars.
const VALID_KEY: &str = "script_trust.v1.0000000000000000000000000000000000000000000000000000000000000000";
const VALID_KEY_2: &str = "script_trust.v1.1111111111111111111111111111111111111111111111111111111111111111";

fn valid_value(path: &str) -> String {
    // JSON-escape backslashes so a Windows-style `path` (e.g. "C:\Users\...")
    // round-trips as valid JSON rather than an invalid escape sequence.
    let escaped_path = path.replace('\\', "\\\\");
    format!(
        r#"{{"v":1,"path":"{escaped_path}","pathNorm":"c:/users/a/book.coco","fingerprint":"sha256:{}","trustedAt":"2026-09-29T00:00:00.000Z"}}"#,
        "a".repeat(64)
    )
}

#[test]
fn check_returns_none_for_unregistered_key() {
    let tmp = TempDir::new().unwrap();
    let v = script_trust_check_core(tmp.path(), VALID_KEY).unwrap();
    assert_eq!(v, None);
}

#[test]
fn grant_then_check_roundtrips_the_exact_value_string() {
    let tmp = TempDir::new().unwrap();
    let value = valid_value("C:\\Users\\a\\Book.coco");
    script_trust_grant_core(tmp.path(), VALID_KEY, &value).unwrap();
    let v = script_trust_check_core(tmp.path(), VALID_KEY).unwrap();
    // Stored and returned byte-for-byte -- Rust never reshapes the value.
    assert_eq!(v.as_deref(), Some(value.as_str()));
}

#[test]
fn grant_overwrites_the_existing_record_for_the_same_key() {
    let tmp = TempDir::new().unwrap();
    script_trust_grant_core(tmp.path(), VALID_KEY, &valid_value("first.coco")).unwrap();
    script_trust_grant_core(tmp.path(), VALID_KEY, &valid_value("second.coco")).unwrap();
    let v = script_trust_check_core(tmp.path(), VALID_KEY).unwrap().unwrap();
    assert!(v.contains("second.coco"));
    assert!(!v.contains("first.coco"));
    // One row per key, not one per grant.
    assert_eq!(script_trust_list_core(tmp.path()).unwrap().len(), 1);
}

#[test]
fn revoke_removes_the_record() {
    let tmp = TempDir::new().unwrap();
    script_trust_grant_core(tmp.path(), VALID_KEY, &valid_value("book.coco")).unwrap();
    assert!(script_trust_check_core(tmp.path(), VALID_KEY).unwrap().is_some());
    script_trust_revoke_core(tmp.path(), VALID_KEY).unwrap();
    assert_eq!(script_trust_check_core(tmp.path(), VALID_KEY).unwrap(), None);
}

#[test]
fn revoke_on_missing_key_is_a_noop() {
    let tmp = TempDir::new().unwrap();
    // Just shouldn't error, matching delete_setting's existing behavior.
    script_trust_revoke_core(tmp.path(), VALID_KEY).unwrap();
}

#[test]
fn list_returns_every_granted_record_as_key_value_pairs() {
    let tmp = TempDir::new().unwrap();
    script_trust_grant_core(tmp.path(), VALID_KEY, &valid_value("a.coco")).unwrap();
    script_trust_grant_core(tmp.path(), VALID_KEY_2, &valid_value("b.coco")).unwrap();
    let mut entries = script_trust_list_core(tmp.path()).unwrap();
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].key, VALID_KEY);
    assert!(entries[0].value.contains("a.coco"));
    assert_eq!(entries[1].key, VALID_KEY_2);
    assert!(entries[1].value.contains("b.coco"));
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
    let value = format!(
        r#"{{"v":1,"path":"x","pathNorm":"x","fingerprint":"sha256:{}","trustedAt":"2026-01-01","summary":{{"scripts":2,"autoConnections":1}}}}"#,
        "a".repeat(64)
    );
    assert!(script_trust_grant_core(tmp.path(), VALID_KEY, &value).is_ok());
}

// ── #355: keys are isolated from the generic `app_settings` surface is
// covered in tests/settings.rs (set_setting_rejects_script_trust_prefixed_keys
// etc.), not duplicated here.

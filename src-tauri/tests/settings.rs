use nicel_lib::commands::settings::{
    delete_setting_core, get_setting_core, list_settings_core, set_setting_core,
};
use tempfile::TempDir;

#[test]
fn get_setting_returns_none_for_missing_key() {
    let tmp = TempDir::new().unwrap();
    let v = get_setting_core(tmp.path(), "no.such.key").unwrap();
    assert_eq!(v, None);
}

#[test]
fn set_and_get_roundtrips() {
    let tmp = TempDir::new().unwrap();
    set_setting_core(tmp.path(), "autosave.interval_ms", "30000").unwrap();
    let v = get_setting_core(tmp.path(), "autosave.interval_ms").unwrap();
    assert_eq!(v.as_deref(), Some("30000"));
}

#[test]
fn set_overwrites_existing_value() {
    let tmp = TempDir::new().unwrap();
    set_setting_core(tmp.path(), "k", "v1").unwrap();
    set_setting_core(tmp.path(), "k", "v2").unwrap();
    let v = get_setting_core(tmp.path(), "k").unwrap();
    assert_eq!(v.as_deref(), Some("v2"));
}

#[test]
fn list_settings_returns_all_in_alpha_order() {
    let tmp = TempDir::new().unwrap();
    set_setting_core(tmp.path(), "zeta", "z").unwrap();
    set_setting_core(tmp.path(), "alpha", "a").unwrap();
    set_setting_core(tmp.path(), "mu", "m").unwrap();
    let entries = list_settings_core(tmp.path()).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].key, "alpha");
    assert_eq!(entries[0].value, "a");
    assert_eq!(entries[1].key, "mu");
    assert_eq!(entries[2].key, "zeta");
}

#[test]
fn delete_setting_removes_row() {
    let tmp = TempDir::new().unwrap();
    set_setting_core(tmp.path(), "ephemeral", "x").unwrap();
    assert!(get_setting_core(tmp.path(), "ephemeral").unwrap().is_some());
    delete_setting_core(tmp.path(), "ephemeral").unwrap();
    assert!(get_setting_core(tmp.path(), "ephemeral").unwrap().is_none());
}

#[test]
fn delete_setting_on_missing_key_is_noop() {
    let tmp = TempDir::new().unwrap();
    // Just shouldn't error.
    delete_setting_core(tmp.path(), "nonexistent").unwrap();
}

// ── #355: the generic settings surface must not touch `script_trust.*` ─────
// (that's reserved for the dedicated script_trust_* commands — see
// db::operations::SCRIPT_TRUST_KEY_PREFIX and commands::script_trust for the
// full "why": a generic write path here would let a script grant itself
// execution by writing its own "always trust" record.)

#[test]
fn set_setting_rejects_script_trust_prefixed_keys() {
    let tmp = TempDir::new().unwrap();
    let result = set_setting_core(
        tmp.path(),
        "script_trust.v1.deadbeef",
        r#"{"v":1,"path":"C:\\evil.coco"}"#,
    );
    assert!(result.is_err(), "set_setting must reject a script_trust.* key");
    // And the rejection must not have written anything.
    assert_eq!(
        get_setting_core(tmp.path(), "script_trust.v1.deadbeef").unwrap(),
        None
    );
}

#[test]
fn delete_setting_rejects_script_trust_prefixed_keys() {
    let tmp = TempDir::new().unwrap();
    // Seed a row the normal way (bypassing the guard, as script_trust.rs's
    // own commands do) so there's something a buggy delete_setting could
    // have removed.
    {
        use rusqlite::Connection;
        let conn = Connection::open(tmp.path().join("app_state.db")).unwrap();
        nicel_lib::db::schema::initialize(&conn).unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params!["script_trust.v1.deadbeef", "{}", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
    }
    let result = delete_setting_core(tmp.path(), "script_trust.v1.deadbeef");
    assert!(
        result.is_err(),
        "delete_setting must reject a script_trust.* key"
    );
}

#[test]
fn list_settings_never_returns_script_trust_prefixed_keys() {
    let tmp = TempDir::new().unwrap();
    set_setting_core(tmp.path(), "ordinary.setting", "1").unwrap();
    // Seed a script_trust row directly (bypassing the guard) so we can prove
    // list_settings excludes it even though it exists in the same table.
    {
        use rusqlite::Connection;
        let conn = Connection::open(tmp.path().join("app_state.db")).unwrap();
        nicel_lib::db::schema::initialize(&conn).unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params!["script_trust.v1.deadbeef", "{}", "2026-01-01T00:00:00Z"],
        )
        .unwrap();
    }
    let entries = list_settings_core(tmp.path()).unwrap();
    assert_eq!(entries.len(), 1, "only the ordinary setting should be listed");
    assert_eq!(entries[0].key, "ordinary.setting");
}

#[test]
fn settings_are_isolated_between_data_dirs() {
    let tmp_a = TempDir::new().unwrap();
    let tmp_b = TempDir::new().unwrap();
    set_setting_core(tmp_a.path(), "k", "from-a").unwrap();
    let from_a = get_setting_core(tmp_a.path(), "k").unwrap();
    let from_b = get_setting_core(tmp_b.path(), "k").unwrap();
    assert_eq!(from_a.as_deref(), Some("from-a"));
    assert_eq!(from_b, None);
}

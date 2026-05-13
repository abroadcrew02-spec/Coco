use coco_lib::commands::settings::{
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

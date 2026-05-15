use crate::db::app_db::{open_app_db, open_app_db_at};
use std::path::Path;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingEntry {
    pub key: String,
    pub value: String,
}

// Pure-Rust cores
pub fn get_setting_core(data_dir: &Path, key: &str) -> Result<Option<String>, String> {
    let conn = open_app_db_at(data_dir)?;
    crate::db::operations::get_setting(&conn, key).map_err(|e| e.to_string())
}

pub fn set_setting_core(data_dir: &Path, key: &str, value: &str) -> Result<(), String> {
    let conn = open_app_db_at(data_dir)?;
    crate::db::operations::set_setting(&conn, key, value).map_err(|e| e.to_string())
}

pub fn list_settings_core(data_dir: &Path) -> Result<Vec<SettingEntry>, String> {
    let conn = open_app_db_at(data_dir)?;
    let rows = crate::db::operations::list_settings(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(k, v)| SettingEntry { key: k, value: v })
        .collect())
}

pub fn delete_setting_core(data_dir: &Path, key: &str) -> Result<(), String> {
    let conn = open_app_db_at(data_dir)?;
    crate::db::operations::delete_setting(&conn, key).map_err(|e| e.to_string())
}

// Tauri wrappers
#[tauri::command]
pub fn get_setting(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let conn = open_app_db(&app)?;
    crate::db::operations::get_setting(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = open_app_db(&app)?;
    crate::db::operations::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_settings(app: tauri::AppHandle) -> Result<Vec<SettingEntry>, String> {
    let conn = open_app_db(&app)?;
    let rows = crate::db::operations::list_settings(&conn).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(k, v)| SettingEntry { key: k, value: v })
        .collect())
}

#[tauri::command]
pub fn delete_setting(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let conn = open_app_db(&app)?;
    crate::db::operations::delete_setting(&conn, &key).map_err(|e| e.to_string())
}

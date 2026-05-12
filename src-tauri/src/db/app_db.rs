use rusqlite::Connection;
use std::path::Path;
use tauri::Manager;

/// Pure-Rust core. Tests pass a `TempDir` path; the Tauri wrapper resolves the
/// real `app_data_dir`. Both call this.
pub fn open_app_db_at(data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("app_state.db");
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    crate::db::schema::initialize(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Tauri-aware wrapper. Resolves the app data dir from the handle and opens
/// `app_state.db` inside it (creating the directory if needed).
pub fn open_app_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    open_app_db_at(&data_dir)
}

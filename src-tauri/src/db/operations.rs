use crate::error::{NicelError, Result};
use rusqlite::Connection;

/// #355: prefix of every persisted script-trust record key
/// (`script_trust.v1.<sha256hex(pathNorm)>`, see `commands::script_trust`).
/// `set_setting` / `delete_setting` refuse any key under this prefix, and
/// `list_settings` never returns one — so the generic settings surface can't
/// write, erase, or leak a trust record. Writing/deleting these keys is only
/// possible through the dedicated `script_trust_*` commands, which talk to
/// `app_settings` directly rather than through this module (PM/Coco's call:
/// if the generic path could touch these rows, a script could grant itself
/// execution by writing its own trust record).
pub const SCRIPT_TRUST_KEY_PREFIX: &str = "script_trust.";

/// Cap on how many recent entries are persisted in the recent_files table.
/// With the inline filter on the HomeScreen, a higher cap is now useful:
/// power users juggle 20–30 working files and benefit from a stable history.
/// Older entries can still be cleared via "すべて削除".
pub const RECENT_FILES_LIMIT: usize = 30;

// Record a file open in recent files (keep last RECENT_FILES_LIMIT)
pub fn record_recent_file(conn: &Connection, path: &str, name: &str) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO recent_files (path, name, last_opened) VALUES (?1, ?2, ?3)",
        rusqlite::params![path, name, now],
    )?;
    conn.execute(
        "DELETE FROM recent_files WHERE path NOT IN (SELECT path FROM recent_files ORDER BY last_opened DESC LIMIT ?1)",
        rusqlite::params![RECENT_FILES_LIMIT as i64],
    )?;
    Ok(())
}

pub fn list_recent_files(conn: &Connection) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, last_opened FROM recent_files ORDER BY last_opened DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(rusqlite::params![RECENT_FILES_LIMIT as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

pub fn remove_recent_file(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM recent_files WHERE path = ?1",
        rusqlite::params![path],
    )?;
    Ok(())
}

pub fn clear_recent_files(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM recent_files", [])?;
    Ok(())
}

pub fn save_recovery_candidate(
    conn: &Connection,
    candidate_id: &str,
    original_path: Option<&str>,
    temp_path: &str,
    reason: &str,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO recovery_candidates (candidate_id, original_path, saved_at, reason, temp_path) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![candidate_id, original_path, now, reason, temp_path],
    )?;
    Ok(())
}

pub fn list_recovery_candidates(
    conn: &Connection,
) -> Result<Vec<(String, Option<String>, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT candidate_id, original_path, saved_at, reason, temp_path FROM recovery_candidates ORDER BY saved_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

pub fn delete_recovery_candidate(conn: &Connection, candidate_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM recovery_candidates WHERE candidate_id = ?1",
        rusqlite::params![candidate_id],
    )?;
    Ok(())
}

/// Deliberately NOT guarded against `script_trust.*` (unlike `set_setting` /
/// `delete_setting` / `list_settings`): a read-only lookup of a trust
/// record's raw JSON can't grant a script anything by itself — the actual
/// trust decision only ever comes from `script_trust_check`, which compares
/// path *and* hash. Only the write/erase/enumerate surface needed closing.
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let row: std::result::Result<String, rusqlite::Error> = conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    );
    match row {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    if key.starts_with(SCRIPT_TRUST_KEY_PREFIX) {
        return Err(NicelError::Rejected(format!(
            "'{SCRIPT_TRUST_KEY_PREFIX}*' keys are reserved for the script trust commands and cannot be written through set_setting"
        )));
    }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now],
    )?;
    Ok(())
}

/// Never returns a `script_trust.*` row (filtered in SQL, not just in Rust,
/// so there's no path through this function that forgets to exclude them).
pub fn list_settings(conn: &Connection) -> Result<Vec<(String, String)>> {
    let exclude_pattern = format!("{SCRIPT_TRUST_KEY_PREFIX}%");
    let mut stmt =
        conn.prepare("SELECT key, value FROM app_settings WHERE key NOT LIKE ?1 ORDER BY key")?;
    let rows = stmt.query_map(rusqlite::params![exclude_pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_setting(conn: &Connection, key: &str) -> Result<()> {
    if key.starts_with(SCRIPT_TRUST_KEY_PREFIX) {
        return Err(NicelError::Rejected(format!(
            "'{SCRIPT_TRUST_KEY_PREFIX}*' keys are reserved for the script trust commands and cannot be deleted through delete_setting"
        )));
    }
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
    )?;
    Ok(())
}

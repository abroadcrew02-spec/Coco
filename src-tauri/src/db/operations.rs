use rusqlite::Connection;
use crate::error::Result;

// Record a file open in recent files (keep last 10)
pub fn record_recent_file(conn: &Connection, path: &str, name: &str) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO recent_files (path, name, last_opened) VALUES (?1, ?2, ?3)",
        rusqlite::params![path, name, now],
    )?;
    // Keep only 10 most recent
    conn.execute(
        "DELETE FROM recent_files WHERE path NOT IN (SELECT path FROM recent_files ORDER BY last_opened DESC LIMIT 10)",
        [],
    )?;
    Ok(())
}

pub fn list_recent_files(conn: &Connection) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, last_opened FROM recent_files ORDER BY last_opened DESC LIMIT 10",
    )?;
    let rows = stmt.query_map([], |row| {
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

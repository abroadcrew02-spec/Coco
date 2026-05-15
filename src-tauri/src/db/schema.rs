use crate::error::Result;
use rusqlite::Connection;

pub const CURRENT_SCHEMA_VERSION: i64 = 1;
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL,
            app_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workbook_meta (
            workbook_id TEXT PRIMARY KEY,
            app_version TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            source_path TEXT,
            source_type TEXT NOT NULL CHECK (source_type IN ('new', 'coco', 'xlsx', 'csv')),
            calc_mode TEXT NOT NULL CHECK (calc_mode IN ('auto', 'manual')),
            locale TEXT NOT NULL DEFAULT 'ja-JP',
            encrypted INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS workbook_snapshots (
            snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
            workbook_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reason TEXT NOT NULL CHECK (reason IN ('manual_save', 'auto_save', 'backup', 'migration')),
            FOREIGN KEY (workbook_id) REFERENCES workbook_meta(workbook_id)
        );

        CREATE TABLE IF NOT EXISTS sheets (
            sheet_id TEXT PRIMARY KEY,
            workbook_id TEXT NOT NULL,
            name TEXT NOT NULL,
            sheet_order INTEGER NOT NULL,
            hidden INTEGER NOT NULL DEFAULT 0,
            default_col_width REAL,
            default_row_height REAL,
            freeze_json TEXT,
            FOREIGN KEY (workbook_id) REFERENCES workbook_meta(workbook_id)
        );

        CREATE TABLE IF NOT EXISTS cells (
            sheet_id TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            col_index INTEGER NOT NULL,
            value_type TEXT NOT NULL CHECK (value_type IN ('blank', 'string', 'number', 'boolean', 'date', 'error', 'formula')),
            raw_value TEXT,
            display_value TEXT,
            formula TEXT,
            cached_result TEXT,
            error_code TEXT,
            style_id TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (sheet_id, row_index, col_index),
            FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id),
            FOREIGN KEY (style_id) REFERENCES styles(style_id)
        );

        CREATE TABLE IF NOT EXISTS styles (
            style_id TEXT PRIMARY KEY,
            hash TEXT NOT NULL UNIQUE,
            style_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS col_widths (
            sheet_id TEXT NOT NULL,
            col_index INTEGER NOT NULL,
            width REAL NOT NULL,
            PRIMARY KEY (sheet_id, col_index),
            FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
        );

        CREATE TABLE IF NOT EXISTS row_heights (
            sheet_id TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            height REAL NOT NULL,
            PRIMARY KEY (sheet_id, row_index),
            FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
        );

        CREATE TABLE IF NOT EXISTS merged_cells (
            sheet_id TEXT NOT NULL,
            start_row INTEGER NOT NULL,
            start_col INTEGER NOT NULL,
            end_row INTEGER NOT NULL,
            end_col INTEGER NOT NULL,
            PRIMARY KEY (sheet_id, start_row, start_col),
            FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
        );

        CREATE TABLE IF NOT EXISTS named_ranges (
            workbook_id TEXT NOT NULL,
            name TEXT NOT NULL,
            range_json TEXT NOT NULL,
            PRIMARY KEY (workbook_id, name),
            FOREIGN KEY (workbook_id) REFERENCES workbook_meta(workbook_id)
        );

        CREATE TABLE IF NOT EXISTS filters (
            sheet_id TEXT NOT NULL,
            filter_id TEXT NOT NULL,
            filter_json TEXT NOT NULL,
            PRIMARY KEY (sheet_id, filter_id),
            FOREIGN KEY (sheet_id) REFERENCES sheets(sheet_id)
        );

        CREATE TABLE IF NOT EXISTS formula_dependencies (
            sheet_id TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            col_index INTEGER NOT NULL,
            dep_sheet_id TEXT NOT NULL,
            dep_row_index INTEGER NOT NULL,
            dep_col_index INTEGER NOT NULL,
            PRIMARY KEY (sheet_id, row_index, col_index, dep_sheet_id, dep_row_index, dep_col_index)
        );

        CREATE TABLE IF NOT EXISTS file_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            path_hash TEXT,
            detail_json TEXT
        );

        CREATE TABLE IF NOT EXISTS recent_files (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            last_opened TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recovery_candidates (
            candidate_id TEXT PRIMARY KEY,
            original_path TEXT,
            saved_at TEXT NOT NULL,
            reason TEXT NOT NULL,
            temp_path TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    ")?;

    // Record the schema version once per database. The PRIMARY KEY on `version`
    // makes this idempotent: re-opening a v1 database is a no-op. A future
    // migration will compare the latest recorded version to CURRENT and run
    // upgrade SQL as needed.
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, applied_at, app_version) VALUES (?1, ?2, ?3)",
        rusqlite::params![CURRENT_SCHEMA_VERSION, now, APP_VERSION],
    )?;

    Ok(())
}

/// Returns the highest schema version recorded in this database, or None if
/// `initialize` hasn't been run yet. Useful for future migration logic and
/// for tests that need to assert the database has been stamped.
pub fn current_schema_version(conn: &Connection) -> Result<Option<i64>> {
    let v: Option<i64> = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .ok()
        .flatten();
    Ok(v)
}

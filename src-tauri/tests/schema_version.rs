use coco_lib::db::schema::{current_schema_version, initialize, CURRENT_SCHEMA_VERSION};
use rusqlite::Connection;
use tempfile::TempDir;

#[test]
fn stamps_current_version_on_first_init() {
    let _tmp = TempDir::new().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    initialize(&conn).unwrap();
    let v = current_schema_version(&conn).unwrap();
    assert_eq!(v, Some(CURRENT_SCHEMA_VERSION));
}

#[test]
fn reinitializing_is_idempotent() {
    // Re-running initialize on an already-stamped DB must not duplicate the row
    // nor bump the version. Tests the `INSERT OR IGNORE`.
    let conn = Connection::open_in_memory().unwrap();
    initialize(&conn).unwrap();
    initialize(&conn).unwrap();
    initialize(&conn).unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1, "schema_version should have exactly one row");
    let v = current_schema_version(&conn).unwrap();
    assert_eq!(v, Some(CURRENT_SCHEMA_VERSION));
}

#[test]
fn current_schema_version_is_none_before_init() {
    // Without initialize(), the table doesn't exist; the helper must
    // gracefully return None rather than panic.
    let conn = Connection::open_in_memory().unwrap();
    let v = current_schema_version(&conn).unwrap();
    assert_eq!(v, None);
}

#[test]
fn schema_version_row_records_app_version() {
    // The app_version column captures CARGO_PKG_VERSION at init time so a
    // future migration can know which version originally created the DB.
    let conn = Connection::open_in_memory().unwrap();
    initialize(&conn).unwrap();
    let app_version: String = conn
        .query_row(
            "SELECT app_version FROM schema_version WHERE version = ?1",
            [CURRENT_SCHEMA_VERSION],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !app_version.is_empty(),
        "app_version should be non-empty (was {:?})",
        app_version
    );
    // CARGO_PKG_VERSION uses semver. Sanity check the shape.
    assert!(
        app_version.chars().any(|c| c == '.'),
        "expected semver, got {:?}",
        app_version
    );
}

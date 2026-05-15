use coco_lib::db::operations::{
    list_recent_files, record_recent_file, remove_recent_file, RECENT_FILES_LIMIT,
};
use coco_lib::db::schema::initialize;
use rusqlite::Connection;

fn new_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    initialize(&conn).unwrap();
    conn
}

#[test]
fn list_returns_empty_initially() {
    let conn = new_db();
    let rows = list_recent_files(&conn).unwrap();
    assert!(rows.is_empty());
}

#[test]
fn record_then_list_returns_the_entry() {
    let conn = new_db();
    record_recent_file(&conn, "/tmp/a.xlsx", "a.xlsx").unwrap();
    let rows = list_recent_files(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "/tmp/a.xlsx");
    assert_eq!(rows[0].1, "a.xlsx");
}

#[test]
fn list_orders_by_last_opened_descending() {
    let conn = new_db();
    record_recent_file(&conn, "/tmp/a.xlsx", "a.xlsx").unwrap();
    // Sleep a tick so timestamps differ (records use to_rfc3339 from chrono).
    std::thread::sleep(std::time::Duration::from_millis(10));
    record_recent_file(&conn, "/tmp/b.xlsx", "b.xlsx").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    record_recent_file(&conn, "/tmp/c.xlsx", "c.xlsx").unwrap();
    let rows = list_recent_files(&conn).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].0, "/tmp/c.xlsx", "most recent first");
    assert_eq!(rows[2].0, "/tmp/a.xlsx", "oldest last");
}

#[test]
fn re_recording_the_same_path_updates_timestamp_without_duplicating() {
    let conn = new_db();
    record_recent_file(&conn, "/tmp/a.xlsx", "a.xlsx").unwrap();
    record_recent_file(&conn, "/tmp/b.xlsx", "b.xlsx").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    // Re-record a.xlsx — should jump to top and not create a 2nd row.
    record_recent_file(&conn, "/tmp/a.xlsx", "a.xlsx").unwrap();
    let rows = list_recent_files(&conn).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "/tmp/a.xlsx");
    assert_eq!(rows[1].0, "/tmp/b.xlsx");
}

#[test]
fn prunes_entries_beyond_recent_files_limit() {
    let conn = new_db();
    // Insert LIMIT + 5 entries with distinct timestamps.
    for i in 0..(RECENT_FILES_LIMIT + 5) {
        record_recent_file(
            &conn,
            &format!("/tmp/file{}.xlsx", i),
            &format!("file{}.xlsx", i),
        )
        .unwrap();
        // Tiny sleep keeps timestamps monotonically ascending.
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let rows = list_recent_files(&conn).unwrap();
    assert_eq!(rows.len(), RECENT_FILES_LIMIT);
    // The 5 oldest (file0..file4) should have been pruned.
    let all_paths: Vec<_> = rows.iter().map(|r| r.0.clone()).collect();
    assert!(!all_paths.contains(&"/tmp/file0.xlsx".to_string()));
    assert!(!all_paths.contains(&"/tmp/file4.xlsx".to_string()));
    // The newest should remain.
    let newest = format!("/tmp/file{}.xlsx", RECENT_FILES_LIMIT + 4);
    assert!(all_paths.contains(&newest));
}

#[test]
fn remove_recent_file_drops_one_path() {
    let conn = new_db();
    record_recent_file(&conn, "/tmp/a.xlsx", "a.xlsx").unwrap();
    record_recent_file(&conn, "/tmp/b.xlsx", "b.xlsx").unwrap();
    remove_recent_file(&conn, "/tmp/a.xlsx").unwrap();
    let rows = list_recent_files(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "/tmp/b.xlsx");
}

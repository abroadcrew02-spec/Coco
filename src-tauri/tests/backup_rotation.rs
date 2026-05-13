use coco_lib::commands::workbook::{
    bak_path, enforce_backup_size_cap, rotate_backups, temp_save_path, total_backup_size,
    MAX_BACKUPS,
};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

#[test]
fn test_rotate_when_target_missing_is_noop() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("nothere.coco");

    rotate_backups(&target).expect("rotate should be Ok for missing target");

    let any_bak = fs::read_dir(tmp.path())
        .expect("read tempdir")
        .filter_map(|e| e.ok())
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .contains(".bak.")
        });
    assert!(!any_bak, "no .bak.* files should exist after no-op rotate");
}

#[test]
fn test_first_rotation_creates_bak_1() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.coco");
    fs::write(&target, b"v1").expect("write initial");

    rotate_backups(&target).expect("rotate ok");

    let bak1 = tmp.path().join("data.coco.bak.1");
    assert!(bak1.exists(), "data.coco.bak.1 should exist");
    assert_eq!(fs::read(&bak1).unwrap(), b"v1", "bak.1 contents");

    assert!(target.exists(), "original target should still exist");
    assert_eq!(
        fs::read(&target).unwrap(),
        b"v1",
        "original target should be untouched"
    );
}

#[test]
fn test_five_rotations_keep_max_five_with_shifting() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.coco");

    for i in 1..=7 {
        fs::write(&target, format!("v{i}")).expect("write target");
        rotate_backups(&target).expect("rotate ok");
    }

    let expectations = [
        (1u32, "v7"),
        (2, "v6"),
        (3, "v5"),
        (4, "v4"),
        (5, "v3"),
    ];
    for (n, expected) in expectations {
        let p = tmp.path().join(format!("data.coco.bak.{n}"));
        assert!(p.exists(), "data.coco.bak.{n} should exist");
        assert_eq!(
            fs::read(&p).unwrap(),
            expected.as_bytes(),
            "bak.{n} should be {expected}"
        );
    }

    let bak6 = tmp.path().join("data.coco.bak.6");
    let bak7 = tmp.path().join("data.coco.bak.7");
    assert!(!bak6.exists(), "data.coco.bak.6 should NOT exist");
    assert!(!bak7.exists(), "data.coco.bak.7 should NOT exist");

    let bak_count = fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .contains(".bak.")
        })
        .count();
    assert_eq!(
        bak_count, MAX_BACKUPS as usize,
        "only MAX_BACKUPS .bak files should remain"
    );
}

#[test]
fn test_bak_path_preserves_full_filename_for_multi_dot() {
    let p = bak_path(Path::new("foo/data.archive.coco"), 1);
    assert!(
        p.to_string_lossy().ends_with("data.archive.coco.bak.1"),
        "got {}",
        p.to_string_lossy()
    );
}

#[test]
fn test_temp_save_path_is_in_same_dir_with_dot_prefix() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("workbook.coco");

    let t = temp_save_path(&target);
    assert_eq!(t.parent(), Some(tmp.path()), "tmp path should be in same dir");

    let name = t.file_name().expect("file name").to_string_lossy().into_owned();
    assert!(
        name.starts_with(".workbook.coco.tmp-"),
        "tmp filename should start with .workbook.coco.tmp-, got {name}"
    );

    let t2 = temp_save_path(&target);
    assert_ne!(t, t2, "two tmp paths should have unique uuids");
}

#[test]
fn total_backup_size_sums_existing_baks() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.coco");

    // No .bak files → 0
    assert_eq!(total_backup_size(&target), 0);

    // Write .bak.1 and .bak.3 (skip .bak.2 to test missing-file tolerance)
    fs::write(bak_path(&target, 1), vec![0u8; 100]).unwrap();
    fs::write(bak_path(&target, 3), vec![0u8; 50]).unwrap();
    assert_eq!(total_backup_size(&target), 150);
}

#[test]
fn enforce_cap_noop_when_under_limit() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.coco");
    fs::write(bak_path(&target, 1), vec![0u8; 100]).unwrap();
    fs::write(bak_path(&target, 2), vec![0u8; 100]).unwrap();

    // Cap is 1000 bytes; total is 200 — should be a no-op.
    enforce_backup_size_cap(&target, 1000).unwrap();

    assert!(bak_path(&target, 1).exists());
    assert!(bak_path(&target, 2).exists());
}

#[test]
fn enforce_cap_evicts_oldest_first() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.coco");
    // Each .bak is 100 bytes; total 500.
    for n in 1..=5 {
        fs::write(bak_path(&target, n), vec![0u8; 100]).unwrap();
    }

    // Cap at 250 bytes — should keep .bak.1 and .bak.2 (200 bytes), evict .bak.3..5.
    enforce_backup_size_cap(&target, 250).unwrap();

    assert!(bak_path(&target, 1).exists(), ".bak.1 (newest) should survive");
    assert!(bak_path(&target, 2).exists(), ".bak.2 should survive");
    assert!(!bak_path(&target, 3).exists(), ".bak.3 should be evicted");
    assert!(!bak_path(&target, 4).exists(), ".bak.4 should be evicted");
    assert!(!bak_path(&target, 5).exists(), ".bak.5 (oldest) should be evicted");
}

#[test]
fn enforce_cap_at_zero_evicts_everything() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.coco");
    for n in 1..=3 {
        fs::write(bak_path(&target, n), vec![0u8; 50]).unwrap();
    }

    enforce_backup_size_cap(&target, 0).unwrap();
    for n in 1..=5 {
        assert!(!bak_path(&target, n).exists(), ".bak.{n} should be evicted");
    }
}

#[test]
fn rotate_backups_applies_size_cap_after_shift() {
    // Use rotate_backups (which uses production 1GB const) plus a manually
    // tightened scenario: pre-seed huge .bak files, then rotate, then check
    // total cap is respected. We can't actually hit 1GB in a test, so we
    // verify the *interaction* by directly calling enforce_backup_size_cap
    // after rotate.
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.coco");
    fs::write(&target, b"current").unwrap();

    rotate_backups(&target).unwrap();
    // After rotation, .bak.1 holds the previous target's content.
    assert!(bak_path(&target, 1).exists());

    // Manually enforce a tight cap to verify the cap function works in
    // conjunction with rotate's output.
    enforce_backup_size_cap(&target, 3).unwrap(); // 3 bytes < "current" length 7
    assert!(!bak_path(&target, 1).exists(), ".bak.1 should be evicted under tight cap");
}

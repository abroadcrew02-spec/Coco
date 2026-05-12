use coco_lib::commands::workbook::{bak_path, rotate_backups, temp_save_path, MAX_BACKUPS};
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

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use nicel_lib::commands::launch::{launch_candidates, LaunchPaths, LAUNCH_EXTENSIONS};

fn abs(dir: &Path, name: &str) -> String {
    dir.join(name).to_str().unwrap().to_owned()
}

#[test]
fn candidates_keep_only_supported_extensions() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    let book = abs(cwd, "b.xlsx");
    let args = vec![
        book.clone(),
        "/UPDATE".to_owned(),
        "/P".to_owned(),
        "--flag".to_owned(),
        abs(cwd, "nicel.exe"),
        "foo.txt".to_owned(),
        String::new(),
    ];
    let got = launch_candidates(args, cwd);
    assert_eq!(got, vec![PathBuf::from(book)]);
}

#[test]
fn candidates_match_extensions_case_insensitively() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    let args = vec![
        abs(cwd, "B.XLSX"),
        abs(cwd, "c.Tsv"),
        abs(cwd, "d.Csv"),
        abs(cwd, "e.xlsx.bak"),
        abs(cwd, "f.coco"),
    ];
    let got = launch_candidates(args, cwd);
    assert_eq!(
        got,
        vec![
            PathBuf::from(abs(cwd, "B.XLSX")),
            PathBuf::from(abs(cwd, "c.Tsv")),
            PathBuf::from(abs(cwd, "d.Csv")),
        ]
    );
}

#[test]
fn candidates_accept_every_launch_extension() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    let args: Vec<String> = LAUNCH_EXTENSIONS
        .iter()
        .map(|e| abs(cwd, &format!("book.{e}")))
        .collect();
    assert_eq!(launch_candidates(args.clone(), cwd).len(), args.len());
}

#[test]
fn relative_paths_are_resolved_against_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    let got = launch_candidates(vec![Path::new("data").join("a.csv")], cwd);
    assert_eq!(got, vec![cwd.join("data").join("a.csv")]);
}

#[cfg(windows)]
#[test]
fn drive_letter_paths_are_kept_as_given() {
    let dir = tempfile::tempdir().unwrap();
    let got = launch_candidates(vec![r"C:\a\b.xlsx"], dir.path());
    assert_eq!(got, vec![PathBuf::from(r"C:\a\b.xlsx")]);
}

#[test]
fn take_existing_returns_only_existing_files_in_argv_order() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    std::fs::write(cwd.join("second.csv"), b"a,b\n").unwrap();
    std::fs::write(cwd.join("first.xlsx"), b"x").unwrap();
    // A directory whose name looks like a workbook is not a file.
    std::fs::create_dir(cwd.join("dir.xlsx")).unwrap();

    let launch = LaunchPaths::from_args(
        vec![
            abs(cwd, "second.csv"),
            abs(cwd, "missing.xlsx"),
            abs(cwd, "dir.xlsx"),
            abs(cwd, "first.xlsx"),
        ],
        cwd,
    );
    assert_eq!(
        launch.take_existing(),
        vec![abs(cwd, "second.csv"), abs(cwd, "first.xlsx")]
    );
}

#[test]
fn take_existing_resolves_relative_paths_against_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    std::fs::write(cwd.join("rel.tsv"), b"a\tb\n").unwrap();
    let launch = LaunchPaths::from_args(vec!["rel.tsv"], cwd);
    assert_eq!(launch.take_existing(), vec![abs(cwd, "rel.tsv")]);
}

#[test]
fn take_existing_returns_nothing_the_second_time() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path();
    std::fs::write(cwd.join("a.xlsx"), b"x").unwrap();
    let launch = LaunchPaths::from_args(vec![abs(cwd, "a.xlsx")], cwd);
    assert_eq!(launch.take_existing().len(), 1);
    assert!(launch.take_existing().is_empty());
}

#[test]
fn no_arguments_means_nothing_to_open() {
    let dir = tempfile::tempdir().unwrap();
    let launch = LaunchPaths::from_args(Vec::<String>::new(), dir.path());
    assert!(launch.take_existing().is_empty());
}

/// Extensions named by `!insertmacro <macro_name> ".ext"` lines in the NSIS
/// hooks, without the leading dot.
fn hook_extensions(hooks: &str, macro_name: &str) -> BTreeSet<String> {
    let needle = format!("!insertmacro {macro_name} ");
    hooks
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with(';'))
        .filter_map(|line| line.strip_prefix(needle.as_str()))
        .map(|rest| {
            rest.trim()
                .trim_matches('"')
                .trim_start_matches('.')
                .to_ascii_lowercase()
        })
        .collect()
}

#[test]
fn launch_extensions_match_the_installer_registration() {
    let hooks = include_str!("../windows/hooks.nsh");
    let expected: BTreeSet<String> = LAUNCH_EXTENSIONS.iter().map(|e| e.to_string()).collect();

    let added = hook_extensions(hooks, "NICEL_OPENWITH_ADD");
    let removed = hook_extensions(hooks, "NICEL_OPENWITH_REMOVE");

    assert!(
        !added.is_empty(),
        "hooks.nsh has no NICEL_OPENWITH_ADD lines"
    );
    assert_eq!(
        added, expected,
        "NICEL_OPENWITH_ADD in hooks.nsh differs from LAUNCH_EXTENSIONS"
    );
    assert_eq!(
        removed, expected,
        "NICEL_OPENWITH_REMOVE in hooks.nsh differs from LAUNCH_EXTENSIONS"
    );
}

use coco_lib::commands::csv_io::import_csv_core;
use std::fs;
use tempfile::TempDir;

fn path_in(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

#[test]
fn bad_extension_rejected() {
    let result = import_csv_core("not_a_csv.xlsx".to_string());
    assert!(result.is_err());
    let err = result.err().unwrap();
    assert!(
        err.contains("CSV_INVALID_EXTENSION"),
        "expected CSV_INVALID_EXTENSION, got: {:?}",
        err
    );
}

#[test]
fn simple_values_roundtrip_through_snapshot() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "values.csv");
    fs::write(&path, "Name,Score,Pass\nAlice,92.5,TRUE\nBob,58,FALSE\n").unwrap();

    let result = import_csv_core(path).unwrap();
    let snapshot_str = result.handle.snapshot_json.clone().unwrap();
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot_str).unwrap();

    assert_eq!(snapshot["sheets"]["sheet-1"]["name"], "values");
    assert_eq!(snapshot["sheetOrder"].as_array().unwrap().len(), 1);

    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];
    assert_eq!(cell_data["0"]["0"]["v"], "Name");
    assert_eq!(cell_data["1"]["1"]["v"].as_f64(), Some(92.5));
    assert_eq!(cell_data["2"]["1"]["v"], 58);
    assert!(
        cell_data["2"]["1"]["v"].is_i64(),
        "expected i64, got: {:?}",
        cell_data["2"]["1"]["v"]
    );
    assert_eq!(cell_data["1"]["2"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["2"]["2"]["v"].as_bool(), Some(false));

    assert!(result.warnings.iter().any(|w| w.code == "CSV_POC_IMPORT"));
}

#[test]
fn bom_stripped() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "bom.csv");
    fs::write(&path, [0xEF, 0xBB, 0xBF, b'a', b',', b'b', b'\n']).unwrap();

    let result = import_csv_core(path).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], "a");
    assert_eq!(cell_data["0"]["1"]["v"], "b");
}

#[test]
fn injection_guard_unescape() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "injection.csv");
    fs::write(&path, "'=cmd(),'+ATTACK,'-DROP,'@HOST,'plain\n").unwrap();

    let result = import_csv_core(path).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], "=cmd()");
    assert_eq!(cell_data["0"]["1"]["v"], "+ATTACK");
    assert_eq!(cell_data["0"]["2"]["v"], "-DROP");
    assert_eq!(cell_data["0"]["3"]["v"], "@HOST");
    assert_eq!(cell_data["0"]["4"]["v"], "'plain");
}

#[test]
fn empty_cells_are_sparse() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "sparse.csv");
    fs::write(&path, "a,,c\n,,\n,e,\n").unwrap();

    let result = import_csv_core(path).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    let row0 = cell_data["0"].as_object().unwrap();
    assert!(row0.contains_key("0"));
    assert!(row0.contains_key("2"));
    assert!(!row0.contains_key("1"), "empty cell should be skipped");

    let root_obj = cell_data.as_object().unwrap();
    assert!(!root_obj.contains_key("1"), "all-empty row should be omitted");

    let row2 = cell_data["2"].as_object().unwrap();
    assert_eq!(row2.len(), 1);
    assert!(row2.contains_key("1"));
}

#[test]
fn numbers_prefer_integer_over_float() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "numbers.csv");
    fs::write(&path, "42\n42.0\n-7\n3.14\n1e5\n").unwrap();

    let result = import_csv_core(path).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"], 42);
    assert!(cell_data["0"]["0"]["v"].is_i64());

    assert_eq!(cell_data["1"]["0"]["v"].as_f64(), Some(42.0));
    assert_eq!(cell_data["2"]["0"]["v"], -7);
    assert!(cell_data["2"]["0"]["v"].is_i64());
    assert_eq!(cell_data["3"]["0"]["v"].as_f64(), Some(3.14));
    assert_eq!(cell_data["4"]["0"]["v"].as_f64(), Some(100000.0));
}

#[test]
fn case_insensitive_bool() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "bools.csv");
    fs::write(&path, "true,TRUE,True,false,False,FALSE\n").unwrap();

    let result = import_csv_core(path).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let cell_data = &snapshot["sheets"]["sheet-1"]["cellData"];

    assert_eq!(cell_data["0"]["0"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["0"]["1"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["0"]["2"]["v"].as_bool(), Some(true));
    assert_eq!(cell_data["0"]["3"]["v"].as_bool(), Some(false));
    assert_eq!(cell_data["0"]["4"]["v"].as_bool(), Some(false));
    assert_eq!(cell_data["0"]["5"]["v"].as_bool(), Some(false));
}

#[test]
fn default_dimensions_minimum() {
    let dir = TempDir::new().unwrap();
    let path = path_in(&dir, "small.csv");
    fs::write(&path, "a,b\nc,d\ne,f\n").unwrap();

    let result = import_csv_core(path).unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(&result.handle.snapshot_json.unwrap()).unwrap();
    let sheet = &snapshot["sheets"]["sheet-1"];

    assert_eq!(sheet["rowCount"], 1000);
    assert_eq!(sheet["columnCount"], 100);
}

#[test]
fn nonexistent_file_returns_err() {
    let result = import_csv_core("/does/not/exist.csv".to_string());
    assert!(result.is_err());
}

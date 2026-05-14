// Performance smoke test for req §5.1.
//
// Unlike `perf.rs` (an informational baseline harness that never asserts),
// this file asserts hard ceilings so a catastrophic regression — e.g. an
// accidental O(n^2) loop in the import pipeline — fails CI. The ceilings are
// deliberately well above the §5.1 p95 targets so flakes are unlikely on a
// loaded CI runner.
//
// All tests are #[ignore] by default because they generate ~1MB fixtures and
// take several seconds each. Run via:
//
//     cargo test --release --test perf_smoke -- --include-ignored --nocapture
//
// IMPORTANT: --release is required. The §5.1 numbers describe the production
// binary; a debug build is ~5x slower and will exceed the ceilings below.
//
// §5.1 targets being smoke-checked here (release-build basis):
//   - xlsx import 1MB / 10% formulas:  p50 2s  / p95 5s   (ceiling 15s)
//   - xlsx export 1MB equivalent:      p50 3s  / p95 8s   (ceiling 15s)
//   - SQLite save 50k cells:           p50 1s  / p95 3s   (ceiling 10s)
//
// The 15s/10s ceilings are deliberately above the spec p95 so this smoke test
// only fires on catastrophic regressions and tolerates slow Windows CI
// runners. The per-iteration printout lets a human spot soft regressions
// long before the hard assertion trips.
//
// Cold start (app launch p50 3s / p95 5s) is *not* covered here — it requires
// the Tauri shell to be running, which can't be done from a unit-test binary.

use coco_lib::commands::workbook::save_core;
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Formula, Workbook};
use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};
use tempfile::TempDir;

// ── Hard ceilings (assertion thresholds) ────────────────────────────────────
// Generous vs §5.1 p95 to absorb slow Windows CI + debug build overhead.
const XLSX_IMPORT_CEILING: Duration = Duration::from_secs(15);
const XLSX_EXPORT_CEILING: Duration = Duration::from_secs(15);
const SQLITE_SAVE_CEILING: Duration = Duration::from_secs(10);

// ── Helpers ─────────────────────────────────────────────────────────────────

fn det_num(r: u32, c: u32) -> f64 {
    // Deterministic pseudo-random-ish numeric generator; no RNG dependency.
    ((r as u64 * 7919 + c as u64 * 31) as f64) / 100.0
}

fn fmt_ms(d: Duration) -> String {
    format!("{:.0} ms", d.as_secs_f64() * 1000.0)
}

// ── Test 1: xlsx import, ~1MB fixture, 10% formula cells ────────────────────

#[test]
#[ignore = "run via `cargo test -- --include-ignored` for performance smoke"]
fn smoke_xlsx_import_1mb_10pct_formulas() {
    // Layout per row (10 cols): 5 strings, 3 numbers, 1 formula, 1 string.
    // formula cells / total cells = 1/10 = 10%, matching §5.1.
    // 5 sheets × 5000 rows × 10 cols = 250k cells, which writes to ~1MB on disk.
    const SHEETS: u32 = 5;
    const ROWS: u32 = 5000;

    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("smoke_import.xlsx");

    {
        let mut wb = Workbook::new();
        for s in 0..SHEETS {
            let ws = wb.add_worksheet();
            ws.set_name(&format!("Sheet{}", s + 1)).expect("set name");
            for r in 0..ROWS {
                for c in 0..5u16 {
                    ws.write_string(r, c, &format!("item_{r}"))
                        .expect("write str");
                }
                for c in 5..8u16 {
                    ws.write_number(r, c, det_num(r, c as u32))
                        .expect("write num");
                }
                let formula = format!("=SUM(F{}:H{})", r + 1, r + 1);
                ws.write_formula(r, 8u16, Formula::new(formula.as_str()))
                    .expect("write formula");
                ws.write_string(r, 9u16, &format!("row_{r}_tail"))
                    .expect("write tail");
            }
        }
        wb.save(&fixture).expect("save fixture");
    }

    let bytes = std::fs::metadata(&fixture).expect("metadata").len();
    let mb = bytes as f64 / 1024.0 / 1024.0;
    let path = fixture.to_string_lossy().into_owned();

    let start = Instant::now();
    let result = import_xlsx_core(path).expect("import_xlsx_core ok");
    let elapsed = start.elapsed();

    assert!(
        result.handle.snapshot_json.is_some(),
        "import must produce a snapshot"
    );

    println!(
        "[perf_smoke] xlsx import: fixture {:.2} MB ({} bytes), elapsed = {} (ceiling = {})",
        mb,
        bytes,
        fmt_ms(elapsed),
        fmt_ms(XLSX_IMPORT_CEILING),
    );
    assert!(
        elapsed < XLSX_IMPORT_CEILING,
        "xlsx import smoke regressed: {} >= ceiling {} (§5.1 p95 target = 5s for 1MB)",
        fmt_ms(elapsed),
        fmt_ms(XLSX_IMPORT_CEILING)
    );
}

// ── Test 2: xlsx export, ~1MB-equivalent snapshot ───────────────────────────

fn build_export_snapshot_250k() -> String {
    // Mirrors the import-fixture shape so produced .xlsx is ~1MB.
    const SHEETS: u32 = 5;
    const ROWS: u32 = 5000;

    let mut sheet_order: Vec<Value> = Vec::with_capacity(SHEETS as usize);
    let mut sheets_map: Map<String, Value> = Map::new();

    for s in 0..SHEETS {
        let sheet_id = format!("sheet-{}", s + 1);
        sheet_order.push(Value::String(sheet_id.clone()));

        let mut cell_data: Map<String, Value> = Map::new();
        for r in 0..ROWS {
            let mut row_map: Map<String, Value> = Map::new();
            for c in 0..5u32 {
                row_map.insert(c.to_string(), json!({ "v": format!("item_{r}") }));
            }
            for c in 5..8u32 {
                row_map.insert(c.to_string(), json!({ "v": det_num(r, c) }));
            }
            row_map.insert(
                "8".to_string(),
                json!({ "f": format!("=SUM(F{}:H{})", r + 1, r + 1) }),
            );
            row_map.insert("9".to_string(), json!({ "v": format!("row_{r}_tail") }));
            cell_data.insert(r.to_string(), Value::Object(row_map));
        }

        sheets_map.insert(
            sheet_id,
            json!({
                "name": format!("Sheet{}", s + 1),
                "cellData": cell_data,
            }),
        );
    }

    let snapshot = json!({
        "id": "perf-smoke-export",
        "name": "Perf Smoke Export",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": {},
        "sheetOrder": sheet_order,
        "sheets": sheets_map,
    });

    serde_json::to_string(&snapshot).expect("serialize snapshot")
}

#[test]
#[ignore = "run via `cargo test -- --include-ignored` for performance smoke"]
fn smoke_xlsx_export_1mb_equivalent() {
    let tmp = TempDir::new().expect("tempdir");
    let out_path = tmp.path().join("smoke_export.xlsx");
    let snapshot_json = build_export_snapshot_250k();

    let start = Instant::now();
    let result = export_xlsx_core(
        out_path.to_string_lossy().into_owned(),
        snapshot_json,
    )
    .expect("export_xlsx_core ok");
    let elapsed = start.elapsed();

    assert!(
        result.success,
        "export must succeed: error = {:?}",
        result.error
    );
    let produced = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);

    println!(
        "[perf_smoke] xlsx export: produced {:.2} MB ({} bytes), elapsed = {} (ceiling = {})",
        produced as f64 / 1024.0 / 1024.0,
        produced,
        fmt_ms(elapsed),
        fmt_ms(XLSX_EXPORT_CEILING),
    );
    assert!(
        elapsed < XLSX_EXPORT_CEILING,
        "xlsx export smoke regressed: {} >= ceiling {} (§5.1 p95 target = 8s for 1MB)",
        fmt_ms(elapsed),
        fmt_ms(XLSX_EXPORT_CEILING)
    );
}

// ── Test 3: SQLite save (.coco), 50k cells ──────────────────────────────────

fn build_save_snapshot_50k() -> String {
    // 1 sheet × 5000 rows × 10 cols = 50k cells; §5.1 target = p50 1s / p95 3s.
    const ROWS: u32 = 5000;
    let sheet_id = "sheet-1";

    let mut cell_data: Map<String, Value> = Map::new();
    for r in 0..ROWS {
        let mut row_map: Map<String, Value> = Map::new();
        for c in 0..5u32 {
            row_map.insert(c.to_string(), json!({ "v": format!("item_{r}") }));
        }
        for c in 5..10u32 {
            row_map.insert(c.to_string(), json!({ "v": det_num(r, c) }));
        }
        cell_data.insert(r.to_string(), Value::Object(row_map));
    }

    let snapshot = json!({
        "id": "perf-smoke-save",
        "name": "Perf Smoke Save",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": {},
        "sheetOrder": [sheet_id],
        "sheets": {
            sheet_id: {
                "name": "Sheet1",
                "cellData": cell_data,
            }
        },
    });

    serde_json::to_string(&snapshot).expect("serialize snapshot")
}

#[test]
#[ignore = "run via `cargo test -- --include-ignored` for performance smoke"]
fn smoke_sqlite_save_50k_cells() {
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("smoke_save.coco");
    let snapshot_json = build_save_snapshot_50k();

    let start = Instant::now();
    let result = save_core(
        "perf-smoke-wb".into(),
        Some(target.to_string_lossy().into_owned()),
        snapshot_json,
    )
    .expect("save_core ok");
    let elapsed = start.elapsed();

    assert!(
        result.success,
        ".coco save must succeed: error = {:?}",
        result.error
    );
    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);

    println!(
        "[perf_smoke] .coco save: produced {:.2} MB ({} bytes), elapsed = {} (ceiling = {})",
        size as f64 / 1024.0 / 1024.0,
        size,
        fmt_ms(elapsed),
        fmt_ms(SQLITE_SAVE_CEILING),
    );
    assert!(
        elapsed < SQLITE_SAVE_CEILING,
        "sqlite save smoke regressed: {} >= ceiling {} (§5.1 p95 target = 3s for 50k cells)",
        fmt_ms(elapsed),
        fmt_ms(SQLITE_SAVE_CEILING)
    );
}

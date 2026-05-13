// Performance baseline harness for req 5.1.
//
// All tests are #[ignore] — opt in with:
//     cargo test --release --test perf -- --ignored --nocapture
//
// Design:
// - No new dependencies; pure std::time::Instant for measurement.
// - Print measurements with a PASS/FAIL verdict vs the spec budget, but never
//   assert on timings (different dev machines run at different speeds).
// - Each test generates its own fixture and is independent.

use coco_lib::commands::csv_io::import_csv_core;
use coco_lib::commands::workbook::save_core;
use coco_lib::commands::xlsx_io::{import_xlsx_core, export_xlsx_core};
use rust_xlsxwriter::{Formula, Workbook};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::time::{Duration, Instant};
use tempfile::TempDir;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn percentile(durations: &mut Vec<Duration>, pct: f64) -> Duration {
    durations.sort();
    let idx = ((durations.len() as f64 - 1.0) * pct).round() as usize;
    durations[idx]
}

fn mean(durations: &[Duration]) -> Duration {
    let total: Duration = durations.iter().sum();
    total / durations.len() as u32
}

fn fmt_ms(d: Duration) -> String {
    format!("{:.1} ms", d.as_secs_f64() * 1000.0)
}

fn verdict(actual: Duration, budget_ms: u64) -> &'static str {
    if actual.as_millis() as u64 <= budget_ms {
        "PASS"
    } else {
        "FAIL"
    }
}

fn raw_ms_list(durations: &[Duration]) -> String {
    let parts: Vec<String> = durations
        .iter()
        .map(|d| format!("{}", d.as_millis()))
        .collect();
    format!("[{}]", parts.join(", "))
}

fn print_header(name: &str) {
    println!();
    println!("═══════════════════════════════════════════");
    println!("  {name}");
    println!("═══════════════════════════════════════════");
}

fn print_results(
    durations: &mut Vec<Duration>,
    p50_budget_ms: Option<u64>,
    p95_budget_ms: Option<u64>,
) {
    let raw = raw_ms_list(durations);
    let p50 = percentile(durations, 0.50);
    let p95 = percentile(durations, 0.95);
    let avg = mean(durations);
    println!("  raw timings (ms): {raw}");
    match p50_budget_ms {
        Some(b) => println!(
            "  p50:    {:<10}  (budget {} ms)   {}",
            fmt_ms(p50),
            b,
            verdict(p50, b)
        ),
        None => println!("  p50:    {:<10}  (no spec budget)", fmt_ms(p50)),
    }
    match p95_budget_ms {
        Some(b) => println!(
            "  p95:    {:<10}  (budget {} ms)   {}",
            fmt_ms(p95),
            b,
            verdict(p95, b)
        ),
        None => println!("  p95:    {:<10}  (no spec budget)", fmt_ms(p95)),
    }
    println!("  mean:   {}", fmt_ms(avg));
}

fn det_num(r: u32, c: u32) -> f64 {
    // Deterministic pseudo-random-ish numeric generator. Avoids RNG dependencies
    // while still producing varied values that don't compress trivially.
    ((r as u64 * 7919 + c as u64 * 31) as f64) / 100.0
}

// ── Test 1: xlsx import, ~1MB fixture ───────────────────────────────────────

#[test]
#[ignore]
fn xlsx_import_1mb() {
    // Fixture: 5 sheets × 5000 rows × 10 cols = 250k cells.
    // Col layout (per row r, 0-indexed):
    //   A-E (cols 0-4): strings  "item_{r}"
    //   F-H (cols 5-7): numbers  det_num(r,c)
    //   I    (col 8) :  formula  =SUM(F{r+1}:H{r+1})   → 1 formula col / 10 = 10%
    //   J    (col 9) :  string   "row_{r}_tail"
    const SHEETS: u32 = 5;
    const ROWS: u32 = 5000;
    const COLS: u32 = 10;
    const ITERATIONS: usize = 10;

    let tmp = TempDir::new().expect("tempdir");
    let fixture_path = tmp.path().join("perf_import_1mb.xlsx");

    // Build the fixture once.
    {
        let mut wb = Workbook::new();
        for s in 0..SHEETS {
            let ws = wb.add_worksheet();
            ws.set_name(&format!("Sheet{}", s + 1)).expect("set name");
            for r in 0..ROWS {
                // cols 0..=4 strings
                for c in 0..5 {
                    ws.write_string(r, c as u16, &format!("item_{r}"))
                        .expect("write str");
                }
                // cols 5..=7 numbers
                for c in 5..8 {
                    ws.write_number(r, c as u16, det_num(r, c))
                        .expect("write num");
                }
                // col 8 formula =SUM(F{r+1}:H{r+1})
                let formula = format!("=SUM(F{}:H{})", r + 1, r + 1);
                ws.write_formula(r, 8u16, Formula::new(formula.as_str()))
                    .expect("write formula");
                // col 9 string
                ws.write_string(r, 9u16, &format!("row_{r}_tail"))
                    .expect("write tail");
            }
        }
        wb.save(&fixture_path).expect("save fixture");
    }

    let file_size = std::fs::metadata(&fixture_path).expect("metadata").len();
    let mb = file_size as f64 / 1024.0 / 1024.0;

    print_header("xlsx_import_1mb");
    println!(
        "  fixture: {:.2} MB ({} bytes), {} cells, {} sheets, formulas in 10% of cells",
        mb,
        file_size,
        (SHEETS * ROWS * COLS),
        SHEETS
    );
    std::io::stdout().flush().ok();

    let path_str = fixture_path.to_string_lossy().into_owned();

    // Warmup
    let warm = import_xlsx_core(path_str.clone()).expect("warmup import ok");
    assert!(
        warm.handle.snapshot_json.is_some(),
        "warmup: snapshot_json should be Some"
    );

    // Measure
    let mut samples: Vec<Duration> = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let t = Instant::now();
        let r = import_xlsx_core(path_str.clone()).expect("import ok");
        let elapsed = t.elapsed();
        assert!(r.handle.snapshot_json.is_some());
        samples.push(elapsed);
    }

    print_results(&mut samples, Some(2000), Some(5000));
}

// ── Test 2: xlsx export, ~1MB worth of cells ────────────────────────────────

fn build_export_snapshot_250k() -> String {
    // Build a Univer-shape snapshot that the export pipeline will consume.
    // Same shape as the test-1 fixture (5 sheets × 5000 × 10 = 250k cells)
    // so the produced .xlsx is of comparable size to test 1.
    const SHEETS: u32 = 5;
    const ROWS: u32 = 5000;

    let mut sheet_order: Vec<Value> = Vec::with_capacity(SHEETS as usize);
    let mut sheets_map: Map<String, Value> = Map::new();

    for s in 0..SHEETS {
        let sheet_id = format!("sheet-{}", s + 1);
        sheet_order.push(Value::String(sheet_id.clone()));

        // cellData: { "<row>": { "<col>": { "v": ... } | { "f": "=..." } } }
        let mut cell_data: Map<String, Value> = Map::new();
        for r in 0..ROWS {
            let mut row_map: Map<String, Value> = Map::new();
            // cols 0..=4 strings
            for c in 0..5u32 {
                row_map.insert(c.to_string(), json!({ "v": format!("item_{r}") }));
            }
            // cols 5..=7 numbers
            for c in 5..8u32 {
                row_map.insert(c.to_string(), json!({ "v": det_num(r, c) }));
            }
            // col 8 formula
            row_map.insert(
                "8".to_string(),
                json!({ "f": format!("=SUM(F{}:H{})", r + 1, r + 1) }),
            );
            // col 9 string
            row_map.insert(
                "9".to_string(),
                json!({ "v": format!("row_{r}_tail") }),
            );
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
        "id": "perf-export-1mb",
        "name": "Perf Export",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": {},
        "sheetOrder": sheet_order,
        "sheets": sheets_map,
    });

    serde_json::to_string(&snapshot).expect("serialize snapshot")
}

#[test]
#[ignore]
fn xlsx_export_1mb_equivalent() {
    const ITERATIONS: usize = 10;
    print_header("xlsx_export_1mb_equivalent");

    let tmp = TempDir::new().expect("tempdir");
    let build_t = Instant::now();
    let snapshot_json = build_export_snapshot_250k();
    let build_ms = build_t.elapsed().as_millis();
    println!(
        "  snapshot built: {} bytes JSON, build took {} ms",
        snapshot_json.len(),
        build_ms
    );
    std::io::stdout().flush().ok();

    // Warmup
    let warm_path = tmp.path().join("perf_export_warmup.xlsx");
    let warm = export_xlsx_core(
        warm_path.to_string_lossy().into_owned(),
        snapshot_json.clone(),
    )
    .expect("warmup export ok");
    assert!(warm.success, "warmup export should succeed: {:?}", warm.error);
    let produced_size = std::fs::metadata(&warm_path)
        .map(|m| m.len())
        .unwrap_or(0);
    println!(
        "  produced .xlsx size: {:.2} MB ({} bytes)",
        produced_size as f64 / 1024.0 / 1024.0,
        produced_size
    );

    // Measure
    let mut samples: Vec<Duration> = Vec::with_capacity(ITERATIONS);
    for i in 0..ITERATIONS {
        let out_path = tmp.path().join(format!("perf_export_{i}.xlsx"));
        let out_str = out_path.to_string_lossy().into_owned();
        let t = Instant::now();
        let r = export_xlsx_core(out_str, snapshot_json.clone()).expect("export ok");
        let elapsed = t.elapsed();
        assert!(r.success, "iter {i}: export should succeed: {:?}", r.error);
        samples.push(elapsed);
    }

    print_results(&mut samples, Some(3000), Some(8000));
}

// ── Test 3: SQLite save, 50k cells ──────────────────────────────────────────

fn build_save_snapshot_50k() -> String {
    // 1 sheet × 5000 rows × 10 cols = 50k cells, mixed strings/numbers.
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
        "id": "perf-save-50k",
        "name": "Perf Save 50k",
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
#[ignore]
fn coco_save_50k_cells() {
    const ITERATIONS: usize = 10;
    print_header("coco_save_50k_cells");

    let snapshot_json = build_save_snapshot_50k();
    println!(
        "  fixture: 50000 cells, snapshot JSON size = {} bytes",
        snapshot_json.len()
    );
    std::io::stdout().flush().ok();

    // Warmup — use its own TempDir so the .bak rotation in subsequent calls
    // doesn't bias measurements (spec budget is for a single fresh save).
    {
        let tmp = TempDir::new().expect("tempdir warmup");
        let path = tmp.path().join("warmup.coco");
        let r = save_core(
            "perf-wb".into(),
            Some(path.to_string_lossy().into_owned()),
            snapshot_json.clone(),
        )
        .expect("warmup save");
        assert!(r.success, "warmup save should succeed: {:?}", r.error);
    }

    // Measure — fresh TempDir per iteration so we time a clean save, not
    // backup rotation of an accumulating chain.
    let mut samples: Vec<Duration> = Vec::with_capacity(ITERATIONS);
    let mut tempdirs: Vec<TempDir> = Vec::with_capacity(ITERATIONS); // keep alive until end
    for i in 0..ITERATIONS {
        let tmp = TempDir::new().expect("tempdir iter");
        let path = tmp.path().join("iter.coco");
        let path_str = path.to_string_lossy().into_owned();

        let t = Instant::now();
        let r = save_core("perf-wb".into(), Some(path_str), snapshot_json.clone())
            .expect("save ok");
        let elapsed = t.elapsed();
        assert!(r.success, "iter {i}: save should succeed: {:?}", r.error);
        samples.push(elapsed);
        tempdirs.push(tmp);
    }

    print_results(&mut samples, Some(1000), Some(3000));
}

// ── Test 4: CSV import, 50k rows ────────────────────────────────────────────

#[test]
#[ignore]
fn csv_import_50k() {
    const ROWS: u32 = 50000;
    const ITERATIONS: usize = 10;

    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("perf_csv_50k.csv");

    // Build the CSV once. ~3MB of text:
    //   cols 0-4 strings, cols 5-9 numeric
    {
        let mut f = std::fs::File::create(&fixture).expect("create csv");
        let mut buf = String::with_capacity(8 * 1024 * 1024);
        for r in 0..ROWS {
            let line = format!(
                "item_{r},alpha_{r},beta_{r},gamma_{r},delta_{r},{},{},{},{},{}\n",
                det_num(r, 5),
                det_num(r, 6),
                det_num(r, 7),
                det_num(r, 8),
                det_num(r, 9),
            );
            buf.push_str(&line);
            if buf.len() > 4 * 1024 * 1024 {
                f.write_all(buf.as_bytes()).expect("write csv chunk");
                buf.clear();
            }
        }
        if !buf.is_empty() {
            f.write_all(buf.as_bytes()).expect("write csv tail");
        }
        f.flush().expect("flush csv");
    }

    let size = std::fs::metadata(&fixture).expect("metadata").len();
    print_header("csv_import_50k");
    println!(
        "  fixture: {:.2} MB ({} bytes), {} rows × 10 cols",
        size as f64 / 1024.0 / 1024.0,
        size,
        ROWS
    );
    std::io::stdout().flush().ok();

    let path = fixture.to_string_lossy().into_owned();

    // Warmup
    let warm = import_csv_core(path.clone()).expect("warmup csv import");
    assert!(warm.handle.snapshot_json.is_some());

    // Measure
    let mut samples: Vec<Duration> = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let t = Instant::now();
        let r = import_csv_core(path.clone()).expect("csv import ok");
        let elapsed = t.elapsed();
        assert!(r.handle.snapshot_json.is_some());
        samples.push(elapsed);
    }

    // No req-5.1 budget for CSV; print an informational suggested target.
    print_results(&mut samples, None, None);
    println!("  (informational suggested budget: p50 ~500 ms, p95 ~1500 ms)");
}

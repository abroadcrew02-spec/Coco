//! End-to-end coverage for xlsx merged-cell round-trip: import the xlsx,
//! verify the snapshot exposes `mergeData` per Univer's expected shape, export
//! through `export_xlsx_core`, then re-open with calamine to confirm the
//! `<mergeCell ref="..."/>` entries survived.

use calamine::{open_workbook, Xlsx};
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Format, Workbook};
use serde_json::Value;
use std::fs;
use std::io::Read as _;
use std::path::PathBuf;
use tempfile::TempDir;
use zip::ZipArchive;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Build a minimal xlsx with the given merged ranges. Each range is an A1-style
/// ref like "B2:D4". Cell content is just numeric "1" in the top-left of each
/// range so the file is non-empty.
fn build_fixture(path: &PathBuf, merges: &[&str]) {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("Sheet1").expect("set name");
    ws.write_number(0, 0, 1.0).expect("write seed");
    let fmt = Format::new();
    for m in merges {
        // Parse "A1:B2" → (sr, sc, er, ec) via calamine-free split.
        let (lhs, rhs) = m.split_once(':').map(|(a, b)| (a, b)).unwrap_or((*m, *m));
        let (sr, sc) = a1_to_rc(lhs);
        let (er, ec) = a1_to_rc(rhs);
        ws.merge_range(sr, sc, er, ec, "M", &fmt)
            .expect("merge_range");
    }
    wb.save(path).expect("save");
}

fn a1_to_rc(s: &str) -> (u32, u16) {
    let mut col = 0u32;
    let mut row_start = 0usize;
    for (i, ch) in s.char_indices() {
        if ch.is_ascii_alphabetic() {
            col = col * 26 + (ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
            row_start = i + 1;
        } else {
            break;
        }
    }
    let row: u32 = s[row_start..].parse().expect("row digits");
    (row - 1, (col - 1) as u16)
}

/// Pull the worksheet XML out of an xlsx zip so we can assert the
/// `<mergeCell ref="..."/>` entries directly. Avoids depending on calamine for
/// merge introspection (which it doesn't expose).
fn read_first_sheet_xml(path: &PathBuf) -> String {
    let bytes = fs::read(path).expect("read xlsx");
    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes)).expect("zip");
    let mut entry = archive
        .by_name("xl/worksheets/sheet1.xml")
        .expect("sheet1.xml");
    let mut xml = String::new();
    entry.read_to_string(&mut xml).expect("read xml");
    xml
}

fn sheet1_merge_data(snapshot: &Value) -> Vec<Value> {
    snapshot["sheets"]["sheet-1"]["mergeData"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[test]
fn single_merge_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    build_fixture(&fixture, &["B2:D4"]);

    // Import → snapshot
    let result = import_xlsx_core(path_str(&fixture)).expect("import ok");
    let snapshot_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let merges = sheet1_merge_data(&snapshot);
    assert_eq!(merges.len(), 1, "expected one merge entry");
    assert_eq!(merges[0]["startRow"].as_u64().unwrap(), 1);
    assert_eq!(merges[0]["startColumn"].as_u64().unwrap(), 1);
    assert_eq!(merges[0]["endRow"].as_u64().unwrap(), 3);
    assert_eq!(merges[0]["endColumn"].as_u64().unwrap(), 3);

    // Export
    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export ok");
    assert!(export.success, "export should succeed: {:?}", export.error);

    // Confirm merge survived: re-import, re-check mergeData.
    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snapshot2: Value =
        serde_json::from_str(&result2.handle.snapshot_json.expect("snap")).expect("parse2");
    let merges2 = sheet1_merge_data(&snapshot2);
    assert_eq!(merges2.len(), 1, "merge entry should round-trip");
    assert_eq!(merges2[0]["startRow"].as_u64().unwrap(), 1);
    assert_eq!(merges2[0]["endRow"].as_u64().unwrap(), 3);
    assert_eq!(merges2[0]["startColumn"].as_u64().unwrap(), 1);
    assert_eq!(merges2[0]["endColumn"].as_u64().unwrap(), 3);

    // And belt-and-braces: the raw xlsx XML contains <mergeCell ref="B2:D4"/>.
    let xml = read_first_sheet_xml(&exported);
    assert!(
        xml.contains("ref=\"B2:D4\""),
        "exported sheet1.xml should contain mergeCell ref=\"B2:D4\"; got:\n{xml}"
    );

    // Sanity: re-opening with calamine works (no parse errors from extra metadata).
    let _: Xlsx<_> = open_workbook(&exported).expect("calamine re-open");
}

#[test]
fn multiple_merges_round_trip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    // Pick non-overlapping ranges across the sheet.
    build_fixture(&fixture, &["A1:B2", "D4:E6", "G1:G3"]);

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let merges = sheet1_merge_data(&snapshot);
    assert_eq!(merges.len(), 3, "expected three merge entries");

    let mut seen: Vec<(u64, u64, u64, u64)> = merges
        .iter()
        .map(|e| {
            (
                e["startRow"].as_u64().unwrap(),
                e["startColumn"].as_u64().unwrap(),
                e["endRow"].as_u64().unwrap(),
                e["endColumn"].as_u64().unwrap(),
            )
        })
        .collect();
    seen.sort();
    assert!(seen.contains(&(0, 0, 1, 1)), "A1:B2 missing: {seen:?}");
    assert!(seen.contains(&(3, 3, 5, 4)), "D4:E6 missing: {seen:?}");
    assert!(seen.contains(&(0, 6, 2, 6)), "G1:G3 missing: {seen:?}");

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok");

    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value =
        serde_json::from_str(&result2.handle.snapshot_json.expect("snap")).expect("parse2");
    let merges2 = sheet1_merge_data(&snap2);
    assert_eq!(merges2.len(), 3, "three merges should round-trip");
}

#[test]
fn no_merges_yields_empty_array() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture_nomerges.xlsx");
    build_fixture(&fixture, &[]);

    let result = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = result.handle.snapshot_json.expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let merges = sheet1_merge_data(&snapshot);
    assert!(
        merges.is_empty(),
        "expected empty mergeData array, got {merges:?}"
    );

    // The field itself MUST be present (so the frontend can assume the shape).
    assert!(
        snapshot["sheets"]["sheet-1"]["mergeData"].is_array(),
        "mergeData should always be emitted as an array"
    );
}

#[test]
fn single_cell_merge_is_filtered_out() {
    // We can't build a single-cell merge via rust_xlsxwriter (it errors on
    // first_row == last_row && first_col == last_col), so we synthesize a
    // worksheet XML with `<mergeCell ref="A1:A1"/>` manually and verify that
    // both import-side filtering and export-side filtering drop it.
    //
    // Approach: build a valid fixture, unzip it, splice a single-cell merge
    // entry into sheet1.xml, re-zip, then re-import.

    use std::io::Write as _;
    use zip::write::FileOptions;

    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture_seed.xlsx");
    let patched = tmp.path().join("fixture_patched.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    // Seed with one valid merge so the `<mergeCells>` block already exists.
    build_fixture(&fixture, &["B2:C3"]);

    // Unzip → patch sheet1.xml → re-zip.
    let src_bytes = fs::read(&fixture).expect("read seed");
    let mut src_archive = ZipArchive::new(std::io::Cursor::new(src_bytes)).expect("seed zip");

    let out = fs::File::create(&patched).expect("create patched");
    let mut zip = zip::ZipWriter::new(out);
    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for i in 0..src_archive.len() {
        let mut entry = src_archive.by_index(i).expect("entry");
        let name = entry.name().to_string();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).expect("read entry");
        zip.start_file(&name, opts).expect("start_file");
        if name == "xl/worksheets/sheet1.xml" {
            let xml = String::from_utf8(data).expect("utf8");
            // Inject an A1:A1 merge alongside the existing B2:C3 entry. Bump
            // the count attr so consumers that trust it still parse cleanly.
            let patched_xml = xml.replace(
                "<mergeCells count=\"1\">",
                "<mergeCells count=\"2\"><mergeCell ref=\"A1:A1\"/>",
            );
            assert!(
                patched_xml != xml,
                "expected to find the seed mergeCells block to patch; original was:\n{xml}"
            );
            zip.write_all(patched_xml.as_bytes()).expect("write xml");
        } else {
            zip.write_all(&data).expect("write entry");
        }
    }
    zip.finish().expect("finish zip");

    // Import: A1:A1 should be filtered out, B2:C3 should remain.
    let result = import_xlsx_core(path_str(&patched)).expect("import patched");
    let snapshot_json = result.handle.snapshot_json.clone().expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let merges = sheet1_merge_data(&snapshot);
    assert_eq!(
        merges.len(),
        1,
        "single-cell merge should be filtered out at import; got {merges:?}"
    );
    assert_eq!(merges[0]["startRow"].as_u64().unwrap(), 1);
    assert_eq!(merges[0]["endColumn"].as_u64().unwrap(), 2);

    // Export: even if a frontend later injects an A1:A1 entry into mergeData,
    // it should not crash the export. Inject one and confirm.
    let mut snapshot_mut = snapshot.clone();
    let arr = snapshot_mut["sheets"]["sheet-1"]["mergeData"]
        .as_array_mut()
        .expect("array");
    arr.push(serde_json::json!({
        "startRow": 0,
        "startColumn": 0,
        "endRow": 0,
        "endColumn": 0,
    }));
    let injected_json = serde_json::to_string(&snapshot_mut).expect("serialize");
    let export = export_xlsx_core(path_str(&exported), injected_json).expect("export");
    assert!(
        export.success,
        "export should succeed despite injected single-cell entry: {:?}",
        export.error
    );

    // And the re-imported snapshot still contains only the valid range.
    let result2 = import_xlsx_core(path_str(&exported)).expect("re-import");
    let snap2: Value =
        serde_json::from_str(&result2.handle.snapshot_json.expect("snap")).expect("parse2");
    let merges2 = sheet1_merge_data(&snap2);
    assert_eq!(
        merges2.len(),
        1,
        "single-cell entry must not survive export"
    );
}

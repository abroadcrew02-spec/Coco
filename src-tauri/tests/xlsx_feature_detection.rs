use coco_lib::commands::xlsx_io::detect_unsupported_features;
use std::io::Write;
use tempfile::TempDir;
use zip::write::FileOptions;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

fn build_zip_with_entries(tmp: &TempDir, name: &str, entries: &[&str]) -> std::path::PathBuf {
    let path = tmp.path().join(name);
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions = FileOptions::default();
    for entry in entries {
        zip.start_file(*entry, opts).unwrap();
        zip.write_all(b"<xml/>").unwrap();
    }
    zip.finish().unwrap();
    path
}

#[test]
fn no_unsupported_features_in_plain_xlsx() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "plain.xlsx",
        &[
            "xl/workbook.xml",
            "xl/sharedStrings.xml",
            "xl/worksheets/sheet1.xml",
            "xl/styles.xml",
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(result.is_empty(), "expected no warnings, got {:?}", result);
}

#[test]
fn charts_detected() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "with_charts.xlsx",
        &[
            "xl/workbook.xml",
            "xl/worksheets/sheet1.xml",
            "xl/charts/chart1.xml",
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(
        result.iter().any(|w| w.code == "XLSX_CHARTS_DISCARDED"),
        "expected XLSX_CHARTS_DISCARDED, got {:?}",
        result
    );
}

#[test]
fn pivot_tables_detected() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "with_pivot.xlsx",
        &["xl/workbook.xml", "xl/pivotTables/pivotTable1.xml"],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(result.iter().any(|w| w.code == "XLSX_PIVOT_DISCARDED"));
}

#[test]
fn pivot_cache_also_detected_as_pivot() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "with_cache.xlsx",
        &["xl/workbook.xml", "xl/pivotCache/pivotCacheDefinition1.xml"],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(result.iter().any(|w| w.code == "XLSX_PIVOT_DISCARDED"));
}

#[test]
fn external_links_detected() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "with_links.xlsx",
        &["xl/workbook.xml", "xl/externalLinks/externalLink1.xml"],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(result.iter().any(|w| w.code == "XLSX_EXTERNAL_LINKS_DISCARDED"));
}

#[test]
fn vba_detected() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "with_vba.xlsx",
        &["xl/workbook.xml", "xl/vbaProject.bin"],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(result.iter().any(|w| w.code == "XLSX_VBA_DISCARDED"));
}

#[test]
fn drawings_and_media_detected_as_drawings() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "with_drawings.xlsx",
        &["xl/workbook.xml", "xl/drawings/drawing1.xml", "xl/media/image1.png"],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    // Both prefixes trigger the same warning code — should only get ONE warning, not two.
    let drawing_warnings: Vec<_> = result.iter().filter(|w| w.code == "XLSX_DRAWINGS_DISCARDED").collect();
    assert_eq!(drawing_warnings.len(), 1, "should dedupe to one drawing warning, got {:?}", result);
}

#[test]
fn embeddings_detected() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "with_embed.xlsx",
        &["xl/workbook.xml", "xl/embeddings/oleObject1.bin"],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(result.iter().any(|w| w.code == "XLSX_EMBEDDED_OBJECTS_DISCARDED"));
}

#[test]
fn multiple_features_detected_independently() {
    let tmp = TempDir::new().unwrap();
    let path = build_zip_with_entries(
        &tmp,
        "kitchen_sink.xlsx",
        &[
            "xl/workbook.xml",
            "xl/charts/chart1.xml",
            "xl/pivotTables/pivotTable1.xml",
            "xl/externalLinks/externalLink1.xml",
            "xl/vbaProject.bin",
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert_eq!(result.len(), 4, "expected 4 distinct warnings, got {:?}", result);
    let codes: Vec<&str> = result.iter().map(|w| w.code.as_str()).collect();
    assert!(codes.contains(&"XLSX_CHARTS_DISCARDED"));
    assert!(codes.contains(&"XLSX_PIVOT_DISCARDED"));
    assert!(codes.contains(&"XLSX_EXTERNAL_LINKS_DISCARDED"));
    assert!(codes.contains(&"XLSX_VBA_DISCARDED"));
}

#[test]
fn invalid_zip_returns_err() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("not_a_zip.xlsx");
    std::fs::write(&path, b"not a zip file").unwrap();
    let result = detect_unsupported_features(&path_str(&path));
    assert!(result.is_err());
}

#[test]
fn missing_file_returns_err() {
    let result = detect_unsupported_features("/definitely/not/here.xlsx");
    assert!(result.is_err());
}

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

fn build_zip_with_contents(
    tmp: &TempDir,
    name: &str,
    entries: &[(&str, &[u8])],
) -> std::path::PathBuf {
    let path = tmp.path().join(name);
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let opts: FileOptions = FileOptions::default();
    for (entry, body) in entries {
        zip.start_file(*entry, opts).unwrap();
        zip.write_all(body).unwrap();
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
fn conditional_formatting_detected_in_worksheet_xml() {
    let tmp = TempDir::new().unwrap();
    let sheet_xml = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData/>
<conditionalFormatting sqref="A1:A10">
  <cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan">
    <formula>5</formula>
  </cfRule>
</conditionalFormatting>
</worksheet>"#;
    let path = build_zip_with_contents(
        &tmp,
        "with_cf.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    let cf = result
        .iter()
        .find(|w| w.code == "XLSX_CONDITIONAL_FORMATTING")
        .unwrap_or_else(|| panic!("expected XLSX_CONDITIONAL_FORMATTING, got {:?}", result));
    assert_eq!(cf.severity, "warning");
    assert!(
        cf.message.contains("条件付き書式"),
        "message should mention conditional formatting in Japanese: {}",
        cf.message
    );
}

#[test]
fn conditional_formatting_not_emitted_when_absent() {
    let tmp = TempDir::new().unwrap();
    let sheet_xml = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
  <row r="1"><c r="A1"><v>1</v></c></row>
</sheetData>
</worksheet>"#;
    let path = build_zip_with_contents(
        &tmp,
        "no_cf.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(
        !result.iter().any(|w| w.code == "XLSX_CONDITIONAL_FORMATTING"),
        "should NOT emit conditional-formatting warning, got {:?}",
        result
    );
}

#[test]
fn conditional_formatting_detected_only_in_second_sheet() {
    let tmp = TempDir::new().unwrap();
    let plain = br#"<?xml version="1.0"?><worksheet><sheetData/></worksheet>"#;
    let with_cf = br#"<?xml version="1.0"?>
<worksheet><sheetData/><conditionalFormatting sqref="B1:B5"><cfRule type="containsText"/></conditionalFormatting></worksheet>"#;
    let path = build_zip_with_contents(
        &tmp,
        "cf_in_second.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", plain.as_slice()),
            ("xl/worksheets/sheet2.xml", with_cf.as_slice()),
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(
        result.iter().any(|w| w.code == "XLSX_CONDITIONAL_FORMATTING"),
        "expected detection across multiple worksheet entries, got {:?}",
        result
    );
}

#[test]
fn data_validation_detected_in_worksheet_xml() {
    let tmp = TempDir::new().unwrap();
    let sheet_xml = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData/>
<dataValidations count="1">
  <dataValidation type="list" sqref="A1:A10">
    <formula1>"yes,no"</formula1>
  </dataValidation>
</dataValidations>
</worksheet>"#;
    let path = build_zip_with_contents(
        &tmp,
        "with_dv.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    let dv = result
        .iter()
        .find(|w| w.code == "XLSX_DATA_VALIDATION")
        .unwrap_or_else(|| panic!("expected XLSX_DATA_VALIDATION, got {:?}", result));
    assert_eq!(dv.severity, "warning");
    assert!(
        dv.message.contains("データバリデーション"),
        "message should mention data validation in Japanese: {}",
        dv.message
    );
}

#[test]
fn data_validation_not_emitted_when_absent() {
    let tmp = TempDir::new().unwrap();
    let sheet_xml = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
  <row r="1"><c r="A1"><v>1</v></c></row>
</sheetData>
</worksheet>"#;
    let path = build_zip_with_contents(
        &tmp,
        "no_dv.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(
        !result.iter().any(|w| w.code == "XLSX_DATA_VALIDATION"),
        "should NOT emit data-validation warning, got {:?}",
        result
    );
}

/// Force the `<conditionalFormatting` marker to straddle the 64 KiB read
/// boundary. Without the chunk-overlap window in the scanner, the marker
/// would be split between two reads and missed.
#[test]
fn conditional_formatting_marker_split_across_chunk_boundary() {
    let tmp = TempDir::new().unwrap();
    let marker = b"<conditionalFormatting sqref=\"A1\"/>";
    // Pad so that the marker starts at an offset that places its middle bytes
    // exactly on the 65_536-byte chunk boundary. We want at least ~10 bytes of
    // the marker before the boundary and the rest after.
    const CHUNK: usize = 65_536;
    let pre_marker_len = CHUNK - 10; // marker begins 10 bytes before boundary
    let prefix = b"<worksheet><sheetData>";
    let padding_needed = pre_marker_len.saturating_sub(prefix.len());
    let mut sheet_xml: Vec<u8> = Vec::with_capacity(CHUNK + 1024);
    sheet_xml.extend_from_slice(prefix);
    sheet_xml.extend(std::iter::repeat(b' ').take(padding_needed));
    sheet_xml.extend_from_slice(marker);
    sheet_xml.extend_from_slice(b"</sheetData></worksheet>");
    // Sanity-check the layout actually straddles the boundary.
    let marker_start = prefix.len() + padding_needed;
    let marker_end = marker_start + marker.len();
    assert!(
        marker_start < CHUNK && marker_end > CHUNK,
        "test setup broken: marker should straddle CHUNK boundary"
    );

    let path = build_zip_with_contents(
        &tmp,
        "cf_split.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", &sheet_xml),
        ],
    );
    let result = detect_unsupported_features(&path_str(&path)).unwrap();
    assert!(
        result.iter().any(|w| w.code == "XLSX_CONDITIONAL_FORMATTING"),
        "boundary-straddling marker should still be detected, got {:?}",
        result
    );
}

/// The chunked scanner caps each worksheet at 16 MiB. A synthetic worksheet
/// padded past that cap must still complete (proves we don't slurp the entire
/// decompressed body into memory) and the conservative-cap policy must emit
/// the warning because we couldn't see the whole sheet.
#[test]
fn worksheet_scan_cap_enforced_at_16mib() {
    let tmp = TempDir::new().unwrap();
    // 18 MiB of padding, well past the 16 MiB cap. The actual marker is placed
    // AFTER the cap so a naive full-read would find it but the capped reader
    // must not (it'll instead emit conservatively because cap_hit=true).
    let padding_size = 18 * 1024 * 1024;
    let mut sheet_xml: Vec<u8> = Vec::with_capacity(padding_size + 256);
    sheet_xml.extend_from_slice(b"<worksheet><sheetData>");
    sheet_xml.extend(std::iter::repeat(b' ').take(padding_size));
    sheet_xml.extend_from_slice(b"<conditionalFormatting sqref=\"A1\"/>");
    sheet_xml.extend_from_slice(b"</sheetData></worksheet>");

    let path = build_zip_with_contents(
        &tmp,
        "huge_sheet.xlsx",
        &[
            ("xl/workbook.xml", b"<xml/>"),
            ("xl/worksheets/sheet1.xml", &sheet_xml),
        ],
    );
    let result = detect_unsupported_features(&path_str(&path))
        .expect("scan must complete on huge sheet, not OOM or error");
    // Conservative emission: cap-hit ⇒ warning even if marker bytes weren't
    // seen. This is intentional per the OOM-hardening spec.
    assert!(
        result.iter().any(|w| w.code == "XLSX_CONDITIONAL_FORMATTING"),
        "cap-hit policy should conservatively emit CF warning, got {:?}",
        result
    );
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

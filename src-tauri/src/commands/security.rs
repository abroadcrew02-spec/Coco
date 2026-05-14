use std::fs::File;
use zip::ZipArchive;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanResult {
    pub safe: bool,
    pub blocked: bool,
    pub warnings: Vec<String>,
    pub issues: Vec<String>,
}

const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED: u64 = 300 * 1024 * 1024;
const MAX_ENTRY_COUNT: usize = 2_000;
const MAX_XML_ENTRY_SIZE: u64 = 50 * 1024 * 1024;
const SHEET_WARN_THRESHOLD: usize = 100;
const SHEET_BLOCK_THRESHOLD: usize = 200;

fn bytes_to_mb(n: u64) -> u64 {
    n / (1024 * 1024)
}

#[tauri::command]
pub fn security_scan_xlsx(path: String) -> Result<SecurityScanResult, String> {
    let mut warnings: Vec<String> = Vec::new();
    let mut issues: Vec<String> = Vec::new();

    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let file_size = metadata.len();
    if file_size > MAX_FILE_SIZE {
        // Hard-block: don't try to ZIP-parse a file we've already rejected by size.
        // Otherwise a hostile actor's 51 MB blob of random bytes would surface as a
        // confusing "Invalid xlsx (zip)" error instead of the intended size verdict.
        issues.push(format!(
            "Input file size {} MB exceeds the {} MB limit",
            bytes_to_mb(file_size),
            bytes_to_mb(MAX_FILE_SIZE)
        ));
        return Ok(SecurityScanResult {
            safe: false,
            blocked: true,
            warnings: vec![
                // TODO(security): enforce §5.3.2 row/column/formula limits (see docs/TODOS.md#medium-security-row-col-formula-caps)
                "Row/column/formula limits not yet checked (Phase 2)".to_string(),
            ],
            issues,
        });
    }

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;

    let entry_count = archive.len();
    if entry_count > MAX_ENTRY_COUNT {
        issues.push(format!(
            "ZIP entry count {} exceeds the {} limit",
            entry_count, MAX_ENTRY_COUNT
        ));
    }

    let mut total_uncompressed: u64 = 0;
    let mut largest_xml: u64 = 0;
    let mut largest_xml_name = String::new();
    let mut sheet_count: usize = 0;

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let size = entry.size();
        total_uncompressed = total_uncompressed.saturating_add(size);

        let is_xml = name.ends_with(".xml") || name.ends_with(".rels");
        if is_xml && size > largest_xml {
            largest_xml = size;
            largest_xml_name = name.clone();
        }

        if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            sheet_count += 1;
        }
    }

    if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
        issues.push(format!(
            "Total uncompressed size {} MB exceeds the {} MB limit",
            bytes_to_mb(total_uncompressed),
            bytes_to_mb(MAX_TOTAL_UNCOMPRESSED)
        ));
    }

    if largest_xml > MAX_XML_ENTRY_SIZE {
        issues.push(format!(
            "Largest XML entry '{}' size {} MB exceeds the {} MB limit",
            largest_xml_name,
            bytes_to_mb(largest_xml),
            bytes_to_mb(MAX_XML_ENTRY_SIZE)
        ));
    }

    if sheet_count > SHEET_BLOCK_THRESHOLD {
        issues.push(format!(
            "Sheet count {} exceeds the {} hard limit",
            sheet_count, SHEET_BLOCK_THRESHOLD
        ));
    } else if sheet_count > SHEET_WARN_THRESHOLD {
        warnings.push(format!(
            "Sheet count {} exceeds the soft limit of {} (importable with confirmation)",
            sheet_count, SHEET_WARN_THRESHOLD
        ));
    }

    // TODO(security): enforce §5.3.2 row/column/formula limits (see docs/TODOS.md#medium-security-row-col-formula-caps)
    warnings.push("Row/column/formula limits not yet checked (Phase 2)".to_string());

    let blocked = !issues.is_empty();
    let safe = !blocked && warnings.is_empty();
    Ok(SecurityScanResult {
        safe,
        blocked,
        warnings,
        issues,
    })
}

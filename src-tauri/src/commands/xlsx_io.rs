use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;

use calamine::{open_workbook, Data, Reader, Xlsx};
use rust_xlsxwriter::{
    Color, ConditionalFormatCell, ConditionalFormatCellRule, ConditionalFormatFormula,
    ConditionalFormatText, ConditionalFormatTextRule, DataValidation, DataValidationErrorStyle,
    DataValidationRule, Format, FormatAlign, FormatBorder, FormatPattern, Formula, Url, Workbook,
};
use serde_json::{json, Map, Value};

use crate::commands::workbook::{
    rotate_backups, temp_save_path, CompatibilityWarning, ExportResult, ImportWorkbookResult,
    WorkbookHandle,
};

const MIN_ROWS: usize = 1000;
const MIN_COLS: usize = 100;
const LARGE_SHEET_THRESHOLD: usize = 100_000;

/// Normalized cell style extracted from xl/styles.xml + per-sheet `<c s="..."/>` refs.
/// Scope: font (bold/italic/color) + fill (color) + alignment (horizontal/vertical)
/// + borders (per-side style/color). Number formats and rich text remain out of scope.
#[derive(Default, Clone, PartialEq, Eq, Hash)]
struct CellStyle {
    bold: bool,
    italic: bool,
    font_color: Option<String>,    // "#RRGGBB"
    fill_color: Option<String>,    // "#RRGGBB"
    h_align: Option<String>,       // "left" | "center" | "right" | "fill" | "justify"
    v_align: Option<String>,       // "top" | "middle" | "bottom"
    borders: Option<CellBorders>,
}

#[derive(Default, Clone, PartialEq, Eq, Hash)]
struct CellBorders {
    top: Option<BorderSide>,
    bottom: Option<BorderSide>,
    left: Option<BorderSide>,
    right: Option<BorderSide>,
}

impl CellBorders {
    fn is_empty(&self) -> bool {
        self.top.is_none()
            && self.bottom.is_none()
            && self.left.is_none()
            && self.right.is_none()
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct BorderSide {
    style: String,           // "thin" | "medium" | "thick" | "double" | "dotted" | "dashed"
    color: Option<String>,   // "#RRGGBB"
}

/// One formatting run inside a rich-text cell. Mirrors the subset of OOXML
/// `<rPr>` (run properties) we round-trip. Fields are all optional so the
/// JSON shape stays compact — only the run's actual styling appears.
#[derive(Default, Clone, PartialEq, Debug)]
struct RichRun {
    text: String,
    bold: bool,
    italic: bool,
    color: Option<String>,   // "#RRGGBB"
    font_size: Option<f64>,  // point size (xlsx `sz val="..."`)
    font_name: Option<String>,
}

impl RichRun {
    fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("text".into(), Value::String(self.text.clone()));
        if self.bold {
            obj.insert("bold".into(), Value::Bool(true));
        }
        if self.italic {
            obj.insert("italic".into(), Value::Bool(true));
        }
        if let Some(c) = &self.color {
            obj.insert("color".into(), Value::String(c.clone()));
        }
        if let Some(sz) = self.font_size {
            obj.insert("fontSize".into(), json!(sz));
        }
        if let Some(n) = &self.font_name {
            obj.insert("fontName".into(), Value::String(n.clone()));
        }
        Value::Object(obj)
    }

    fn from_json(v: &Value) -> Option<RichRun> {
        let obj = v.as_object()?;
        let text = obj.get("text").and_then(|x| x.as_str())?.to_string();
        Some(RichRun {
            text,
            bold: obj.get("bold").and_then(|x| x.as_bool()).unwrap_or(false),
            italic: obj.get("italic").and_then(|x| x.as_bool()).unwrap_or(false),
            color: obj.get("color").and_then(|x| x.as_str()).map(|s| s.to_string()),
            font_size: obj.get("fontSize").and_then(|x| x.as_f64()),
            font_name: obj
                .get("fontName")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
        })
    }
}

impl CellStyle {
    fn is_empty(&self) -> bool {
        !self.bold
            && !self.italic
            && self.font_color.is_none()
            && self.fill_color.is_none()
            && self.h_align.is_none()
            && self.v_align.is_none()
            && self.borders.is_none()
    }

    fn to_json(&self) -> Value {
        let mut obj = Map::new();
        if self.bold || self.italic || self.font_color.is_some() {
            let mut f = Map::new();
            if self.bold {
                f.insert("bold".into(), Value::Bool(true));
            }
            if self.italic {
                f.insert("italic".into(), Value::Bool(true));
            }
            if let Some(c) = &self.font_color {
                f.insert("color".into(), Value::String(c.clone()));
            }
            obj.insert("font".into(), Value::Object(f));
        }
        if let Some(c) = &self.fill_color {
            let mut fl = Map::new();
            fl.insert("color".into(), Value::String(c.clone()));
            obj.insert("fill".into(), Value::Object(fl));
        }
        if self.h_align.is_some() || self.v_align.is_some() {
            let mut a = Map::new();
            if let Some(h) = &self.h_align {
                a.insert("horizontal".into(), Value::String(h.clone()));
            }
            if let Some(v) = &self.v_align {
                a.insert("vertical".into(), Value::String(v.clone()));
            }
            obj.insert("alignment".into(), Value::Object(a));
        }
        if let Some(b) = &self.borders {
            let mut bobj = Map::new();
            for (key, side) in [
                ("top", &b.top),
                ("bottom", &b.bottom),
                ("left", &b.left),
                ("right", &b.right),
            ] {
                if let Some(s) = side {
                    let mut sobj = Map::new();
                    sobj.insert("style".into(), Value::String(s.style.clone()));
                    if let Some(c) = &s.color {
                        sobj.insert("color".into(), Value::String(c.clone()));
                    }
                    bobj.insert(key.into(), Value::Object(sobj));
                }
            }
            obj.insert("borders".into(), Value::Object(bobj));
        }
        Value::Object(obj)
    }

    fn from_json(v: &Value) -> Option<CellStyle> {
        let obj = v.as_object()?;
        let mut s = CellStyle::default();
        if let Some(f) = obj.get("font").and_then(|x| x.as_object()) {
            s.bold = f.get("bold").and_then(|x| x.as_bool()).unwrap_or(false);
            s.italic = f.get("italic").and_then(|x| x.as_bool()).unwrap_or(false);
            s.font_color = f.get("color").and_then(|x| x.as_str()).map(|s| s.to_string());
        }
        if let Some(fl) = obj.get("fill").and_then(|x| x.as_object()) {
            s.fill_color = fl.get("color").and_then(|x| x.as_str()).map(|s| s.to_string());
        }
        if let Some(a) = obj.get("alignment").and_then(|x| x.as_object()) {
            s.h_align = a.get("horizontal").and_then(|x| x.as_str()).map(|s| s.to_string());
            s.v_align = a.get("vertical").and_then(|x| x.as_str()).map(|s| s.to_string());
        }
        if let Some(b) = obj.get("borders").and_then(|x| x.as_object()) {
            let read_side = |key: &str| -> Option<BorderSide> {
                let side_obj = b.get(key)?.as_object()?;
                let style = side_obj.get("style").and_then(|v| v.as_str())?.to_string();
                let color = side_obj
                    .get("color")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                Some(BorderSide { style, color })
            };
            let borders = CellBorders {
                top: read_side("top"),
                bottom: read_side("bottom"),
                left: read_side("left"),
                right: read_side("right"),
            };
            if !borders.is_empty() {
                s.borders = Some(borders);
            }
        }
        Some(s)
    }
}

/// Workbook-wide raw style indexes parsed from `xl/styles.xml`.
struct ParsedStyles {
    /// One CellStyle per cellXfs entry (index = xf id). Empty styles are still kept
    /// to preserve indexing semantics.
    cell_xfs: Vec<CellStyle>,
    /// Number-format string per cellXfs entry (index = xf id). `None` = no fmt
    /// (i.e. General or unmapped builtin).
    cell_num_formats: Vec<Option<String>>,
    /// sheet xml name (e.g. "sheet1") → map of (row0, col0) → xf index
    per_sheet: HashMap<String, HashMap<(u32, u32), usize>>,
}

/// Built-in Excel numFmtId mappings. Returns `None` for `0` (General) and any
/// id we don't normalize. Custom formats use ids >= 164 and live in
/// `<numFmts>` instead.
fn builtin_num_format(id: u32) -> Option<&'static str> {
    match id {
        0 => None, // "General" — no fmt
        1 => Some("0"),
        2 => Some("0.00"),
        9 => Some("0%"),
        10 => Some("0.00%"),
        14 => Some("yyyy-mm-dd"), // normalize locale-dependent dates
        22 => Some("yyyy-mm-dd hh:mm:ss"),
        38 => Some("#,##0;(#,##0)"),
        39 => Some("#,##0.00;(#,##0.00)"),
        49 => Some("@"), // text
        _ => None,
    }
}

fn parse_xlsx_styles(path: &str) -> Result<ParsedStyles, String> {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;

    // 1. styles.xml: fonts, fills, cellXfs
    let mut styles_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/styles.xml") {
        entry.read_to_string(&mut styles_xml).map_err(|e| e.to_string())?;
    }
    let (fonts, fills, borders, cell_xfs_raw, custom_num_fmts) = parse_styles_xml(&styles_xml);

    // 2. resolve each cellXf to a normalized CellStyle + number format
    let cell_xfs: Vec<CellStyle> = cell_xfs_raw
        .iter()
        .map(|x| resolve_xf(x, &fonts, &fills, &borders))
        .collect();
    let cell_num_formats: Vec<Option<String>> = cell_xfs_raw
        .iter()
        .map(|x| resolve_num_format(x, &custom_num_fmts))
        .collect();

    // 3. workbook.xml: ordered list of (sheet name, r:id)
    let mut wb_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/workbook.xml") {
        entry.read_to_string(&mut wb_xml).map_err(|e| e.to_string())?;
    }
    let sheet_refs = parse_workbook_sheets(&wb_xml);

    // 4. workbook.xml.rels: r:id → target path
    let mut rels_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/_rels/workbook.xml.rels") {
        entry.read_to_string(&mut rels_xml).map_err(|e| e.to_string())?;
    }
    let rels = parse_rels(&rels_xml);

    // 5. for each sheet, read its xml and extract per-cell `s` attributes
    let mut per_sheet: HashMap<String, HashMap<(u32, u32), usize>> = HashMap::new();
    for (sheet_name, rid) in &sheet_refs {
        let target = match rels.get(rid) {
            Some(t) => t.clone(),
            None => continue,
        };
        // Target paths are usually "worksheets/sheet1.xml" (relative to xl/). Normalize.
        let zip_path = if target.starts_with('/') {
            target.trim_start_matches('/').to_string()
        } else {
            format!("xl/{}", target)
        };
        let mut sheet_xml = String::new();
        if let Ok(mut entry) = archive.by_name(&zip_path) {
            if entry.read_to_string(&mut sheet_xml).is_err() {
                continue;
            }
        } else {
            continue;
        }
        let cell_map = parse_sheet_cell_styles(&sheet_xml);
        if !cell_map.is_empty() {
            per_sheet.insert(sheet_name.clone(), cell_map);
        }
    }

    Ok(ParsedStyles {
        cell_xfs,
        cell_num_formats,
        per_sheet,
    })
}

/// Per-sheet rich-text map: (row0, col0) -> Vec<RichRun>. Plain strings stay
/// out of the map so a missing entry means "use the plain calamine value".
type SheetRichTextMap = HashMap<(u32, u32), Vec<RichRun>>;

/// Parsed rich-text data for a workbook. Only the per-sheet map is consumed
/// downstream; the shared-strings vec is kept as an intermediate during
/// `parse_xlsx_rich_text` (used to resolve `<c t="s">` lookups) and isn't
/// read further once `per_sheet` is built.
struct ParsedRichText {
    per_sheet: HashMap<String, SheetRichTextMap>,
}

/// Parse `xl/sharedStrings.xml` + each sheet to find rich-text cells.
///
/// Two sources of rich text:
/// - `<si><r><rPr>...</rPr><t>...</t></r>...<si>` in sharedStrings.xml. Cells
///   referencing the index via `<c t="s"><v>N</v></c>` inherit the runs.
/// - `<c t="inlineStr"><is><r>...</r>...</is></c>` directly in the sheet XML.
fn parse_xlsx_rich_text(path: &str) -> Result<ParsedRichText, String> {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;

    // 1. sharedStrings.xml — optional (workbooks with only inline strings omit it)
    let mut ss_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/sharedStrings.xml") {
        entry.read_to_string(&mut ss_xml).map_err(|e| e.to_string())?;
    }
    let shared = parse_shared_strings_xml(&ss_xml);

    // 2. workbook.xml + rels to enumerate sheets (mirrors parse_xlsx_styles).
    let mut wb_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/workbook.xml") {
        entry.read_to_string(&mut wb_xml).map_err(|e| e.to_string())?;
    }
    let sheet_refs = parse_workbook_sheets(&wb_xml);

    let mut rels_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/_rels/workbook.xml.rels") {
        entry.read_to_string(&mut rels_xml).map_err(|e| e.to_string())?;
    }
    let rels = parse_rels(&rels_xml);

    // 3. Walk each sheet for shared-string refs that point to rich entries and
    //    for inline rich strings.
    let mut per_sheet: HashMap<String, SheetRichTextMap> = HashMap::new();
    for (sheet_name, rid) in &sheet_refs {
        let target = match rels.get(rid) {
            Some(t) => t.clone(),
            None => continue,
        };
        let zip_path = if target.starts_with('/') {
            target.trim_start_matches('/').to_string()
        } else {
            format!("xl/{}", target)
        };
        let mut sheet_xml = String::new();
        if let Ok(mut entry) = archive.by_name(&zip_path) {
            if entry.read_to_string(&mut sheet_xml).is_err() {
                continue;
            }
        } else {
            continue;
        }
        let map = parse_sheet_rich_text(&sheet_xml, &shared);
        if !map.is_empty() {
            per_sheet.insert(sheet_name.clone(), map);
        }
    }

    let _ = shared; // explicitly drop — only per_sheet is consumed by callers.
    Ok(ParsedRichText { per_sheet })
}

/// Parse `xl/sharedStrings.xml` into one entry per `<si>`. Entries are
/// `Some(runs)` when the `<si>` contains multiple `<r>` children (or any
/// `<r>` carrying `<rPr>`); plain `<si><t>text</t></si>` stays as `None`
/// because calamine already gives us the plain string. The vec is indexed
/// by the shared-string id used in `<c t="s"><v>N</v></c>`.
fn parse_shared_strings_xml(xml: &str) -> Vec<Option<Vec<RichRun>>> {
    let mut out: Vec<Option<Vec<RichRun>>> = Vec::new();
    if xml.is_empty() {
        return out;
    }
    let Some(block) = extract_block(xml, "<sst", "</sst>") else {
        return out;
    };
    for si in extract_elements(&block, "<si", "</si>") {
        let runs = parse_rich_runs(&si);
        if runs.is_empty() {
            out.push(None);
        } else if runs.len() == 1 && !run_has_formatting(&runs[0]) {
            // A single un-formatted `<r>` (no rPr) is effectively a plain string.
            out.push(None);
        } else {
            out.push(Some(runs));
        }
    }
    out
}

/// True when a run carries any visible formatting (i.e. should be kept as a
/// rich run rather than collapsed into the plain string).
fn run_has_formatting(r: &RichRun) -> bool {
    r.bold
        || r.italic
        || r.color.is_some()
        || r.font_size.is_some()
        || r.font_name.is_some()
}

/// Extract all `<r>...</r>` runs inside the given element body (works for
/// both `<si>` and `<is>` containers). Returns an empty Vec when no `<r>`
/// children are present.
fn parse_rich_runs(container_xml: &str) -> Vec<RichRun> {
    let mut runs: Vec<RichRun> = Vec::new();
    for r in extract_elements(container_xml, "<r", "</r>") {
        // Skip `<rPh>` (Asian phonetic) accidentally caught by the `<r` prefix
        // — extract_elements already gates on the char after the prefix, but
        // double-check the element header here.
        if r.starts_with("<rPh") || r.starts_with("<rPr") {
            continue;
        }
        // Text portion: `<t>...</t>` or `<t xml:space="preserve">...</t>`.
        let text = extract_t_text(&r).unwrap_or_default();
        if text.is_empty() {
            // rust_xlsxwriter rejects empty rich runs; skip them on import too
            // so we don't round-trip a run that re-export would refuse.
            continue;
        }
        let mut run = RichRun {
            text,
            ..RichRun::default()
        };
        // Run properties (`<rPr>`) carry font formatting for this run only.
        if let Some(rpr) = extract_block(&r, "<rPr", "</rPr>") {
            run.bold = has_self_or_open_tag(&rpr, "<b");
            run.italic = has_self_or_open_tag(&rpr, "<i");
            if let Some(color_el) = find_tag(&rpr, "<color") {
                run.color = parse_attr(&color_el, "rgb").map(normalize_argb);
            }
            if let Some(sz_el) = find_tag(&rpr, "<sz") {
                run.font_size = parse_attr(&sz_el, "val").and_then(|v| v.parse::<f64>().ok());
            }
            if let Some(name_el) = find_tag(&rpr, "<rFont") {
                run.font_name = parse_attr(&name_el, "val");
            }
        }
        runs.push(run);
    }
    runs
}

/// Pull the body of the first `<t>...</t>` child inside an `<r>` run. Honors
/// `xml:space="preserve"` by *not* trimming the returned text. Returns an
/// empty string for `<t/>` (Excel writes this for an empty run, although
/// rust_xlsxwriter rejects empty runs on export so we drop them upstream).
fn extract_t_text(run_xml: &str) -> Option<String> {
    // Find the opening `<t` of the run's text child. We have to be careful
    // not to grab a `<t>` inside `<rPr>` etc., but `<rPr>` never contains
    // `<t>`, so scanning the run as-is is fine.
    let open = run_xml.find("<t")?;
    // Ensure the next char is a valid tag boundary (space, '>', '/').
    let next = run_xml.as_bytes().get(open + 2).copied();
    if !matches!(next, Some(b' ') | Some(b'>') | Some(b'/')) {
        return None;
    }
    let gt = run_xml[open..].find('>')? + open;
    // Self-closing `<t/>` ⇒ empty.
    if run_xml.as_bytes().get(gt - 1) == Some(&b'/') {
        return Some(String::new());
    }
    let close = run_xml[gt..].find("</t>")? + gt;
    Some(decode_xml_entities(&run_xml[gt + 1..close]))
}

/// For one sheet's XML, find every `<c>` that points to a rich shared string
/// or carries an inline rich string. Returns a (row, col) -> runs map. The
/// `shared` argument is the workbook's parsed sharedStrings table.
fn parse_sheet_rich_text(
    xml: &str,
    shared: &[Option<Vec<RichRun>>],
) -> SheetRichTextMap {
    let mut out: SheetRichTextMap = HashMap::new();
    let bytes = xml.as_bytes();
    let mut i: usize = 0;
    while i + 2 < bytes.len() {
        // Find an opening `<c ` / `<c>` / `<c/>` tag (NOT `<col>`, `<cell...>`).
        if bytes[i] == b'<'
            && bytes[i + 1] == b'c'
            && (bytes[i + 2] == b' ' || bytes[i + 2] == b'>' || bytes[i + 2] == b'/')
        {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != b'>' {
                j += 1;
            }
            if j >= bytes.len() {
                break;
            }
            let opening = &xml[i..=j];
            let self_closing = bytes.get(j - 1) == Some(&b'/');
            let r_attr = parse_attr(opening, "r");
            let t_attr = parse_attr(opening, "t");
            let coord = r_attr.as_deref().and_then(parse_a1);

            // If the `<c>` is self-closing it can't carry a value/runs.
            if self_closing {
                i = j + 1;
                continue;
            }

            // Locate the matching `</c>` (cells can't nest).
            let close_rel = match xml[j..].find("</c>") {
                Some(p) => p,
                None => break,
            };
            let body = &xml[j + 1..j + close_rel];
            let end_abs = j + close_rel + "</c>".len();

            if let Some(coord) = coord {
                match t_attr.as_deref() {
                    Some("s") => {
                        // Shared-string reference: <v>N</v>
                        if let Some(v_block) = extract_block(body, "<v", "</v>") {
                            if let Ok(idx) = v_block.trim().parse::<usize>() {
                                if let Some(Some(runs)) = shared.get(idx) {
                                    out.insert(coord, runs.clone());
                                }
                            }
                        }
                    }
                    Some("inlineStr") => {
                        // Inline string: `<is>` with optional `<r>` runs.
                        if let Some(is_block) = extract_block(body, "<is", "</is>") {
                            let runs = parse_rich_runs(&is_block);
                            // Only treat as rich when at least one run has
                            // formatting (or the cell has multiple runs).
                            let keep = runs.len() > 1
                                || runs.iter().any(run_has_formatting);
                            if keep && !runs.is_empty() {
                                out.insert(coord, runs);
                            }
                        }
                    }
                    _ => {}
                }
            }

            i = end_abs;
        } else {
            i += 1;
        }
    }
    out
}

/// Returns (fonts, fills, borders, raw_xfs, custom_num_fmts). Each font/fill
/// is a (bold,italic,color)/(color) tuple. `custom_num_fmts` is a map of
/// `numFmtId -> formatCode` for `<numFmt>` entries (typically id >= 164).
fn parse_styles_xml(
    xml: &str,
) -> (Vec<RawFont>, Vec<RawFill>, Vec<RawBorder>, Vec<RawXf>, HashMap<u32, String>) {
    let mut fonts: Vec<RawFont> = Vec::new();
    let mut fills: Vec<RawFill> = Vec::new();
    let mut borders: Vec<RawBorder> = Vec::new();
    let mut xfs: Vec<RawXf> = Vec::new();
    let mut custom_num_fmts: HashMap<u32, String> = HashMap::new();

    // numFmts: <numFmts ...> <numFmt numFmtId="164" formatCode="..."/> ... </numFmts>
    if let Some(block) = extract_block(xml, "<numFmts", "</numFmts>") {
        for el in extract_self_closing_or_paired(&block, "numFmt") {
            let id = parse_attr(&el, "numFmtId").and_then(|s| s.parse::<u32>().ok());
            let code = parse_attr(&el, "formatCode");
            if let (Some(id), Some(code)) = (id, code) {
                custom_num_fmts.insert(id, decode_xml_entities(&code));
            }
        }
    }

    // Fonts: <fonts ...> ... <font> ... </font> ... </fonts>
    if let Some(fonts_block) = extract_block(xml, "<fonts", "</fonts>") {
        for font_el in extract_elements(&fonts_block, "<font", "</font>") {
            let mut f = RawFont::default();
            // <b/> or <b val="1"/> means bold; absence means not bold.
            f.bold = has_self_or_open_tag(&font_el, "<b");
            f.italic = has_self_or_open_tag(&font_el, "<i");
            // <color rgb="FF000000"/> or <color theme=".."/> — we only honor rgb.
            if let Some(color_el) = find_tag(&font_el, "<color") {
                f.color = parse_attr(&color_el, "rgb").map(normalize_argb);
            }
            fonts.push(f);
        }
    }

    // Fills: <fills> ... <fill><patternFill patternType="solid"><fgColor rgb="FFRRGGBB"/></patternFill></fill> ...
    if let Some(fills_block) = extract_block(xml, "<fills", "</fills>") {
        for fill_el in extract_elements(&fills_block, "<fill", "</fill>") {
            let mut f = RawFill::default();
            if let Some(pf) = find_tag(&fill_el, "<patternFill") {
                let pattern = parse_attr(&pf, "patternType").unwrap_or_default();
                if pattern == "solid" {
                    // Excel quirk: in "solid" fills the color is in fgColor.
                    if let Some(fg) = find_tag(&fill_el, "<fgColor") {
                        f.color = parse_attr(&fg, "rgb").map(normalize_argb);
                    }
                }
            }
            fills.push(f);
        }
    }

    // Borders: <borders> ... <border><top style="thin"><color rgb="FF000000"/></top> ... </border> ...
    if let Some(borders_block) = extract_block(xml, "<borders", "</borders>") {
        for border_el in extract_elements(&borders_block, "<border", "</border>") {
            let mut b = RawBorder::default();
            b.top = parse_border_side(&border_el, "<top");
            b.bottom = parse_border_side(&border_el, "<bottom");
            b.left = parse_border_side(&border_el, "<left");
            b.right = parse_border_side(&border_el, "<right");
            borders.push(b);
        }
    }

    // cellXfs: <cellXfs ...> <xf ...><alignment .../></xf> ... </cellXfs>
    if let Some(xfs_block) = extract_block(xml, "<cellXfs", "</cellXfs>") {
        for xf_el in extract_elements(&xfs_block, "<xf", "</xf>") {
            let mut x = RawXf::default();
            x.font_id = parse_attr(&xf_el, "fontId").and_then(|s| s.parse().ok());
            x.fill_id = parse_attr(&xf_el, "fillId").and_then(|s| s.parse().ok());
            x.border_id = parse_attr(&xf_el, "borderId").and_then(|s| s.parse().ok());
            x.num_fmt_id = parse_attr(&xf_el, "numFmtId").and_then(|s| s.parse().ok());
            x.apply_font = parse_attr(&xf_el, "applyFont").as_deref() == Some("1");
            x.apply_fill = parse_attr(&xf_el, "applyFill").as_deref() == Some("1");
            x.apply_border = parse_attr(&xf_el, "applyBorder").as_deref() == Some("1");
            x.apply_number_format =
                parse_attr(&xf_el, "applyNumberFormat").as_deref() == Some("1");
            x.apply_alignment = parse_attr(&xf_el, "applyAlignment").as_deref() == Some("1");
            if let Some(align) = find_tag(&xf_el, "<alignment") {
                x.h_align = parse_attr(&align, "horizontal");
                x.v_align = parse_attr(&align, "vertical");
            }
            xfs.push(x);
        }
        // Some files use self-closing <xf .../> inside cellXfs — handle by also splitting
        // the block on `<xf` boundaries.
        if xfs.is_empty() {
            for xf_el in extract_self_closing_or_paired(&xfs_block, "xf") {
                let mut x = RawXf::default();
                x.font_id = parse_attr(&xf_el, "fontId").and_then(|s| s.parse().ok());
                x.fill_id = parse_attr(&xf_el, "fillId").and_then(|s| s.parse().ok());
                x.border_id = parse_attr(&xf_el, "borderId").and_then(|s| s.parse().ok());
                x.num_fmt_id = parse_attr(&xf_el, "numFmtId").and_then(|s| s.parse().ok());
                x.apply_font = parse_attr(&xf_el, "applyFont").as_deref() == Some("1");
                x.apply_fill = parse_attr(&xf_el, "applyFill").as_deref() == Some("1");
                x.apply_border = parse_attr(&xf_el, "applyBorder").as_deref() == Some("1");
                x.apply_number_format =
                    parse_attr(&xf_el, "applyNumberFormat").as_deref() == Some("1");
                x.apply_alignment = parse_attr(&xf_el, "applyAlignment").as_deref() == Some("1");
                if let Some(align) = find_tag(&xf_el, "<alignment") {
                    x.h_align = parse_attr(&align, "horizontal");
                    x.v_align = parse_attr(&align, "vertical");
                }
                xfs.push(x);
            }
        }
    }

    (fonts, fills, borders, xfs, custom_num_fmts)
}

/// Decode the small set of XML entities that may appear inside `formatCode`
/// attributes (rust_xlsxwriter / Excel escape `&`, `<`, `>`, `"`).
fn decode_xml_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Parse a `<top style="thin"><color rgb="FF000000"/></top>` (or similar side
/// tag) into a BorderSide. Returns None if the tag is absent, the `style`
/// attribute is missing/empty, or the style is "none".
fn parse_border_side(border_xml: &str, side_open: &str) -> Option<BorderSide> {
    let tag_open = find_tag(border_xml, side_open)?;
    let style = parse_attr(&tag_open, "style")?;
    if style.is_empty() || style == "none" {
        return None;
    }
    // The element may be self-closing (just attrs) or paired with an inner
    // `<color .../>`. Extract the full element body so we can look for color.
    let elements = extract_elements(border_xml, side_open, &format!("</{}>", &side_open[1..]));
    let body = elements.into_iter().next().unwrap_or(tag_open);
    let color = find_tag(&body, "<color").and_then(|c| parse_attr(&c, "rgb").map(normalize_argb));
    Some(BorderSide { style, color })
}

#[derive(Default, Clone)]
struct RawFont {
    bold: bool,
    italic: bool,
    color: Option<String>, // "#RRGGBB"
}

#[derive(Default, Clone)]
struct RawFill {
    color: Option<String>, // "#RRGGBB"
}

#[derive(Default, Clone)]
struct RawBorder {
    top: Option<BorderSide>,
    bottom: Option<BorderSide>,
    left: Option<BorderSide>,
    right: Option<BorderSide>,
}

impl RawBorder {
    fn is_empty(&self) -> bool {
        self.top.is_none()
            && self.bottom.is_none()
            && self.left.is_none()
            && self.right.is_none()
    }
}

#[derive(Default, Clone)]
struct RawXf {
    font_id: Option<usize>,
    fill_id: Option<usize>,
    border_id: Option<usize>,
    num_fmt_id: Option<u32>,
    apply_font: bool,
    apply_fill: bool,
    apply_border: bool,
    apply_number_format: bool,
    apply_alignment: bool,
    h_align: Option<String>,
    v_align: Option<String>,
}

/// Resolve a cellXf's `numFmtId` into a format string. Built-in ids (0..163)
/// map via `builtin_num_format`; custom ids (>=164 conventionally) look up
/// `<numFmt>` entries from the workbook. Returns `None` when the cell uses
/// "General" or an unknown id.
fn resolve_num_format(xf: &RawXf, custom: &HashMap<u32, String>) -> Option<String> {
    let id = xf.num_fmt_id?;
    // Honor the format regardless of `applyNumberFormat` — many writers
    // (including rust_xlsxwriter) omit the flag even when the format is set.
    if let Some(code) = custom.get(&id) {
        if !code.is_empty() {
            return Some(code.clone());
        }
    }
    builtin_num_format(id).map(|s| s.to_string())
}

fn resolve_xf(xf: &RawXf, fonts: &[RawFont], fills: &[RawFill], borders: &[RawBorder]) -> CellStyle {
    let mut s = CellStyle::default();
    // Font: honor regardless of applyFont — many writers omit the apply* flag.
    if let Some(idx) = xf.font_id {
        if let Some(f) = fonts.get(idx) {
            s.bold = f.bold;
            s.italic = f.italic;
            s.font_color = f.color.clone();
        }
    }
    // Fill: Excel reserves fills 0 (none) and 1 (gray125 default). Skip those.
    if let Some(idx) = xf.fill_id {
        if idx >= 2 {
            if let Some(f) = fills.get(idx) {
                s.fill_color = f.color.clone();
            }
        }
    }
    // Border: like font, honor regardless of applyBorder. Skip if no sides are set.
    if let Some(idx) = xf.border_id {
        if let Some(rb) = borders.get(idx) {
            if !rb.is_empty() {
                s.borders = Some(CellBorders {
                    top: rb.top.clone(),
                    bottom: rb.bottom.clone(),
                    left: rb.left.clone(),
                    right: rb.right.clone(),
                });
            }
        }
    }
    if xf.apply_alignment || xf.h_align.is_some() || xf.v_align.is_some() {
        s.h_align = xf.h_align.clone();
        // Normalize OOXML's "center" → keep as-is; "middle" only exists in some writers.
        s.v_align = xf.v_align.clone().map(|v| match v.as_str() {
            "center" => "middle".to_string(),
            other => other.to_string(),
        });
    }
    s
}

fn parse_workbook_sheets(xml: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(block) = extract_block(xml, "<sheets", "</sheets>") {
        for el in extract_self_closing_or_paired(&block, "sheet") {
            let name = parse_attr(&el, "name").unwrap_or_default();
            let rid = parse_attr(&el, "r:id").unwrap_or_default();
            if !name.is_empty() && !rid.is_empty() {
                out.push((name, rid));
            }
        }
    }
    out
}

/// Parse `xl/workbook.xml` for per-sheet visibility. Returns
/// `sheet name -> state` for any sheet whose `state` attribute is `"hidden"`
/// or `"veryHidden"`. Sheets without the attribute (i.e. visible) are omitted.
fn parse_workbook_sheet_visibility(xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(block) = extract_block(xml, "<sheets", "</sheets>") {
        for el in extract_self_closing_or_paired(&block, "sheet") {
            let name = parse_attr(&el, "name").unwrap_or_default();
            let state = parse_attr(&el, "state").unwrap_or_default();
            if !name.is_empty() && (state == "hidden" || state == "veryHidden") {
                out.insert(name, state);
            }
        }
    }
    out
}

/// One parsed freeze-pane declaration from a worksheet's `<sheetView>`.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct FreezePaneEntry {
    /// 0-based row of the first scrollable cell (== ySplit; rows 0..row are frozen).
    pub row: u32,
    /// 0-based column of the first scrollable cell (== xSplit; cols 0..col are frozen).
    pub col: u32,
    /// Optional A1-style top-left visible cell in the scrolling pane
    /// (e.g. `"A20"`), as written by `topLeftCell` on the `<pane>` element.
    pub top_left: Option<String>,
}

/// Parse the `<sheetView><pane .../></sheetView>` block of one worksheet's XML
/// into a `FreezePaneEntry`. Returns `None` when no frozen pane is declared.
/// Only `state="frozen"` (and its xSplit/ySplit/topLeftCell attrs) is handled
/// — split panes (the live-drag variant) are intentionally out of scope.
fn parse_sheet_freeze_pane(xml: &str) -> Option<FreezePaneEntry> {
    let view = extract_block(xml, "<sheetView", "</sheetView>")?;
    let pane = find_tag(&view, "<pane")?;
    let state = parse_attr(&pane, "state").unwrap_or_default();
    if state != "frozen" {
        return None;
    }
    let x_split: u32 = parse_attr(&pane, "xSplit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let y_split: u32 = parse_attr(&pane, "ySplit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if x_split == 0 && y_split == 0 {
        return None;
    }
    let top_left = parse_attr(&pane, "topLeftCell").filter(|s| !s.is_empty());
    Some(FreezePaneEntry {
        row: y_split,
        col: x_split,
        top_left,
    })
}

/// Walk every sheet in an xlsx and pull out its freeze-pane declaration.
/// Returns `sheet name -> FreezePaneEntry`; sheets without a frozen pane are
/// omitted.
pub(crate) fn parse_xlsx_freeze_panes(path: &str) -> HashMap<String, FreezePaneEntry> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let sheet_paths = parse_sheet_path_map(&bytes);
    if sheet_paths.is_empty() {
        return HashMap::new();
    }
    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };
    let mut out: HashMap<String, FreezePaneEntry> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(&entry_path) {
            if entry.read_to_string(&mut xml).is_ok() {
                if let Some(fp) = parse_sheet_freeze_pane(&xml) {
                    out.insert(sheet_name, fp);
                }
            }
        }
    }
    out
}

/// Read `xl/workbook.xml` from an xlsx and return the sheet-visibility map.
/// Best-effort: returns empty on read or parse failure.
pub(crate) fn parse_xlsx_sheet_visibility(path: &str) -> HashMap<String, String> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };
    let mut wb_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/workbook.xml") {
        if entry.read_to_string(&mut wb_xml).is_err() {
            return HashMap::new();
        }
    } else {
        return HashMap::new();
    }
    parse_workbook_sheet_visibility(&wb_xml)
}

fn parse_rels(xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for el in extract_self_closing_or_paired(xml, "Relationship") {
        let id = parse_attr(&el, "Id").unwrap_or_default();
        let target = parse_attr(&el, "Target").unwrap_or_default();
        if !id.is_empty() && !target.is_empty() {
            out.insert(id, target);
        }
    }
    out
}

fn parse_sheet_cell_styles(xml: &str) -> HashMap<(u32, u32), usize> {
    let mut out = HashMap::new();
    // Scan all <c ...> opens; capture r="A1" and s="N" attrs.
    let bytes = xml.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'<' && bytes[i + 1] == b'c' && (bytes[i + 2] == b' ' || bytes[i + 2] == b'>' || bytes[i + 2] == b'/') {
            // find end of opening tag '>'
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != b'>' {
                j += 1;
            }
            if j >= bytes.len() {
                break;
            }
            let tag = &xml[i..=j];
            // Must be opening tag of <c> only — skip <col>, <cellStyle>, etc.
            // Already enforced above via the char after "<c".
            if let (Some(r), Some(s)) = (parse_attr(tag, "r"), parse_attr(tag, "s")) {
                if let Some((row, col)) = parse_a1(&r) {
                    if let Ok(idx) = s.parse::<usize>() {
                        out.insert((row, col), idx);
                    }
                }
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Parse an A1-style ref like "B12" or "AA100" into (row0, col0).
fn parse_a1(s: &str) -> Option<(u32, u32)> {
    let mut col = 0u32;
    let mut row_start = 0;
    for (i, ch) in s.char_indices() {
        if ch.is_ascii_alphabetic() {
            col = col * 26 + (ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
            row_start = i + 1;
        } else {
            break;
        }
    }
    if col == 0 || row_start >= s.len() {
        return None;
    }
    let row: u32 = s[row_start..].parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

// ---- tiny XML helpers (just enough for our well-formed inputs) ----

fn extract_block<'a>(xml: &'a str, open_prefix: &str, close_tag: &str) -> Option<String> {
    let open_idx = xml.find(open_prefix)?;
    // Find the '>' that closes the opening tag (it may have attrs).
    let after_open = xml[open_idx..].find('>')? + open_idx + 1;
    let close_rel = xml[after_open..].find(close_tag)?;
    Some(xml[after_open..after_open + close_rel].to_string())
}

/// Returns element substrings for each `<name ...> ... </name>` block.
fn extract_elements(xml: &str, open_prefix: &str, close_tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(open_rel) = xml[cursor..].find(open_prefix) {
        let open_abs = cursor + open_rel;
        // ensure char after prefix is ' ', '>' or '/' to avoid prefix collisions
        let after = open_abs + open_prefix.len();
        let next_ch = xml.as_bytes().get(after).copied();
        if !matches!(next_ch, Some(b' ') | Some(b'>') | Some(b'/')) {
            cursor = open_abs + open_prefix.len();
            continue;
        }
        // Find end of opening tag
        let gt = match xml[open_abs..].find('>') {
            Some(p) => open_abs + p,
            None => break,
        };
        // Self-closing?
        if xml.as_bytes().get(gt - 1) == Some(&b'/') {
            out.push(xml[open_abs..=gt].to_string());
            cursor = gt + 1;
            continue;
        }
        // Find matching close tag
        let close_rel = match xml[gt..].find(close_tag) {
            Some(p) => p,
            None => break,
        };
        let close_abs_end = gt + close_rel + close_tag.len();
        out.push(xml[open_abs..close_abs_end].to_string());
        cursor = close_abs_end;
    }
    out
}

/// For tags that may be self-closing or paired. Yields the opening tag substring
/// plus any inner content if paired (caller usually only needs attrs from the
/// opening tag, so we return the full element).
fn extract_self_closing_or_paired(xml: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open_prefix = format!("<{}", name);
    let close_tag = format!("</{}>", name);
    let mut cursor = 0;
    while let Some(open_rel) = xml[cursor..].find(&open_prefix) {
        let open_abs = cursor + open_rel;
        let after = open_abs + open_prefix.len();
        let next_ch = xml.as_bytes().get(after).copied();
        if !matches!(next_ch, Some(b' ') | Some(b'>') | Some(b'/')) {
            cursor = open_abs + open_prefix.len();
            continue;
        }
        let gt = match xml[open_abs..].find('>') {
            Some(p) => open_abs + p,
            None => break,
        };
        if xml.as_bytes().get(gt - 1) == Some(&b'/') {
            out.push(xml[open_abs..=gt].to_string());
            cursor = gt + 1;
            continue;
        }
        match xml[gt..].find(&close_tag) {
            Some(p) => {
                let end = gt + p + close_tag.len();
                out.push(xml[open_abs..end].to_string());
                cursor = end;
            }
            None => {
                // Treat as opening-only.
                out.push(xml[open_abs..=gt].to_string());
                cursor = gt + 1;
            }
        }
    }
    out
}

fn find_tag(xml: &str, open_prefix: &str) -> Option<String> {
    let idx = xml.find(open_prefix)?;
    let after = idx + open_prefix.len();
    if !matches!(xml.as_bytes().get(after), Some(b' ') | Some(b'>') | Some(b'/')) {
        // collision; try further
        return find_tag(&xml[after..], open_prefix);
    }
    let end = xml[idx..].find('>')? + idx + 1;
    Some(xml[idx..end].to_string())
}

fn has_self_or_open_tag(xml: &str, open_prefix: &str) -> bool {
    let mut cursor = 0;
    while let Some(rel) = xml[cursor..].find(open_prefix) {
        let abs = cursor + rel;
        let after = abs + open_prefix.len();
        let next_ch = xml.as_bytes().get(after).copied();
        if matches!(next_ch, Some(b' ') | Some(b'>') | Some(b'/')) {
            // Found. If val="0", it's actually NOT set.
            let end = match xml[abs..].find('>') {
                Some(p) => abs + p + 1,
                None => return true,
            };
            let tag = &xml[abs..end];
            if let Some(v) = parse_attr(tag, "val") {
                return v != "0" && v != "false";
            }
            return true;
        }
        cursor = after;
    }
    false
}

fn parse_attr(tag: &str, name: &str) -> Option<String> {
    // Looks for `name="value"` inside the tag. Tolerates `name='value'` too.
    let needle_eq = format!("{}=", name);
    let mut cursor = 0;
    while let Some(rel) = tag[cursor..].find(&needle_eq) {
        let abs = cursor + rel;
        // Ensure this `name=` is preceded by whitespace or `<tagname` boundary,
        // so we don't match `applyFont` when looking for `font`.
        if abs > 0 {
            let before = tag.as_bytes()[abs - 1];
            if !(before == b' ' || before == b'\t' || before == b'\n' || before == b'\r') {
                cursor = abs + needle_eq.len();
                continue;
            }
        }
        let after = abs + needle_eq.len();
        let quote = *tag.as_bytes().get(after)?;
        if quote != b'"' && quote != b'\'' {
            cursor = after;
            continue;
        }
        let val_start = after + 1;
        let val_end = tag[val_start..].find(quote as char)? + val_start;
        return Some(tag[val_start..val_end].to_string());
    }
    None
}

/// Normalize an "AARRGGBB" hex (8 chars) or "RRGGBB" (6 chars) to "#RRGGBB".
fn normalize_argb(s: String) -> String {
    let trimmed = s.trim();
    if trimmed.len() == 8 {
        format!("#{}", &trimmed[2..])
    } else if trimmed.len() == 6 {
        format!("#{}", trimmed)
    } else {
        trimmed.to_string()
    }
}

/// Parse a "#RRGGBB" string into a rust_xlsxwriter Color::RGB.
fn parse_color(hex: &str) -> Option<Color> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(Color::RGB(v))
}

fn build_format(style: &CellStyle, num_format: Option<&str>) -> Format {
    let mut fmt = Format::new();
    if style.bold {
        fmt = fmt.set_bold();
    }
    if style.italic {
        fmt = fmt.set_italic();
    }
    if let Some(c) = style.font_color.as_deref().and_then(parse_color) {
        fmt = fmt.set_font_color(c);
    }
    if let Some(c) = style.fill_color.as_deref().and_then(parse_color) {
        // Need both pattern=Solid and bg color for a visible fill.
        fmt = fmt.set_background_color(c).set_pattern(FormatPattern::Solid);
    }
    if let Some(h) = style.h_align.as_deref() {
        let align = match h {
            "left" => Some(FormatAlign::Left),
            "center" | "centerContinuous" => Some(FormatAlign::Center),
            "right" => Some(FormatAlign::Right),
            "fill" => Some(FormatAlign::Fill),
            "justify" => Some(FormatAlign::Justify),
            _ => None,
        };
        if let Some(a) = align {
            fmt = fmt.set_align(a);
        }
    }
    if let Some(v) = style.v_align.as_deref() {
        let align = match v {
            "top" => Some(FormatAlign::Top),
            "middle" | "center" => Some(FormatAlign::VerticalCenter),
            "bottom" => Some(FormatAlign::Bottom),
            _ => None,
        };
        if let Some(a) = align {
            fmt = fmt.set_align(a);
        }
    }
    if let Some(b) = &style.borders {
        if let Some(side) = &b.top {
            fmt = fmt.set_border_top(border_style_for(&side.style));
            if let Some(c) = side.color.as_deref().and_then(parse_color) {
                fmt = fmt.set_border_top_color(c);
            }
        }
        if let Some(side) = &b.bottom {
            fmt = fmt.set_border_bottom(border_style_for(&side.style));
            if let Some(c) = side.color.as_deref().and_then(parse_color) {
                fmt = fmt.set_border_bottom_color(c);
            }
        }
        if let Some(side) = &b.left {
            fmt = fmt.set_border_left(border_style_for(&side.style));
            if let Some(c) = side.color.as_deref().and_then(parse_color) {
                fmt = fmt.set_border_left_color(c);
            }
        }
        if let Some(side) = &b.right {
            fmt = fmt.set_border_right(border_style_for(&side.style));
            if let Some(c) = side.color.as_deref().and_then(parse_color) {
                fmt = fmt.set_border_right_color(c);
            }
        }
    }
    if let Some(nf) = num_format {
        fmt = fmt.set_num_format(nf);
    }
    fmt
}

/// Build a Format suitable for one rich-text run. Only Font properties survive
/// in rich strings per Excel's rules; fill/border/alignment on a per-run basis
/// are silently ignored by the rust_xlsxwriter rich-string API.
fn build_run_format(run: &RichRun) -> Format {
    let mut fmt = Format::new();
    if run.bold {
        fmt = fmt.set_bold();
    }
    if run.italic {
        fmt = fmt.set_italic();
    }
    if let Some(c) = run.color.as_deref().and_then(parse_color) {
        fmt = fmt.set_font_color(c);
    }
    if let Some(sz) = run.font_size {
        fmt = fmt.set_font_size(sz);
    }
    if let Some(name) = run.font_name.as_deref() {
        fmt = fmt.set_font_name(name);
    }
    fmt
}

/// Map a stored OOXML border style string to a rust_xlsxwriter FormatBorder.
/// Unknown styles fall back to Thin so the visual border isn't lost entirely.
fn border_style_for(s: &str) -> FormatBorder {
    match s {
        "thin" => FormatBorder::Thin,
        "medium" => FormatBorder::Medium,
        "thick" => FormatBorder::Thick,
        "double" => FormatBorder::Double,
        "dotted" => FormatBorder::Dotted,
        "dashed" => FormatBorder::Dashed,
        _ => FormatBorder::Thin,
    }
}

fn data_to_cell(d: &Data, num_format_override: Option<&str>) -> Option<Value> {
    let base = match d {
        Data::Empty => None,
        Data::Int(n) => Some(json!({ "v": n })),
        Data::Float(f) => Some(json!({ "v": f })),
        Data::String(s) => Some(json!({ "v": s })),
        Data::Bool(b) => Some(json!({ "v": b })),
        Data::DateTime(dt) => {
            let v = dt.as_f64();
            let fmt = if v.fract().abs() < f64::EPSILON {
                "yyyy-mm-dd"
            } else {
                "yyyy-mm-dd hh:mm:ss"
            };
            Some(json!({ "v": v, "_fmt": fmt }))
        }
        Data::DateTimeIso(s) => Some(json!({ "v": s, "_fmt": "@" })),
        Data::DurationIso(s) => Some(json!({ "v": s })),
        Data::Error(_) => Some(json!({ "v": Value::Null, "t": "e" })),
    };
    // Apply the style's number format (when present) on top, overriding the
    // calamine-derived default. This lets `0%`, `#,##0.00`, etc. round-trip
    // while leaving the DateTime fallback in place for cells that have no xf.
    match (base, num_format_override) {
        (Some(mut v), Some(fmt)) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("_fmt".into(), Value::String(fmt.to_string()));
            }
            Some(v)
        }
        (base, _) => base,
    }
}

/// Hard cap on decompressed bytes scanned per worksheet by
/// `worksheet_contains_marker`. Worksheets in legitimate files almost always
/// fit; the cap exists so a maliciously-crafted or pathologically large sheet
/// can't OOM the process. 16 MiB chosen as a compromise between covering real
/// CF/dataValidation blocks (typically near the end of the sheet) and bounding
/// memory.
const WORKSHEET_SCAN_CAP_BYTES: u64 = 16 * 1024 * 1024;
/// Read buffer size for the chunked worksheet scan.
const WORKSHEET_SCAN_CHUNK: usize = 65_536;
/// Overlap window kept between successive chunks so a marker straddling a
/// 64 KiB boundary is still found. Must be >= max marker length.
const WORKSHEET_SCAN_OVERLAP: usize = 32;

/// Scan a single worksheet entry in the archive for the given byte marker
/// without loading the whole decompressed XML into memory.
///
/// - Reads in 64 KiB chunks and keeps a 32-byte trailing window so markers
///   spanning chunk boundaries are still detected.
/// - Hard-caps total bytes read per sheet at `WORKSHEET_SCAN_CAP_BYTES`. The
///   second return value is `true` iff the cap was hit (callers may want to
///   emit a conservative warning).
/// - Bubbles up real I/O errors instead of masking them as "marker not found".
///
/// Known false-positive limitation: matches the literal byte sequence
/// anywhere, including inside XML comments. Coco's xlsx writer never emits
/// comments around `<conditionalFormatting`/`<dataValidations`, so this only
/// affects hand-authored or third-party files. We accept the over-warning.
fn worksheet_contains_marker<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    idx: usize,
    marker: &[u8],
) -> Result<(bool, bool), String> {
    assert!(
        marker.len() <= WORKSHEET_SCAN_OVERLAP,
        "marker longer than overlap window; bump WORKSHEET_SCAN_OVERLAP"
    );

    let mut entry = archive.by_index(idx).map_err(|e| e.to_string())?;
    let mut buf = [0u8; WORKSHEET_SCAN_CHUNK];
    // The overlap holds the tail bytes of the previous chunk so we can detect
    // markers that span the chunk boundary. We search the concatenation of
    // (overlap || current chunk) each iteration.
    let mut overlap: Vec<u8> = Vec::with_capacity(WORKSHEET_SCAN_OVERLAP);
    let mut total_read: u64 = 0;
    let mut cap_hit = false;

    loop {
        let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total_read = total_read.saturating_add(n as u64);

        // Build a scratch view of (overlap || new bytes) and search it whole.
        // Allocation is bounded by 64KiB + 32B per iteration.
        let mut window: Vec<u8> = Vec::with_capacity(overlap.len() + n);
        window.extend_from_slice(&overlap);
        window.extend_from_slice(&buf[..n]);

        if memchr_find(&window, marker) {
            return Ok((true, false));
        }

        // Preserve the tail of `window` as the next iteration's overlap so a
        // marker that straddles the next chunk boundary is still detected.
        let keep = window.len().min(WORKSHEET_SCAN_OVERLAP);
        overlap.clear();
        overlap.extend_from_slice(&window[window.len() - keep..]);

        if total_read >= WORKSHEET_SCAN_CAP_BYTES {
            cap_hit = true;
            break;
        }
    }

    Ok((false, cap_hit))
}

/// Substring search via libstd's window iteration. Pulled out to a free
/// function so callers read cleanly; ripgrep-style `memchr` is overkill for
/// the short ASCII markers we use.
fn memchr_find(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Inspects the ZIP for unsupported feature directories and returns a list of
/// CompatibilityWarning entries describing what will be silently dropped on
/// save-back. Pure-Rust: takes the path so it's testable from cargo test.
pub fn detect_unsupported_features(path: &str) -> Result<Vec<CompatibilityWarning>, String> {
    use std::fs::File;
    use zip::ZipArchive;

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;

    let mut has_charts = false;
    let mut has_pivot = false;
    let mut has_external_links = false;
    let mut has_vba = false;
    let mut has_embeddings = false;
    let mut has_drawings = false;
    // Collect worksheet entry indices first; per-sheet content scans need a
    // mutable borrow of the archive that can't coexist with the iteration borrow.
    let mut worksheet_indices: Vec<usize> = Vec::new();

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name();

        if name.starts_with("xl/charts/") {
            has_charts = true;
        }
        if name.starts_with("xl/pivotTables/") || name.starts_with("xl/pivotCache/") {
            has_pivot = true;
        }
        if name.starts_with("xl/externalLinks/") {
            has_external_links = true;
        }
        if name == "xl/vbaProject.bin" {
            has_vba = true;
        }
        if name.starts_with("xl/embeddings/") {
            has_embeddings = true;
        }
        if name.starts_with("xl/drawings/") || name.starts_with("xl/media/") {
            has_drawings = true;
        }
        if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            worksheet_indices.push(i);
        }
    }

    // Per-sheet XML body scan: conditional formatting + data validations both
    // live inline. Stops scanning a feature as soon as any sheet hits — we do
    // not collect affected_sheets per spec (keep it simple). The chunked
    // reader hard-caps memory per sheet so a 500 MB worksheet can't OOM us.
    let cf_marker: &[u8] = b"<conditionalFormatting";
    let dv_marker: &[u8] = b"<dataValidations";
    let mut has_conditional_formatting = false;
    let mut has_data_validation = false;

    for i in worksheet_indices {
        if !has_conditional_formatting {
            let (hit, cap_hit) = worksheet_contains_marker(&mut archive, i, cf_marker)?;
            // Cap-hit ⇒ we did not see the full XML. Emit conservatively so a
            // 500 MB sheet that legitimately contains conditional formatting
            // past the 16 MiB mark still surfaces the warning.
            if hit || cap_hit {
                has_conditional_formatting = true;
            }
        }
        if !has_data_validation {
            let (hit, cap_hit) = worksheet_contains_marker(&mut archive, i, dv_marker)?;
            if hit || cap_hit {
                has_data_validation = true;
            }
        }
        if has_conditional_formatting && has_data_validation {
            break;
        }
    }

    let mut warnings = Vec::new();

    if has_charts {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_CHARTS_DISCARDED".to_string(),
            message: "このファイルにはグラフが含まれていますが、Coco では保持されません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_pivot {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_PIVOT_DISCARDED".to_string(),
            message: "ピボットテーブルが含まれていますが、Coco では保持されません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_external_links {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_EXTERNAL_LINKS_DISCARDED".to_string(),
            message: "外部ブックへのリンクが含まれていますが、Coco では値のみ保持され、リンクは失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_vba {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_VBA_DISCARDED".to_string(),
            message: "VBA マクロが含まれていますが、Coco では実行も保持もされません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_embeddings {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_EMBEDDED_OBJECTS_DISCARDED".to_string(),
            message: "埋め込みオブジェクト（OLE 等）が含まれていますが、Coco では保持されません。".to_string(),
            affected_sheets: None,
        });
    }
    if has_drawings {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_DRAWINGS_DISCARDED".to_string(),
            message: "図形・画像が含まれていますが、Coco では保持されません。保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_conditional_formatting {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_CONDITIONAL_FORMATTING".to_string(),
            message: "条件付き書式が検出されました。Coco では編集できず、保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_data_validation {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_DATA_VALIDATION".to_string(),
            message: "データバリデーション設定が検出されました。Coco では編集できず、保存時に失われます。".to_string(),
            affected_sheets: None,
        });
    }

    Ok(warnings)
}

/// Per-sheet column widths and row heights parsed straight out of the xlsx
/// worksheet XML. calamine 0.24 does not expose this metadata, so we parse the
/// raw zip ourselves.
#[derive(Debug, Default, Clone)]
pub(crate) struct SheetDimensions {
    /// Map of 0-based column index -> width (in character units, as stored in xlsx XML).
    pub columns: HashMap<u32, f64>,
    /// Map of 0-based row index -> height (in point units).
    pub rows: HashMap<u32, f64>,
}

/// Read `xl/workbook.xml` and the rels file to build a `sheet name -> worksheet
/// xml zip-path` mapping. Returns an empty map on any parse error (callers
/// should treat the absence of dimensions as "no custom widths/heights").
fn parse_sheet_path_map(archive_bytes: &[u8]) -> HashMap<String, String> {
    use std::io::Cursor;
    use zip::ZipArchive;

    let mut out: HashMap<String, String> = HashMap::new();

    let Ok(mut archive) = ZipArchive::new(Cursor::new(archive_bytes)) else {
        return out;
    };

    // Pull workbook.xml — list of <sheet name="..." sheetId="..." r:id="rIdN"/>
    let mut workbook_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/workbook.xml") {
        if entry.read_to_string(&mut workbook_xml).is_err() {
            return out;
        }
    } else {
        return out;
    }

    // Pull rels — maps rId -> Target (e.g. "worksheets/sheet1.xml")
    let mut rels_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/_rels/workbook.xml.rels") {
        let _ = entry.read_to_string(&mut rels_xml);
    }

    let rid_to_target = parse_rels(&rels_xml);
    let sheets = parse_workbook_sheets(&workbook_xml);

    for (name, rid) in sheets {
        if let Some(target) = rid_to_target.get(&rid) {
            // Targets can be "worksheets/sheet1.xml" or "/xl/worksheets/sheet1.xml".
            let normalized = if target.starts_with('/') {
                target.trim_start_matches('/').to_string()
            } else {
                format!("xl/{target}")
            };
            out.insert(name, normalized);
        }
    }

    out
}

/// Pull a `key="value"` attribute out of a substring. Naive but adequate for
/// the well-formed XML rust_xlsxwriter / Excel emit.
fn extract_attr(tag: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Parse one sheet's XML, returning the dimensions block (or default/empty if
/// no custom widths/heights are declared).
fn parse_sheet_dimensions_xml(xml: &str) -> SheetDimensions {
    let mut dims = SheetDimensions::default();

    // --- columns ---
    if let (Some(s), Some(e)) = (xml.find("<cols"), xml.find("</cols>")) {
        if e > s {
            let body = &xml[s..e];
            let mut cursor = 0usize;
            while let Some(start) = body[cursor..].find("<col ") {
                let abs_start = cursor + start;
                let rest = &body[abs_start..];
                let end = match rest.find("/>").or_else(|| rest.find('>')) {
                    Some(end) => end,
                    None => break,
                };
                let tag = &rest[..end];
                let is_custom = extract_attr(tag, "customWidth").as_deref() == Some("1");
                if is_custom {
                    let min: Option<u32> = extract_attr(tag, "min").and_then(|s| s.parse().ok());
                    let max: Option<u32> = extract_attr(tag, "max").and_then(|s| s.parse().ok());
                    let width: Option<f64> =
                        extract_attr(tag, "width").and_then(|s| s.parse().ok());
                    if let (Some(min), Some(max), Some(w)) = (min, max, width) {
                        // min/max are 1-based, inclusive; convert to 0-based.
                        let start_col = min.saturating_sub(1);
                        let end_col = max.saturating_sub(1);
                        for c in start_col..=end_col {
                            dims.columns.insert(c, w);
                        }
                    }
                }
                cursor = abs_start + end + 2;
            }
        }
    }

    // --- rows ---
    // We only need the opening <row ...> tags. Scan them sequentially.
    let mut cursor = 0usize;
    while let Some(start) = xml[cursor..].find("<row ") {
        let abs_start = cursor + start;
        let rest = &xml[abs_start..];
        // Find the end of the start-tag (the first '>', not counting self-closing edge cases).
        let end = match rest.find('>') {
            Some(e) => e,
            None => break,
        };
        let tag = &rest[..end];
        let is_custom = extract_attr(tag, "customHeight").as_deref() == Some("1");
        if is_custom {
            let r: Option<u32> = extract_attr(tag, "r").and_then(|s| s.parse().ok());
            let h: Option<f64> = extract_attr(tag, "ht").and_then(|s| s.parse().ok());
            if let (Some(r), Some(h)) = (r, h) {
                // `r` is 1-based; convert to 0-based.
                dims.rows.insert(r.saturating_sub(1), h);
            }
        }
        cursor = abs_start + end + 1;
    }

    dims
}

/// Parse per-sheet column widths and row heights out of an xlsx. Returns a map
/// keyed by sheet name. Quietly returns an empty map if anything is malformed
/// — dimensions are best-effort metadata, not load-bearing.
pub(crate) fn parse_xlsx_dimensions(path: &str) -> HashMap<String, SheetDimensions> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };

    let sheet_paths = parse_sheet_path_map(&bytes);
    if sheet_paths.is_empty() {
        return HashMap::new();
    }

    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };

    let mut out: HashMap<String, SheetDimensions> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(&entry_path) {
            if entry.read_to_string(&mut xml).is_ok() {
                let dims = parse_sheet_dimensions_xml(&xml);
                if !dims.columns.is_empty() || !dims.rows.is_empty() {
                    out.insert(sheet_name, dims);
                }
            }
        }
    }

    out
}

/// Parse an A1-style range reference like `"B3:D5"` or `"A1"` into 0-based
/// `(start_row, start_col, end_row, end_col)`. A single cell ref expands to a
/// range where start == end. Returns `None` for malformed input.
fn parse_range_ref(s: &str) -> Option<(u32, u32, u32, u32)> {
    let s = s.trim();
    if let Some((lhs, rhs)) = s.split_once(':') {
        let (sr, sc) = parse_a1(lhs.trim())?;
        let (er, ec) = parse_a1(rhs.trim())?;
        // Normalize so start <= end on each axis, in case Excel ever emits a
        // reversed ref (very rare, but cheap to handle).
        let (sr, er) = if sr <= er { (sr, er) } else { (er, sr) };
        let (sc, ec) = if sc <= ec { (sc, ec) } else { (ec, sc) };
        Some((sr, sc, er, ec))
    } else {
        let (r, c) = parse_a1(s)?;
        Some((r, c, r, c))
    }
}

/// Parse one sheet's XML and extract the merged-cell ranges declared in its
/// `<mergeCells>...<mergeCell ref="A1:B2"/>...</mergeCells>` block. Each entry
/// is `(start_row, start_col, end_row, end_col)`, 0-based, inclusive on both
/// ends. Single-cell refs (start == end on both axes) are filtered out because
/// rust_xlsxwriter rejects them on export and Excel itself doesn't allow them.
fn parse_sheet_merge_cells(xml: &str) -> Vec<(u32, u32, u32, u32)> {
    let mut out = Vec::new();
    let Some(block) = extract_block(xml, "<mergeCells", "</mergeCells>") else {
        return out;
    };
    for el in extract_self_closing_or_paired(&block, "mergeCell") {
        let Some(reference) = parse_attr(&el, "ref") else {
            continue;
        };
        let Some((sr, sc, er, ec)) = parse_range_ref(&reference) else {
            continue;
        };
        if sr == er && sc == ec {
            // Skip degenerate single-cell merges.
            continue;
        }
        out.push((sr, sc, er, ec));
    }
    out
}

/// Parse per-sheet merged-cell ranges out of an xlsx. Returns a map keyed by
/// sheet name. Returns an empty map on any I/O / structure error — merges are
/// best-effort metadata, not load-bearing.
pub(crate) fn parse_xlsx_merges(path: &str) -> HashMap<String, Vec<(u32, u32, u32, u32)>> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };

    let sheet_paths = parse_sheet_path_map(&bytes);
    if sheet_paths.is_empty() {
        return HashMap::new();
    }

    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };

    let mut out: HashMap<String, Vec<(u32, u32, u32, u32)>> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(&entry_path) {
            if entry.read_to_string(&mut xml).is_ok() {
                let merges = parse_sheet_merge_cells(&xml);
                if !merges.is_empty() {
                    out.insert(sheet_name, merges);
                }
            }
        }
    }

    out
}

/// One parsed `<dataValidation>` element from a worksheet's XML, normalized
/// into a stable struct that we round-trip through the snapshot JSON. We keep
/// every attribute Excel writes that's needed to reconstruct the rule, plus
/// the originating sqref so non-contiguous ranges (e.g. `"A1:A5 C1:C5"`)
/// survive intact.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DataValidationEntry {
    pub sqref: String,
    /// One of: "list", "whole", "decimal", "date", "time", "textLength",
    /// "custom", or "" for the Any type (no validation rule, message-only).
    pub validation_type: String,
    /// Operator: "between" | "notBetween" | "equal" | "notEqual" |
    /// "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual".
    /// Empty for "list", "custom", and types Excel doesn't store an operator on.
    pub operator: String,
    pub formula1: String,
    pub formula2: String,
    pub allow_blank: bool,
    pub show_error_message: bool,
    pub show_input_message: bool,
    /// "stop" | "warning" | "information". Empty means default ("stop").
    pub error_style: String,
    pub error_title: String,
    pub error_message: String,
    pub prompt_title: String,
    pub prompt_message: String,
}

/// Parse one sheet's `<dataValidations>...</dataValidations>` block. Returns
/// an empty vec when the sheet has no validations. Tolerant of malformed
/// entries: a single bad child is skipped, not fatal for the rest.
fn parse_sheet_data_validations(xml: &str) -> Vec<DataValidationEntry> {
    let mut out = Vec::new();
    let Some(block) = extract_block(xml, "<dataValidations", "</dataValidations>") else {
        return out;
    };
    for el in extract_self_closing_or_paired(&block, "dataValidation") {
        // The opening tag carries the attributes; the inner body holds
        // <formula1>/<formula2>.
        let head_end = match el.find('>') {
            Some(p) => p + 1,
            None => continue,
        };
        let head = &el[..head_end];

        let Some(sqref) = parse_attr(head, "sqref") else {
            continue;
        };
        let sqref = decode_xml_entities(&sqref);
        if sqref.trim().is_empty() {
            continue;
        }

        let validation_type =
            parse_attr(head, "type").map(|s| decode_xml_entities(&s)).unwrap_or_default();
        let operator =
            parse_attr(head, "operator").map(|s| decode_xml_entities(&s)).unwrap_or_default();

        let bool_attr = |name: &str| -> bool {
            parse_attr(head, name)
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false)
        };
        let allow_blank = bool_attr("allowBlank");
        let show_error_message = bool_attr("showErrorMessage");
        let show_input_message = bool_attr("showInputMessage");
        let error_style =
            parse_attr(head, "errorStyle").map(|s| decode_xml_entities(&s)).unwrap_or_default();
        let error_title =
            parse_attr(head, "errorTitle").map(|s| decode_xml_entities(&s)).unwrap_or_default();
        let error_message =
            parse_attr(head, "error").map(|s| decode_xml_entities(&s)).unwrap_or_default();
        let prompt_title =
            parse_attr(head, "promptTitle").map(|s| decode_xml_entities(&s)).unwrap_or_default();
        let prompt_message =
            parse_attr(head, "prompt").map(|s| decode_xml_entities(&s)).unwrap_or_default();

        // Strip the head; the rest holds <formula1>...</formula1>[<formula2>...</formula2>].
        let body = if head_end < el.len() {
            &el[head_end..]
        } else {
            ""
        };
        let formula1 = extract_inner_text(body, "<formula1", "</formula1>").unwrap_or_default();
        let formula2 = extract_inner_text(body, "<formula2", "</formula2>").unwrap_or_default();

        out.push(DataValidationEntry {
            sqref,
            validation_type,
            operator,
            formula1: decode_xml_entities(&formula1),
            formula2: decode_xml_entities(&formula2),
            allow_blank,
            show_error_message,
            show_input_message,
            error_style,
            error_title,
            error_message,
            prompt_title,
            prompt_message,
        });
    }
    out
}

/// Helper: grab the *text* inside `<tag ...>...</tag>` from `xml`. Returns
/// None if the open tag isn't present.
fn extract_inner_text(xml: &str, open_prefix: &str, close_tag: &str) -> Option<String> {
    let open_idx = xml.find(open_prefix)?;
    let after_open = xml[open_idx..].find('>')? + open_idx + 1;
    // Self-closing `<formula1/>`.
    if xml.as_bytes().get(after_open.saturating_sub(2)) == Some(&b'/') {
        return Some(String::new());
    }
    let close_rel = xml[after_open..].find(close_tag)?;
    Some(xml[after_open..after_open + close_rel].to_string())
}

/// Parse per-sheet `<dataValidations>` ranges out of an xlsx. Returns a map
/// keyed by sheet name. Returns an empty map on I/O / structure error — like
/// the other per-sheet parsers, data validations are best-effort metadata.
pub(crate) fn parse_xlsx_data_validations(path: &str) -> HashMap<String, Vec<DataValidationEntry>> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };

    let sheet_paths = parse_sheet_path_map(&bytes);
    if sheet_paths.is_empty() {
        return HashMap::new();
    }

    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };

    let mut out: HashMap<String, Vec<DataValidationEntry>> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(&entry_path) {
            if entry.read_to_string(&mut xml).is_ok() {
                let dvs = parse_sheet_data_validations(&xml);
                if !dvs.is_empty() {
                    out.insert(sheet_name, dvs);
                }
            }
        }
    }

    out
}

/// One parsed `<hyperlink>` entry from a worksheet's XML, resolved against the
/// per-sheet rels file so the URL target is in hand. Internal links (Excel's
/// `<hyperlink location="Sheet2!A1"/>` shape with no rels rId) store the target
/// in `target` with a leading `#` so the export side can re-emit them via
/// rust_xlsxwriter's `internal:` URL prefix.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HyperlinkEntry {
    /// A1-style single-cell ref. The OOXML attribute is `ref="A1"`. We only
    /// handle single-cell hyperlinks (Excel itself only writes them per-cell
    /// in practice). Range refs are stored verbatim and snapped to the top-left
    /// cell on export.
    pub cell: String,
    /// Resolved target. For external links this is the URL pulled from the
    /// per-sheet rels Target attribute. For internal links it's `#Sheet2!A1`
    /// (taken from the `location` attribute on the hyperlink element, with a
    /// leading `#`).
    pub target: String,
    /// Optional display text shown in the cell (the `display` attribute).
    pub display: String,
    /// Optional tooltip text (the `tooltip` attribute).
    pub tooltip: String,
}

/// Parse one sheet's `<hyperlinks>...</hyperlinks>` block. `rels` maps the
/// per-sheet rId → Target string (for external hyperlinks). Returns an empty
/// vec when the sheet has no hyperlinks.
fn parse_sheet_hyperlinks(
    xml: &str,
    rels: &HashMap<String, String>,
) -> Vec<HyperlinkEntry> {
    let mut out = Vec::new();
    let Some(block) = extract_block(xml, "<hyperlinks", "</hyperlinks>") else {
        return out;
    };
    for el in extract_self_closing_or_paired(&block, "hyperlink") {
        // Only need the opening tag's attributes.
        let head_end = match el.find('>') {
            Some(p) => p + 1,
            None => continue,
        };
        let head = &el[..head_end];
        let Some(cell_ref) = parse_attr(head, "ref") else {
            continue;
        };
        let cell_ref = decode_xml_entities(&cell_ref);
        // Range refs like "A1:B2" — keep just the top-left cell since
        // rust_xlsxwriter writes URLs per-cell.
        let cell = cell_ref
            .split_once(':')
            .map(|(lhs, _)| lhs.to_string())
            .unwrap_or(cell_ref);
        if cell.trim().is_empty() {
            continue;
        }

        // r:id resolves to an entry in the per-sheet rels (external link).
        // OOXML namespacing means we may see "r:id" or "id" depending on
        // emitter; parse_attr does a literal match so try both.
        let rid = parse_attr(head, "r:id")
            .or_else(|| parse_attr(head, "id"))
            .map(|s| decode_xml_entities(&s));
        let location = parse_attr(head, "location").map(|s| decode_xml_entities(&s));
        let display = parse_attr(head, "display")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();
        let tooltip = parse_attr(head, "tooltip")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();

        let target = match (rid.as_deref(), location.as_deref()) {
            (Some(r), _) if !r.is_empty() => match rels.get(r) {
                Some(t) if !t.is_empty() => {
                    // External rels Target may itself carry a "#anchor" for
                    // sheet-local links written via the rels indirection.
                    // Append the location if present so e.g.
                    // file://foo.xlsx#Sheet1!A1 round-trips.
                    if let Some(loc) = location.as_deref().filter(|s| !s.is_empty()) {
                        format!("{t}#{loc}")
                    } else {
                        t.clone()
                    }
                }
                // rId unresolved: fall back to location-only if available.
                _ => match location.as_deref() {
                    Some(loc) if !loc.is_empty() => format!("#{loc}"),
                    _ => continue,
                },
            },
            (_, Some(loc)) if !loc.is_empty() => format!("#{loc}"),
            _ => continue,
        };

        out.push(HyperlinkEntry {
            cell,
            target,
            display,
            tooltip,
        });
    }
    out
}

/// Resolve per-sheet rels file path for a given worksheet entry path. The
/// rels file lives at `xl/worksheets/_rels/sheetN.xml.rels` for an entry at
/// `xl/worksheets/sheetN.xml`. Returns the conventional rels path either way
/// (the caller is responsible for handling "missing entry" gracefully).
fn sheet_rels_path(sheet_entry_path: &str) -> Option<String> {
    let (dir, file) = sheet_entry_path.rsplit_once('/')?;
    Some(format!("{dir}/_rels/{file}.rels"))
}

/// Parse per-sheet hyperlinks out of an xlsx, joining each sheet's
/// `<hyperlinks>` block with its dedicated rels file. Returns a map keyed by
/// sheet name. Empty map on I/O / structure error — hyperlinks are best-effort
/// metadata, same policy as merges and data validations.
pub(crate) fn parse_xlsx_hyperlinks(path: &str) -> HashMap<String, Vec<HyperlinkEntry>> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };

    let sheet_paths = parse_sheet_path_map(&bytes);
    if sheet_paths.is_empty() {
        return HashMap::new();
    }

    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };

    let mut out: HashMap<String, Vec<HyperlinkEntry>> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        // Read the per-sheet rels file (may be absent — internal-only links).
        let rels: HashMap<String, String> = sheet_rels_path(&entry_path)
            .and_then(|rels_path| {
                let mut s = String::new();
                archive
                    .by_name(&rels_path)
                    .ok()?
                    .read_to_string(&mut s)
                    .ok()?;
                Some(parse_rels(&s))
            })
            .unwrap_or_default();

        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(&entry_path) {
            if entry.read_to_string(&mut xml).is_ok() {
                let links = parse_sheet_hyperlinks(&xml, &rels);
                if !links.is_empty() {
                    out.insert(sheet_name, links);
                }
            }
        }
    }

    out
}

/// One parsed cell-note entry from a worksheet's linked `comments*.xml`.
/// Coco preserves only the legacy (non-threaded) form: cell reference, author
/// name, plain text. Modern threaded comments (`xl/threadedComments/*`) and
/// VML drawing geometry are intentionally dropped on import — rust_xlsxwriter
/// re-creates fresh VML for any note we re-emit on export.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CommentEntry {
    pub cell: String,
    pub author: String,
    pub text: String,
}

/// Parse one sheet's linked `comments*.xml`. Strips the Excel-style
/// "Author:\n" prefix when present so the snapshot stores only the
/// user-authored content.
fn parse_comments_xml(xml: &str) -> Vec<CommentEntry> {
    let mut out: Vec<CommentEntry> = Vec::new();

    let mut authors: Vec<String> = Vec::new();
    if let Some(block) = extract_block(xml, "<authors", "</authors>") {
        for el in extract_self_closing_or_paired(&block, "author") {
            let body = if let Some(gt) = el.find('>') {
                let after = &el[gt + 1..];
                if let Some(end) = after.rfind("</author>") {
                    &after[..end]
                } else {
                    after
                }
            } else {
                ""
            };
            authors.push(decode_xml_entities(body));
        }
    }

    let Some(list) = extract_block(xml, "<commentList", "</commentList>") else {
        return out;
    };

    for el in extract_elements(&list, "<comment", "</comment>") {
        let head_end = match el.find('>') {
            Some(p) => p + 1,
            None => continue,
        };
        let head = &el[..head_end];
        let Some(cell) = parse_attr(head, "ref") else {
            continue;
        };
        let cell = decode_xml_entities(&cell);
        let author_id: Option<usize> =
            parse_attr(head, "authorId").and_then(|s| s.parse().ok());
        let author = author_id
            .and_then(|i| authors.get(i).cloned())
            .unwrap_or_default();

        let body = if head_end < el.len() {
            &el[head_end..]
        } else {
            ""
        };
        let text_block = extract_block(body, "<text", "</text>").unwrap_or_default();
        let mut text = String::new();
        let mut cursor = 0usize;
        while let Some(open) = text_block[cursor..].find("<t") {
            let abs_open = cursor + open;
            let rest = &text_block[abs_open..];
            let after_t = abs_open + 2;
            let next_ch = text_block.as_bytes().get(after_t).copied();
            if !matches!(next_ch, Some(b'>') | Some(b' ') | Some(b'/')) {
                cursor = abs_open + 2;
                continue;
            }
            let Some(gt_rel) = rest.find('>') else {
                break;
            };
            if text_block.as_bytes().get(abs_open + gt_rel - 1) == Some(&b'/') {
                cursor = abs_open + gt_rel + 1;
                continue;
            }
            let text_start = abs_open + gt_rel + 1;
            let Some(close_rel) = text_block[text_start..].find("</t>") else {
                break;
            };
            text.push_str(&text_block[text_start..text_start + close_rel]);
            cursor = text_start + close_rel + 4;
        }
        let text = decode_xml_entities(&text);

        let text = if !author.is_empty() {
            let prefix = format!("{author}:\n");
            text.strip_prefix(&prefix).map(|s| s.to_string()).unwrap_or(text)
        } else {
            text
        };

        out.push(CommentEntry { cell, author, text });
    }

    out
}

/// Serialize a list of `(cell, author, text)` into a `xl/commentsN.xml` body.
/// Overwrites the file rust_xlsxwriter 0.77 emits — upstream mis-orders the
/// `<authors>` list relative to per-note `authorId`. Our rewrite keeps the
/// author/comment ids in lockstep so author values round-trip correctly.
fn build_comments_xml(notes: &[(String, String, String)]) -> String {
    use std::fmt::Write as _;
    let mut authors: Vec<String> = Vec::new();
    for (_, author, _) in notes {
        let name = if author.is_empty() { "Author".to_string() } else { author.clone() };
        if !authors.iter().any(|a| a == &name) {
            authors.push(name);
        }
    }

    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    out.push_str("<comments xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">");
    if !authors.is_empty() {
        out.push_str("<authors>");
        for a in &authors {
            let _ = write!(out, "<author>{}</author>", encode_xml_text(a));
        }
        out.push_str("</authors>");
    }
    out.push_str("<commentList>");
    for (cell, author, text) in notes {
        let display_author = if author.is_empty() { "Author" } else { author.as_str() };
        let author_id = authors.iter().position(|a| a == display_author).unwrap_or(0);
        let _ = write!(out, "<comment ref=\"{}\" authorId=\"{}\"><text>", encode_xml_text(cell), author_id);
        let _ = write!(
            out,
            "<r><rPr><b/><sz val=\"8\"/><color indexed=\"81\"/><rFont val=\"Tahoma\"/><family val=\"2\"/></rPr><t xml:space=\"preserve\">{}:</t></r>",
            encode_xml_text(display_author)
        );
        let prefixed = format!("\n{}", text);
        let _ = write!(
            out,
            "<r><rPr><sz val=\"8\"/><color indexed=\"81\"/><rFont val=\"Tahoma\"/><family val=\"2\"/></rPr><t xml:space=\"preserve\">{}</t></r>",
            encode_xml_text(&prefixed)
        );
        out.push_str("</text></comment>");
    }
    out.push_str("</commentList></comments>");
    out
}

/// Minimal XML escaper for body text and attribute values.
fn encode_xml_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Post-save zip rewrite: replace `xl/comments*.xml` entries with our own
/// correctly-mapped XML to work around rust_xlsxwriter 0.77's author/id
/// ordering bug.
fn rewrite_comments_in_zip(
    xlsx_path: &std::path::Path,
    sheets_with_comments: &[(String, Vec<(String, String, String)>)],
) -> Result<(), String> {
    use std::io::{Cursor, Read, Write};

    if sheets_with_comments.is_empty() {
        return Ok(());
    }

    let bytes = std::fs::read(xlsx_path).map_err(|e| format!("read xlsx: {e}"))?;

    let sheet_paths = parse_sheet_path_map(&bytes);
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes))
        .map_err(|e| format!("open xlsx zip: {e}"))?;

    let mut sheet_to_comments_path: HashMap<String, String> = HashMap::new();
    for (sheet_name, entry_path) in &sheet_paths {
        let rels_path = match entry_path.rsplit_once('/') {
            Some((dir, file)) => format!("{dir}/_rels/{file}.rels"),
            None => continue,
        };
        let mut rels_xml = String::new();
        if let Ok(mut e) = archive.by_name(&rels_path) {
            if e.read_to_string(&mut rels_xml).is_err() {
                continue;
            }
        } else {
            continue;
        }
        let mut target: Option<String> = None;
        for rel in extract_self_closing_or_paired(&rels_xml, "Relationship") {
            let ty = parse_attr(&rel, "Type").unwrap_or_default();
            if ty.ends_with("/comments") {
                if let Some(t) = parse_attr(&rel, "Target") {
                    target = Some(t);
                    break;
                }
            }
        }
        if let Some(t) = target {
            let normalized = if let Some(s) = t.strip_prefix('/') {
                s.to_string()
            } else if let Some(s) = t.strip_prefix("../") {
                format!("xl/{s}")
            } else {
                match entry_path.rsplit_once('/') {
                    Some((dir, _)) => format!("{dir}/{t}"),
                    None => t,
                }
            };
            sheet_to_comments_path.insert(sheet_name.clone(), normalized);
        }
    }

    let mut replacements: HashMap<String, Vec<u8>> = HashMap::new();
    for (sheet_name, notes) in sheets_with_comments {
        if let Some(path) = sheet_to_comments_path.get(sheet_name) {
            let xml = build_comments_xml(notes);
            replacements.insert(path.clone(), xml.into_bytes());
        }
    }
    if replacements.is_empty() {
        return Ok(());
    }

    let mut out_buf: Vec<u8> = Vec::with_capacity(bytes.len());
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut out_buf));
        let opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("read entry {i}: {e}"))?;
            let name = entry.name().to_string();
            writer.start_file(name.clone(), opts).map_err(|e| format!("start_file: {e}"))?;
            if let Some(replacement) = replacements.get(&name) {
                writer.write_all(replacement).map_err(|e| format!("write: {e}"))?;
            } else {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).map_err(|e| format!("read: {e}"))?;
                writer.write_all(&data).map_err(|e| format!("write: {e}"))?;
            }
        }
        writer.finish().map_err(|e| format!("zip finish: {e}"))?;
    }

    std::fs::write(xlsx_path, &out_buf).map_err(|e| format!("write xlsx: {e}"))?;
    Ok(())
}

/// Parse cell comments from an xlsx ZIP, grouped by sheet name. Empty map on
/// I/O / parse error — comments are best-effort metadata.
pub(crate) fn parse_xlsx_comments(path: &str) -> HashMap<String, Vec<CommentEntry>> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };

    let sheet_paths = parse_sheet_path_map(&bytes);
    if sheet_paths.is_empty() {
        return HashMap::new();
    }

    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };

    let mut out: HashMap<String, Vec<CommentEntry>> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        let rels_path = match entry_path.rsplit_once('/') {
            Some((dir, file)) => format!("{dir}/_rels/{file}.rels"),
            None => continue,
        };
        let mut rels_xml = String::new();
        if let Ok(mut entry) = archive.by_name(&rels_path) {
            if entry.read_to_string(&mut rels_xml).is_err() {
                continue;
            }
        } else {
            continue;
        }

        let mut comments_target: Option<String> = None;
        for rel in extract_self_closing_or_paired(&rels_xml, "Relationship") {
            let ty = parse_attr(&rel, "Type").unwrap_or_default();
            if ty.ends_with("/comments") || ty.ends_with("/comments\"") {
                if let Some(target) = parse_attr(&rel, "Target") {
                    comments_target = Some(target);
                    break;
                }
            }
        }
        let Some(target) = comments_target else {
            continue;
        };
        let normalized = if let Some(stripped) = target.strip_prefix('/') {
            stripped.to_string()
        } else if let Some(stripped) = target.strip_prefix("../") {
            format!("xl/{stripped}")
        } else {
            match entry_path.rsplit_once('/') {
                Some((dir, _)) => format!("{dir}/{target}"),
                None => target.clone(),
            }
        };

        let mut comments_xml = String::new();
        if let Ok(mut entry) = archive.by_name(&normalized) {
            if entry.read_to_string(&mut comments_xml).is_ok() {
                let entries = parse_comments_xml(&comments_xml);
                if !entries.is_empty() {
                    out.insert(sheet_name, entries);
                }
            }
        }
    }

    out
}

/// Build a `rust_xlsxwriter::Url` and 0-based (row, col) from one snapshot
/// hyperlink entry. Returns `None` for malformed entries (bad cell ref, empty
/// target) so the caller can drop them without aborting export.
fn build_hyperlink_from_snapshot(entry: &Value) -> Option<(u32, u16, Url)> {
    let cell = entry.get("cell").and_then(|v| v.as_str())?.trim();
    if cell.is_empty() {
        return None;
    }
    let target = entry.get("target").and_then(|v| v.as_str())?.trim();
    if target.is_empty() {
        return None;
    }
    let (row, col) = parse_a1(cell)?;
    let col16: u16 = col.try_into().ok()?;

    // Map our snapshot's "#Sheet2!A1" form to rust_xlsxwriter's "internal:"
    // pseudo-URI. External http(s)/ftp/mailto/file URLs pass through as-is.
    let link_str = if let Some(loc) = target.strip_prefix('#') {
        format!("internal:{loc}")
    } else {
        target.to_string()
    };

    let mut url = Url::new(link_str);
    if let Some(display) = entry.get("display").and_then(|v| v.as_str()) {
        if !display.is_empty() {
            url = url.set_text(display);
        }
    }
    if let Some(tooltip) = entry.get("tooltip").and_then(|v| v.as_str()) {
        if !tooltip.is_empty() {
            url = url.set_tip(tooltip);
        }
    }
    Some((row, col16, url))
}

/// Build a `rust_xlsxwriter::DataValidation` plus a bounding (first_row,
/// first_col, last_row, last_col) tuple from one snapshot entry. Returns
/// `None` for entries that cannot be expressed via rust_xlsxwriter's typed API
/// (e.g. malformed sqref, unknown `type`, or a `between` rule with
/// non-numeric formulas) so the caller can drop them without aborting export.
fn build_data_validation_from_snapshot(
    entry: &Value,
) -> Option<(DataValidation, u32, u16, u32, u16)> {
    let sqref = entry.get("sqref").and_then(|v| v.as_str())?;
    let sqref = sqref.trim();
    if sqref.is_empty() {
        return None;
    }
    // Compute the bounding box over a possibly multi-part sqref like
    // "A1:A5 C1:C5". add_data_validation just needs *a* valid range; the
    // sqref-as-stored is what actually persists thanks to set_multi_range.
    let (first_row, first_col, last_row, last_col) = bounding_box_of_sqref(sqref)?;
    let first_col16: u16 = first_col.try_into().ok()?;
    let last_col16: u16 = last_col.try_into().ok()?;

    let validation_type = entry
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let formula1 = entry
        .get("formula1")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let formula2 = entry
        .get("formula2")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // OOXML quirk: rust_xlsxwriter (and Excel) omit the `operator` attribute
    // on `between` rules because it's the implicit default. Reconstruct it
    // from formula2's presence so we can pick the right typed rule.
    let operator_raw = entry
        .get("operator")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let operator = if operator_raw.is_empty() && !formula2.is_empty() {
        "between"
    } else {
        operator_raw
    };

    let mut dv = DataValidation::new();
    dv = match validation_type {
        "list" => {
            // For list, formula1 is either a literal `"a,b,c"` (note the
            // outer quotes Excel stores) or a cell-range formula. Pass it to
            // `allow_list_formula` either way — that variant takes raw text.
            dv.allow_list_formula(Formula::new(formula1))
        }
        "whole" => apply_numeric_rule_i32(dv, operator, formula1, formula2)?,
        "decimal" => apply_numeric_rule_f64(dv, operator, formula1, formula2)?,
        "textLength" => apply_text_length_rule(dv, operator, formula1, formula2)?,
        "custom" => dv.allow_custom(Formula::new(formula1)),
        // "date" and "time" need datetime values we'd have to parse from the
        // Excel serial-number representation in formula1. Falling back to
        // `allow_custom` is lossy but keeps the rule alive instead of
        // dropping it entirely.
        "date" | "time" => dv.allow_custom(Formula::new(formula1)),
        // Empty type => "any" (message-only validation). Nothing to set.
        "" => dv,
        // Unknown type — try custom, otherwise drop.
        _ => {
            if formula1.is_empty() {
                return None;
            }
            dv.allow_custom(Formula::new(formula1))
        }
    };

    let allow_blank = entry
        .get("allowBlank")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    dv = dv.ignore_blank(allow_blank);
    let show_input = entry
        .get("showInputMessage")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    dv = dv.show_input_message(show_input);
    let show_error = entry
        .get("showErrorMessage")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    dv = dv.show_error_message(show_error);

    if let Some(style) = entry.get("errorStyle").and_then(|v| v.as_str()) {
        let style = match style {
            "warning" => Some(DataValidationErrorStyle::Warning),
            "information" => Some(DataValidationErrorStyle::Information),
            "stop" => Some(DataValidationErrorStyle::Stop),
            _ => None,
        };
        if let Some(s) = style {
            dv = dv.set_error_style(s);
        }
    }
    if let Some(t) = entry.get("errorTitle").and_then(|v| v.as_str()) {
        if !t.is_empty() {
            dv = dv.set_error_title(t).ok()?;
        }
    }
    if let Some(m) = entry.get("errorMessage").and_then(|v| v.as_str()) {
        if !m.is_empty() {
            dv = dv.set_error_message(m).ok()?;
        }
    }
    if let Some(t) = entry.get("promptTitle").and_then(|v| v.as_str()) {
        if !t.is_empty() {
            dv = dv.set_input_title(t).ok()?;
        }
    }
    if let Some(m) = entry.get("promptMessage").and_then(|v| v.as_str()) {
        if !m.is_empty() {
            dv = dv.set_input_message(m).ok()?;
        }
    }

    // Always preserve the original sqref exactly (including multi-part forms).
    // set_multi_range overrides the (first_row..last_col) range that
    // add_data_validation derives.
    dv = dv.set_multi_range(sqref);

    Some((dv, first_row, first_col16, last_row, last_col16))
}

/// One parsed `<conditionalFormatting>` block + `<cfRule>` from a worksheet's
/// XML. Each entry represents a single rule (a block can carry multiple
/// `cfRule` children — we flatten to one entry per rule, sharing the parent's
/// sqref). PoC scope: preserve the rule shape so it survives a round-trip; we
/// do NOT preserve the dxf-referenced visual format (dxfId → styles.xml dxfs)
/// because rust_xlsxwriter expects a fresh `Format` per rule and we don't yet
/// parse the dxf table.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ConditionalFormattingEntry {
    pub sqref: String,
    /// `cfRule@type`: "cellIs", "containsText", "notContainsText",
    /// "beginsWith", "endsWith", "expression", or anything else we'll round-trip
    /// the value through as best-effort. Empty means "unknown" — dropped on export.
    pub rule_type: String,
    /// `cfRule@operator`: "greaterThan", "lessThan", "between", "equal",
    /// "containsText", etc. Empty when the rule type implies the operator.
    pub operator: String,
    pub formula1: String,
    pub formula2: String,
    /// For text rules, the literal text being matched. Excel stores this both
    /// in `cfRule@text` and inside the synthetic `<formula>` it generates;
    /// we surface it explicitly so the export side doesn't have to parse the
    /// formula expression.
    pub text: String,
    /// `cfRule@priority`. Lower number = higher priority. We preserve it so
    /// re-export keeps the original ordering, though rust_xlsxwriter will
    /// reassign internally.
    pub priority: u32,
    pub stop_if_true: bool,
}

/// Parse one sheet's `<conditionalFormatting>` blocks. Unlike data validations
/// (single block per sheet, multiple children), CF has one block per sqref
/// with one or more `<cfRule>` children — so we scan all matching blocks and
/// flatten the rules into a single Vec.
fn parse_sheet_conditional_formatting(xml: &str) -> Vec<ConditionalFormattingEntry> {
    let mut out = Vec::new();
    for cf_block in extract_self_closing_or_paired(xml, "conditionalFormatting") {
        // Element header carries `sqref`. Body holds one or more <cfRule>.
        let head_end = match cf_block.find('>') {
            Some(p) => p + 1,
            None => continue,
        };
        let head = &cf_block[..head_end];
        let Some(sqref) = parse_attr(head, "sqref") else {
            continue;
        };
        let sqref = decode_xml_entities(&sqref);
        if sqref.trim().is_empty() {
            continue;
        }
        let body = if head_end < cf_block.len() {
            &cf_block[head_end..]
        } else {
            ""
        };
        for rule_el in extract_self_closing_or_paired(body, "cfRule") {
            let rule_head_end = match rule_el.find('>') {
                Some(p) => p + 1,
                None => continue,
            };
            let rule_head = &rule_el[..rule_head_end];
            let rule_type = parse_attr(rule_head, "type")
                .map(|s| decode_xml_entities(&s))
                .unwrap_or_default();
            let operator = parse_attr(rule_head, "operator")
                .map(|s| decode_xml_entities(&s))
                .unwrap_or_default();
            let text = parse_attr(rule_head, "text")
                .map(|s| decode_xml_entities(&s))
                .unwrap_or_default();
            let priority = parse_attr(rule_head, "priority")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(1);
            let stop_if_true = parse_attr(rule_head, "stopIfTrue")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);

            let rule_body = if rule_head_end < rule_el.len() {
                &rule_el[rule_head_end..]
            } else {
                ""
            };
            // A cfRule may carry 0, 1, or 2 <formula> children.
            let mut formulas: Vec<String> = Vec::new();
            let mut cursor = 0;
            while let Some(rel) = rule_body[cursor..].find("<formula") {
                let abs = cursor + rel;
                let after = abs + "<formula".len();
                let next_ch = rule_body.as_bytes().get(after).copied();
                if !matches!(next_ch, Some(b' ') | Some(b'>') | Some(b'/')) {
                    cursor = after;
                    continue;
                }
                let gt = match rule_body[abs..].find('>') {
                    Some(p) => abs + p,
                    None => break,
                };
                if rule_body.as_bytes().get(gt - 1) == Some(&b'/') {
                    formulas.push(String::new());
                    cursor = gt + 1;
                    continue;
                }
                match rule_body[gt..].find("</formula>") {
                    Some(p) => {
                        let inner = &rule_body[gt + 1..gt + p];
                        formulas.push(decode_xml_entities(inner));
                        cursor = gt + p + "</formula>".len();
                    }
                    None => break,
                }
            }
            let formula1 = formulas.first().cloned().unwrap_or_default();
            let formula2 = formulas.get(1).cloned().unwrap_or_default();

            out.push(ConditionalFormattingEntry {
                sqref: sqref.clone(),
                rule_type,
                operator,
                formula1,
                formula2,
                text,
                priority,
                stop_if_true,
            });
        }
    }
    out
}

/// Parse per-sheet `<conditionalFormatting>` rules out of an xlsx. Mirrors the
/// data-validation parser: best-effort, empty map on any structural error.
pub(crate) fn parse_xlsx_conditional_formatting(
    path: &str,
) -> HashMap<String, Vec<ConditionalFormattingEntry>> {
    use std::fs;
    use std::io::Cursor;
    use zip::ZipArchive;

    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };

    let sheet_paths = parse_sheet_path_map(&bytes);
    if sheet_paths.is_empty() {
        return HashMap::new();
    }

    let mut archive = match ZipArchive::new(Cursor::new(&bytes)) {
        Ok(a) => a,
        Err(_) => return HashMap::new(),
    };

    let mut out: HashMap<String, Vec<ConditionalFormattingEntry>> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(&entry_path) {
            if entry.read_to_string(&mut xml).is_ok() {
                let rules = parse_sheet_conditional_formatting(&xml);
                if !rules.is_empty() {
                    out.insert(sheet_name, rules);
                }
            }
        }
    }

    out
}

/// Apply a conditional-formatting snapshot entry to the given worksheet. The
/// generic `add_conditional_format<T: ConditionalFormat>` API can't be called
/// through a trait object, so this helper dispatches on `rule_type` and calls
/// the typed method directly. Returns `false` if the entry was unsupported and
/// silently dropped (so the caller can keep going for the rest).
fn apply_conditional_format_from_snapshot(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    entry: &Value,
) -> bool {
    let Some(sqref) = entry.get("sqref").and_then(|v| v.as_str()) else {
        return false;
    };
    let sqref = sqref.trim();
    if sqref.is_empty() {
        return false;
    }
    let Some((first_row, first_col, last_row, last_col)) = bounding_box_of_sqref(sqref) else {
        return false;
    };
    let first_col16: u16 = match first_col.try_into().ok() {
        Some(v) => v,
        None => return false,
    };
    let last_col16: u16 = match last_col.try_into().ok() {
        Some(v) => v,
        None => return false,
    };

    let rule_type = entry
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let operator = entry
        .get("operator")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let formula1 = entry.get("formula1").and_then(|v| v.as_str()).unwrap_or("");
    let formula2 = entry.get("formula2").and_then(|v| v.as_str()).unwrap_or("");
    let text_val = entry.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let stop_if_true = entry
        .get("stopIfTrue")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    match rule_type {
        "cellIs" => {
            // Pick the rule variant from the OOXML operator. Operands round-
            // trip as Formula values so cell refs (e.g. "=A1") and literals
            // ("100") both pass through.
            let f1 = Formula::new(formula1);
            let f2 = Formula::new(formula2);
            let rule: Option<ConditionalFormatCellRule<Formula>> = match operator {
                "equal" => Some(ConditionalFormatCellRule::EqualTo(f1)),
                "notEqual" => Some(ConditionalFormatCellRule::NotEqualTo(f1)),
                "greaterThan" => Some(ConditionalFormatCellRule::GreaterThan(f1)),
                "greaterThanOrEqual" => Some(ConditionalFormatCellRule::GreaterThanOrEqualTo(f1)),
                "lessThan" => Some(ConditionalFormatCellRule::LessThan(f1)),
                "lessThanOrEqual" => Some(ConditionalFormatCellRule::LessThanOrEqualTo(f1)),
                "between" => Some(ConditionalFormatCellRule::Between(f1, f2)),
                "notBetween" => Some(ConditionalFormatCellRule::NotBetween(f1, f2)),
                _ => None,
            };
            let Some(rule) = rule else {
                return false;
            };
            let cf = ConditionalFormatCell::new()
                .set_rule(rule)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        "containsText" | "notContainsText" | "beginsWith" | "endsWith" => {
            // `text` is the canonical literal; fall back to formula1 just in
            // case the source file omits the attribute (rare).
            let literal = if !text_val.is_empty() {
                text_val.to_string()
            } else {
                formula1.to_string()
            };
            if literal.is_empty() {
                return false;
            }
            let rule = match rule_type {
                "containsText" => ConditionalFormatTextRule::Contains(literal),
                "notContainsText" => ConditionalFormatTextRule::DoesNotContain(literal),
                "beginsWith" => ConditionalFormatTextRule::BeginsWith(literal),
                "endsWith" => ConditionalFormatTextRule::EndsWith(literal),
                _ => unreachable!(),
            };
            let cf = ConditionalFormatText::new()
                .set_rule(rule)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        "expression" => {
            if formula1.is_empty() {
                return false;
            }
            let cf = ConditionalFormatFormula::new()
                .set_rule(formula1)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        // Other rule types (colorScale / dataBar / iconSet / top10 / aboveAverage
        // / duplicateValues / timePeriod) need typed values we don't reconstruct
        // yet. Drop silently — PoC scope only.
        _ => false,
    }
}

/// Bounding box of a possibly multi-part sqref like `"A1:A5 C1:C5"`. The
/// space-delimited parts each follow A1 or A1:B2 syntax. Returns the box that
/// encloses every part, or None if no part parses.
fn bounding_box_of_sqref(sqref: &str) -> Option<(u32, u32, u32, u32)> {
    let mut sr = u32::MAX;
    let mut sc = u32::MAX;
    let mut er: u32 = 0;
    let mut ec: u32 = 0;
    let mut any = false;
    for part in sqref.split_ascii_whitespace() {
        if let Some((a, b, c, d)) = parse_range_ref(part) {
            sr = sr.min(a);
            sc = sc.min(b);
            er = er.max(c);
            ec = ec.max(d);
            any = true;
        }
    }
    if any {
        Some((sr, sc, er, ec))
    } else {
        None
    }
}

/// Apply a numeric (whole-number) rule. Operator strings follow the OOXML
/// names (`equal`, `between`, etc.). Falls back to a formula-typed rule when
/// the operand isn't a literal integer, so cell-reference operands like `=D1`
/// also survive.
fn apply_numeric_rule_i32(
    dv: DataValidation,
    operator: &str,
    f1: &str,
    f2: &str,
) -> Option<DataValidation> {
    let lit1 = f1.trim().parse::<i32>().ok();
    let lit2 = f2.trim().parse::<i32>().ok();
    let f1_owned = f1.to_string();
    let f2_owned = f2.to_string();
    let formula_rule = |op: &str| -> Option<DataValidationRule<Formula>> {
        match op {
            "equal" => Some(DataValidationRule::EqualTo(Formula::new(f1_owned.clone()))),
            "notEqual" => Some(DataValidationRule::NotEqualTo(Formula::new(f1_owned.clone()))),
            "greaterThan" => Some(DataValidationRule::GreaterThan(Formula::new(f1_owned.clone()))),
            "greaterThanOrEqual" => Some(DataValidationRule::GreaterThanOrEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "lessThan" => Some(DataValidationRule::LessThan(Formula::new(f1_owned.clone()))),
            "lessThanOrEqual" => Some(DataValidationRule::LessThanOrEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "between" => Some(DataValidationRule::Between(
                Formula::new(f1_owned.clone()),
                Formula::new(f2_owned.clone()),
            )),
            "notBetween" => Some(DataValidationRule::NotBetween(
                Formula::new(f1_owned.clone()),
                Formula::new(f2_owned.clone()),
            )),
            _ => None,
        }
    };
    match (operator, lit1, lit2) {
        ("equal", Some(a), _) => Some(dv.allow_whole_number(DataValidationRule::EqualTo(a))),
        ("notEqual", Some(a), _) => Some(dv.allow_whole_number(DataValidationRule::NotEqualTo(a))),
        ("greaterThan", Some(a), _) => {
            Some(dv.allow_whole_number(DataValidationRule::GreaterThan(a)))
        }
        ("greaterThanOrEqual", Some(a), _) => {
            Some(dv.allow_whole_number(DataValidationRule::GreaterThanOrEqualTo(a)))
        }
        ("lessThan", Some(a), _) => Some(dv.allow_whole_number(DataValidationRule::LessThan(a))),
        ("lessThanOrEqual", Some(a), _) => {
            Some(dv.allow_whole_number(DataValidationRule::LessThanOrEqualTo(a)))
        }
        ("between", Some(a), Some(b)) => {
            Some(dv.allow_whole_number(DataValidationRule::Between(a, b)))
        }
        ("notBetween", Some(a), Some(b)) => {
            Some(dv.allow_whole_number(DataValidationRule::NotBetween(a, b)))
        }
        _ => formula_rule(operator).map(|r| dv.allow_whole_number_formula(r)),
    }
}

/// Apply a decimal-number rule. Mirrors `apply_numeric_rule_i32` for f64.
fn apply_numeric_rule_f64(
    dv: DataValidation,
    operator: &str,
    f1: &str,
    f2: &str,
) -> Option<DataValidation> {
    let lit1 = f1.trim().parse::<f64>().ok();
    let lit2 = f2.trim().parse::<f64>().ok();
    let f1_owned = f1.to_string();
    let f2_owned = f2.to_string();
    let formula_rule = |op: &str| -> Option<DataValidationRule<Formula>> {
        match op {
            "equal" => Some(DataValidationRule::EqualTo(Formula::new(f1_owned.clone()))),
            "notEqual" => Some(DataValidationRule::NotEqualTo(Formula::new(f1_owned.clone()))),
            "greaterThan" => Some(DataValidationRule::GreaterThan(Formula::new(f1_owned.clone()))),
            "greaterThanOrEqual" => Some(DataValidationRule::GreaterThanOrEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "lessThan" => Some(DataValidationRule::LessThan(Formula::new(f1_owned.clone()))),
            "lessThanOrEqual" => Some(DataValidationRule::LessThanOrEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "between" => Some(DataValidationRule::Between(
                Formula::new(f1_owned.clone()),
                Formula::new(f2_owned.clone()),
            )),
            "notBetween" => Some(DataValidationRule::NotBetween(
                Formula::new(f1_owned.clone()),
                Formula::new(f2_owned.clone()),
            )),
            _ => None,
        }
    };
    match (operator, lit1, lit2) {
        ("equal", Some(a), _) => Some(dv.allow_decimal_number(DataValidationRule::EqualTo(a))),
        ("notEqual", Some(a), _) => Some(dv.allow_decimal_number(DataValidationRule::NotEqualTo(a))),
        ("greaterThan", Some(a), _) => {
            Some(dv.allow_decimal_number(DataValidationRule::GreaterThan(a)))
        }
        ("greaterThanOrEqual", Some(a), _) => {
            Some(dv.allow_decimal_number(DataValidationRule::GreaterThanOrEqualTo(a)))
        }
        ("lessThan", Some(a), _) => Some(dv.allow_decimal_number(DataValidationRule::LessThan(a))),
        ("lessThanOrEqual", Some(a), _) => {
            Some(dv.allow_decimal_number(DataValidationRule::LessThanOrEqualTo(a)))
        }
        ("between", Some(a), Some(b)) => {
            Some(dv.allow_decimal_number(DataValidationRule::Between(a, b)))
        }
        ("notBetween", Some(a), Some(b)) => {
            Some(dv.allow_decimal_number(DataValidationRule::NotBetween(a, b)))
        }
        _ => formula_rule(operator).map(|r| dv.allow_decimal_number_formula(r)),
    }
}

/// Apply a textLength rule.
fn apply_text_length_rule(
    dv: DataValidation,
    operator: &str,
    f1: &str,
    f2: &str,
) -> Option<DataValidation> {
    let lit1 = f1.trim().parse::<u32>().ok();
    let lit2 = f2.trim().parse::<u32>().ok();
    let f1_owned = f1.to_string();
    let f2_owned = f2.to_string();
    let formula_rule = |op: &str| -> Option<DataValidationRule<Formula>> {
        match op {
            "equal" => Some(DataValidationRule::EqualTo(Formula::new(f1_owned.clone()))),
            "notEqual" => Some(DataValidationRule::NotEqualTo(Formula::new(f1_owned.clone()))),
            "greaterThan" => Some(DataValidationRule::GreaterThan(Formula::new(f1_owned.clone()))),
            "greaterThanOrEqual" => Some(DataValidationRule::GreaterThanOrEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "lessThan" => Some(DataValidationRule::LessThan(Formula::new(f1_owned.clone()))),
            "lessThanOrEqual" => Some(DataValidationRule::LessThanOrEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "between" => Some(DataValidationRule::Between(
                Formula::new(f1_owned.clone()),
                Formula::new(f2_owned.clone()),
            )),
            "notBetween" => Some(DataValidationRule::NotBetween(
                Formula::new(f1_owned.clone()),
                Formula::new(f2_owned.clone()),
            )),
            _ => None,
        }
    };
    match (operator, lit1, lit2) {
        ("equal", Some(a), _) => Some(dv.allow_text_length(DataValidationRule::EqualTo(a))),
        ("notEqual", Some(a), _) => Some(dv.allow_text_length(DataValidationRule::NotEqualTo(a))),
        ("greaterThan", Some(a), _) => {
            Some(dv.allow_text_length(DataValidationRule::GreaterThan(a)))
        }
        ("greaterThanOrEqual", Some(a), _) => {
            Some(dv.allow_text_length(DataValidationRule::GreaterThanOrEqualTo(a)))
        }
        ("lessThan", Some(a), _) => Some(dv.allow_text_length(DataValidationRule::LessThan(a))),
        ("lessThanOrEqual", Some(a), _) => {
            Some(dv.allow_text_length(DataValidationRule::LessThanOrEqualTo(a)))
        }
        ("between", Some(a), Some(b)) => {
            Some(dv.allow_text_length(DataValidationRule::Between(a, b)))
        }
        ("notBetween", Some(a), Some(b)) => {
            Some(dv.allow_text_length(DataValidationRule::NotBetween(a, b)))
        }
        _ => formula_rule(operator).map(|r| dv.allow_text_length_formula(r)),
    }
}

/// rust_xlsxwriter converts the input width to a character-width-with-padding
/// before serialising, so calling `set_column_width(N)` actually writes a
/// different `width` attribute. This function inverts that conversion so the
/// xlsx ends up with the requested raw value.
///
/// Conversion (for width >= 1): `out = (((in*7) + 5) / 7 * 256).floor() / 256`.
/// Plain inverse (`in = N - 5/7`) lands right on the edge of a floor() step
/// and fp rounding can drop us down to `N - 1/256`. Adding `1/512` puts us
/// safely inside the (1/256 wide) acceptance window so `out == N` exactly.
fn inverse_col_width_for_xlsxwriter(target_raw_width: f64) -> f64 {
    if target_raw_width >= 1.0 {
        target_raw_width - 5.0 / 7.0 + 1.0 / 512.0
    } else {
        target_raw_width
    }
}

/// Tauri command wrapper. Calls the pure-Rust core and records the file in recent files.
#[tauri::command]
pub fn workbook_import_xlsx(
    app: tauri::AppHandle,
    path: String,
) -> Result<ImportWorkbookResult, String> {
    let result = import_xlsx_core(path.clone())?;
    let recent_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path)
        .to_string();
    if let Ok(app_conn) = crate::db::app_db::open_app_db(&app) {
        let _ = crate::db::operations::record_recent_file(&app_conn, &path, &recent_name);
    }
    Ok(result)
}

/// Pure-Rust import logic. Independent of Tauri so it's directly callable from tests.
pub fn import_xlsx_core(path: String) -> Result<ImportWorkbookResult, String> {
    let workbook_id = uuid::Uuid::new_v4().to_string();

    // Accept .xlsx and .xlsm. .xlsm is read identically (calamine handles both) but
    // we emit a macro-loss warning per AD-02b and req 5.3.2.
    let ext_lower = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let is_xlsx = ext_lower.as_deref() == Some("xlsx");
    let is_xlsm = ext_lower.as_deref() == Some("xlsm");

    if !is_xlsx && !is_xlsm {
        let empty_snapshot = json!({
            "id": workbook_id,
            "name": "Imported Workbook",
            "appVersion": "0.1.0",
            "locale": "enUS",
            "styles": {},
            "sheetOrder": [],
            "sheets": {},
        });
        return Ok(ImportWorkbookResult {
            handle: WorkbookHandle {
                workbook_id,
                path: Some(path.clone()),
                source_type: "xlsx".to_string(),
                snapshot_json: Some(
                    serde_json::to_string(&empty_snapshot).map_err(|e| e.to_string())?,
                ),
            },
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_INVALID_EXTENSION".to_string(),
                message: "対応していない拡張子です（.xlsx / .xlsm のみ受け付けます）".to_string(),
                affected_sheets: None,
            }],
        });
    }

    // Defense-in-depth: run security scan before touching the file with calamine.
    let scan = crate::commands::security::security_scan_xlsx(path.clone())
        .map_err(|e| format!("security scan failed: {e}"))?;
    if scan.blocked {
        let empty_snapshot = json!({
            "id": workbook_id,
            "name": "Imported Workbook",
            "appVersion": "0.1.0",
            "locale": "enUS",
            "styles": {},
            "sheetOrder": [],
            "sheets": {},
        });
        let mut warnings: Vec<CompatibilityWarning> = scan
            .issues
            .into_iter()
            .map(|m| CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_SECURITY_BLOCKED".to_string(),
                message: m,
                affected_sheets: None,
            })
            .collect();
        for w in scan.warnings {
            warnings.push(CompatibilityWarning {
                severity: "warning".to_string(),
                code: "XLSX_SECURITY_WARNING".to_string(),
                message: w,
                affected_sheets: None,
            });
        }
        return Ok(ImportWorkbookResult {
            handle: WorkbookHandle {
                workbook_id,
                path: Some(path),
                source_type: "xlsx".to_string(),
                snapshot_json: Some(
                    serde_json::to_string(&empty_snapshot).map_err(|e| e.to_string())?,
                ),
            },
            warnings,
        });
    }

    let prepended_warnings: Vec<CompatibilityWarning> = scan
        .warnings
        .into_iter()
        .map(|m| CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_SECURITY_WARNING".to_string(),
            message: m,
            affected_sheets: None,
        })
        .collect();

    // Pre-parse per-sheet data validations so they can round-trip through the
    // snapshot. calamine doesn't expose them, and rust_xlsxwriter's high-level
    // API handles re-emission on export. Must happen BEFORE feature_warnings
    // so we can suppress the generic "DV will be lost" warning once we know
    // the rules will round-trip.
    let data_validations_by_sheet = parse_xlsx_data_validations(&path);
    // Same pattern for conditional formatting rules.
    let conditional_formats_by_sheet = parse_xlsx_conditional_formatting(&path);

    let mut feature_warnings = detect_unsupported_features(&path).unwrap_or_default();
    // We now preserve data validations through the snapshot, so the generic
    // "data validation will be lost on save" warning is misleading once we've
    // captured at least one rule from the source file. Drop it in that case.
    // (If parsing yielded zero rules for whatever reason — e.g. the rule lived
    // somewhere the parser didn't see — we leave the warning so the user
    // doesn't get a silent data loss.)
    let dv_rules_seen = data_validations_by_sheet
        .values()
        .any(|v: &Vec<DataValidationEntry>| !v.is_empty());
    if dv_rules_seen {
        feature_warnings.retain(|w| w.code != "XLSX_DATA_VALIDATION");
    }
    // Same suppression for conditional formatting once we've captured rules.
    let cf_rules_seen = conditional_formats_by_sheet
        .values()
        .any(|v: &Vec<ConditionalFormattingEntry>| !v.is_empty());
    if cf_rules_seen {
        feature_warnings.retain(|w| w.code != "XLSX_CONDITIONAL_FORMATTING");
    }

    // Per-cell styles: parsed straight from the xlsx ZIP (calamine 0.24 doesn't
    // expose them). Tolerant of failure — missing styles just degrade to "no styles".
    let parsed_styles = parse_xlsx_styles(&path).ok();
    // Pre-parse per-sheet column widths and row heights (calamine doesn't
    // expose this). Best-effort: silently no-op if the structure is unusual.
    let dimensions_by_sheet = parse_xlsx_dimensions(&path);
    // Pre-parse per-sheet merged-cell ranges (calamine doesn't expose these).
    let merges_by_sheet = parse_xlsx_merges(&path);
    // Pre-parse per-sheet frozen-pane declarations (only `state="frozen"`).
    let freeze_panes_by_sheet = parse_xlsx_freeze_panes(&path);
    // Pre-parse workbook-level sheet visibility (`state="hidden"` / `"veryHidden"`).
    let sheet_visibility = parse_xlsx_sheet_visibility(&path);
    // Pre-parse per-sheet hyperlinks. Joins the `<hyperlinks>` block in
    // sheetN.xml with the per-sheet rels file so external URLs are resolved.
    let hyperlinks_by_sheet = parse_xlsx_hyperlinks(&path);
    // Pre-parse per-sheet cell comments / notes. Each sheet's rels file points
    // to its `xl/commentsN.xml`; we read author + plain text and stash on the
    // snapshot for re-emission via rust_xlsxwriter's insert_note on export.
    let comments_by_sheet = parse_xlsx_comments(&path);
    // Pre-parse rich-text runs from sharedStrings.xml + inline `<is>` strings.
    // calamine flattens rich strings to plain — we re-attach the runs here.
    let rich_text = parse_xlsx_rich_text(&path).ok();

    let mut wb: Xlsx<_> =
        open_workbook(&path).map_err(|e| format!("Failed to open xlsx: {e}"))?;

    // Capture workbook-level named ranges. calamine's defined_names() returns a
    // flat [(name, formula)] slice — sheet-scope (localSheetId) is not exposed,
    // so we treat every entry as workbook-scoped (scope omitted). Names with an
    // empty name or formula are skipped defensively.
    let named_ranges: Vec<Value> = wb
        .defined_names()
        .iter()
        .filter(|(n, f)| !n.trim().is_empty() && !f.trim().is_empty())
        .map(|(n, f)| json!({ "name": n, "formula": f }))
        .collect();

    let sheet_names = wb.sheet_names().to_vec();
    let mut sheet_order: Vec<String> = Vec::new();
    let mut sheets_map: Map<String, Value> = Map::new();
    let mut large_sheets: Vec<String> = Vec::new();
    // Workbook-level dedup: normalized style → stable "sN" id.
    let mut styles_dedup: HashMap<CellStyle, String> = HashMap::new();
    let mut styles_map: Map<String, Value> = Map::new();

    for (i, name) in sheet_names.iter().enumerate() {
        let sheet_id = format!("sheet-{}", i + 1);
        sheet_order.push(sheet_id.clone());

        let range = wb
            .worksheet_range(name)
            .map_err(|e| format!("Failed to read sheet '{name}': {e}"))?;

        // Try to extract formulas as a parallel range; ignore if unavailable.
        // calamine's worksheet_formula returns a *sparse* range whose start
        // matches the first cell with a formula — not necessarily (0, 0). So we
        // must look up cells with absolute sheet coordinates via get_value.
        let formula_range = wb.worksheet_formula(name).ok();
        let range_start = range.start().unwrap_or((0, 0));

        let (used_rows, used_cols) = range.get_size();
        let row_count = used_rows.max(MIN_ROWS);
        let col_count = used_cols.max(MIN_COLS);

        let sheet_style_lookup = parsed_styles.as_ref().and_then(|ps| ps.per_sheet.get(name));
        let sheet_rich_lookup = rich_text.as_ref().and_then(|rt| rt.per_sheet.get(name));

        let mut cell_data: Map<String, Value> = Map::new();
        let mut non_empty_cells: usize = 0;

        for (r, row) in range.rows().enumerate() {
            let mut row_map: Map<String, Value> = Map::new();
            for (c, cell) in row.iter().enumerate() {
                let abs_r = range_start.0 + r as u32;
                let abs_c = range_start.1 + c as u32;
                // Prefer formula if present at this position.
                let formula_str = formula_range
                    .as_ref()
                    .and_then(|fr| fr.get_value((abs_r, abs_c)))
                    .and_then(|s: &String| {
                        if s.is_empty() {
                            None
                        } else {
                            Some(s.clone())
                        }
                    });

                // Look up the xf index for this cell once; reuse it for both
                // the visual style id and the number-format string.
                let xf_idx: Option<usize> = sheet_style_lookup
                    .and_then(|m| m.get(&(abs_r, abs_c)).copied());

                // Resolve a style id (if any) for this cell.
                let style_id: Option<String> = xf_idx
                    .and_then(|i| parsed_styles.as_ref()?.cell_xfs.get(i).cloned())
                    .filter(|s| !s.is_empty())
                    .map(|style| {
                        if let Some(id) = styles_dedup.get(&style) {
                            id.clone()
                        } else {
                            let id = format!("s{}", styles_dedup.len() + 1);
                            styles_map.insert(id.clone(), style.to_json());
                            styles_dedup.insert(style, id.clone());
                            id
                        }
                    });

                // Resolve the number-format string for this cell from the same xf.
                let num_format: Option<String> = xf_idx.and_then(|i| {
                    parsed_styles
                        .as_ref()?
                        .cell_num_formats
                        .get(i)
                        .cloned()
                        .flatten()
                });

                if let Some(f) = formula_str {
                    let f = if f.starts_with('=') {
                        f
                    } else {
                        format!("={f}")
                    };
                    // Combine cached display value (so Univer can show Excel's
                    // result even when it can't recompute) AND the style id (so
                    // visual styling round-trips).
                    let mut cell_obj = Map::new();
                    cell_obj.insert("f".into(), Value::String(f));
                    if let Some(cached) = data_to_cell(cell, num_format.as_deref()) {
                        if let Value::Object(cached_map) = cached {
                            for (k, v) in cached_map.into_iter() {
                                cell_obj.insert(k, v);
                            }
                        }
                    } else if let Some(fmt) = &num_format {
                        // No cached value, but the cell carries a number format
                        // — keep it so the formula's output renders correctly.
                        cell_obj.insert("_fmt".into(), Value::String(fmt.clone()));
                    }
                    if let Some(sid) = &style_id {
                        cell_obj.insert("s".into(), Value::String(sid.clone()));
                    }
                    row_map.insert(c.to_string(), Value::Object(cell_obj));
                    non_empty_cells += 1;
                    continue;
                }

                // Rich-text runs for this cell, if any. Looked up by absolute
                // coords because the rich-text scanner reads sheet XML
                // independent of calamine's view of the range.
                let rich_runs: Option<&Vec<RichRun>> =
                    sheet_rich_lookup.and_then(|m| m.get(&(abs_r, abs_c)));

                if let Some(mut v) = data_to_cell(cell, num_format.as_deref()) {
                    if let Some(sid) = &style_id {
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert("s".into(), Value::String(sid.clone()));
                        }
                    }
                    if let Some(runs) = rich_runs {
                        if let Some(obj) = v.as_object_mut() {
                            let arr: Vec<Value> = runs.iter().map(RichRun::to_json).collect();
                            obj.insert("_richRuns".into(), Value::Array(arr));
                        }
                    }
                    row_map.insert(c.to_string(), v);
                    non_empty_cells += 1;
                } else if let Some(sid) = &style_id {
                    // Empty cell with a style (e.g. a colored blank cell). Preserve it
                    // so blank fills round-trip.
                    let mut cell_obj = Map::new();
                    cell_obj.insert("s".into(), Value::String(sid.clone()));
                    row_map.insert(c.to_string(), Value::Object(cell_obj));
                }
            }
            if !row_map.is_empty() {
                cell_data.insert(r.to_string(), Value::Object(row_map));
            }
        }

        if non_empty_cells > LARGE_SHEET_THRESHOLD {
            large_sheets.push(name.clone());
        }

        // Attach per-column widths and per-row heights when the xlsx declared them.
        let mut sheet_obj = json!({
            "id": sheet_id,
            "name": name,
            "rowCount": row_count,
            "columnCount": col_count,
            "cellData": Value::Object(cell_data),
        });

        if let Some(dims) = dimensions_by_sheet.get(name) {
            if !dims.columns.is_empty() {
                let mut col_data: Map<String, Value> = Map::new();
                let mut keys: Vec<u32> = dims.columns.keys().copied().collect();
                keys.sort_unstable();
                for k in keys {
                    let w = dims.columns[&k];
                    col_data.insert(k.to_string(), json!({ "w": w }));
                }
                sheet_obj["columnData"] = Value::Object(col_data);
            }
            if !dims.rows.is_empty() {
                let mut row_data: Map<String, Value> = Map::new();
                let mut keys: Vec<u32> = dims.rows.keys().copied().collect();
                keys.sort_unstable();
                for k in keys {
                    let h = dims.rows[&k];
                    row_data.insert(k.to_string(), json!({ "h": h }));
                }
                sheet_obj["rowData"] = Value::Object(row_data);
            }
        }

        // Univer expects mergeData as an array of inclusive 0-based row/col
        // ranges per sheet. Always emit the field (empty array when none) so
        // the frontend can rely on its presence.
        let merge_data: Vec<Value> = merges_by_sheet
            .get(name)
            .map(|v| {
                v.iter()
                    .map(|(sr, sc, er, ec)| {
                        json!({
                            "startRow": sr,
                            "startColumn": sc,
                            "endRow": er,
                            "endColumn": ec,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        sheet_obj["mergeData"] = Value::Array(merge_data);

        // Per-sheet data validations. We only emit `_dataValidations` when the
        // sheet has at least one entry — the absence of the field signals
        // "no rules" to the export side, preventing a stray empty
        // <dataValidations count="0"> block that some Excel versions reject.
        if let Some(dvs) = data_validations_by_sheet.get(name) {
            if !dvs.is_empty() {
                let arr: Vec<Value> = dvs
                    .iter()
                    .map(|e| {
                        let mut obj = Map::new();
                        obj.insert("sqref".into(), Value::String(e.sqref.clone()));
                        if !e.validation_type.is_empty() {
                            obj.insert("type".into(), Value::String(e.validation_type.clone()));
                        }
                        if !e.operator.is_empty() {
                            obj.insert("operator".into(), Value::String(e.operator.clone()));
                        }
                        if !e.formula1.is_empty() {
                            obj.insert("formula1".into(), Value::String(e.formula1.clone()));
                        }
                        if !e.formula2.is_empty() {
                            obj.insert("formula2".into(), Value::String(e.formula2.clone()));
                        }
                        if e.allow_blank {
                            obj.insert("allowBlank".into(), Value::Bool(true));
                        }
                        if e.show_error_message {
                            obj.insert("showErrorMessage".into(), Value::Bool(true));
                        }
                        if e.show_input_message {
                            obj.insert("showInputMessage".into(), Value::Bool(true));
                        }
                        if !e.error_style.is_empty() {
                            obj.insert("errorStyle".into(), Value::String(e.error_style.clone()));
                        }
                        if !e.error_title.is_empty() {
                            obj.insert("errorTitle".into(), Value::String(e.error_title.clone()));
                        }
                        if !e.error_message.is_empty() {
                            obj.insert(
                                "errorMessage".into(),
                                Value::String(e.error_message.clone()),
                            );
                        }
                        if !e.prompt_title.is_empty() {
                            obj.insert(
                                "promptTitle".into(),
                                Value::String(e.prompt_title.clone()),
                            );
                        }
                        if !e.prompt_message.is_empty() {
                            obj.insert(
                                "promptMessage".into(),
                                Value::String(e.prompt_message.clone()),
                            );
                        }
                        Value::Object(obj)
                    })
                    .collect();
                sheet_obj["_dataValidations"] = Value::Array(arr);
            }
        }

        // Per-sheet hyperlinks. Opt-in: omit `_hyperlinks` when empty so a
        // workbook that never had links doesn't acquire an empty array on
        // round-trip.
        if let Some(links) = hyperlinks_by_sheet.get(name) {
            if !links.is_empty() {
                let arr: Vec<Value> = links
                    .iter()
                    .map(|e| {
                        let mut obj = Map::new();
                        obj.insert("cell".into(), Value::String(e.cell.clone()));
                        obj.insert("target".into(), Value::String(e.target.clone()));
                        if !e.display.is_empty() {
                            obj.insert("display".into(), Value::String(e.display.clone()));
                        }
                        if !e.tooltip.is_empty() {
                            obj.insert("tooltip".into(), Value::String(e.tooltip.clone()));
                        }
                        Value::Object(obj)
                    })
                    .collect();
                sheet_obj["_hyperlinks"] = Value::Array(arr);
            }
        }

        // Per-sheet conditional formatting rules. Opt-in: omit entirely when
        // the sheet has none, so a clean file doesn't get a stray
        // `<conditionalFormatting>` block on re-export. Mirrors the
        // _dataValidations shape on purpose.
        if let Some(cfs) = conditional_formats_by_sheet.get(name) {
            if !cfs.is_empty() {
                let arr: Vec<Value> = cfs
                    .iter()
                    .map(|e| {
                        let mut obj = Map::new();
                        obj.insert("sqref".into(), Value::String(e.sqref.clone()));
                        if !e.rule_type.is_empty() {
                            obj.insert("type".into(), Value::String(e.rule_type.clone()));
                        }
                        if !e.operator.is_empty() {
                            obj.insert("operator".into(), Value::String(e.operator.clone()));
                        }
                        if !e.formula1.is_empty() {
                            obj.insert("formula1".into(), Value::String(e.formula1.clone()));
                        }
                        if !e.formula2.is_empty() {
                            obj.insert("formula2".into(), Value::String(e.formula2.clone()));
                        }
                        if !e.text.is_empty() {
                            obj.insert("text".into(), Value::String(e.text.clone()));
                        }
                        obj.insert("priority".into(), Value::from(e.priority));
                        if e.stop_if_true {
                            obj.insert("stopIfTrue".into(), Value::Bool(true));
                        }
                        Value::Object(obj)
                    })
                    .collect();
                sheet_obj["_conditionalFormatting"] = Value::Array(arr);
            }
        }

        // Per-sheet cell comments / notes. Opt-in: omit `_comments` when empty
        // so a workbook with no notes doesn't acquire an empty array on
        // round-trip (which would also force `xl/commentsN.xml` to be emitted).
        if let Some(notes) = comments_by_sheet.get(name) {
            if !notes.is_empty() {
                let arr: Vec<Value> = notes
                    .iter()
                    .map(|e| {
                        let mut obj = Map::new();
                        obj.insert("cell".into(), Value::String(e.cell.clone()));
                        if !e.author.is_empty() {
                            obj.insert("author".into(), Value::String(e.author.clone()));
                        }
                        obj.insert("text".into(), Value::String(e.text.clone()));
                        Value::Object(obj)
                    })
                    .collect();
                sheet_obj["_comments"] = Value::Array(arr);
            }
        }

        // Per-sheet frozen pane. Opt-in: omit `_freezePane` entirely when the
        // sheet has no frozen rows/cols. `topLeft` is only emitted when the
        // source workbook carried `topLeftCell` so we don't materialize a
        // default A1 pre-scroll on round-trip.
        if let Some(fp) = freeze_panes_by_sheet.get(name) {
            let mut obj = Map::new();
            obj.insert("row".into(), Value::from(fp.row));
            obj.insert("col".into(), Value::from(fp.col));
            if let Some(tl) = &fp.top_left {
                obj.insert("topLeft".into(), Value::String(tl.clone()));
            }
            sheet_obj["_freezePane"] = Value::Object(obj);
        }

        // Workbook-level sheet visibility. Opt-in: omit `_sheetState` when the
        // sheet is visible (the default) so clean files don't acquire a stray
        // attribute on round-trip.
        if let Some(state) = sheet_visibility.get(name) {
            sheet_obj["_sheetState"] = Value::String(state.clone());
        }

        sheets_map.insert(sheet_id, sheet_obj);
    }

    // Chart-preservation: capture chart/drawing/theme parts byte-for-byte so
    // they survive a save round-trip even though we don't render them.
    let preserved_parts = parse_xlsx_preserved_parts(&path);

    let mut snapshot = json!({
        "id": workbook_id,
        "name": "Imported Workbook",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": Value::Object(styles_map),
        "sheetOrder": sheet_order,
        "sheets": Value::Object(sheets_map),
        "namedRanges": named_ranges,
    });
    if let Some(pp) = preserved_parts {
        snapshot["_preservedParts"] = pp;
    }

    let snapshot_json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

    let mut warnings: Vec<CompatibilityWarning> = prepended_warnings;
    warnings.extend(feature_warnings);
    warnings.push(CompatibilityWarning {
        severity: "info".to_string(),
        code: "XLSX_POC_IMPORT".to_string(),
        message:
            "xlsx PoC import: pivot tables are not yet preserved (named ranges + font/fill/alignment/border styles + merged cells + number formats + column widths + row heights + rich text + data validations + conditional formatting + charts (blob-preserved) are preserved)"
                .to_string(),
        affected_sheets: None,
    });

    if is_xlsm {
        // AD-02b / req 5.3.2: VBA macros are never loaded or persisted.
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSM_MACROS_DISCARDED".to_string(),
            message:
                ".xlsm を開きました。VBA マクロは読み込まれず、保存時は .xlsx 形式になります。"
                    .to_string(),
            affected_sheets: None,
        });
    }

    if !large_sheets.is_empty() {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_LARGE_SHEET".to_string(),
            message: format!(
                "One or more sheets exceed {LARGE_SHEET_THRESHOLD} non-empty cells; import may be slow."
            ),
            affected_sheets: Some(large_sheets),
        });
    }

    // For xlsm, derive a sibling .xlsx target so Ctrl+S overwrites the converted
    // copy without touching the macro-bearing original.
    let working_path = if is_xlsm {
        std::path::Path::new(&path)
            .with_extension("xlsx")
            .to_string_lossy()
            .into_owned()
    } else {
        path.clone()
    };

    if is_xlsm && std::path::Path::new(&working_path).exists() {
        let name = std::path::Path::new(&working_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSM_DERIVED_XLSX_EXISTS".to_string(),
            message: format!(
                "保存時の既定ターゲット {} がすでに存在します。Ctrl+S で上書きされる前に「名前を付けて保存」をご検討ください。",
                name
            ),
            affected_sheets: None,
        });
    }

    Ok(ImportWorkbookResult {
        handle: WorkbookHandle {
            workbook_id,
            path: Some(working_path),
            source_type: "xlsx".to_string(),
            snapshot_json: Some(snapshot_json),
        },
        warnings,
    })
}

fn sanitize_sheet_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            _ => c,
        })
        .collect();
    // Excel sheet name length limit is 31 chars (count by chars, not bytes).
    let truncated: String = cleaned.chars().take(31).collect();
    truncated
}

/// Given a sanitized candidate sheet name and a set of names already in use,
/// return a unique variant. If `candidate` is unused, returns it verbatim.
/// Otherwise appends `_2`, `_3`, ... until a free name is found, truncating
/// the base so the final length stays within Excel's 31-char limit.
fn dedup_sheet_name(candidate: &str, used: &HashSet<String>) -> String {
    if !used.contains(candidate) {
        return candidate.to_string();
    }
    let base_chars: Vec<char> = candidate.chars().collect();
    let mut n: u32 = 2;
    loop {
        let suffix = format!("_{}", n);
        let suffix_len = suffix.chars().count();
        let keep = 31usize.saturating_sub(suffix_len);
        let base: String = base_chars.iter().take(keep).collect();
        let candidate_n = format!("{}{}", base, suffix);
        if !used.contains(&candidate_n) {
            return candidate_n;
        }
        n += 1;
    }
}

/// Tauri command wrapper: delegates to export_xlsx_core, then on success records
/// the saved path in recent_files so the Home screen lists it.
#[tauri::command]
pub fn workbook_export_xlsx(
    app: tauri::AppHandle,
    path: String,
    snapshot_json: String,
) -> Result<ExportResult, String> {
    let result = export_xlsx_core(path.clone(), snapshot_json)?;
    if result.success {
        let name = std::path::Path::new(&result.path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&result.path)
            .to_string();
        if let Ok(conn) = crate::db::app_db::open_app_db(&app) {
            let _ = crate::db::operations::record_recent_file(&conn, &result.path, &name);
        }
    }
    Ok(result)
}

/// Pure-Rust export core. Directly callable from cargo tests.
pub fn export_xlsx_core(
    path: String,
    snapshot_json: String,
) -> Result<ExportResult, String> {
    // Step 1: extension check
    let ext_ok = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(false);

    if !ext_ok {
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_INVALID_EXTENSION".to_string(),
                message: "Export path must end in .xlsx".to_string(),
                affected_sheets: None,
            }],
            error: Some("XLSX_INVALID_EXTENSION".to_string()),
        });
    }

    // Step 2: parse snapshot
    let snapshot: Value = match serde_json::from_str(&snapshot_json) {
        Ok(v) => v,
        Err(e) => {
            return Ok(ExportResult {
                success: false,
                path: path.clone(),
                warnings: vec![CompatibilityWarning {
                    severity: "blocking".to_string(),
                    code: "XLSX_INVALID_SNAPSHOT".to_string(),
                    message: format!("Failed to parse snapshot JSON: {e}"),
                    affected_sheets: None,
                }],
                error: Some(format!("XLSX_INVALID_SNAPSHOT: {e}")),
            });
        }
    };

    let sheet_order = snapshot
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if sheet_order.is_empty() {
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_EMPTY_SNAPSHOT".to_string(),
                message: "Snapshot has no sheets to export.".to_string(),
                affected_sheets: None,
            }],
            error: Some("XLSX_EMPTY_SNAPSHOT".to_string()),
        });
    }

    let sheets_obj = snapshot.get("sheets").and_then(|v| v.as_object());

    // Workbook-level styles map: { "s1": { font: {...}, fill: {...}, alignment: {...} }, ... }
    let styles_obj = snapshot.get("styles").and_then(|v| v.as_object());
    let resolved_styles: HashMap<String, CellStyle> = styles_obj
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| CellStyle::from_json(v).map(|s| (k.clone(), s)))
                .collect()
        })
        .unwrap_or_default();

    // Step 3: build workbook
    let mut workbook = Workbook::new();
    let mut sheet_count: usize = 0;
    let mut cell_count: usize = 0;
    let mut formula_count: usize = 0;
    let mut sanitized_names: Vec<String> = Vec::new();
    let mut used_sheet_names: HashSet<String> = HashSet::new();
    // Cache keyed on (style_id, num_format) so identical (style, format) combos
    // reuse the same rust_xlsxwriter Format object.
    let mut format_cache: HashMap<(String, String), Format> = HashMap::new();
    let mut named_range_failures: Vec<String> = Vec::new();
    let mut scoped_names_downgraded: Vec<String> = Vec::new();
    // Captured per-sheet `(cell, author, text)` tuples for the post-save
    // comments rewrite (works around rust_xlsxwriter 0.77's authorId mis-ordering).
    let mut sheets_with_comments: Vec<(String, Vec<(String, String, String)>)> = Vec::new();

    let build_result: Result<(), String> = (|| -> Result<(), String> {
        for (i, sheet_id_val) in sheet_order.iter().enumerate() {
            let sheet_id = match sheet_id_val.as_str() {
                Some(s) => s,
                None => continue,
            };

            let sheet_obj = sheets_obj.and_then(|m| m.get(sheet_id));

            let raw_name = sheet_obj
                .and_then(|s| s.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");

            let safe_name = if raw_name.is_empty() {
                format!("Sheet{}", i + 1)
            } else {
                let s = sanitize_sheet_name(raw_name);
                if s != raw_name {
                    sanitized_names.push(raw_name.to_string());
                }
                if s.is_empty() {
                    format!("Sheet{}", i + 1)
                } else {
                    s
                }
            };
            // Dedup against names already assigned to earlier sheets: two raw
            // names that sanitize to the same value (e.g. "a[b]" and "a_b_")
            // would otherwise make rust_xlsxwriter reject set_name.
            let safe_name = dedup_sheet_name(&safe_name, &used_sheet_names);
            used_sheet_names.insert(safe_name.clone());

            let worksheet = workbook.add_worksheet();
            worksheet
                .set_name(&safe_name)
                .map_err(|e| e.to_string())?;

            // Apply sheet visibility from `_sheetState`. Anything other than
            // "hidden" / "veryHidden" leaves the default (visible).
            if let Some(state) = sheet_obj
                .and_then(|s| s.get("_sheetState"))
                .and_then(|v| v.as_str())
            {
                match state {
                    "hidden" => {
                        worksheet.set_hidden(true);
                    }
                    "veryHidden" => {
                        worksheet.set_very_hidden(true);
                    }
                    _ => {}
                }
            }

            // Apply frozen pane from `_freezePane`. Out-of-bounds rows/cols
            // (or a {0,0} pane) are dropped — rust_xlsxwriter rejects the
            // former and the latter is a no-op anyway.
            if let Some(fp) = sheet_obj
                .and_then(|s| s.get("_freezePane"))
                .and_then(|v| v.as_object())
            {
                let row = fp.get("row").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let col = fp.get("col").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                if row > 0 || col > 0 {
                    let _ = worksheet.set_freeze_panes(row, col);
                    if let Some(tl) = fp.get("topLeft").and_then(|v| v.as_str()) {
                        if let Some((tr, tc)) = parse_a1(tl) {
                            let _ = worksheet.set_freeze_panes_top_cell(tr, tc as u16);
                        }
                    }
                }
            }

            // Apply per-column widths from snapshot.columnData.
            if let Some(col_map) = sheet_obj
                .and_then(|s| s.get("columnData"))
                .and_then(|c| c.as_object())
            {
                for (col_key, val) in col_map.iter() {
                    let Some(col_idx): Option<u16> = col_key.parse().ok() else {
                        continue;
                    };
                    let Some(w) = val.get("w").and_then(|w| w.as_f64()) else {
                        continue;
                    };
                    // Compensate for rust_xlsxwriter's internal char-width
                    // conversion so the on-disk xlsx records the same width
                    // we read on import.
                    let raw = inverse_col_width_for_xlsxwriter(w);
                    worksheet
                        .set_column_width(col_idx, raw)
                        .map_err(|e| e.to_string())?;
                }
            }

            // Apply per-row heights from snapshot.rowData.
            if let Some(row_map) = sheet_obj
                .and_then(|s| s.get("rowData"))
                .and_then(|c| c.as_object())
            {
                for (row_key, val) in row_map.iter() {
                    let Some(row_idx): Option<u32> = row_key.parse().ok() else {
                        continue;
                    };
                    let Some(h) = val.get("h").and_then(|h| h.as_f64()) else {
                        continue;
                    };
                    worksheet
                        .set_row_height(row_idx, h)
                        .map_err(|e| e.to_string())?;
                }
            }

            // Apply merged ranges first, then cell writes overwrite the blank
            // fill that merge_range stamps across the range. Skip degenerate
            // single-cell entries (rust_xlsxwriter rejects them) and any range
            // that fails to write (overlap, out-of-bounds) — those are dropped
            // silently per the best-effort policy. The default Format used here
            // does not override per-cell styles, since cell writes that follow
            // carry their own format.
            let empty_format = Format::new();
            if let Some(merge_arr) = sheet_obj
                .and_then(|s| s.get("mergeData"))
                .and_then(|m| m.as_array())
            {
                for entry in merge_arr {
                    let Some(sr) = entry.get("startRow").and_then(|v| v.as_u64()) else {
                        continue;
                    };
                    let Some(sc) = entry.get("startColumn").and_then(|v| v.as_u64()) else {
                        continue;
                    };
                    let Some(er) = entry.get("endRow").and_then(|v| v.as_u64()) else {
                        continue;
                    };
                    let Some(ec) = entry.get("endColumn").and_then(|v| v.as_u64()) else {
                        continue;
                    };
                    // Normalize order and skip single-cell entries.
                    let (sr, er) = if sr <= er { (sr, er) } else { (er, sr) };
                    let (sc, ec) = if sc <= ec { (sc, ec) } else { (ec, sc) };
                    if sr == er && sc == ec {
                        continue;
                    }
                    let (sr32, sc32, er32, ec32) =
                        match (u32::try_from(sr), u16::try_from(sc), u32::try_from(er), u16::try_from(ec)) {
                            (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
                            _ => continue,
                        };
                    let _ = worksheet.merge_range(sr32, sc32, er32, ec32, "", &empty_format);
                }
            }

            // Re-emit per-sheet data validations from `_dataValidations`. The
            // helper computes the bounding range from the (possibly multi-part)
            // sqref so rust_xlsxwriter's `add_data_validation(first_row, ...,
            // last_row, ...)` shape is satisfied, then `set_multi_range` carries
            // the original sqref through verbatim (preserving non-contiguous
            // ranges like "A1:A5 C1:C5"). Malformed entries are dropped silently
            // — same best-effort policy as merges/named ranges.
            if let Some(dv_arr) = sheet_obj
                .and_then(|s| s.get("_dataValidations"))
                .and_then(|v| v.as_array())
            {
                for entry in dv_arr {
                    if let Some(dv_built) = build_data_validation_from_snapshot(entry) {
                        let (dv, sr, sc, er, ec) = dv_built;
                        let _ = worksheet.add_data_validation(sr, sc, er, ec, &dv);
                    }
                }
            }

            // Re-emit per-sheet conditional formatting rules from
            // `_conditionalFormatting`. Each entry is dispatched on its
            // `type` to the matching rust_xlsxwriter conditional-format
            // variant (cellIs / containsText / expression / ...). dxf-
            // referenced visual styling is NOT preserved through this PoC
            // — rules round-trip with rust_xlsxwriter's default styling so
            // the rule shape (range + condition) survives even though the
            // colours / fonts attached to each rule do not.
            if let Some(cf_arr) = sheet_obj
                .and_then(|s| s.get("_conditionalFormatting"))
                .and_then(|v| v.as_array())
            {
                for entry in cf_arr {
                    let _ = apply_conditional_format_from_snapshot(worksheet, entry);
                }
            }

            let cell_data = sheet_obj
                .and_then(|s| s.get("cellData"))
                .and_then(|c| c.as_object());

            if let Some(rows) = cell_data {
                for (row_key, row_val) in rows.iter() {
                    let row_idx: u32 = match row_key.parse().ok() {
                        Some(r) => r,
                        None => continue,
                    };
                    let row_cells = match row_val.as_object() {
                        Some(o) => o,
                        None => continue,
                    };
                    for (col_key, cell_val) in row_cells.iter() {
                        let col_idx: u16 = match col_key.parse().ok() {
                            Some(c) => c,
                            None => continue,
                        };

                        let fmt_str = cell_val.get("_fmt").and_then(|f| f.as_str());
                        let style_id = cell_val.get("s").and_then(|f| f.as_str());
                        let style_obj = style_id.and_then(|id| resolved_styles.get(id));

                        // Build (or reuse) a Format combining the cell style + num format.
                        let fmt_obj: Option<Format> =
                            if style_obj.is_some() || fmt_str.is_some() {
                                let key = (
                                    style_id.unwrap_or("").to_string(),
                                    fmt_str.unwrap_or("").to_string(),
                                );
                                Some(
                                    format_cache
                                        .entry(key)
                                        .or_insert_with(|| {
                                            let s = style_obj.cloned().unwrap_or_default();
                                            build_format(&s, fmt_str)
                                        })
                                        .clone(),
                                )
                            } else {
                                None
                            };

                        // Formula takes precedence
                        if let Some(f) = cell_val.get("f").and_then(|f| f.as_str()) {
                            if let Some(ref fmt) = fmt_obj {
                                worksheet
                                    .write_formula_with_format(row_idx, col_idx, f, fmt)
                                    .map_err(|e| e.to_string())?;
                            } else {
                                worksheet
                                    .write_formula(row_idx, col_idx, f)
                                    .map_err(|e| e.to_string())?;
                            }
                            formula_count += 1;
                            cell_count += 1;
                            continue;
                        }

                        // Rich-text cells: write each run with its own Format.
                        // rust_xlsxwriter's write_rich_string takes &[(&Format, &str)]
                        // and rejects empty segments, so build the Vec carefully.
                        if let Some(runs_arr) =
                            cell_val.get("_richRuns").and_then(|v| v.as_array())
                        {
                            let parsed_runs: Vec<RichRun> = runs_arr
                                .iter()
                                .filter_map(RichRun::from_json)
                                .filter(|r| !r.text.is_empty())
                                .collect();
                            if !parsed_runs.is_empty() {
                                let formats: Vec<Format> = parsed_runs
                                    .iter()
                                    .map(build_run_format)
                                    .collect();
                                let segments: Vec<(&Format, &str)> = parsed_runs
                                    .iter()
                                    .zip(formats.iter())
                                    .map(|(r, f)| (f, r.text.as_str()))
                                    .collect();
                                let write_res = if let Some(ref fmt) = fmt_obj {
                                    worksheet.write_rich_string_with_format(
                                        row_idx, col_idx, &segments, fmt,
                                    )
                                } else {
                                    worksheet.write_rich_string(row_idx, col_idx, &segments)
                                };
                                if write_res.is_ok() {
                                    cell_count += 1;
                                    continue;
                                }
                                // On failure, fall through to plain `v` write so
                                // the cell isn't dropped.
                            }
                        }

                        if let Some(v) = cell_val.get("v") {
                            match v {
                                Value::Null => {
                                    // Style-only blank cell: write a blank with format.
                                    if let Some(ref fmt) = fmt_obj {
                                        worksheet
                                            .write_blank(row_idx, col_idx, fmt)
                                            .map_err(|e| e.to_string())?;
                                        cell_count += 1;
                                    }
                                    continue;
                                }
                                Value::Bool(b) => {
                                    if let Some(ref fmt) = fmt_obj {
                                        worksheet
                                            .write_boolean_with_format(row_idx, col_idx, *b, fmt)
                                            .map_err(|e| e.to_string())?;
                                    } else {
                                        worksheet
                                            .write_boolean(row_idx, col_idx, *b)
                                            .map_err(|e| e.to_string())?;
                                    }
                                }
                                Value::Number(n) => {
                                    let f = n.as_f64().unwrap_or(0.0);
                                    if let Some(ref fmt) = fmt_obj {
                                        worksheet
                                            .write_number_with_format(row_idx, col_idx, f, fmt)
                                            .map_err(|e| e.to_string())?;
                                    } else {
                                        worksheet
                                            .write_number(row_idx, col_idx, f)
                                            .map_err(|e| e.to_string())?;
                                    }
                                }
                                Value::String(s) => {
                                    if let Some(ref fmt) = fmt_obj {
                                        worksheet
                                            .write_string_with_format(row_idx, col_idx, s, fmt)
                                            .map_err(|e| e.to_string())?;
                                    } else {
                                        worksheet
                                            .write_string(row_idx, col_idx, s)
                                            .map_err(|e| e.to_string())?;
                                    }
                                }
                                Value::Array(_) | Value::Object(_) => {
                                    if let Some(ref fmt) = fmt_obj {
                                        worksheet
                                            .write_string_with_format(
                                                row_idx,
                                                col_idx,
                                                &v.to_string(),
                                                fmt,
                                            )
                                            .map_err(|e| e.to_string())?;
                                    } else {
                                        worksheet
                                            .write_string(row_idx, col_idx, &v.to_string())
                                            .map_err(|e| e.to_string())?;
                                    }
                                }
                            }
                            cell_count += 1;
                        } else if let Some(ref fmt) = fmt_obj {
                            // No `v` field but has style — blank styled cell.
                            worksheet
                                .write_blank(row_idx, col_idx, fmt)
                                .map_err(|e| e.to_string())?;
                            cell_count += 1;
                        }
                    }
                }
            }

            // Re-emit per-sheet hyperlinks from `_hyperlinks` AFTER cell writes
            // so the URL clobbers any plain string written at the same (row,
            // col). rust_xlsxwriter's `write_url` builds the per-sheet rels
            // file automatically and uses the `display` text (set via
            // `Url::set_text`) as the visible cell value. Malformed entries
            // are skipped silently — same best-effort policy as merges/DVs.
            if let Some(link_arr) = sheet_obj
                .and_then(|s| s.get("_hyperlinks"))
                .and_then(|v| v.as_array())
            {
                for entry in link_arr {
                    if let Some((row, col, url)) = build_hyperlink_from_snapshot(entry) {
                        let _ = worksheet.write_url(row, col, url);
                    }
                }
            }

            // Re-emit cell comments / notes from `_comments`. We disable
            // rust_xlsxwriter's automatic "Author:\n" prefix because our
            // import side strips it back off and round-trips would otherwise
            // double-apply. We still call insert_note so rust_xlsxwriter wires
            // up content-types and rels, then `rewrite_comments_in_zip` (run
            // after save) overwrites the comments XML with a correctly-mapped
            // version (workaround for rust_xlsxwriter 0.77 author/id bug).
            let mut sheet_notes: Vec<(String, String, String)> = Vec::new();
            if let Some(note_arr) = sheet_obj
                .and_then(|s| s.get("_comments"))
                .and_then(|v| v.as_array())
            {
                for entry in note_arr {
                    let Some(cell) = entry.get("cell").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let Some((row, col)) = parse_a1(cell) else {
                        continue;
                    };
                    let Ok(col_u16) = u16::try_from(col) else {
                        continue;
                    };
                    let text = entry
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let author = entry
                        .get("author")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let mut note = rust_xlsxwriter::Note::new(text).add_author_prefix(false);
                    if !author.is_empty() {
                        note = note.set_author(author);
                    }
                    let _ = worksheet.insert_note(row, col_u16, &note);
                    sheet_notes.push((cell.to_string(), author.to_string(), text.to_string()));
                }
            }
            if !sheet_notes.is_empty() {
                sheets_with_comments.push((safe_name.clone(), sheet_notes));
            }

            sheet_count += 1;
        }

        // Emit workbook-level named ranges. rust_xlsxwriter supports both
        // workbook-scoped (just `Name`) and sheet-scoped (`SheetName!Name`)
        // names through the same define_name(name, formula) entry point, so
        // when an entry carries a `scope` field we prefix the name accordingly.
        if let Some(ranges) = snapshot.get("namedRanges").and_then(|v| v.as_array()) {
            for entry in ranges {
                let name = match entry.get("name").and_then(|v| v.as_str()) {
                    Some(s) if !s.trim().is_empty() => s,
                    _ => continue,
                };
                let formula = match entry.get("formula").and_then(|v| v.as_str()) {
                    Some(s) if !s.trim().is_empty() => s,
                    _ => continue,
                };
                let scope = entry
                    .get("scope")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty());

                let qualified = if let Some(sheet) = scope {
                    // rust_xlsxwriter accepts "SheetName!Name" for local scope.
                    // If the sheet name needs single-quoting, the caller is
                    // expected to have already done so on import; otherwise
                    // pass through as-is.
                    format!("{sheet}!{name}")
                } else {
                    name.to_string()
                };

                if let Err(e) = workbook.define_name(&qualified, formula) {
                    if scope.is_some() {
                        // Sheet-scoped names can fail if the referenced sheet
                        // doesn't exist or the name doesn't survive Excel's
                        // validation rules. Retry as workbook-scope so the
                        // value is at least preserved instead of dropped.
                        if workbook.define_name(name, formula).is_ok() {
                            scoped_names_downgraded.push(name.to_string());
                            continue;
                        }
                    }
                    named_range_failures.push(format!("{name}: {e}"));
                }
            }
        }

        Ok(())
    })();

    if let Err(e) = build_result {
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_BUILD_FAILED".to_string(),
                message: format!("Failed to build xlsx: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_BUILD_FAILED: {e}")),
        });
    }

    // Step 4: atomic save — rotate backups, write tmp, rename onto target
    let target_path = PathBuf::from(&path);
    let tmp_path = temp_save_path(&target_path);

    if target_path.exists() {
        if let Err(e) = rotate_backups(&target_path) {
            return Ok(ExportResult {
                success: false,
                path: path.clone(),
                warnings: vec![CompatibilityWarning {
                    severity: "blocking".to_string(),
                    code: "XLSX_WRITE_FAILED".to_string(),
                    message: format!("backup rotation failed: {e}"),
                    affected_sheets: None,
                }],
                error: Some(format!("backup rotation failed: {e}")),
            });
        }
    }

    if let Err(e) = workbook.save(&tmp_path) {
        let msg = e.to_string();
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_WRITE_FAILED".to_string(),
                message: format!("Failed to write xlsx: {msg}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_WRITE_FAILED: {msg}")),
        });
    }

    // Post-save: rewrite `xl/commentsN.xml` entries with our own correctly-
    // mapped XML to work around rust_xlsxwriter 0.77's author/id bug.
    if let Err(e) = rewrite_comments_in_zip(&tmp_path, &sheets_with_comments) {
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_WRITE_FAILED".to_string(),
                message: format!("comment rewrite failed: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_WRITE_FAILED: {e}")),
        });
    }

    // Chart-preservation: if the snapshot carried `_preservedParts`, reopen
    // the temp xlsx and splice the preserved chart/drawing/theme parts back
    // in. Best-effort: a failure here leaves the rust_xlsxwriter-written file
    // in place so the user at least gets their cells + styles.
    let mut chart_injection_failed: Option<String> = None;
    if let Some(preserved) = snapshot.get("_preservedParts") {
        if let Err(e) = inject_preserved_parts(&tmp_path, preserved, sheet_order.len()) {
            chart_injection_failed = Some(e);
        }
    }

    if let Err(e) = std::fs::rename(&tmp_path, &target_path) {
        let msg = e.to_string();
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_WRITE_FAILED".to_string(),
                message: format!("rename failed: {msg}"),
                affected_sheets: None,
            }],
            error: Some(format!("rename failed: {msg}")),
        });
    }

    // Step 5: build warnings
    let mut warnings: Vec<CompatibilityWarning> = Vec::new();
    warnings.push(CompatibilityWarning {
        severity: "info".to_string(),
        code: "XLSX_POC_EXPORT".to_string(),
        message: format!(
            "xlsx PoC export: {sheet_count} sheets, {cell_count} cells, {formula_count} formulas. Pivot tables are not yet preserved (named ranges + font/fill/alignment/border styles + column widths + row heights + merged cells + number formats + rich text + data validations + conditional formatting + charts (blob-preserved) are preserved)."
        ),
        affected_sheets: None,
    });

    if let Some(err) = chart_injection_failed {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_CHART_INJECTION_FAILED".to_string(),
            message: format!(
                "Preserved chart parts could not be re-injected into the saved file: {err}"
            ),
            affected_sheets: None,
        });
    }

    if !sanitized_names.is_empty() {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_SHEET_NAME_SANITIZED".to_string(),
            message: "One or more sheet names contained illegal characters or exceeded 31 chars; they were sanitized.".to_string(),
            affected_sheets: Some(sanitized_names),
        });
    }

    if !scoped_names_downgraded.is_empty() {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_NAMED_RANGE_SCOPE_DOWNGRADED".to_string(),
            message: format!(
                "{} sheet-scoped named range(s) could not be emitted with their original scope and were re-emitted as workbook-scoped.",
                scoped_names_downgraded.len()
            ),
            affected_sheets: None,
        });
    }

    if !named_range_failures.is_empty() {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_NAMED_RANGE_DROPPED".to_string(),
            message: format!(
                "{} named range(s) could not be exported and were dropped: {}",
                named_range_failures.len(),
                named_range_failures.join("; ")
            ),
            affected_sheets: None,
        });
    }

    Ok(ExportResult {
        success: true,
        path,
        warnings,
        error: None,
    })
}

// ============================================================================
// Chart preservation (blob-level).
//
// Charts in xlsx are spread across several parts (`xl/charts/*`,
// `xl/drawings/*`, their `_rels`, `xl/theme/*`) plus a per-sheet `<drawing>`
// reference that lives inside the worksheet XML. Rendering them is out of
// scope for the PoC — instead we preserve every related part byte-for-byte
// in the snapshot and inject it back on export so the saved file still
// carries its charts.
//
// On import: `parse_xlsx_preserved_parts` walks the source zip, base64-encodes
// every preserved part under a single JSON object keyed by zip entry path,
// and records each sheet's `<drawing r:id="..."/>` element + the relationship
// target it points at. The whole thing is stamped into the snapshot under
// `_preservedParts`.
//
// On export: after `rust_xlsxwriter` writes the new xlsx to `tmp_path`,
// `inject_preserved_parts` reopens that zip and rewrites it with every
// preserved blob added, the `[Content_Types].xml` overrides merged in, and
// a `<drawing>` ref plus `_rels/sheetN.xml.rels` inserted into the matching
// (by sheet-order position) worksheet.
//
// Limits:
//   - Per-part cap: 16 MiB.
//   - Aggregate cap: 32 MiB (defense against a maliciously crafted file).
//   - Only the parts listed in `PRESERVED_PREFIXES` are captured.
// ============================================================================

const PRESERVED_PART_SIZE_CAP: usize = 16 * 1024 * 1024;
const PRESERVED_TOTAL_SIZE_CAP: usize = 32 * 1024 * 1024;

/// Path prefixes captured verbatim from the source xlsx. Each entry whose
/// name starts with one of these is base64-encoded into the snapshot.
const PRESERVED_PREFIXES: &[&str] = &[
    "xl/charts/",
    "xl/drawings/",
    "xl/theme/",
];

/// Minimal base64 encoder — avoids adding a crate dependency for a single
/// internal use. Standard RFC 4648 alphabet, with `=` padding.
fn b64_encode(input: &[u8]) -> String {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((input.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | input[i + 2] as u32;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

fn b64_decode(input: &str) -> Option<Vec<u8>> {
    fn decode_char(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut i = 0;
    while i < bytes.len() {
        let b0 = decode_char(bytes[i])?;
        let b1 = decode_char(bytes[i + 1])?;
        let c2 = bytes[i + 2];
        let c3 = bytes[i + 3];
        let n0 = (b0 as u32) << 18 | (b1 as u32) << 12;
        if c2 == b'=' {
            out.push((n0 >> 16) as u8);
        } else {
            let b2 = decode_char(c2)?;
            let n = n0 | (b2 as u32) << 6;
            if c3 == b'=' {
                out.push((n >> 16) as u8);
                out.push((n >> 8) as u8);
            } else {
                let b3 = decode_char(c3)?;
                let n = n | b3 as u32;
                out.push((n >> 16) as u8);
                out.push((n >> 8) as u8);
                out.push(n as u8);
            }
        }
        i += 4;
    }
    Some(out)
}

/// Walk the source xlsx zip and return preserved parts + per-sheet drawing
/// refs. Returns `None` when there's nothing to preserve so callers can skip
/// stamping an empty `_preservedParts` block into the snapshot.
pub(crate) fn parse_xlsx_preserved_parts(path: &str) -> Option<Value> {
    use std::fs::File;
    use zip::ZipArchive;

    let file = File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;

    let mut parts: Map<String, Value> = Map::new();
    let mut total_size: usize = 0;

    // Pass 1: collect all preserved blobs (charts, drawings, theme, and their
    // _rels). The `_rels` subdirs live UNDER each prefix already, so the
    // prefix check is sufficient.
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        let matches = PRESERVED_PREFIXES.iter().any(|p| name.starts_with(p));
        if !matches {
            continue;
        }
        // Directory entries (rare but legal) — skip.
        if name.ends_with('/') {
            continue;
        }
        let size = entry.size() as usize;
        if size > PRESERVED_PART_SIZE_CAP {
            continue;
        }
        if total_size.saturating_add(size) > PRESERVED_TOTAL_SIZE_CAP {
            break;
        }
        let mut buf = Vec::with_capacity(size);
        if std::io::Read::read_to_end(&mut entry, &mut buf).is_err() {
            continue;
        }
        total_size += buf.len();
        parts.insert(name, Value::String(b64_encode(&buf)));
    }

    if parts.is_empty() {
        return None;
    }

    // Pass 2: capture per-sheet drawing references. For each worksheet, pull
    // its `<drawing r:id="..."/>` element from the body and the corresponding
    // target from its `_rels/sheetN.xml.rels`. Indexed by position in
    // `workbook.xml`'s `<sheets>` list so we can re-link on export — the
    // export side uses the snapshot's `sheetOrder` position.
    let bytes = std::fs::read(path).ok()?;
    let sheet_paths = parse_sheet_path_map(&bytes);
    // Reuse the canonical ordering from workbook.xml (calamine returns sheets
    // in this order too).
    let workbook_xml = {
        let mut s = String::new();
        if let Ok(mut e) = archive.by_name("xl/workbook.xml") {
            let _ = std::io::Read::read_to_string(&mut e, &mut s);
        }
        s
    };
    let ordered_sheets = parse_workbook_sheets(&workbook_xml);

    let mut sheet_refs: Vec<Value> = Vec::new();
    for (sheet_name, _rid) in &ordered_sheets {
        let Some(sheet_part) = sheet_paths.get(sheet_name) else {
            sheet_refs.push(Value::Null);
            continue;
        };
        // Read the worksheet body to find a `<drawing r:id="rdN"/>` element.
        let mut body = String::new();
        if let Ok(mut entry) = archive.by_name(sheet_part) {
            let _ = std::io::Read::read_to_string(&mut entry, &mut body);
        }
        let drawing_rid: Option<String> = body
            .find("<drawing")
            .map(|s| &body[s..])
            .and_then(|chunk| chunk.find("/>").map(|e| &chunk[..e]))
            .and_then(|tag| parse_attr(tag, "r:id"));

        // Look up the rId in the per-sheet rels.
        let sheet_rels_path = sheet_part_to_rels_path(sheet_part);
        let mut sheet_rels_xml = String::new();
        if let Ok(mut entry) = archive.by_name(&sheet_rels_path) {
            let _ = std::io::Read::read_to_string(&mut entry, &mut sheet_rels_xml);
        }
        let rid_to_target = parse_rels(&sheet_rels_xml);

        let drawing_target = drawing_rid
            .as_ref()
            .and_then(|rid| rid_to_target.get(rid).cloned());

        if drawing_rid.is_some() && drawing_target.is_some() {
            sheet_refs.push(json!({
                "drawingRid": drawing_rid,
                "drawingTarget": drawing_target,
            }));
        } else {
            sheet_refs.push(Value::Null);
        }
    }

    // Also preserve the source [Content_Types].xml so we can pluck out the
    // chart/drawing Override entries on export.
    let mut content_types_xml = String::new();
    if let Ok(mut e) = archive.by_name("[Content_Types].xml") {
        let _ = std::io::Read::read_to_string(&mut e, &mut content_types_xml);
    }

    Some(json!({
        "parts": Value::Object(parts),
        "sheetRefs": sheet_refs,
        "contentTypes": content_types_xml,
    }))
}

/// Map a worksheet entry path to its sibling `_rels` path.
/// e.g. `"xl/worksheets/sheet1.xml"` → `"xl/worksheets/_rels/sheet1.xml.rels"`.
fn sheet_part_to_rels_path(sheet_part: &str) -> String {
    if let Some((dir, file)) = sheet_part.rsplit_once('/') {
        format!("{dir}/_rels/{file}.rels")
    } else {
        format!("_rels/{sheet_part}.rels")
    }
}

/// Reopen the freshly-written xlsx zip at `tmp_path`, append every preserved
/// part, inject the per-sheet drawing references, and merge content-type
/// overrides. Best-effort: any failure logs (silent in tests) and leaves the
/// original file untouched.
pub(crate) fn inject_preserved_parts(
    tmp_path: &std::path::Path,
    preserved: &Value,
    sheet_order_len: usize,
) -> Result<(), String> {
    use std::fs;
    use std::io::Cursor;
    use zip::{write::FileOptions, ZipArchive, ZipWriter};

    let parts = preserved
        .get("parts")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "preserved: missing parts".to_string())?;
    let sheet_refs = preserved
        .get("sheetRefs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let original_content_types = preserved
        .get("contentTypes")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let original_bytes = fs::read(tmp_path).map_err(|e| e.to_string())?;
    let mut src = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;

    let mut out_buf: Vec<u8> = Vec::with_capacity(original_bytes.len() + 4096);
    {
        let mut out = ZipWriter::new(Cursor::new(&mut out_buf));
        let opts: FileOptions = FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        // Track entries we will skip on copy because we're rewriting them.
        // Up to `sheet_order_len` sheet XMLs may need a `<drawing>` injection,
        // and a matching `_rels` file may need to be added/replaced.
        let mut sheet_to_drawing: HashMap<usize, (String, String)> = HashMap::new(); // sheet_idx → (rId, target)
        for (idx, val) in sheet_refs.iter().enumerate() {
            if idx >= sheet_order_len {
                break;
            }
            let Some(obj) = val.as_object() else { continue };
            let Some(rid) = obj.get("drawingRid").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(target) = obj.get("drawingTarget").and_then(|v| v.as_str()) else {
                continue;
            };
            sheet_to_drawing.insert(idx, (rid.to_string(), target.to_string()));
        }

        // We rewrite [Content_Types].xml and sheet XMLs / rels we touch.
        let mut skip_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        skip_names.insert("[Content_Types].xml".to_string());
        for idx in sheet_to_drawing.keys() {
            let n = idx + 1;
            skip_names.insert(format!("xl/worksheets/sheet{n}.xml"));
            skip_names.insert(format!("xl/worksheets/_rels/sheet{n}.xml.rels"));
        }
        // Also skip any of the preserved-part target names so a stale empty
        // copy from rust_xlsxwriter (unlikely, but defensive) doesn't survive.
        for name in parts.keys() {
            skip_names.insert(name.clone());
        }

        // Copy all entries from rust_xlsxwriter's output, skipping ones we
        // intend to rewrite.
        for i in 0..src.len() {
            let mut entry = src.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            if skip_names.contains(&name) {
                continue;
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;
            out.start_file(&name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, &buf).map_err(|e| e.to_string())?;
        }

        // Inject preserved parts (charts, drawings, theme, their rels).
        for (name, val) in parts.iter() {
            let Some(s) = val.as_str() else { continue };
            let Some(bytes) = b64_decode(s) else { continue };
            out.start_file(name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, &bytes).map_err(|e| e.to_string())?;
        }

        // Rewrite each affected worksheet XML with a `<drawing r:id="..."/>`
        // tail. Also write a fresh `_rels/sheetN.xml.rels` carrying that rId.
        // We must reopen src fresh because we already exhausted the iterator
        // above on the borrow that got moved into the loop. Re-create archive.
        let mut src2 =
            ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;
        for (idx, (rid, target)) in &sheet_to_drawing {
            let n = idx + 1;
            let sheet_name = format!("xl/worksheets/sheet{n}.xml");
            let mut sheet_xml = String::new();
            if let Ok(mut e) = src2.by_name(&sheet_name) {
                let _ = std::io::Read::read_to_string(&mut e, &mut sheet_xml);
            }
            if sheet_xml.is_empty() {
                continue;
            }
            // Inject `<drawing r:id="..."/>` just before `</worksheet>`.
            let injected = if let Some(pos) = sheet_xml.rfind("</worksheet>") {
                let mut s = String::with_capacity(sheet_xml.len() + 64);
                s.push_str(&sheet_xml[..pos]);
                s.push_str(&format!("<drawing r:id=\"{rid}\"/>"));
                s.push_str(&sheet_xml[pos..]);
                s
            } else {
                sheet_xml
            };
            out.start_file(&sheet_name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, injected.as_bytes()).map_err(|e| e.to_string())?;

            // Compose a minimal `_rels/sheetN.xml.rels` with just the drawing
            // relationship. If rust_xlsxwriter wrote one with other rels
            // (hyperlinks, etc.) we lose them — acceptable for the PoC.
            let rels = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
                 <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n\
                 <Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing\" Target=\"{target}\"/>\n\
                 </Relationships>"
            );
            let rels_name = format!("xl/worksheets/_rels/sheet{n}.xml.rels");
            out.start_file(&rels_name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, rels.as_bytes()).map_err(|e| e.to_string())?;
        }

        // Rewrite [Content_Types].xml: pull the new (rust_xlsxwriter-emitted)
        // body, then splice in any chart/drawing Override entries from the
        // original. We don't need to dedupe perfectly — Excel is tolerant of
        // duplicate Overrides as long as content types agree.
        let mut new_ct = String::new();
        if let Ok(mut e) = src.by_name("[Content_Types].xml") {
            let _ = std::io::Read::read_to_string(&mut e, &mut new_ct);
        }
        let merged_ct = merge_content_type_overrides(&new_ct, original_content_types);
        out.start_file("[Content_Types].xml", opts)
            .map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut out, merged_ct.as_bytes()).map_err(|e| e.to_string())?;

        out.finish().map_err(|e| e.to_string())?;
    }

    fs::write(tmp_path, &out_buf).map_err(|e| e.to_string())?;
    Ok(())
}

/// Splice chart/drawing-related `<Override>` entries from `original_ct` into
/// `new_ct` so the resulting `[Content_Types].xml` advertises the parts we
/// just injected. Overrides whose PartName already appears in `new_ct` are
/// skipped to keep the file deterministic.
fn merge_content_type_overrides(new_ct: &str, original_ct: &str) -> String {
    // Pull every <Override .../> from the original, keep only the ones whose
    // PartName matches a preserved prefix.
    let mut adds: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = original_ct[cursor..].find("<Override") {
        let start = cursor + rel;
        let rest = &original_ct[start..];
        let Some(end) = rest.find("/>") else { break };
        let tag = &original_ct[start..start + end + 2];
        cursor = start + end + 2;
        let part_name = parse_attr(tag, "PartName").unwrap_or_default();
        // Strip leading slash to compare against preserved keys.
        let normalized = part_name.trim_start_matches('/');
        let keep = PRESERVED_PREFIXES.iter().any(|p| normalized.starts_with(p));
        if !keep {
            continue;
        }
        if new_ct.contains(&format!("PartName=\"{part_name}\"")) {
            continue;
        }
        adds.push(tag.to_string());
    }
    if adds.is_empty() {
        return new_ct.to_string();
    }
    // Inject right before the closing </Types>.
    if let Some(pos) = new_ct.rfind("</Types>") {
        let mut out = String::with_capacity(new_ct.len() + adds.iter().map(|s| s.len()).sum::<usize>() + 16);
        out.push_str(&new_ct[..pos]);
        for tag in &adds {
            out.push_str(tag);
        }
        out.push_str(&new_ct[pos..]);
        out
    } else {
        new_ct.to_string()
    }
}

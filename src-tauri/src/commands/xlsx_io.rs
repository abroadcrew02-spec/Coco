use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek};
use std::path::PathBuf;

use calamine::{open_workbook, Data, Reader, Xlsx};
use rust_xlsxwriter::{
    Color, ConditionalFormatAverage, ConditionalFormatAverageRule, ConditionalFormatCell,
    ConditionalFormatCellRule, ConditionalFormatDate, ConditionalFormatDateRule,
    ConditionalFormatDuplicate, ConditionalFormatFormula, ConditionalFormatText,
    ConditionalFormatTextRule, ConditionalFormatTop, ConditionalFormatTopRule, DataValidation,
    DataValidationErrorStyle,
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
const MAX_EXPORT_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_EXPORT_CELLS: usize = 500_000;

/// Normalized cell style extracted from xl/styles.xml + per-sheet `<c s="..."/>` refs.
/// Scope: font (bold/italic/color) + fill (color) + alignment (horizontal/vertical)
/// + borders (per-side style/color) + number format (resolved code string).
///
/// #40: num_format moved in so the struct is self-contained and the dedup
/// hash naturally accounts for it. Rich-text formatting still lives on the
/// per-cell `_richRuns` array because each cell carries its own text — sharing
/// a "rich-text style" across cells would require splitting style from text,
/// which is a separate refactor.
#[derive(Default, Clone, PartialEq, Eq, Hash)]
struct CellStyle {
    bold: bool,
    italic: bool,
    font_color: Option<String>, // "#RRGGBB"
    fill_color: Option<String>, // "#RRGGBB"
    h_align: Option<String>,    // "left" | "center" | "right" | "fill" | "justify"
    v_align: Option<String>,    // "top" | "middle" | "bottom"
    borders: Option<CellBorders>,
    /// Number format code as resolved by `resolve_num_format` (built-in
    /// table + custom `numFmts`). None means "no explicit num format" which
    /// rust_xlsxwriter treats as General.
    num_format: Option<String>,
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
        self.top.is_none() && self.bottom.is_none() && self.left.is_none() && self.right.is_none()
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct BorderSide {
    style: String,         // "thin" | "medium" | "thick" | "double" | "dotted" | "dashed"
    color: Option<String>, // "#RRGGBB"
}

/// One formatting run inside a rich-text cell. Mirrors the subset of OOXML
/// `<rPr>` (run properties) we round-trip. Fields are all optional so the
/// JSON shape stays compact — only the run's actual styling appears.
#[derive(Default, Clone, PartialEq, Debug)]
struct RichRun {
    text: String,
    bold: bool,
    italic: bool,
    color: Option<String>,  // "#RRGGBB"
    font_size: Option<f64>, // point size (xlsx `sz val="..."`)
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
            color: obj
                .get("color")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
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
            && self.num_format.is_none()
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
            s.font_color = f
                .get("color")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
        }
        if let Some(fl) = obj.get("fill").and_then(|x| x.as_object()) {
            s.fill_color = fl
                .get("color")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
        }
        if let Some(a) = obj.get("alignment").and_then(|x| x.as_object()) {
            s.h_align = a
                .get("horizontal")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            s.v_align = a
                .get("vertical")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
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

fn parse_xlsx_styles<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<ParsedStyles, String> {
    use std::io::Read;

    // 1. styles.xml: fonts, fills, cellXfs
    let mut styles_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/styles.xml") {
        entry
            .read_to_string(&mut styles_xml)
            .map_err(|e| e.to_string())?;
    }
    let (fonts, fills, borders, cell_xfs_raw, custom_num_fmts) = parse_styles_xml(&styles_xml);

    // 2. resolve each cellXf to a normalized CellStyle (which now carries its
    //    own num_format per #40 — kept parallel cell_num_formats for callers
    //    that still index by xf id without going through CellStyle).
    let cell_xfs: Vec<CellStyle> = cell_xfs_raw
        .iter()
        .map(|x| resolve_xf(x, &fonts, &fills, &borders, &custom_num_fmts))
        .collect();
    let cell_num_formats: Vec<Option<String>> = cell_xfs
        .iter()
        .map(|s| s.num_format.clone())
        .collect();

    Ok(ParsedStyles {
        cell_xfs,
        cell_num_formats,
        per_sheet: HashMap::new(),
    })
}

/// Per-sheet rich-text map: (row0, col0) -> Vec<RichRun>. Plain strings stay
/// out of the map so a missing entry means "use the plain calamine value".
type SheetRichTextMap = HashMap<(u32, u32), Vec<RichRun>>;

/// Parsed rich-text data for a workbook. Only the per-sheet map is consumed
/// downstream; the shared-strings vec is kept as an intermediate during
/// the per-sheet import pass (used to resolve `<c t="s">` lookups) and isn't
/// read further once `per_sheet` is built.
struct ParsedRichText {
    per_sheet: HashMap<String, SheetRichTextMap>,
}

/// Parse `xl/sharedStrings.xml` rich-text entries. Per-sheet rich-text cells
/// are resolved during the one-sheet-at-a-time worksheet XML pass.
fn parse_xlsx_shared_rich_text<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<Vec<Option<Vec<RichRun>>>, String> {
    use std::io::Read;

    // 1. sharedStrings.xml — optional (workbooks with only inline strings omit it)
    let mut ss_xml = String::new();
    if let Ok(mut entry) = archive.by_name("xl/sharedStrings.xml") {
        entry
            .read_to_string(&mut ss_xml)
            .map_err(|e| e.to_string())?;
    }
    let shared = parse_shared_strings_xml(&ss_xml);

    Ok(shared)
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
    r.bold || r.italic || r.color.is_some() || r.font_size.is_some() || r.font_name.is_some()
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
fn parse_sheet_rich_text(xml: &str, shared: &[Option<Vec<RichRun>>]) -> SheetRichTextMap {
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
                            let keep = runs.len() > 1 || runs.iter().any(run_has_formatting);
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
) -> (
    Vec<RawFont>,
    Vec<RawFill>,
    Vec<RawBorder>,
    Vec<RawXf>,
    HashMap<u32, String>,
) {
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
            x.apply_number_format = parse_attr(&xf_el, "applyNumberFormat").as_deref() == Some("1");
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

/// Decode the XML entities Excel may emit inside attribute / text content:
/// the five named entities plus numeric character references in decimal
/// (`&#10;`) and hexadecimal (`&#xA;`) forms. #66: without numeric refs,
/// Excel-emitted newlines inside header/footer / comments / number formats
/// survive as literal `&#10;` text and get double-escaped on re-export.
fn decode_xml_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let after = &rest[idx..];
        let semi = match after.find(';') {
            Some(p) if p <= 8 => p,
            _ => {
                // No `;` close within a plausible entity window — emit `&`
                // verbatim and continue past it.
                out.push('&');
                rest = &after[1..];
                continue;
            }
        };
        let body = &after[1..semi];
        let decoded: Option<char> = match body {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if body.starts_with("#x") || body.starts_with("#X") => {
                u32::from_str_radix(&body[2..], 16).ok().and_then(char::from_u32)
            }
            _ if body.starts_with('#') => {
                body[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        match decoded {
            Some(c) => out.push(c),
            None => out.push_str(&after[..=semi]),
        }
        rest = &after[semi + 1..];
    }
    out.push_str(rest);
    out
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
        self.top.is_none() && self.bottom.is_none() && self.left.is_none() && self.right.is_none()
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

fn resolve_xf(
    xf: &RawXf,
    fonts: &[RawFont],
    fills: &[RawFill],
    borders: &[RawBorder],
    custom_num_fmts: &HashMap<u32, String>,
) -> CellStyle {
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
    // #40: resolve the number-format code so it travels with the rest of the
    // CellStyle. Same precedence as the old parallel cell_num_formats vec
    // (built-in lookup, then custom numFmts table) but now bound to the
    // style identity hash.
    s.num_format = resolve_num_format(xf, custom_num_fmts);
    s
}

fn parse_workbook_sheets(xml: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(block) = extract_block(xml, "<sheets", "</sheets>") {
        for el in extract_self_closing_or_paired(&block, "sheet") {
            // workbook.xml stores names with XML entities escaped (e.g.
            // `name="Q&amp;A"`), but calamine surfaces sheet names already
            // decoded (`Q&A`). Downstream maps (sheet_paths, sheet_drawing_rids)
            // are keyed by name and looked up using the calamine form, so we
            // must decode here to keep the keys in sync. Bug: without this
            // decode, sheets with `& < > " '` in their names silently drop
            // drawings / preserved parts on import.
            let name = parse_attr(&el, "name")
                .map(|s| decode_xml_entities(&s))
                .unwrap_or_default();
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
    ///
    /// For `state="split"`, this carries the raw `ySplit` value as parsed
    /// (Excel writes split offsets in 1/20 pt units / pixels — we preserve the
    /// number verbatim so a round-trip is byte-identical).
    pub row: u32,
    /// 0-based column of the first scrollable cell (== xSplit; cols 0..col are frozen).
    ///
    /// For `state="split"`, this carries the raw `xSplit` value as parsed
    /// (see `row` above).
    pub col: u32,
    /// Optional A1-style top-left visible cell in the scrolling pane
    /// (e.g. `"A20"`), as written by `topLeftCell` on the `<pane>` element.
    pub top_left: Option<String>,
    /// `"frozen"` (the D5 default) or `"split"`. Split panes use the same
    /// `<pane>` element but `xSplit`/`ySplit` are pixel/twip offsets rather
    /// than row/col counts. Defaults to `"frozen"` for back-compat.
    pub state: String,
}

/// Parse the `<sheetView><pane .../></sheetView>` block of one worksheet's XML
/// into a `FreezePaneEntry`. Returns `None` when no pane is declared.
/// Handles both `state="frozen"` and `state="split"` (the latter is the
/// live-drag variant — xSplit/ySplit are pixel offsets, not row/col counts).
/// A missing `state` attribute defaults to `"split"` per the OOXML schema.
fn parse_sheet_freeze_pane(xml: &str) -> Option<FreezePaneEntry> {
    let view = extract_block(xml, "<sheetView", "</sheetView>")?;
    let pane = find_tag(&view, "<pane")?;
    let raw_state = parse_attr(&pane, "state").unwrap_or_default();
    let state = match raw_state.as_str() {
        "frozen" | "frozenSplit" => "frozen",
        // OOXML default when `state` is absent is "split".
        "split" | "" => "split",
        _ => return None,
    };
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
        state: state.to_string(),
    })
}

/// Walk every sheet in an xlsx and pull out its freeze-pane declaration.
/// Returns `sheet name -> FreezePaneEntry`; sheets without a frozen pane are
/// omitted.
#[allow(dead_code)]
pub(crate) fn parse_xlsx_freeze_panes(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, FreezePaneEntry> {
    let mut out: HashMap<String, FreezePaneEntry> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        if let Some(fp) = parse_sheet_freeze_pane(xml) {
            out.insert(sheet_name.clone(), fp);
        }
    }
    out
}

/// Project a Coco `_freezePane` declaration onto Univer's native
/// `IWorksheetData.freeze` field (`{ xSplit, ySplit, startRow, startColumn }`).
///
/// Without this, opening an xlsx that carries a frozen / split pane shows no
/// visual freeze until the user toggles it via the View menu: Univer's freeze
/// renderer only activates when `sheets.<id>.freeze` is populated, but the
/// import path historically wrote only the Coco-private `_freezePane` marker.
/// This helper closes that gap (issue #178, item 3) so the freeze / split is
/// visible immediately on direct open.
///
/// Semantics:
///   * `state="frozen"` — `row`/`col` are fixed row/column counts (the OOXML
///     `xSplit`/`ySplit` of a frozen pane). They map directly onto Univer's
///     `IFreeze`.
///   * `state="split"`  — `row`/`col` carry the raw `xSplit`/`ySplit` verbatim.
///     Coco-authored splits store row/col indices here; Excel-authored splits
///     store pixel/twip offsets. Univer 0.5.x has no split renderer, so the
///     freeze renderer is the visual approximation either way.
///
/// `row_count`/`col_count` are the sheet's dimensions. A pane anchor at or
/// beyond those bounds (e.g. an Excel pixel-offset split that dwarfs the sheet)
/// is rejected — projecting it would produce a nonsensical freeze. The
/// `_freezePane` marker still round-trips in that case; only the visual
/// projection is skipped. Returns `None` when no projection should be written.
fn freeze_field_for_pane(
    row: u64,
    col: u64,
    row_count: u64,
    col_count: u64,
) -> Option<Value> {
    if row == 0 && col == 0 {
        return None;
    }
    // Reject anchors that fall outside the sheet — clamping would silently
    // shift the freeze line, so we drop the projection instead.
    if row >= row_count || col >= col_count {
        return None;
    }
    // Univer's "no freeze on this axis" sentinel is startRow/startColumn = -1.
    let start_row: i64 = if row > 0 { row as i64 } else { -1 };
    let start_column: i64 = if col > 0 { col as i64 } else { -1 };
    Some(json!({
        "xSplit": col,
        "ySplit": row,
        "startRow": start_row,
        "startColumn": start_column,
    }))
}

/// Read `xl/workbook.xml` from an xlsx and return the sheet-visibility map.
/// Best-effort: returns empty on read or parse failure.
pub(crate) fn parse_xlsx_sheet_visibility<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> HashMap<String, String> {
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

/// One parsed sheet-protection declaration from a worksheet's
/// `<sheetProtection .../>` element.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct SheetProtectionEntry {
    /// True when the worksheet is marked read-only (`sheet="1"`).
    pub protected: bool,
}

/// Parse the `<sheetProtection .../>` element of one worksheet's XML into a
/// `SheetProtectionEntry`. Returns `None` when the element isn't present or
/// the `sheet` attribute isn't "1" / "true".
fn parse_sheet_protection(xml: &str) -> Option<SheetProtectionEntry> {
    let el = find_tag(xml, "<sheetProtection")?;
    let sheet = parse_attr(&el, "sheet").unwrap_or_default();
    let on = matches!(sheet.as_str(), "1" | "true");
    if !on {
        return None;
    }
    Some(SheetProtectionEntry { protected: true })
}

/// Walk every sheet in an xlsx and pull out its sheet-protection declaration.
/// Returns `sheet name -> SheetProtectionEntry`; sheets without protection are
/// omitted.
#[allow(dead_code)]
pub(crate) fn parse_xlsx_sheet_protection(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, SheetProtectionEntry> {
    let mut out: HashMap<String, SheetProtectionEntry> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        if let Some(sp) = parse_sheet_protection(xml) {
            out.insert(sheet_name.clone(), sp);
        }
    }
    out
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
        if bytes[i] == b'<'
            && bytes[i + 1] == b'c'
            && (bytes[i + 2] == b' ' || bytes[i + 2] == b'>' || bytes[i + 2] == b'/')
        {
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
    // OOXML spec caps columns at XFD (16384) and rows at 1048576. #65: use
    // checked arithmetic so malicious refs like "ZZZZZZZ1" can't overflow u32
    // (panic in debug, silent wrap in release with downstream HashMap
    // mis-keying). Reject anything past the spec maximum.
    const MAX_COL: u32 = 16_384;
    const MAX_ROW: u32 = 1_048_576;
    let mut col = 0u32;
    let mut row_start = 0;
    for (i, ch) in s.char_indices() {
        if ch.is_ascii_alphabetic() {
            let inc = (ch.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
            col = col.checked_mul(26)?.checked_add(inc)?;
            if col > MAX_COL {
                return None;
            }
            row_start = i + 1;
        } else {
            break;
        }
    }
    if col == 0 || row_start >= s.len() {
        return None;
    }
    let row: u32 = s[row_start..].parse().ok()?;
    if row == 0 || row > MAX_ROW {
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
    if !matches!(
        xml.as_bytes().get(after),
        Some(b' ') | Some(b'>') | Some(b'/')
    ) {
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
        fmt = fmt
            .set_background_color(c)
            .set_pattern(FormatPattern::Solid);
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
    // #40: prefer the explicit override (per-cell `_fmt`) if present; fall
    // back to whatever the resolved CellStyle carries. Previously num_format
    // only flowed through the override channel, so cells that inherited
    // formatting purely from their xf number-format ref were silently
    // emitted as General on export.
    let effective_num_fmt = num_format.or(style.num_format.as_deref());
    if let Some(nf) = effective_num_fmt {
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
const IMPORT_WORKSHEET_XML_CAP_BYTES: u64 = WORKSHEET_SCAN_CAP_BYTES;
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
/// Scans for the marker while skipping over `<!-- ... -->` comment regions so
/// a literal `<conditionalFormatting` sitting inside an XML comment doesn't
/// produce a false-positive warning (see `medium-cf-comment-falsepositive`
/// in docs/TODOS.md).
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
    // markers (and comment delimiters) that span the chunk boundary. We always
    // walk the joined `(overlap || new)` window from its beginning so the
    // byte-level state machine cleanly handles a `<!--` that opens in chunk N
    // and closes in chunk N+1.
    let mut overlap: Vec<u8> = Vec::with_capacity(WORKSHEET_SCAN_OVERLAP);
    // Mirror of `in_comment` AT THE START of `overlap` (i.e., the state to
    // restore when we re-walk the overlap on the next iteration). Updating
    // this in lock-step with the overlap tail keeps the walker idempotent
    // over the overlapped bytes.
    let mut in_comment_at_overlap_start = false;
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
        let prev_overlap_len = overlap.len();
        let mut window: Vec<u8> = Vec::with_capacity(prev_overlap_len + n);
        window.extend_from_slice(&overlap);
        window.extend_from_slice(&buf[..n]);

        let mut in_comment = in_comment_at_overlap_start;
        // Walking the prefix (the previous overlap) is what makes boundary-
        // straddling markers detectable; the in-comment state at the START of
        // the overlap is what we restore from, so the transitions inside the
        // overlap reproduce the exact same outcome as last time.
        if find_marker_outside_comments(&window, 0, marker, &mut in_comment) {
            return Ok((true, false));
        }

        // Compute the in_comment state at the START of the next overlap, i.e.
        // at position `window.len() - keep` in the window we just walked.
        let keep = window.len().min(WORKSHEET_SCAN_OVERLAP);
        let next_overlap_start = window.len() - keep;
        let mut probe = in_comment_at_overlap_start;
        // Re-walk just up to next_overlap_start to recover the in_comment
        // state at that position. (Cheap: `next_overlap_start <= 64KiB`.)
        find_marker_outside_comments(&window[..next_overlap_start], 0, &[], &mut probe);
        in_comment_at_overlap_start = probe;

        overlap.clear();
        overlap.extend_from_slice(&window[next_overlap_start..]);

        if total_read >= WORKSHEET_SCAN_CAP_BYTES {
            cap_hit = true;
            break;
        }
    }

    Ok((false, cap_hit))
}

/// Walk `haystack[start..]`, tracking `<!-- ... -->` regions across calls via
/// `in_comment`, and report whether `marker` appears outside any comment.
/// Pass an empty `marker` to use this purely as a state-update walker (no
/// match attempts). Comments inside CDATA are rare enough in worksheet XML
/// that we don't special-case them.
fn find_marker_outside_comments(
    haystack: &[u8],
    start: usize,
    marker: &[u8],
    in_comment: &mut bool,
) -> bool {
    let open = b"<!--";
    let close = b"-->";
    let mut i = start;
    while i < haystack.len() {
        if *in_comment {
            // Look for "-->" ending the comment.
            if i + close.len() <= haystack.len() && &haystack[i..i + close.len()] == close {
                *in_comment = false;
                i += close.len();
            } else {
                i += 1;
            }
            continue;
        }
        // Not in a comment: check comment open, then marker.
        if i + open.len() <= haystack.len() && &haystack[i..i + open.len()] == open {
            *in_comment = true;
            i += open.len();
            continue;
        }
        if !marker.is_empty()
            && i + marker.len() <= haystack.len()
            && &haystack[i..i + marker.len()] == marker
        {
            return true;
        }
        i += 1;
    }
    false
}

/// Inspects the ZIP for unsupported feature directories and returns a list of
/// CompatibilityWarning entries describing what will be silently dropped on
/// save-back. Pure-Rust: takes the path so it's testable from cargo test.
/// Public wrapper: opens the file as a zip and delegates. Kept for tests and
/// any external caller that doesn't already have a shared archive in hand.
/// The hot import path uses `detect_unsupported_features_in` directly so it
/// can reuse the already-open archive.
pub fn detect_unsupported_features(path: &str) -> Result<Vec<CompatibilityWarning>, String> {
    use std::fs::File;
    use std::io::BufReader;
    use zip::ZipArchive;
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;
    detect_unsupported_features_in(&mut archive)
}

pub fn detect_unsupported_features_in<R: std::io::Read + std::io::Seek>(
    mut archive: &mut zip::ZipArchive<R>,
) -> Result<Vec<CompatibilityWarning>, String> {
    let mut has_charts = false;
    let mut has_pivot = false;
    let mut has_external_links = false;
    let mut has_vba = false;
    let mut has_embeddings = false;
    let mut has_drawings = false;
    let mut has_form_controls = false;
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
        if name.starts_with("xl/ctrlProps/") {
            has_form_controls = true;
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
            message:
                "ピボットテーブルが含まれていますが、Coco では保持されません。保存時に失われます。"
                    .to_string(),
            affected_sheets: None,
        });
    }
    if has_external_links {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_EXTERNAL_LINKS_DISCARDED".to_string(),
            message: "外部ブックへのリンクが含まれています。キャッシュ値は保持されますが、Coco では外部ブックの自動取得は行いません。".to_string(),
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
            message: "埋め込みオブジェクト（OLE 等）が含まれていますが、Coco では保持されません。"
                .to_string(),
            affected_sheets: None,
        });
    }
    if has_drawings {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_DRAWINGS_DISCARDED".to_string(),
            message: "図形・画像が含まれていますが、Coco では保持されません。保存時に失われます。"
                .to_string(),
            affected_sheets: None,
        });
    }
    if has_form_controls {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_FORM_CONTROLS_NOT_RENDERED".to_string(),
            message: "フォームコントロール（チェックボックス・ラジオボタン・スピンボタン等）が検出されましたが、Coco では Excel の装飾として再現されません。リンクされたセルの値は読み込まれます。".to_string(),
            affected_sheets: None,
        });
    }
    if has_conditional_formatting {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_CONDITIONAL_FORMATTING".to_string(),
            message: "条件付き書式が検出されました。Coco では編集できず、保存時に失われます。"
                .to_string(),
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
fn parse_sheet_path_map_from_archive<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();

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

fn parse_sheet_path_map(archive_bytes: &[u8]) -> HashMap<String, String> {
    use std::io::Cursor;
    use zip::ZipArchive;

    let Ok(mut archive) = ZipArchive::new(Cursor::new(archive_bytes)) else {
        return HashMap::new();
    };

    parse_sheet_path_map_from_archive(&mut archive)
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
#[allow(dead_code)]
pub(crate) fn parse_xlsx_dimensions(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, SheetDimensions> {
    let mut out: HashMap<String, SheetDimensions> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        let dims = parse_sheet_dimensions_xml(xml);
        if !dims.columns.is_empty() || !dims.rows.is_empty() {
            out.insert(sheet_name.clone(), dims);
        }
    }

    out
}

/// Per-sheet print / page-setup metadata parsed from the worksheet XML. Each
/// field is optional so the snapshot can omit them entirely when the source
/// file declared no non-default values. See OOXML's `<pageSetup>`,
/// `<pageMargins>`, `<printOptions>`, `<headerFooter>`, and `<sheetView>`.
#[derive(Debug, Default, Clone)]
pub(crate) struct SheetPageSetup {
    pub orientation: Option<String>, // "portrait" | "landscape"
    pub paper_size: Option<u8>,
    pub scale: Option<u32>,
    pub fit_to_width: Option<u32>,
    pub fit_to_height: Option<u32>,
    pub margin_left: Option<f64>,
    pub margin_right: Option<f64>,
    pub margin_top: Option<f64>,
    pub margin_bottom: Option<f64>,
    pub margin_header: Option<f64>,
    pub margin_footer: Option<f64>,
    pub print_gridlines: Option<bool>,
    pub print_headings: Option<bool>,
    pub header: Option<String>,
    pub footer: Option<String>,
    pub show_gridlines: Option<bool>,
    pub zoom_scale: Option<u32>,
}

impl SheetPageSetup {
    fn is_empty(&self) -> bool {
        self.orientation.is_none()
            && self.paper_size.is_none()
            && self.scale.is_none()
            && self.fit_to_width.is_none()
            && self.fit_to_height.is_none()
            && self.margin_left.is_none()
            && self.margin_right.is_none()
            && self.margin_top.is_none()
            && self.margin_bottom.is_none()
            && self.margin_header.is_none()
            && self.margin_footer.is_none()
            && self.print_gridlines.is_none()
            && self.print_headings.is_none()
            && self.header.is_none()
            && self.footer.is_none()
            && self.show_gridlines.is_none()
            && self.zoom_scale.is_none()
    }
}

/// Find the opening tag for `name` in `xml` (e.g. `<pageSetup ... />` or
/// `<pageSetup ...>`) and return its attribute substring as `&str`. Returns
/// `None` when the tag is absent. Tolerates both self-closing and paired forms.
fn find_opening_tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("<{name}");
    let start = xml.find(&needle)?;
    // The char immediately after the name must be whitespace, '/', or '>'.
    // This rejects e.g. `<pageSetupPr` when searching for `<pageSetup`.
    let after = xml.as_bytes().get(start + needle.len()).copied()?;
    if !(after == b' '
        || after == b'\t'
        || after == b'\r'
        || after == b'\n'
        || after == b'/'
        || after == b'>')
    {
        // Probe further along the string for a non-prefix match.
        let mut cursor = start + needle.len();
        loop {
            let rest = xml.get(cursor..)?;
            let rel = rest.find(&needle)?;
            let abs = cursor + rel;
            let after2 = xml.as_bytes().get(abs + needle.len()).copied()?;
            if after2 == b' '
                || after2 == b'\t'
                || after2 == b'\r'
                || after2 == b'\n'
                || after2 == b'/'
                || after2 == b'>'
            {
                let end = xml[abs..].find('>')? + abs;
                return Some(&xml[abs..=end]);
            }
            cursor = abs + needle.len();
        }
    }
    let end = xml[start..].find('>')? + start;
    Some(&xml[start..=end])
}

/// Extract the text content of a `<headerFooter><oddHeader>...</oddHeader>...`
/// child. Tolerates the OOXML CDATA wrapper used for header/footer strings.
fn extract_hf_child(block: &str, child: &str) -> Option<String> {
    let open = format!("<{child}");
    let close = format!("</{child}>");
    let start = block.find(&open)?;
    let body_start = block[start..].find('>')? + start + 1;
    let body_end = block[body_start..].find(&close)? + body_start;
    let body = &block[body_start..body_end];
    // Strip optional CDATA wrapper.
    let trimmed = body.trim();
    let unwrapped = if trimmed.starts_with("<![CDATA[") && trimmed.ends_with("]]>") {
        &trimmed[9..trimmed.len() - 3]
    } else {
        trimmed
    };
    if unwrapped.is_empty() {
        None
    } else {
        Some(decode_xml_entities(unwrapped))
    }
}

/// Parse the print / page-setup fields out of one sheet's XML.
fn parse_sheet_page_setup_xml(xml: &str) -> SheetPageSetup {
    let mut ps = SheetPageSetup::default();

    // --- <sheetView showGridLines="0" zoomScale="125" .../> ---
    if let Some(tag) = find_opening_tag(xml, "sheetView") {
        if let Some(v) = extract_attr(tag, "showGridLines") {
            // OOXML default is true; only record explicit "0".
            if v == "0" {
                ps.show_gridlines = Some(false);
            } else if v == "1" {
                ps.show_gridlines = Some(true);
            }
        }
        if let Some(z) = extract_attr(tag, "zoomScale").and_then(|s| s.parse::<u32>().ok()) {
            if z != 100 {
                ps.zoom_scale = Some(z);
            }
        }
    }

    // --- <pageSetup orientation="landscape" paperSize="9" scale="80"
    //                fitToWidth="1" fitToHeight="0" .../> ---
    if let Some(tag) = find_opening_tag(xml, "pageSetup") {
        if let Some(o) = extract_attr(tag, "orientation") {
            if o == "portrait" || o == "landscape" {
                ps.orientation = Some(o);
            }
        }
        ps.paper_size = extract_attr(tag, "paperSize").and_then(|s| s.parse::<u8>().ok());
        ps.scale = extract_attr(tag, "scale").and_then(|s| s.parse::<u32>().ok());
        ps.fit_to_width = extract_attr(tag, "fitToWidth").and_then(|s| s.parse::<u32>().ok());
        ps.fit_to_height = extract_attr(tag, "fitToHeight").and_then(|s| s.parse::<u32>().ok());
    }

    // --- <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/> ---
    if let Some(tag) = find_opening_tag(xml, "pageMargins") {
        ps.margin_left = extract_attr(tag, "left").and_then(|s| s.parse::<f64>().ok());
        ps.margin_right = extract_attr(tag, "right").and_then(|s| s.parse::<f64>().ok());
        ps.margin_top = extract_attr(tag, "top").and_then(|s| s.parse::<f64>().ok());
        ps.margin_bottom = extract_attr(tag, "bottom").and_then(|s| s.parse::<f64>().ok());
        ps.margin_header = extract_attr(tag, "header").and_then(|s| s.parse::<f64>().ok());
        ps.margin_footer = extract_attr(tag, "footer").and_then(|s| s.parse::<f64>().ok());
    }

    // --- <printOptions gridLines="1" headings="1"/> ---
    if let Some(tag) = find_opening_tag(xml, "printOptions") {
        if let Some(v) = extract_attr(tag, "gridLines") {
            ps.print_gridlines = Some(v == "1" || v == "true");
        }
        if let Some(v) = extract_attr(tag, "headings") {
            ps.print_headings = Some(v == "1" || v == "true");
        }
    }

    // --- <headerFooter><oddHeader>...</oddHeader><oddFooter>...</oddFooter></headerFooter> ---
    if let (Some(s), Some(e)) = (xml.find("<headerFooter"), xml.find("</headerFooter>")) {
        if e > s {
            let block = &xml[s..e];
            ps.header = extract_hf_child(block, "oddHeader");
            ps.footer = extract_hf_child(block, "oddFooter");
        }
    }

    ps
}

/// Parse per-sheet print / page-setup metadata out of an xlsx. Returns a map
/// keyed by sheet name. Returns an empty map on I/O or parse errors — page
/// setup is best-effort decoration, not load-bearing.
#[allow(dead_code)]
pub(crate) fn parse_xlsx_page_setup(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, SheetPageSetup> {
    let mut out: HashMap<String, SheetPageSetup> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        let ps = parse_sheet_page_setup_xml(xml);
        if !ps.is_empty() {
            out.insert(sheet_name.clone(), ps);
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
#[allow(dead_code)]
pub(crate) fn parse_xlsx_merges(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, Vec<(u32, u32, u32, u32)>> {
    let mut out: HashMap<String, Vec<(u32, u32, u32, u32)>> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        let merges = parse_sheet_merge_cells(xml);
        if !merges.is_empty() {
            out.insert(sheet_name.clone(), merges);
        }
    }

    out
}

/// Extract the tab color (if any) from a worksheet's XML. Excel stores it as
/// `<sheetPr><tabColor rgb="FFRRGGBB"/></sheetPr>`. Returns a "#RRGGBB" string
/// when present; `None` when the sheet has no tab color set.
fn parse_sheet_tab_color(xml: &str) -> Option<String> {
    let pr = extract_block(xml, "<sheetPr", "</sheetPr>")?;
    // tabColor is always self-closing in practice. Locate its opening tag and
    // read the rgb attr.
    let open_idx = pr.find("<tabColor")?;
    let head_end = pr[open_idx..].find('>')? + open_idx + 1;
    let head = &pr[open_idx..head_end];
    let rgb = parse_attr(head, "rgb")?;
    let normalized = normalize_argb(rgb);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Extract the auto-filter range (if any) from a worksheet's XML. Excel stores
/// it as `<autoFilter ref="A1:E10"/>`. Returns the raw ref string (e.g.
/// "A1:E10") when present; `None` when the sheet has no auto-filter.
fn parse_sheet_auto_filter(xml: &str) -> Option<String> {
    let open_idx = xml.find("<autoFilter")?;
    let head_end = xml[open_idx..].find('>')? + open_idx + 1;
    let head = &xml[open_idx..head_end];
    let reference = parse_attr(head, "ref")?;
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Parse per-sheet tab colors out of an xlsx. Returns a map keyed by sheet name
/// — sheets without a tab color are simply absent from the map. Best-effort:
/// returns an empty map on any I/O / structure error.
#[allow(dead_code)]
pub(crate) fn parse_xlsx_tab_colors(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        if let Some(color) = parse_sheet_tab_color(xml) {
            out.insert(sheet_name.clone(), color);
        }
    }

    out
}

/// Parse per-sheet auto-filter ranges out of an xlsx. Returns a map keyed by
/// sheet name — sheets without an auto-filter are simply absent. Best-effort:
/// returns an empty map on any I/O / structure error.
#[allow(dead_code)]
pub(crate) fn parse_xlsx_auto_filters(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        if let Some(reference) = parse_sheet_auto_filter(xml) {
            out.insert(sheet_name.clone(), reference);
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

        let validation_type = parse_attr(head, "type")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();
        let operator = parse_attr(head, "operator")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();

        let bool_attr = |name: &str| -> bool {
            parse_attr(head, name)
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false)
        };
        let allow_blank = bool_attr("allowBlank");
        let show_error_message = bool_attr("showErrorMessage");
        let show_input_message = bool_attr("showInputMessage");
        let error_style = parse_attr(head, "errorStyle")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();
        let error_title = parse_attr(head, "errorTitle")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();
        let error_message = parse_attr(head, "error")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();
        let prompt_title = parse_attr(head, "promptTitle")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();
        let prompt_message = parse_attr(head, "prompt")
            .map(|s| decode_xml_entities(&s))
            .unwrap_or_default();

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
#[allow(dead_code)]
pub(crate) fn parse_xlsx_data_validations(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, Vec<DataValidationEntry>> {
    let mut out: HashMap<String, Vec<DataValidationEntry>> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        let dvs = parse_sheet_data_validations(xml);
        if !dvs.is_empty() {
            out.insert(sheet_name.clone(), dvs);
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
fn parse_sheet_hyperlinks(xml: &str, rels: &HashMap<String, String>) -> Vec<HyperlinkEntry> {
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

fn read_sheet_rels<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_entry_path: &str,
) -> HashMap<String, String> {
    sheet_rels_path(sheet_entry_path)
        .and_then(|rels_path| {
            let mut s = String::new();
            archive
                .by_name(&rels_path)
                .ok()?
                .read_to_string(&mut s)
                .ok()?;
            Some(parse_rels(&s))
        })
        .unwrap_or_default()
}

fn parse_sheet_drawing_rid(xml: &str) -> Option<String> {
    xml.find("<drawing")
        .map(|s| &xml[s..])
        .and_then(|chunk| chunk.find("/>").map(|e| &chunk[..e]))
        .and_then(|tag| parse_attr(tag, "r:id"))
}

/// Parse per-sheet hyperlinks out of an xlsx, joining each sheet's
/// `<hyperlinks>` block with its dedicated rels file. Returns a map keyed by
/// sheet name. Empty map on I/O / structure error — hyperlinks are best-effort
/// metadata, same policy as merges and data validations.
#[allow(dead_code)]
pub(crate) fn parse_xlsx_hyperlinks<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_paths: &HashMap<String, String>,
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, Vec<HyperlinkEntry>> {
    let mut out: HashMap<String, Vec<HyperlinkEntry>> = HashMap::new();
    for (sheet_name, entry_path) in sheet_paths {
        let Some(xml) = sheet_xmls.get(sheet_name) else {
            continue;
        };
        // Fast path: most workbooks have no hyperlinks. Skip the rels lookup
        // entirely when the sheet body carries no `<hyperlinks>` block — this
        // is by far the common case and saves a per-sheet zip entry lookup.
        if !xml.contains("<hyperlinks") {
            continue;
        }
        // Read the per-sheet rels file (may be absent — internal-only links).
        let rels = read_sheet_rels(archive, entry_path);

        let links = parse_sheet_hyperlinks(xml, &rels);
        if !links.is_empty() {
            out.insert(sheet_name.clone(), links);
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
        let author_id: Option<usize> = parse_attr(head, "authorId").and_then(|s| s.parse().ok());
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
            text.strip_prefix(&prefix)
                .map(|s| s.to_string())
                .unwrap_or(text)
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
    // #90: dedup authors in O(N) via a HashMap that also remembers each
    // author's stable index — `commentList` below needs to look up the id by
    // name. Previously both the `any` walk above and the `position` walk
    // below were O(N), giving an overall O(N²) export.
    let mut authors: Vec<String> = Vec::new();
    let mut author_index: HashMap<String, usize> = HashMap::new();
    for (_, author, _) in notes {
        let name = if author.is_empty() {
            "Author".to_string()
        } else {
            author.clone()
        };
        if !author_index.contains_key(&name) {
            author_index.insert(name.clone(), authors.len());
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
        let display_author = if author.is_empty() {
            "Author"
        } else {
            author.as_str()
        };
        // #90: HashMap lookup instead of linear scan.
        let author_id = author_index.get(display_author).copied().unwrap_or(0);
        let _ = write!(
            out,
            "<comment ref=\"{}\" authorId=\"{}\"><text>",
            encode_xml_text(cell),
            author_id
        );
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
            // #80: strip XML 1.0 illegal control characters. NUL and other
            // C0 controls (except TAB / LF / CR) are not legal in any XML
            // document — leaving them in `<t>` cells produces a comments.xml
            // that Excel rejects with "file is corrupt" on open. Replace with
            // U+FFFD so the cell stays present but no longer invalidates the
            // whole package.
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || (c as u32) == 0x7F => out.push('\u{FFFD}'),
            _ => out.push(c),
        }
    }
    out
}

/// One sheet's split-pane spec, captured during the rust_xlsxwriter pass and
/// applied to the saved worksheet XML by `rewrite_split_panes_in_zip`.
#[derive(Debug, Clone)]
struct SplitPaneSpec {
    /// Worksheet name (after sanitization), used to locate `xl/worksheets/sheetN.xml`.
    sheet_name: String,
    /// Raw `xSplit` value to emit (pixel / twip offset, NOT a column index).
    x_split: u64,
    /// Raw `ySplit` value to emit (pixel / twip offset, NOT a row index).
    y_split: u64,
    /// Optional `topLeftCell` (A1) — preserved verbatim from the source.
    top_left: Option<String>,
}

/// Post-save zip rewrite: for each sheet flagged as split-pane, replace the
/// `<pane .../>` element rust_xlsxwriter wrote (always `state="frozen"`) with
/// a `state="split"` variant carrying the snapshot's original xSplit/ySplit
/// pixel offsets and topLeftCell. No-op when `specs` is empty.
fn rewrite_split_panes_in_zip(
    xlsx_path: &std::path::Path,
    specs: &[SplitPaneSpec],
) -> Result<(), String> {
    use std::io::{Cursor, Read, Write};

    if specs.is_empty() {
        return Ok(());
    }

    let bytes = std::fs::read(xlsx_path).map_err(|e| format!("read xlsx: {e}"))?;
    let sheet_paths = parse_sheet_path_map(&bytes);
    let mut archive =
        zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|e| format!("open xlsx zip: {e}"))?;

    // Build entry-path -> new XML map for sheets that need a split-pane swap.
    let mut replacements: HashMap<String, Vec<u8>> = HashMap::new();
    for spec in specs {
        let Some(entry_path) = sheet_paths.get(&spec.sheet_name) else {
            continue;
        };
        let mut xml = String::new();
        match archive.by_name(entry_path) {
            Ok(mut e) => {
                if e.read_to_string(&mut xml).is_err() {
                    continue;
                }
            }
            Err(_) => continue,
        }
        // Locate the `<pane ... />` self-closing tag inside the first
        // <sheetView>. rust_xlsxwriter writes one per sheet when freeze_panes
        // is set, always with `state="frozen"`. We swap the whole tag.
        let Some(start) = xml.find("<pane ") else {
            continue;
        };
        let Some(end_rel) = xml[start..].find("/>") else {
            continue;
        };
        let end = start + end_rel + 2;
        // Replicate rust_xlsxwriter's attribute order so diffs stay minimal:
        // xSplit, ySplit, topLeftCell, activePane, state.
        let top_left = spec.top_left.clone().unwrap_or_else(|| "A1".to_string());
        let new_pane = format!(
            r#"<pane xSplit="{x}" ySplit="{y}" topLeftCell="{tl}" activePane="bottomRight" state="split"/>"#,
            x = spec.x_split,
            y = spec.y_split,
            tl = top_left,
        );
        let mut new_xml = String::with_capacity(xml.len() + new_pane.len());
        new_xml.push_str(&xml[..start]);
        new_xml.push_str(&new_pane);
        new_xml.push_str(&xml[end..]);
        replacements.insert(entry_path.clone(), new_xml.into_bytes());
    }

    if replacements.is_empty() {
        return Ok(());
    }

    let mut out_buf: Vec<u8> = Vec::with_capacity(bytes.len());
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut out_buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("read entry {i}: {e}"))?;
            let name = entry.name().to_string();
            writer
                .start_file(name.clone(), opts)
                .map_err(|e| format!("start_file: {e}"))?;
            if let Some(replacement) = replacements.get(&name) {
                writer
                    .write_all(replacement)
                    .map_err(|e| format!("write: {e}"))?;
            } else {
                let mut data = Vec::new();
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("read: {e}"))?;
                writer.write_all(&data).map_err(|e| format!("write: {e}"))?;
            }
        }
        writer.finish().map_err(|e| format!("zip finish: {e}"))?;
    }

    std::fs::write(xlsx_path, &out_buf).map_err(|e| format!("write xlsx: {e}"))?;
    Ok(())
}

/// Post-save zip rewrite: splice extra `<conditionalFormatting>` blocks into
/// per-sheet XML for CF rule types rust_xlsxwriter can't emit (colorScale,
/// dataBar, iconSet). Each entry is one cfRule's verbatim XML keyed by sqref;
/// rules sharing the same sheet+sqref are coalesced into a single
/// `<conditionalFormatting sqref="...">...</conditionalFormatting>` element.
///
/// Insertion point: per OOXML schema, `<conditionalFormatting>` must precede
/// `<pageMargins>` / `<pageSetup>` / `<headerFooter>` / `<drawing>` /
/// `<tableParts>` / `<extLst>` / `</worksheet>`. We find the earliest of
/// those and inject right before it. If an existing `</conditionalFormatting>`
/// is present (the typed CF path emitted one) we insert immediately after to
/// keep the blocks contiguous.
fn rewrite_extra_cf_in_zip(
    xlsx_path: &std::path::Path,
    extras: &[(String, String, String)],
) -> Result<(), String> {
    use std::io::{Cursor, Read, Write};

    if extras.is_empty() {
        return Ok(());
    }

    let bytes = std::fs::read(xlsx_path).map_err(|e| format!("read xlsx: {e}"))?;
    let sheet_paths = parse_sheet_path_map(&bytes);
    let mut archive =
        zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|e| format!("open xlsx zip: {e}"))?;

    // Group: sheet_name -> Vec<(sqref, raw_cfRule_xml)>
    let mut by_sheet: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (sheet_name, sqref, raw) in extras {
        by_sheet
            .entry(sheet_name.clone())
            .or_default()
            .push((sqref.clone(), raw.clone()));
    }

    let mut replacements: HashMap<String, Vec<u8>> = HashMap::new();
    for (sheet_name, items) in &by_sheet {
        let Some(entry_path) = sheet_paths.get(sheet_name) else {
            continue;
        };
        let mut xml = String::new();
        match archive.by_name(entry_path) {
            Ok(mut e) => {
                if e.read_to_string(&mut xml).is_err() {
                    continue;
                }
            }
            Err(_) => continue,
        }

        // Coalesce by sqref so all cfRules sharing a range live in one
        // <conditionalFormatting> block (Excel accepts split blocks too, but
        // a single block keeps the file tidier).
        let mut by_sqref: Vec<(String, Vec<String>)> = Vec::new();
        for (sqref, raw) in items {
            if let Some(slot) = by_sqref.iter_mut().find(|(s, _)| s == sqref) {
                slot.1.push(raw.clone());
            } else {
                by_sqref.push((sqref.clone(), vec![raw.clone()]));
            }
        }

        let mut blocks = String::new();
        for (sqref, raws) in &by_sqref {
            blocks.push_str(&format!(
                r#"<conditionalFormatting sqref="{}">"#,
                encode_xml_text(sqref)
            ));
            for r in raws {
                blocks.push_str(r);
            }
            blocks.push_str("</conditionalFormatting>");
        }

        // Pick insertion point. Prefer right after an existing
        // </conditionalFormatting>; otherwise before the earliest of the
        // post-CF elements; otherwise before </worksheet>.
        let insert_at = if let Some(p) = xml.rfind("</conditionalFormatting>") {
            Some(p + "</conditionalFormatting>".len())
        } else {
            let candidates = [
                "<pageMargins",
                "<pageSetup",
                "<headerFooter",
                "<rowBreaks",
                "<colBreaks",
                "<drawing",
                "<legacyDrawing",
                "<tableParts",
                "<extLst",
                "</worksheet>",
            ];
            candidates
                .iter()
                .filter_map(|needle| xml.find(needle))
                .min()
        };

        let Some(pos) = insert_at else {
            continue;
        };
        let mut new_xml = String::with_capacity(xml.len() + blocks.len());
        new_xml.push_str(&xml[..pos]);
        new_xml.push_str(&blocks);
        new_xml.push_str(&xml[pos..]);
        replacements.insert(entry_path.clone(), new_xml.into_bytes());
    }

    if replacements.is_empty() {
        return Ok(());
    }

    let mut out_buf: Vec<u8> = Vec::with_capacity(bytes.len());
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut out_buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("read entry {i}: {e}"))?;
            let name = entry.name().to_string();
            writer
                .start_file(name.clone(), opts)
                .map_err(|e| format!("start_file: {e}"))?;
            if let Some(replacement) = replacements.get(&name) {
                writer
                    .write_all(replacement)
                    .map_err(|e| format!("write: {e}"))?;
            } else {
                let mut data = Vec::new();
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("read: {e}"))?;
                writer.write_all(&data).map_err(|e| format!("write: {e}"))?;
            }
        }
        writer.finish().map_err(|e| format!("zip finish: {e}"))?;
    }

    std::fs::write(xlsx_path, &out_buf).map_err(|e| format!("write xlsx: {e}"))?;
    Ok(())
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
    let mut archive =
        zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|e| format!("open xlsx zip: {e}"))?;

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
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("read entry {i}: {e}"))?;
            let name = entry.name().to_string();
            writer
                .start_file(name.clone(), opts)
                .map_err(|e| format!("start_file: {e}"))?;
            if let Some(replacement) = replacements.get(&name) {
                writer
                    .write_all(replacement)
                    .map_err(|e| format!("write: {e}"))?;
            } else {
                let mut data = Vec::new();
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("read: {e}"))?;
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
pub(crate) fn parse_xlsx_comments<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_paths: &HashMap<String, String>,
) -> HashMap<String, Vec<CommentEntry>> {
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
                    out.insert(sheet_name.clone(), entries);
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
    let formula1 = entry.get("formula1").and_then(|v| v.as_str()).unwrap_or("");
    let formula2 = entry.get("formula2").and_then(|v| v.as_str()).unwrap_or("");
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
/// sqref). Round-trips rule shape + visual format (dxf-referenced bold / font
/// color / fill color) through the snapshot for re-export.
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
    /// `cfRule@rank` for `top10` rules. 0 = unset (defaults to 10 on export).
    pub rank: u16,
    /// `cfRule@percent="1"` flag for `top10` rules — switches Top/Bottom to
    /// TopPercent/BottomPercent.
    pub percent: bool,
    /// `cfRule@bottom="1"` flag for `top10` rules — switches Top to Bottom.
    pub bottom: bool,
    /// `aboveAverage` rules: `cfRule@aboveAverage="0"` means below-average.
    /// OOXML default (absent or `="1"`) is above-average → `below=false`.
    pub below: bool,
    /// `aboveAverage` rules: `cfRule@equalAverage="1"` switches the rule to
    /// include the average itself (At-Or-Above / At-Or-Below variants).
    pub equal_average: bool,
    /// `timePeriod` rules: `cfRule@timePeriod` literal ("today", "yesterday",
    /// "last7Days", etc). Empty for non-`timePeriod` rules.
    pub time_period: String,
    /// Verbatim `<cfRule>...</cfRule>` source for rule types that can't be
    /// reconstructed through rust_xlsxwriter's typed CF API (currently
    /// `colorScale`, `dataBar`, `iconSet`). Empty for rules that round-trip
    /// via the typed fields above. When non-empty, the export side splices
    /// this back into the sheet XML verbatim inside a
    /// `<conditionalFormatting sqref="...">` block.
    pub raw: String,
    /// #37: visual format hints carried via the rule's `dxfId` → styles.xml
    /// `<dxfs>` table. Populated by `parse_xlsx_conditional_formatting` so
    /// authored & round-tripped rules keep their bold / font-color / bg-color
    /// on re-export through `build_cf_rule_format`. Empty for rules without
    /// a dxf reference.
    pub dxf_style: Option<DxfStyle>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct DxfStyle {
    pub bold: bool,
    pub italic: bool,
    pub font_color: Option<String>, // "#RRGGBB"
    pub bg_color: Option<String>,   // "#RRGGBB"
}

/// Parse one sheet's `<conditionalFormatting>` blocks. Unlike data validations
/// (single block per sheet, multiple children), CF has one block per sqref
/// with one or more `<cfRule>` children — so we scan all matching blocks and
/// flatten the rules into a single Vec.
/// Parse the `<dxfs>` block from `xl/styles.xml`. Each `<dxf>` entry can
/// declare font (bold/italic/color) and fill (bgColor) — we lift the subset
/// the dialog round-trips. Returns dxf entries in declaration order so
/// `dxfId` indexes directly. (#37)
fn parse_dxfs_from_styles(styles_xml: &str) -> Vec<DxfStyle> {
    let mut out = Vec::new();
    let block = match extract_block(styles_xml, "<dxfs", "</dxfs>") {
        Some(b) => b,
        None => return out,
    };
    for dxf_el in extract_self_closing_or_paired(&block, "dxf") {
        let mut dx = DxfStyle::default();
        // <font><b/></font> / <font><i/></font> / <font><color rgb="FFRRGGBB"/></font>
        if let Some(font) = extract_block(&dxf_el, "<font", "</font>") {
            if font.contains("<b/>") || font.contains("<b ") {
                dx.bold = true;
            }
            if font.contains("<i/>") || font.contains("<i ") {
                dx.italic = true;
            }
            if let Some(color_tag) = find_tag(&font, "<color") {
                if let Some(rgb) = parse_attr(&color_tag, "rgb") {
                    if let Some(hex) = normalize_argb_hex(&rgb) {
                        dx.font_color = Some(hex);
                    }
                }
            }
        }
        // <fill><patternFill patternType="solid"><bgColor rgb="..."/></patternFill></fill>
        // — Excel commonly writes bg under <bgColor> for solid dxf fills.
        if let Some(fill) = extract_block(&dxf_el, "<fill", "</fill>") {
            for needle in ["<bgColor", "<fgColor"].iter() {
                if let Some(tag) = find_tag(&fill, needle) {
                    if let Some(rgb) = parse_attr(&tag, "rgb") {
                        if let Some(hex) = normalize_argb_hex(&rgb) {
                            dx.bg_color = Some(hex);
                            break;
                        }
                    }
                }
            }
        }
        out.push(dx);
    }
    out
}

/// Normalize an OOXML ARGB hex (`FFRRGGBB`) to the `#RRGGBB` shape the
/// dialog speaks. Returns None if the input isn't 6 or 8 hex digits.
fn normalize_argb_hex(s: &str) -> Option<String> {
    let cleaned: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let rgb = if cleaned.len() == 8 {
        &cleaned[2..]
    } else if cleaned.len() == 6 {
        &cleaned[..]
    } else {
        return None;
    };
    Some(format!("#{}", rgb.to_ascii_uppercase()))
}

fn parse_sheet_conditional_formatting(
    xml: &str,
    dxfs: &[DxfStyle],
) -> Vec<ConditionalFormattingEntry> {
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
            // #37: capture dxfId and resolve against the dxfs table so the
            // rule's visual format (bold / colors) round-trips on re-export.
            let dxf_style = parse_attr(rule_head, "dxfId")
                .and_then(|s| s.parse::<usize>().ok())
                .and_then(|idx| dxfs.get(idx).cloned());
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
            // `top10` rules carry `rank` (the N), and the flags `percent` and
            // `bottom` to switch between Top/Bottom/TopPercent/BottomPercent.
            // For other rule types these attributes are absent and the defaults
            // (0 / false / false) are harmless.
            let rank = parse_attr(rule_head, "rank")
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);
            let percent = parse_attr(rule_head, "percent")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            let bottom = parse_attr(rule_head, "bottom")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            // `aboveAverage` rules: OOXML semantics are
            //   aboveAverage attr absent OR "1" → above (below = false)
            //   aboveAverage attr "0"           → below (below = true)
            // `equalAverage` similarly: absent or "0" → strict; "1" → include
            // the average. Other rule types don't carry these attributes so
            // the defaults (false / false) are harmless.
            let below = if rule_type == "aboveAverage" {
                parse_attr(rule_head, "aboveAverage")
                    .map(|v| v == "0" || v.eq_ignore_ascii_case("false"))
                    .unwrap_or(false)
            } else {
                false
            };
            let equal_average = if rule_type == "aboveAverage" {
                parse_attr(rule_head, "equalAverage")
                    .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                    .unwrap_or(false)
            } else {
                false
            };
            // `timePeriod` rules carry the named relative range
            // ("today" / "yesterday" / "last7Days" / etc) on cfRule@timePeriod.
            // Preserve verbatim so the export side can map it back.
            let time_period = if rule_type == "timePeriod" {
                parse_attr(rule_head, "timePeriod")
                    .map(|s| decode_xml_entities(&s))
                    .unwrap_or_default()
            } else {
                String::new()
            };

            // For rule types we don't reconstruct via rust_xlsxwriter
            // (colorScale / dataBar / iconSet — all gradient/visual rules),
            // stash the entire <cfRule>...</cfRule> XML so the export side
            // can splice it back verbatim. This preserves the rule end-to-end
            // without needing to model its inner cfvo/color/dataBar/iconSet
            // schemas. Authoring these isn't a goal — preservation is.
            if matches!(rule_type.as_str(), "colorScale" | "dataBar" | "iconSet") {
                out.push(ConditionalFormattingEntry {
                    sqref: sqref.clone(),
                    rule_type,
                    operator: String::new(),
                    formula1: String::new(),
                    formula2: String::new(),
                    text: String::new(),
                    priority,
                    stop_if_true,
                    rank: 0,
                    percent: false,
                    bottom: false,
                    below: false,
                    equal_average: false,
                    time_period: String::new(),
                    raw: rule_el.clone(),
                    // colorScale / dataBar / iconSet carry their own gradient
                    // colors inside the raw block, so we don't lift a dxf
                    // entry here.
                    dxf_style: dxf_style.clone(),
                });
                continue;
            }

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
                rank,
                percent,
                bottom,
                below,
                equal_average,
                time_period,
                raw: String::new(),
                dxf_style,
            });
        }
    }
    out
}

/// Parse per-sheet `<conditionalFormatting>` rules out of an xlsx. Mirrors the
/// data-validation parser: best-effort, empty map on any structural error.
#[allow(dead_code)]
pub(crate) fn parse_xlsx_conditional_formatting(
    sheet_xmls: &HashMap<String, String>,
) -> HashMap<String, Vec<ConditionalFormattingEntry>> {
    // External callers (tests / pre-#37 sites) don't have styles.xml
    // available; pass an empty dxf table so dxf_style is just None.
    let mut out: HashMap<String, Vec<ConditionalFormattingEntry>> = HashMap::new();
    for (sheet_name, xml) in sheet_xmls {
        let rules = parse_sheet_conditional_formatting(xml, &[]);
        if !rules.is_empty() {
            out.insert(sheet_name.clone(), rules);
        }
    }

    out
}

/// Build a rust_xlsxwriter `Format` for a CF rule's `style` bag (see
/// ConditionalFormattingDialog.tsx). The dialog only emits fields that are
/// set; we mirror that here so an empty/missing object yields `None` and the
/// caller skips `.set_format(...)`. When rust_xlsxwriter writes the workbook
/// it lifts this Format into the `<dxfs>` block of `xl/styles.xml` and refers
/// to it via `dxfId` on the cfRule.
///
/// Supported keys: `bold`, `italic`, `fontColor` (#RRGGBB), `bgColor`
/// (#RRGGBB; emitted as a solid pattern fill). Unknown keys are ignored.
fn build_cf_rule_format(style: Option<&Value>) -> Option<Format> {
    let obj = style?.as_object()?;
    let bold = obj.get("bold").and_then(|v| v.as_bool()).unwrap_or(false);
    let italic = obj.get("italic").and_then(|v| v.as_bool()).unwrap_or(false);
    let font_color = obj
        .get("fontColor")
        .and_then(|v| v.as_str())
        .and_then(parse_color);
    let bg_color = obj
        .get("bgColor")
        .and_then(|v| v.as_str())
        .and_then(parse_color);
    if !bold && !italic && font_color.is_none() && bg_color.is_none() {
        return None;
    }
    let mut fmt = Format::new();
    if bold {
        fmt = fmt.set_bold();
    }
    if italic {
        fmt = fmt.set_italic();
    }
    if let Some(c) = font_color {
        fmt = fmt.set_font_color(c);
    }
    if let Some(c) = bg_color {
        fmt = fmt
            .set_background_color(c)
            .set_pattern(FormatPattern::Solid);
    }
    Some(fmt)
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
    // top10 attributes: `rank` (the N), and the `percent`/`bottom` flags that
    // pick which ConditionalFormatTopRule variant to use. Excel's default rank
    // is 10 when the attribute is absent.
    let rank = entry
        .get("rank")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|&n| n > 0)
        .unwrap_or(10);
    let percent = entry
        .get("percent")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let bottom = entry
        .get("bottom")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Optional `style` bag carried by authored rules (see
    // ConditionalFormattingDialog.tsx). We translate the hints into a
    // rust_xlsxwriter `Format`, which the library serializes as an `<dxf>`
    // entry in `xl/styles.xml` and references via `dxfId` on the cfRule. We
    // only build the Format when at least one field is set so unstyled rules
    // stay dxf-free.
    let style_format: Option<Format> = build_cf_rule_format(entry.get("style"));

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
            let mut cf = ConditionalFormatCell::new()
                .set_rule(rule)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            if let Some(f) = style_format {
                cf = cf.set_format(f);
            }
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
            let mut cf = ConditionalFormatText::new()
                .set_rule(rule)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            if let Some(f) = style_format {
                cf = cf.set_format(f);
            }
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        "expression" => {
            if formula1.is_empty() {
                return false;
            }
            let mut cf = ConditionalFormatFormula::new()
                .set_rule(formula1)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            if let Some(f) = style_format {
                cf = cf.set_format(f);
            }
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        "top10" => {
            // Pick the variant from the (percent, bottom) flag pair. Excel
            // encodes all four combinations on the same rule type.
            let rule = match (percent, bottom) {
                (false, false) => ConditionalFormatTopRule::Top(rank),
                (false, true) => ConditionalFormatTopRule::Bottom(rank),
                (true, false) => ConditionalFormatTopRule::TopPercent(rank),
                (true, true) => ConditionalFormatTopRule::BottomPercent(rank),
            };
            let mut cf = ConditionalFormatTop::new()
                .set_rule(rule)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            if let Some(f) = style_format {
                cf = cf.set_format(f);
            }
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        "duplicateValues" | "uniqueValues" => {
            // rust_xlsxwriter exposes one struct for both; `.invert()` switches
            // it from Duplicate to Unique semantics.
            let mut cf = ConditionalFormatDuplicate::new()
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            if rule_type == "uniqueValues" {
                cf = cf.invert();
            }
            if let Some(f) = style_format {
                cf = cf.set_format(f);
            }
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        "aboveAverage" => {
            // #38: dialog stores the two bool toggles under `aboveAverage`.
            // Excel encodes 4 variants on the same rule type via {below,
            // equalAverage} combinations.
            let aa = entry
                .get("aboveAverage")
                .and_then(|v| v.as_object());
            let below = aa
                .and_then(|o| o.get("below"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let equal_average = aa
                .and_then(|o| o.get("equalAverage"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let rule = match (below, equal_average) {
                (false, false) => ConditionalFormatAverageRule::AboveAverage,
                (false, true) => ConditionalFormatAverageRule::EqualOrAboveAverage,
                (true, false) => ConditionalFormatAverageRule::BelowAverage,
                (true, true) => ConditionalFormatAverageRule::EqualOrBelowAverage,
            };
            let mut cf = ConditionalFormatAverage::new()
                .set_rule(rule)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            if let Some(f) = style_format {
                cf = cf.set_format(f);
            }
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        "timePeriod" => {
            // #38: Excel's timePeriod CF rule has a fixed set of named
            // relative ranges (today / yesterday / lastWeek / etc).
            let period = entry
                .get("timePeriod")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rule = match period {
                "today" => Some(ConditionalFormatDateRule::Today),
                "yesterday" => Some(ConditionalFormatDateRule::Yesterday),
                "tomorrow" => Some(ConditionalFormatDateRule::Tomorrow),
                "last7Days" => Some(ConditionalFormatDateRule::Last7Days),
                "thisWeek" => Some(ConditionalFormatDateRule::ThisWeek),
                "lastWeek" => Some(ConditionalFormatDateRule::LastWeek),
                "nextWeek" => Some(ConditionalFormatDateRule::NextWeek),
                "thisMonth" => Some(ConditionalFormatDateRule::ThisMonth),
                "lastMonth" => Some(ConditionalFormatDateRule::LastMonth),
                "nextMonth" => Some(ConditionalFormatDateRule::NextMonth),
                _ => None,
            };
            let Some(rule) = rule else {
                return false;
            };
            let mut cf = ConditionalFormatDate::new()
                .set_rule(rule)
                .set_multi_range(sqref)
                .set_stop_if_true(stop_if_true);
            if let Some(f) = style_format {
                cf = cf.set_format(f);
            }
            worksheet
                .add_conditional_format(first_row, first_col16, last_row, last_col16, &cf)
                .is_ok()
        }
        // colorScale / dataBar / iconSet still require gradient/icon
        // authoring UI that isn't on the dialog yet. When imported from
        // existing xlsx they round-trip via the verbatim raw_xml path
        // (parse_sheet_conditional_formatting line 3319) so files keep
        // their visuals — we just don't generate new rules of these
        // shapes from the Coco dialog.
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
            "notEqual" => Some(DataValidationRule::NotEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "greaterThan" => Some(DataValidationRule::GreaterThan(Formula::new(
                f1_owned.clone(),
            ))),
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
            "notEqual" => Some(DataValidationRule::NotEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "greaterThan" => Some(DataValidationRule::GreaterThan(Formula::new(
                f1_owned.clone(),
            ))),
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
        ("notEqual", Some(a), _) => {
            Some(dv.allow_decimal_number(DataValidationRule::NotEqualTo(a)))
        }
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
            "notEqual" => Some(DataValidationRule::NotEqualTo(Formula::new(
                f1_owned.clone(),
            ))),
            "greaterThan" => Some(DataValidationRule::GreaterThan(Formula::new(
                f1_owned.clone(),
            ))),
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
                requires_save_as_on_first_save: false,
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
                requires_save_as_on_first_save: false,
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

    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to read xlsx: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Invalid xlsx (zip): {e}"))?;
    let sheet_paths = parse_sheet_path_map_from_archive(&mut archive);

    let mut oversized_sheet: Option<(String, u64)> = None;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let zip_path = entry.name().to_string();
        if !zip_path.starts_with("xl/worksheets/") || !zip_path.ends_with(".xml") {
            continue;
        }
        if entry.size() > IMPORT_WORKSHEET_XML_CAP_BYTES {
            let sheet_name = sheet_paths
                .iter()
                .find(|(_, path)| *path == &zip_path)
                .map(|(name, _)| name.clone())
                .unwrap_or(zip_path);
            oversized_sheet = Some((sheet_name, entry.size()));
            break;
        }
    }
    if let Some((sheet_name, size)) = oversized_sheet {
        let empty_snapshot = json!({
            "id": workbook_id,
            "name": "Imported Workbook",
            "appVersion": "0.1.0",
            "locale": "enUS",
            "styles": {},
            "sheetOrder": [],
            "sheets": {},
        });
        let mb = size as f64 / 1024.0 / 1024.0;
        let cap_mb = IMPORT_WORKSHEET_XML_CAP_BYTES as f64 / 1024.0 / 1024.0;
        let mut warnings = prepended_warnings;
        warnings.push(CompatibilityWarning {
            severity: "blocking".to_string(),
            code: "XLSX_WORKSHEET_XML_TOO_LARGE".to_string(),
            message: format!(
                "Worksheet '{sheet_name}' XML is {mb:.1} MB after decompression; limit is {cap_mb:.0} MB."
            ),
            affected_sheets: Some(vec![sheet_name]),
        });
        return Ok(ImportWorkbookResult {
            handle: WorkbookHandle {
                workbook_id,
                path: Some(path),
                source_type: "xlsx".to_string(),
                snapshot_json: Some(
                    serde_json::to_string(&empty_snapshot).map_err(|e| e.to_string())?,
                ),
                requires_save_as_on_first_save: false,
            },
            warnings,
        });
    }

    // Workbook-level XML parts are parsed once. Worksheet XML is streamed one
    // sheet at a time below, then dropped after each sheet's metadata is merged.
    let mut parsed_styles = parse_xlsx_styles(&mut archive).ok();
    let shared_rich_strings = parse_xlsx_shared_rich_text(&mut archive).ok();
    let mut rich_text = shared_rich_strings.as_ref().map(|_| ParsedRichText {
        per_sheet: HashMap::new(),
    });

    let mut data_validations_by_sheet: HashMap<String, Vec<DataValidationEntry>> = HashMap::new();
    let mut conditional_formats_by_sheet: HashMap<String, Vec<ConditionalFormattingEntry>> =
        HashMap::new();
    // #37: read xl/styles.xml's <dxfs> block once so per-sheet CF parsing
    // can resolve dxfId → bold/color hints. Best-effort — empty when the
    // workbook has no styles or no dxfs.
    let dxfs_table: Vec<DxfStyle> = {
        let mut sx = String::new();
        if let Ok(mut entry) = archive.by_name("xl/styles.xml") {
            let _ = entry.read_to_string(&mut sx);
        }
        if sx.is_empty() {
            Vec::new()
        } else {
            parse_dxfs_from_styles(&sx)
        }
    };
    let mut dimensions_by_sheet: HashMap<String, SheetDimensions> = HashMap::new();
    let mut merges_by_sheet: HashMap<String, Vec<(u32, u32, u32, u32)>> = HashMap::new();
    let mut freeze_panes_by_sheet: HashMap<String, FreezePaneEntry> = HashMap::new();
    let mut sheet_protection_by_sheet: HashMap<String, SheetProtectionEntry> = HashMap::new();
    let mut tab_colors_by_sheet: HashMap<String, String> = HashMap::new();
    let mut auto_filters_by_sheet: HashMap<String, String> = HashMap::new();
    let mut hyperlinks_by_sheet: HashMap<String, Vec<HyperlinkEntry>> = HashMap::new();
    let mut page_setup_by_sheet: HashMap<String, SheetPageSetup> = HashMap::new();
    let mut sheet_drawing_rids: HashMap<String, String> = HashMap::new();

    for (sheet_name, zip_path) in &sheet_paths {
        let mut xml = String::new();
        let sheet_read = match archive.by_name(zip_path) {
            Ok(mut entry) => entry.read_to_string(&mut xml).is_ok(),
            Err(_) => false,
        };
        if !sheet_read {
            continue;
        }

        let dvs = parse_sheet_data_validations(&xml);
        if !dvs.is_empty() {
            data_validations_by_sheet.insert(sheet_name.clone(), dvs);
        }

        let cfs = parse_sheet_conditional_formatting(&xml, &dxfs_table);
        if !cfs.is_empty() {
            conditional_formats_by_sheet.insert(sheet_name.clone(), cfs);
        }

        if let Some(ps) = parsed_styles.as_mut() {
            let cell_map = parse_sheet_cell_styles(&xml);
            if !cell_map.is_empty() {
                ps.per_sheet.insert(sheet_name.clone(), cell_map);
            }
        }

        let dims = parse_sheet_dimensions_xml(&xml);
        if !dims.columns.is_empty() || !dims.rows.is_empty() {
            dimensions_by_sheet.insert(sheet_name.clone(), dims);
        }

        let merges = parse_sheet_merge_cells(&xml);
        if !merges.is_empty() {
            merges_by_sheet.insert(sheet_name.clone(), merges);
        }

        if let Some(fp) = parse_sheet_freeze_pane(&xml) {
            freeze_panes_by_sheet.insert(sheet_name.clone(), fp);
        }

        if let Some(sp) = parse_sheet_protection(&xml) {
            sheet_protection_by_sheet.insert(sheet_name.clone(), sp);
        }

        if let Some(color) = parse_sheet_tab_color(&xml) {
            tab_colors_by_sheet.insert(sheet_name.clone(), color);
        }

        if let Some(reference) = parse_sheet_auto_filter(&xml) {
            auto_filters_by_sheet.insert(sheet_name.clone(), reference);
        }

        if xml.contains("<hyperlinks") {
            let rels = read_sheet_rels(&mut archive, zip_path);
            let links = parse_sheet_hyperlinks(&xml, &rels);
            if !links.is_empty() {
                hyperlinks_by_sheet.insert(sheet_name.clone(), links);
            }
        }

        if let (Some(shared), Some(rt)) = (shared_rich_strings.as_ref(), rich_text.as_mut()) {
            let map = parse_sheet_rich_text(&xml, shared);
            if !map.is_empty() {
                rt.per_sheet.insert(sheet_name.clone(), map);
            }
        }

        let page_setup = parse_sheet_page_setup_xml(&xml);
        if !page_setup.is_empty() {
            page_setup_by_sheet.insert(sheet_name.clone(), page_setup);
        }

        if let Some(rid) = parse_sheet_drawing_rid(&xml) {
            sheet_drawing_rids.insert(sheet_name.clone(), rid);
        }
    }

    let mut feature_warnings = detect_unsupported_features_in(&mut archive).unwrap_or_default();
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

    // Pre-parse workbook-level sheet visibility (`state="hidden"` / `"veryHidden"`).
    let sheet_visibility = parse_xlsx_sheet_visibility(&mut archive);
    // Pre-parse per-sheet cell comments / notes. Each sheet's rels file points
    // to its `xl/commentsN.xml`; we read author + plain text and stash on the
    // snapshot for re-emission via rust_xlsxwriter's insert_note on export.
    let comments_by_sheet = parse_xlsx_comments(&mut archive, &sheet_paths);

    let mut wb: Xlsx<_> = open_workbook(&path).map_err(|e| format!("Failed to open xlsx: {e}"))?;

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
                    .and_then(
                        |s: &String| {
                            if s.is_empty() {
                                None
                            } else {
                                Some(s.clone())
                            }
                        },
                    );

                // Look up the xf index for this cell once; reuse it for both
                // the visual style id and the number-format string.
                let xf_idx: Option<usize> =
                    sheet_style_lookup.and_then(|m| m.get(&(abs_r, abs_c)).copied());

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

        // Per-sheet tab color. Opt-in: omit `_tabColor` when the source sheet
        // has none, so a default workbook doesn't acquire a stray color on
        // re-export. The value is a "#RRGGBB" string (normalized at parse time).
        if let Some(color) = tab_colors_by_sheet.get(name) {
            sheet_obj["_tabColor"] = Value::String(color.clone());
        }

        // Per-sheet auto-filter range. Opt-in: omit `_autoFilter` when the
        // sheet has none. The value is the original A1-style ref (e.g.
        // "A1:E10"); the export side parses it back to row/col indices for
        // rust_xlsxwriter's `autofilter(...)` call.
        if let Some(reference) = auto_filters_by_sheet.get(name) {
            sheet_obj["_autoFilter"] = Value::String(reference.clone());
        }

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
                            obj.insert("promptTitle".into(), Value::String(e.prompt_title.clone()));
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
                        // top10 trio: only emit when present so non-top10 rules
                        // don't get noisy default fields in the snapshot.
                        if e.rank > 0 {
                            obj.insert("rank".into(), Value::from(e.rank));
                        }
                        if e.percent {
                            obj.insert("percent".into(), Value::Bool(true));
                        }
                        if e.bottom {
                            obj.insert("bottom".into(), Value::Bool(true));
                        }
                        // #38: aboveAverage variants — emit the {below,
                        // equalAverage} pair only for that rule type so the
                        // export side picks up the right
                        // ConditionalFormatAverageRule variant.
                        if e.rule_type == "aboveAverage" {
                            let mut aa = Map::new();
                            aa.insert("below".into(), Value::Bool(e.below));
                            aa.insert(
                                "equalAverage".into(),
                                Value::Bool(e.equal_average),
                            );
                            obj.insert("aboveAverage".into(), Value::Object(aa));
                        }
                        // #38: timePeriod literal — emit only when populated
                        // so other rule types don't get a stray key.
                        if e.rule_type == "timePeriod" && !e.time_period.is_empty() {
                            obj.insert(
                                "timePeriod".into(),
                                Value::String(e.time_period.clone()),
                            );
                        }
                        // Verbatim cfRule XML for colorScale / dataBar /
                        // iconSet — the export side will re-emit this inside
                        // a fresh `<conditionalFormatting sqref="...">` block.
                        if !e.raw.is_empty() {
                            obj.insert("raw".into(), Value::String(e.raw.clone()));
                        }
                        // #37: dxf-referenced visual format (bold / font
                        // color / fill color) reads through to the same
                        // `style` shape the dialog authors. apply_*_from_snapshot
                        // then re-emits the dxf via rust_xlsxwriter on
                        // re-export, closing the round-trip.
                        if let Some(dxf) = &e.dxf_style {
                            let mut sty = Map::new();
                            if dxf.bold {
                                sty.insert("bold".into(), Value::Bool(true));
                            }
                            if dxf.italic {
                                sty.insert("italic".into(), Value::Bool(true));
                            }
                            if let Some(c) = &dxf.font_color {
                                sty.insert("fontColor".into(), Value::String(c.clone()));
                            }
                            if let Some(c) = &dxf.bg_color {
                                sty.insert("bgColor".into(), Value::String(c.clone()));
                            }
                            if !sty.is_empty() {
                                obj.insert("style".into(), Value::Object(sty));
                            }
                        }
                        // dxfId for raw-preserved rules: carry alongside the
                        // raw XML so the splice path doesn't have to re-parse.
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

        // Per-sheet frozen / split pane. Opt-in: omit `_freezePane` entirely
        // when the sheet has no pane declaration. `topLeft` is only emitted
        // when the source workbook carried `topLeftCell` so we don't
        // materialize a default A1 pre-scroll on round-trip. `state` is
        // emitted only when "split" — frozen is the default and stays
        // implicit for back-compat with D5 snapshots.
        if let Some(fp) = freeze_panes_by_sheet.get(name) {
            let mut obj = Map::new();
            obj.insert("row".into(), Value::from(fp.row));
            obj.insert("col".into(), Value::from(fp.col));
            if let Some(tl) = &fp.top_left {
                obj.insert("topLeft".into(), Value::String(tl.clone()));
            }
            if fp.state == "split" {
                obj.insert("state".into(), Value::String("split".into()));
            }
            sheet_obj["_freezePane"] = Value::Object(obj);
            // #178: also project onto Univer's native `freeze` field so the
            // freeze / split renderer activates immediately on direct open,
            // without waiting for a View-menu toggle. `_freezePane` above
            // still drives xlsx round-trip (it carries the `state`
            // discriminator); `freeze` is the in-app visual.
            if let Some(freeze) = freeze_field_for_pane(
                fp.row as u64,
                fp.col as u64,
                row_count as u64,
                col_count as u64,
            ) {
                sheet_obj["freeze"] = freeze;
            }
        }

        // Workbook-level sheet visibility. Opt-in: omit `_sheetState` when the
        // sheet is visible (the default) so clean files don't acquire a stray
        // attribute on round-trip.
        if let Some(state) = sheet_visibility.get(name) {
            sheet_obj["_sheetState"] = Value::String(state.clone());
        }

        // Per-sheet protection (read-only marker). Opt-in: omit `_protected`
        // entirely when the sheet has no `<sheetProtection sheet="1"/>` so
        // a clean workbook doesn't gain the field on round-trip. We only
        // track the on/off flag here; password / fine-grained options aren't
        // round-tripped at the snapshot level (rust_xlsxwriter's
        // `protect_with_password` is available but the snapshot field is
        // intentionally minimal — { protected: true, password?: string }).
        if let Some(sp) = sheet_protection_by_sheet.get(name) {
            if sp.protected {
                let mut obj = Map::new();
                obj.insert("protected".into(), Value::Bool(true));
                sheet_obj["_protected"] = Value::Object(obj);
            }
        }

        // Per-sheet print / page-setup. Opt-in: only emit `_pageSetup` when at
        // least one non-default field was captured, so a workbook that never
        // customized page setup doesn't acquire a stray object on round-trip.
        if let Some(ps) = page_setup_by_sheet.get(name) {
            let mut obj = Map::new();
            if let Some(o) = &ps.orientation {
                obj.insert("orientation".into(), Value::String(o.clone()));
            }
            if let Some(p) = ps.paper_size {
                obj.insert("paperSize".into(), Value::from(p));
            }
            if let Some(s) = ps.scale {
                obj.insert("scale".into(), Value::from(s));
            }
            if let Some(w) = ps.fit_to_width {
                obj.insert("fitToWidth".into(), Value::from(w));
            }
            if let Some(h) = ps.fit_to_height {
                obj.insert("fitToHeight".into(), Value::from(h));
            }
            let any_margin = ps.margin_left.is_some()
                || ps.margin_right.is_some()
                || ps.margin_top.is_some()
                || ps.margin_bottom.is_some()
                || ps.margin_header.is_some()
                || ps.margin_footer.is_some();
            if any_margin {
                let mut m = Map::new();
                if let Some(v) = ps.margin_left {
                    m.insert("left".into(), Value::from(v));
                }
                if let Some(v) = ps.margin_right {
                    m.insert("right".into(), Value::from(v));
                }
                if let Some(v) = ps.margin_top {
                    m.insert("top".into(), Value::from(v));
                }
                if let Some(v) = ps.margin_bottom {
                    m.insert("bottom".into(), Value::from(v));
                }
                if let Some(v) = ps.margin_header {
                    m.insert("header".into(), Value::from(v));
                }
                if let Some(v) = ps.margin_footer {
                    m.insert("footer".into(), Value::from(v));
                }
                obj.insert("margins".into(), Value::Object(m));
            }
            if let Some(b) = ps.print_gridlines {
                obj.insert("printGridLines".into(), Value::Bool(b));
            }
            if let Some(b) = ps.print_headings {
                obj.insert("printHeadings".into(), Value::Bool(b));
            }
            if let Some(s) = &ps.header {
                obj.insert("header".into(), Value::String(s.clone()));
            }
            if let Some(s) = &ps.footer {
                obj.insert("footer".into(), Value::String(s.clone()));
            }
            if let Some(b) = ps.show_gridlines {
                obj.insert("showGridLines".into(), Value::Bool(b));
            }
            if let Some(z) = ps.zoom_scale {
                obj.insert("zoomScale".into(), Value::from(z));
            }
            if !obj.is_empty() {
                sheet_obj["_pageSetup"] = Value::Object(obj);
            }
        }

        sheets_map.insert(sheet_id, sheet_obj);
    }

    // Chart-preservation: capture chart/drawing/theme parts byte-for-byte so
    // they survive a save round-trip even though we don't render them.
    let mut preserved_parts =
        parse_xlsx_preserved_parts(&mut archive, &sheet_paths, &sheet_drawing_rids);

    // #312 Step 6: normalise embedded images from _preservedParts into _images.
    // Successfully parsed images are removed from _preservedParts.parts to enforce
    // the XOR invariant: _images XOR _preservedParts.parts[xl/media|drawings/*].
    let (image_entries_by_sheet, image_warnings) = parse_xlsx_images(
        &mut archive,
        &sheet_order,
        &sheet_names,
        &sheet_paths,
        &sheet_drawing_rids,
        preserved_parts.as_mut(),
    );

    // #105: re-hydrate any `xl/cocoExtensions/*.json` parts a previous Coco
    // export wrote (tables / sparklines / outline / pivot meta / slicers /
    // scenarios / sheet notes / Coco-authored charts / threaded-comment
    // extras). For files Excel saved (no extension parts), this is a no-op.
    let coco_extensions = read_coco_extensions(&mut archive);

    // Bug 4 fix: detect when this looks like a Coco-authored workbook but no
    // cocoExtensions parts are present. That indicates Excel (or another
    // tool) re-saved the file and silently dropped the extension parts, so
    // tables / pivots / slicers / sparklines / outline / scenarios / sheet
    // notes / threaded-comment extras have been lost. We don't auto-recover
    // anything — just surface a warning so the user knows the original
    // structure may not be intact.
    let coco_extensions_missing_after_external_edit =
        coco_extensions.is_empty() && xlsx_looks_coco_authored(&mut archive);

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
    // #312 Step 6: stamp normalised _images into each sheet's snapshot.
    if let Some(sheets_obj) = snapshot.get_mut("sheets").and_then(|v| v.as_object_mut()) {
        for (sheet_id, images) in &image_entries_by_sheet {
            if let Some(sheet) = sheets_obj.get_mut(sheet_id) {
                sheet["_images"] = Value::Array(
                    images.iter().map(|img| img.to_json()).collect::<Vec<_>>(),
                );
            }
        }
    }
    // #312 Step 8: SHEET_DRAWING_PLUGIN resource bridge disabled.
    // InGridImageLayer reads _images directly; @univerjs/sheets-drawing stays dormant.
    merge_coco_extensions_into_snapshot(&mut snapshot, &coco_extensions);

    let snapshot_json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

    let mut warnings: Vec<CompatibilityWarning> = prepended_warnings;
    warnings.extend(feature_warnings);
    warnings.extend(image_warnings);
    warnings.push(CompatibilityWarning {
        severity: "info".to_string(),
        code: "XLSX_POC_IMPORT".to_string(),
        message:
            "xlsx import compatibility notice: threaded comments are not yet preserved (named ranges + font/fill/alignment/border styles + merged cells + number formats + column widths + row heights + rich text + data validations + conditional formatting + charts (blob-preserved) + pivot tables (blob-preserved) + images/drawings (blob-preserved) are preserved)"
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

    // Bug 4 fix: surface silent data loss when a Coco-authored xlsx loses its
    // cocoExtensions parts (typical when the file was re-saved in Excel).
    if coco_extensions_missing_after_external_edit {
        warnings.push(CompatibilityWarning {
            severity: "warning".to_string(),
            code: "XLSX_COCO_EXTENSIONS_MISSING".to_string(),
            message:
                "このファイルは Coco で作成された可能性がありますが、Coco 拡張データ (テーブル / ピボット / スパークライン等) が含まれていません。Excel 等の他ツールで上書き保存された場合、これらの機能は失われている可能性があります。"
                    .to_string(),
            affected_sheets: None,
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
            requires_save_as_on_first_save: is_xlsm,
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
        // #93: defensive guard — Excel's hard cap of 200 sheets makes
        // reaching `u32::MAX` unreachable in practice, but security harness
        // and direct snapshot injection can push past the cap. checked_add
        // turns an overflow into a fallback name instead of wrapping (and
        // potentially colliding with `Sheet_0`).
        match n.checked_add(1) {
            Some(next) => n = next,
            None => {
                // Fall back to a uuid-suffixed name so we still return a
                // unique value rather than looping forever.
                return format!(
                    "{}_{}",
                    base_chars.iter().take(20).collect::<String>(),
                    uuid::Uuid::new_v4().simple()
                );
            }
        }
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
pub fn export_xlsx_core(path: String, snapshot_json: String) -> Result<ExportResult, String> {
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

    if snapshot_json.len() > MAX_EXPORT_SNAPSHOT_BYTES {
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_SNAPSHOT_TOO_LARGE".to_string(),
                message: format!(
                    "Snapshot JSON is too large for XLSX export ({} bytes > {} bytes).",
                    snapshot_json.len(),
                    MAX_EXPORT_SNAPSHOT_BYTES
                ),
                affected_sheets: None,
            }],
            error: Some("XLSX_SNAPSHOT_TOO_LARGE".to_string()),
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
    // Captured per-sheet split-pane specs. rust_xlsxwriter 0.77 only emits
    // `state="frozen"` panes — split panes need a post-save XML rewrite to
    // overwrite the `<pane>` attributes (xSplit / ySplit pixel offsets +
    // `state="split"`).
    let mut sheets_with_split_panes: Vec<SplitPaneSpec> = Vec::new();
    // Captured per-sheet raw `<cfRule>` XML for CF rule types that
    // rust_xlsxwriter doesn't expose typed APIs for (colorScale / dataBar /
    // iconSet). Each tuple is `(safe_sheet_name, sqref, raw_cfRule_xml)`.
    // `rewrite_extra_cf_in_zip` splices these into the saved sheet XML.
    let mut sheets_with_extra_cf: Vec<(String, String, String)> = Vec::new();

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
            worksheet.set_name(&safe_name).map_err(|e| e.to_string())?;

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

            // Apply frozen / split pane from `_freezePane`. Out-of-bounds
            // rows/cols (or a {0,0} pane) are dropped — rust_xlsxwriter
            // rejects the former and the latter is a no-op anyway. For
            // `state="split"`, rust_xlsxwriter only emits `state="frozen"`
            // panes; we ask it to emit *some* pane (so the `<pane>` element
            // and its surrounding `<sheetView>` exist in the worksheet XML)
            // and then post-process the saved file to rewrite the pane attrs
            // (xSplit / ySplit values + `state="split"`). See
            // `rewrite_split_panes_in_zip` below.
            if let Some(fp) = sheet_obj
                .and_then(|s| s.get("_freezePane"))
                .and_then(|v| v.as_object())
            {
                let row_raw = fp.get("row").and_then(|v| v.as_u64()).unwrap_or(0);
                let col_raw = fp.get("col").and_then(|v| v.as_u64()).unwrap_or(0);
                let state = fp.get("state").and_then(|v| v.as_str()).unwrap_or("frozen");
                if state == "split" {
                    // For split panes, the row/col are pixel/twip offsets and
                    // may be much larger than rust_xlsxwriter's row/col limits.
                    // Pass `(1, 1)` as a placeholder so the writer emits a
                    // `<pane .../>` element; we'll rewrite the attributes in
                    // `rewrite_split_panes_in_zip` after the workbook is
                    // saved. `topLeft` is also re-emitted by that pass.
                    let _ = worksheet.set_freeze_panes(1u32, 1u16);
                    sheets_with_split_panes.push(SplitPaneSpec {
                        sheet_name: safe_name.clone(),
                        x_split: col_raw,
                        y_split: row_raw,
                        top_left: fp
                            .get("topLeft")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                    });
                } else {
                    // #85: checked conversion so out-of-range snapshot values
                    // (corruption / hostile injection) don't wrap and freeze
                    // an unintended row/col. OOXML caps row at 1048576 and
                    // col at XFD (16384, fits u16); reject anything past
                    // those bounds.
                    let row = u32::try_from(row_raw).ok().filter(|r| *r <= 1_048_576);
                    let col = u16::try_from(col_raw).ok().filter(|c| *c <= 16_384);
                    if let (Some(row), Some(col)) = (row, col) {
                        if row > 0 || col > 0 {
                            let _ = worksheet.set_freeze_panes(row, col);
                            if let Some(tl) = fp.get("topLeft").and_then(|v| v.as_str()) {
                                if let Some((tr, tc)) = parse_a1(tl) {
                                    if let Ok(tc_u16) = u16::try_from(tc) {
                                        let _ = worksheet
                                            .set_freeze_panes_top_cell(tr, tc_u16);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Apply sheet protection from `_protected`. The snapshot shape is
            // `{ protected: bool, password?: string }`; only `protected: true`
            // actually emits `<sheetProtection sheet="1"/>`. `password` is
            // optional and routed through rust_xlsxwriter's weak-hash variant.
            if let Some(prot) = sheet_obj
                .and_then(|s| s.get("_protected"))
                .and_then(|v| v.as_object())
            {
                let on = prot
                    .get("protected")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if on {
                    let pw = prot.get("password").and_then(|v| v.as_str()).unwrap_or("");
                    if pw.is_empty() {
                        worksheet.protect();
                    } else {
                        worksheet.protect_with_password(pw);
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

            // Apply per-sheet print / page-setup from `_pageSetup`. All fields
            // are individually optional and each maps to a single
            // rust_xlsxwriter setter — missing fields leave the underlying
            // default in place. Setters that reject out-of-range values (e.g.
            // print scale must be 10..=400) silently no-op, matching the
            // best-effort policy for the other preserved metadata.
            if let Some(ps) = sheet_obj
                .and_then(|s| s.get("_pageSetup"))
                .and_then(|v| v.as_object())
            {
                if let Some(o) = ps.get("orientation").and_then(|v| v.as_str()) {
                    match o {
                        "landscape" => {
                            worksheet.set_landscape();
                        }
                        "portrait" => {
                            worksheet.set_portrait();
                        }
                        _ => {}
                    }
                }
                if let Some(p) = ps.get("paperSize").and_then(|v| v.as_u64()) {
                    if let Ok(p8) = u8::try_from(p) {
                        worksheet.set_paper_size(p8);
                    }
                }
                if let Some(s) = ps.get("scale").and_then(|v| v.as_u64()) {
                    if let Ok(s16) = u16::try_from(s) {
                        worksheet.set_print_scale(s16);
                    }
                }
                // fit-to-pages is set together; rust_xlsxwriter requires both.
                let ftw = ps.get("fitToWidth").and_then(|v| v.as_u64());
                let fth = ps.get("fitToHeight").and_then(|v| v.as_u64());
                if ftw.is_some() || fth.is_some() {
                    let w = ftw.and_then(|v| u16::try_from(v).ok()).unwrap_or(1);
                    let h = fth.and_then(|v| u16::try_from(v).ok()).unwrap_or(1);
                    worksheet.set_print_fit_to_pages(w, h);
                }
                if let Some(margins) = ps.get("margins").and_then(|v| v.as_object()) {
                    // -1.0 signals "use Excel default" for each axis in
                    // rust_xlsxwriter, so missing fields are skipped that way.
                    let g = |k: &str| -> f64 {
                        margins.get(k).and_then(|v| v.as_f64()).unwrap_or(-1.0)
                    };
                    worksheet.set_margins(
                        g("left"),
                        g("right"),
                        g("top"),
                        g("bottom"),
                        g("header"),
                        g("footer"),
                    );
                }
                if let Some(b) = ps.get("printGridLines").and_then(|v| v.as_bool()) {
                    worksheet.set_print_gridlines(b);
                }
                if let Some(b) = ps.get("printHeadings").and_then(|v| v.as_bool()) {
                    worksheet.set_print_headings(b);
                }
                if let Some(s) = ps.get("header").and_then(|v| v.as_str()) {
                    worksheet.set_header(s);
                }
                if let Some(s) = ps.get("footer").and_then(|v| v.as_str()) {
                    worksheet.set_footer(s);
                }
                if let Some(b) = ps.get("showGridLines").and_then(|v| v.as_bool()) {
                    worksheet.set_screen_gridlines(b);
                }
                if let Some(z) = ps.get("zoomScale").and_then(|v| v.as_u64()) {
                    if let Ok(z16) = u16::try_from(z) {
                        worksheet.set_zoom(z16);
                    }
                }
            }

            // Apply per-sheet tab color from `_tabColor`. Best-effort: silently
            // skip when the snapshot omits the field or the value isn't a valid
            // "#RRGGBB" hex.
            if let Some(color_str) = sheet_obj
                .and_then(|s| s.get("_tabColor"))
                .and_then(|v| v.as_str())
            {
                if let Some(color) = parse_color(color_str) {
                    worksheet.set_tab_color(color);
                }
            }

            // Apply per-sheet auto-filter from `_autoFilter`. Value is an A1
            // range ref like "A1:E10". Malformed entries are dropped silently
            // — best-effort metadata, same policy as merges.
            if let Some(filter_ref) = sheet_obj
                .and_then(|s| s.get("_autoFilter"))
                .and_then(|v| v.as_str())
            {
                if let Some((sr, sc, er, ec)) = parse_range_ref(filter_ref) {
                    if let (Ok(sc16), Ok(ec16)) = (u16::try_from(sc), u16::try_from(ec)) {
                        let _ = worksheet.autofilter(sr, sc16, er, ec16);
                    }
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
                    let (sr32, sc32, er32, ec32) = match (
                        u32::try_from(sr),
                        u16::try_from(sc),
                        u32::try_from(er),
                        u16::try_from(ec),
                    ) {
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
            // variant (cellIs / containsText / expression / ...). When the
            // entry carries a `style` bag (authored via the dialog), we
            // build a `Format` and call `.set_format(...)` on the rule so
            // rust_xlsxwriter emits a matching `<dxf>` entry in
            // `xl/styles.xml`. Imported rules don't currently carry styles
            // because we don't parse the dxf table on the import side
            // (see the doc on ConditionalFormattingEntry).
            if let Some(cf_arr) = sheet_obj
                .and_then(|s| s.get("_conditionalFormatting"))
                .and_then(|v| v.as_array())
            {
                for entry in cf_arr {
                    // colorScale / dataBar / iconSet round-trip via a
                    // verbatim XML splice rather than rust_xlsxwriter's typed
                    // CF API (which doesn't cover them). Stash and skip; the
                    // post-write pass injects a fresh `<conditionalFormatting>`
                    // block. Other rule types fall through to the typed path.
                    let raw = entry.get("raw").and_then(|v| v.as_str()).unwrap_or("");
                    if !raw.is_empty() {
                        let sqref = entry
                            .get("sqref")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !sqref.trim().is_empty() {
                            sheets_with_extra_cf.push((safe_name.clone(), sqref, raw.to_string()));
                        }
                        continue;
                    }
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
                        let fmt_obj: Option<Format> = if style_obj.is_some() || fmt_str.is_some() {
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
                            // #176: rust_xlsxwriter stores 0 as every formula's
                            // result and flags the file for full recalc on open.
                            // For an external-book reference (`=[Book]Sheet!A1`)
                            // that's lossy: Univer cannot recompute it (single-
                            // workbook editor — the referenced unit is never
                            // loaded), so the imported cached value is the only
                            // thing the user can see. Re-emit that cached value
                            // as the formula result so the closed-book fallback
                            // survives the round-trip. Normal formulas are left
                            // alone — Univer recalculates them at render time.
                            if formula_is_external_ref(f) {
                                if let Some(result) = cached_formula_result(cell_val) {
                                    worksheet.set_formula_result(row_idx, col_idx, result);
                                }
                            }
                            formula_count += 1;
                            cell_count += 1;
                            if cell_count > MAX_EXPORT_CELLS {
                                return Err(format!(
                                    "XLSX_EXPORT_TOO_MANY_CELLS: {cell_count} cells exceeds limit {MAX_EXPORT_CELLS}"
                                ));
                            }
                            continue;
                        }

                        // Rich-text cells: write each run with its own Format.
                        // rust_xlsxwriter's write_rich_string takes &[(&Format, &str)]
                        // and rejects empty segments, so build the Vec carefully.
                        // #81: if there's only a single run, write_rich_string
                        // would reject it (it requires ≥2 segments). Instead of
                        // dropping the run's formatting, write the text with the
                        // run's format applied as a cell-level Format.
                        if let Some(runs_arr) = cell_val.get("_richRuns").and_then(|v| v.as_array())
                        {
                            let parsed_runs: Vec<RichRun> = runs_arr
                                .iter()
                                .filter_map(RichRun::from_json)
                                .filter(|r| !r.text.is_empty())
                                .collect();
                            if parsed_runs.len() == 1 {
                                // Single-run shortcut: build a Format from the
                                // run's properties and merge with the cell-level
                                // fmt_obj (cell style + num format). The run's
                                // typography wins over the cell style for the
                                // exact attributes the run specifies.
                                let run_fmt = build_run_format(&parsed_runs[0]);
                                let write_res = worksheet.write_string_with_format(
                                    row_idx,
                                    col_idx,
                                    &parsed_runs[0].text,
                                    &run_fmt,
                                );
                                if write_res.is_ok() {
                                    cell_count += 1;
                                    if cell_count > MAX_EXPORT_CELLS {
                                        return Err(format!(
                                            "XLSX_EXPORT_TOO_MANY_CELLS: {cell_count} cells exceeds limit {MAX_EXPORT_CELLS}"
                                        ));
                                    }
                                    continue;
                                }
                            } else if !parsed_runs.is_empty() {
                                let formats: Vec<Format> =
                                    parsed_runs.iter().map(build_run_format).collect();
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
                                    if cell_count > MAX_EXPORT_CELLS {
                                        return Err(format!(
                                            "XLSX_EXPORT_TOO_MANY_CELLS: {cell_count} cells exceeds limit {MAX_EXPORT_CELLS}"
                                        ));
                                    }
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
                                        if cell_count > MAX_EXPORT_CELLS {
                                            return Err(format!(
                                                "XLSX_EXPORT_TOO_MANY_CELLS: {cell_count} cells exceeds limit {MAX_EXPORT_CELLS}"
                                            ));
                                        }
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
                            if cell_count > MAX_EXPORT_CELLS {
                                return Err(format!(
                                    "XLSX_EXPORT_TOO_MANY_CELLS: {cell_count} cells exceeds limit {MAX_EXPORT_CELLS}"
                                ));
                            }
                        } else if let Some(ref fmt) = fmt_obj {
                            // No `v` field but has style — blank styled cell.
                            worksheet
                                .write_blank(row_idx, col_idx, fmt)
                                .map_err(|e| e.to_string())?;
                            cell_count += 1;
                            if cell_count > MAX_EXPORT_CELLS {
                                return Err(format!(
                                    "XLSX_EXPORT_TOO_MANY_CELLS: {cell_count} cells exceeds limit {MAX_EXPORT_CELLS}"
                                ));
                            }
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
                    let text = entry.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let author = entry.get("author").and_then(|v| v.as_str()).unwrap_or("");
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

    // Step 4: atomic save — write tmp first, rotate backups only after the
    // tmp is fully built (#68 — rotating earlier means a transient failure
    // during write / preserved-parts injection / comment rewrite shifts the
    // backup chain even though no successful save happened).
    let target_path = PathBuf::from(&path);
    let tmp_path = temp_save_path(&target_path);

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

    // Post-save: rewrite the `<pane>` element on sheets that wanted
    // `state="split"` rather than the default `state="frozen"`
    // rust_xlsxwriter 0.77 emits.
    if let Err(e) = rewrite_split_panes_in_zip(&tmp_path, &sheets_with_split_panes) {
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_WRITE_FAILED".to_string(),
                message: format!("split-pane rewrite failed: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_WRITE_FAILED: {e}")),
        });
    }

    // Post-save: splice in raw `<cfRule>` blocks for CF types
    // (colorScale / dataBar / iconSet) that rust_xlsxwriter doesn't model.
    if let Err(e) = rewrite_extra_cf_in_zip(&tmp_path, &sheets_with_extra_cf) {
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_WRITE_FAILED".to_string(),
                message: format!("extra CF rewrite failed: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_WRITE_FAILED: {e}")),
        });
    }

    // Chart-preservation: if the snapshot carried `_preservedParts`, reopen
    // the temp xlsx and splice the preserved chart/drawing/theme parts back
    // in. Failure is blocking because the temp file may now be incomplete or
    // corrupt and must not be promoted over the target.
    if let Some(preserved) = snapshot.get("_preservedParts") {
        if let Err(e) = inject_preserved_parts(&tmp_path, preserved, sheet_order.len()) {
            let _ = std::fs::remove_file(&tmp_path);
            return Ok(ExportResult {
                success: false,
                path: path.clone(),
                warnings: vec![CompatibilityWarning {
                    severity: "blocking".to_string(),
                    code: "XLSX_PRESERVED_PARTS_INJECTION_FAILED".to_string(),
                    message: format!("preserved parts injection failed: {e}"),
                    affected_sheets: None,
                }],
                error: Some(format!("XLSX_PRESERVED_PARTS_INJECTION_FAILED: {e}")),
            });
        }
    }

    // #312 Step 7: re-generate xl/drawings + xl/media from _images entries.
    // Runs after inject_preserved_parts so image numbering avoids collisions
    // with _preservedParts media (floor at 9001).
    if let Err(e) = inject_images_to_xlsx(&tmp_path, &snapshot, &sheet_order) {
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_IMAGE_INJECT_FAILED".to_string(),
                message: format!("image injection failed: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_IMAGE_INJECT_FAILED: {e}")),
        });
    }

    // #309: Emit OOXML ctrlProp / vmlDrawing for Coco-new checkboxes.
    if let Err(e) = inject_coco_form_controls(&tmp_path, &snapshot, &sheet_order) {
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_FORM_CONTROL_EMIT_FAILED".to_string(),
                message: format!("Coco-new form control emit failed: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_FORM_CONTROL_EMIT_FAILED: {e}")),
        });
    }

    // #105 / #120: Coco-extension preservation. Snapshot fields that have no
    // first-class OOXML representation (tables, sparklines, outline groups,
    // pivot metadata, slicers, scenarios, sheet notes, Coco-authored charts,
    // threaded-comments extras) are bundled into `xl/cocoExtensions/*.json`
    // parts. Excel ignores them, but a Coco re-import restores them losslessly.
    let (coco_ext_bundles, coco_ext_families) =
        build_coco_extension_bundles(&snapshot, &sheet_order);
    if let Err(e) = inject_coco_extensions(&tmp_path, &coco_ext_bundles) {
        let _ = std::fs::remove_file(&tmp_path);
        return Ok(ExportResult {
            success: false,
            path: path.clone(),
            warnings: vec![CompatibilityWarning {
                severity: "blocking".to_string(),
                code: "XLSX_COCO_EXTENSIONS_INJECTION_FAILED".to_string(),
                message: format!("coco extensions injection failed: {e}"),
                affected_sheets: None,
            }],
            error: Some(format!("XLSX_COCO_EXTENSIONS_INJECTION_FAILED: {e}")),
        });
    }

    // #68: rotate now that the tmp file passed every build / injection
    // step. A rotation failure here is fatal and we still abort cleanly,
    // but at this point the bak chain only shifts when we're truly about
    // to commit a new generation.
    if target_path.exists() {
        if let Err(e) = rotate_backups(&target_path) {
            let _ = std::fs::remove_file(&tmp_path);
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

    if let Err(e) = crate::commands::file_replace::replace_temp_file(&tmp_path, &target_path) {
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
            "xlsx export compatibility notice: {sheet_count} sheets, {cell_count} cells, {formula_count} formulas. Threaded comments are not yet preserved (named ranges + font/fill/alignment/border styles + column widths + row heights + merged cells + number formats + rich text + data validations + conditional formatting + charts (blob-preserved) + pivot tables (blob-preserved) + images/drawings (blob-preserved) are preserved)."
        ),
        affected_sheets: None,
    });

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

    // #120: surface per-family notices when a snapshot carried Coco-only data
    // that we preserved via cocoExtensions parts. The data IS in the file and
    // will round-trip back into Coco, but Excel won't render it. The wording
    // makes both halves explicit so users can plan accordingly.
    for fam in &coco_ext_families {
        let label = coco_extension_label_ja(fam);
        warnings.push(CompatibilityWarning {
            severity: "info".to_string(),
            code: format!("XLSX_COCO_EXTENSION_{}", fam.to_uppercase()),
            message: format!(
                "{label} は Coco 拡張パート (xl/cocoExtensions/{fam}.json) として保存されました (Excel では非表示・Coco で再オープン時に復元されます)"
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
// Blob-level part preservation (charts, drawings, theme, pivot tables, media).
//
// These features are spread across several xlsx parts plus per-sheet
// relationship entries. Rendering them is out of scope for the PoC — instead
// we preserve every related part byte-for-byte in the snapshot and inject
// it back on export so the saved file still carries them.
//
// On import: `parse_xlsx_preserved_parts` walks the source zip, base64-encodes
// every preserved part under a single JSON object keyed by zip entry path,
// and records each sheet's `<drawing r:id="..."/>` element + every
// pivot-table relationship pointing out of the sheet's rels. The whole
// thing is stamped into the snapshot under `_preservedParts`.
//
// On export: after `rust_xlsxwriter` writes the new xlsx to `tmp_path`,
// `inject_preserved_parts` reopens that zip and rewrites it with every
// preserved blob added, the `[Content_Types].xml` overrides merged in, and
// a `<drawing>` ref plus merged `_rels/sheetN.xml.rels` entries for the
// drawing relationship and every pivot-table relationship inserted into the
// matching (by sheet-order position) worksheet.
//
// Limits:
//   - Per-part cap: 16 MiB.
//   - Aggregate cap: 32 MiB (defense against a maliciously crafted file).
//   - Only the parts listed in `PRESERVED_PREFIXES` are captured.
//   - Workbook-level pivotCache wiring (`xl/_rels/workbook.xml.rels` +
//     `<pivotCaches>` in `xl/workbook.xml`) is NOT yet rewired — the blob
//     survives round-trip but Excel won't re-link the pivot to its cache
//     automatically. Sheet-level rels are rewired.
//   - External-link wiring IS rewired: workbook.xml.rels gets the externalLink
//     `<Relationship>` entries appended, and workbook.xml has its captured
//     `<externalReferences>` block spliced back in. Per req 5.3.2, cached
//     values survive but Coco never auto-fetches the external workbook.
// ============================================================================

/// True when a formula string is an external-book reference, i.e. it carries
/// an OOXML `[index]` / `[Book.xlsx]` workbook bracket before a sheet name —
/// `=[1]Sheet1!A1`, `='[1]Sheet 1'!A1`, `=SUM([2]Data!B2:B9)`. Univer's
/// formula engine cannot evaluate these in Coco (single-workbook editor — the
/// referenced unit is never loaded), so on export their imported cached value
/// must be re-emitted as the formula result (#176).
///
/// The check is intentionally conservative: a `[` that is not a workbook
/// bracket (e.g. a structured table reference `Table1[Col]`) is not followed
/// by a sheet-name `!`, so the `]` ... `!` ordering test rejects it.
pub(crate) fn formula_is_external_ref(formula: &str) -> bool {
    let mut search_from = 0;
    while let Some(open_rel) = formula[search_from..].find('[') {
        let open = search_from + open_rel;
        let Some(close_rel) = formula[open + 1..].find(']') else {
            return false;
        };
        let close = open + 1 + close_rel;
        // A workbook bracket is immediately followed by the sheet portion of
        // the reference, which always contains a `!`. A structured table
        // reference like `Table1[Column]` has no `!` after the `]` before the
        // next bracket / end, so it is correctly rejected.
        if let Some(bang_rel) = formula[close + 1..].find('!') {
            // Reject if another `[` sits between `]` and `!` — that would mean
            // the `!` belongs to a later, unrelated reference.
            let between = &formula[close + 1..close + 1 + bang_rel];
            if !between.contains('[') {
                return true;
            }
        }
        search_from = close + 1;
    }
    false
}

/// Stringify a formula cell's cached value (`v`) for `set_formula_result`.
/// Returns `None` when the cell has no usable cached value (so the export
/// path leaves rust_xlsxwriter's default `0` result untouched). Errors (`t:"e"`
/// with a null `v`) round-trip the stored error literal when present.
pub(crate) fn cached_formula_result(cell: &Value) -> Option<String> {
    match cell.get("v") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(if *b { "TRUE".into() } else { "FALSE".into() }),
        _ => None,
    }
}

const PRESERVED_PART_SIZE_CAP: usize = 16 * 1024 * 1024;
const PRESERVED_TOTAL_SIZE_CAP: usize = 32 * 1024 * 1024;

/// Path prefixes captured verbatim from the source xlsx. Each entry whose
/// name starts with one of these is base64-encoded into the snapshot.
const PRESERVED_PREFIXES: &[&str] = &[
    "xl/charts/",
    "xl/drawings/",
    "xl/theme/",
    "xl/pivotTables/",
    "xl/pivotCache/",
    "xl/media/",
    "xl/externalLinks/",
    // #239 Step 4: Power Pivot / Data Model. xl/model/item.data is the binary
    // Vertipaq columnstore (xlsx 2013+). Coco doesn't author it — but a user
    // opening an Excel-authored data-model workbook in Coco and re-saving
    // would otherwise lose the model entirely. Byte-perfect round-trip via
    // _preservedParts keeps the model intact even when Coco can't read it.
    "xl/model/",
    // #238 Step 4 (xlsx round-trip for Power Query connection definitions).
    // Excel stores query connection metadata in connections.xml + queryTables/.
    // Same preservation rationale as xl/model/.
    "xl/queryTables/",
    // #194 Step 1 (form controls OOXML preservation). ctrlProps + vmlDrawings
    // carry form control state. Coco can't write these natively yet so
    // byte-for-byte preservation keeps Excel-authored form controls intact
    // through a Coco round-trip.
    "xl/ctrlProps/",
    "xl/embeddings/",
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
pub(crate) fn parse_xlsx_preserved_parts<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_paths: &HashMap<String, String>,
    sheet_drawing_rids: &HashMap<String, String>,
) -> Option<Value> {
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

    // Pass 2: capture per-sheet drawing references. The import pass already
    // pulled each worksheet's `<drawing r:id="..."/>`; here we resolve that
    // rId to the corresponding target from `_rels/sheetN.xml.rels`. Indexed by
    // position in `workbook.xml`'s `<sheets>` list so we can re-link on export
    // — the export side uses the snapshot's `sheetOrder` position.
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
        // The worksheet body was already scanned during the per-sheet import
        // pass, so avoid retaining or rereading every sheet XML here.
        let drawing_rid = sheet_drawing_rids.get(sheet_name).cloned();

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

        // Walk Relationship elements again to capture every pivot-table rel
        // (Type ends in `/pivotTable`). A single worksheet can reference more
        // than one pivot table.
        let mut pivot_rels: Vec<Value> = Vec::new();
        for el in extract_self_closing_or_paired(&sheet_rels_xml, "Relationship") {
            let ty = parse_attr(&el, "Type").unwrap_or_default();
            if !ty.ends_with("/pivotTable") {
                continue;
            }
            let id = parse_attr(&el, "Id").unwrap_or_default();
            let target = parse_attr(&el, "Target").unwrap_or_default();
            if id.is_empty() || target.is_empty() {
                continue;
            }
            pivot_rels.push(json!({ "rid": id, "target": target }));
        }

        let has_drawing = drawing_rid.is_some() && drawing_target.is_some();
        let has_pivot = !pivot_rels.is_empty();
        if has_drawing || has_pivot {
            sheet_refs.push(json!({
                "drawingRid": drawing_rid,
                "drawingTarget": drawing_target,
                "pivotRels": pivot_rels,
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

    // Workbook-level external-link wiring: capture both the rels entries
    // (Type ending in `/externalLink`) and the `<externalReferences>` block
    // from workbook.xml. Required so the saved file still routes preserved
    // `xl/externalLinks/*` blobs back into the workbook structure.
    let mut workbook_rels_xml = String::new();
    if let Ok(mut e) = archive.by_name("xl/_rels/workbook.xml.rels") {
        let _ = std::io::Read::read_to_string(&mut e, &mut workbook_rels_xml);
    }
    let mut ext_link_rels: Vec<Value> = Vec::new();
    for el in extract_self_closing_or_paired(&workbook_rels_xml, "Relationship") {
        let ty = parse_attr(&el, "Type").unwrap_or_default();
        if !ty.ends_with("/externalLink") {
            continue;
        }
        let id = parse_attr(&el, "Id").unwrap_or_default();
        let target = parse_attr(&el, "Target").unwrap_or_default();
        if id.is_empty() || target.is_empty() {
            continue;
        }
        ext_link_rels.push(json!({ "rid": id, "target": target, "type": ty }));
    }

    // Extract `<externalReferences>...</externalReferences>` verbatim from
    // workbook.xml. rust_xlsxwriter does not emit this block on export, so we
    // splice it back in after the saved file is written.
    let ext_refs_block: Option<String> = workbook_xml.find("<externalReferences").and_then(|s| {
        let rest = &workbook_xml[s..];
        rest.find("</externalReferences>")
            .map(|e| workbook_xml[s..s + e + "</externalReferences>".len()].to_string())
    });

    let mut result = json!({
        "parts": Value::Object(parts),
        "sheetRefs": sheet_refs,
        "contentTypes": content_types_xml,
    });
    if !ext_link_rels.is_empty() {
        result["workbookExternalLinkRels"] = Value::Array(ext_link_rels);
    }
    if let Some(b) = ext_refs_block {
        result["workbookExternalReferences"] = Value::String(b);
    }
    Some(result)
}

// === Phase 4c: Univer 0.24 sheets-drawing render bridge =====================
//
// `_preservedParts` is a byte-perfect export channel — Univer's render layer
// can't see it. The `@univerjs/sheets-drawing` plugin reads the workbook
// snapshot's top-level `resources` array (see IResources / IResourceHook in
// `@univerjs/core`). The hook registered under `pluginName: "SHEET_DRAWING_PLUGIN"`
// expects `data` to be a JSON-stringified `IDrawingSubunitMap<ISheetImage>`,
// i.e. `{ [subUnitId]: { data: { [drawingId]: ISheetImage }, order: string[] } }`.
//
// This bridge walks the same OOXML drawing XML / rels / media bytes that
// `_preservedParts` already captures (so the export path stays untouched) and
// emits an additional render-only snapshot resource. Read-side only.
//
// EMU → px: OOXML drawing coords are in English Metric Units. At 96 DPI,
// 914400 EMU = 1 inch = 96 px, so `px = emu / 9525`. We round half-up.
//
// Anchor types handled:
//   - twoCellAnchor (most common in Excel-saved files)
//   - oneCellAnchor (single anchor + ext for size)
//   - absoluteAnchor: pixel coords are absolute — Univer's ISheetOverGridPosition
//     requires from/to as cell anchors. We log + skip (preservedParts still
//     round-trips the bytes).

/// Convert OOXML EMU to pixels at 96 DPI (Univer's coordinate space).
fn emu_to_px(emu: i64) -> i32 {
    // Round half-up so a 9525-EMU column offset becomes 1px not 0.
    let abs = emu.unsigned_abs();
    let px = ((abs + 4762) / 9525) as i32;
    if emu < 0 {
        -px
    } else {
        px
    }
}

/// Pick a `data:` URL MIME type from a media file extension.
#[allow(dead_code)]
fn media_ext_to_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

/// Resolve a rels Target (e.g. `../media/image1.png`) against the drawing
/// part path (e.g. `xl/drawings/drawing1.xml`) to a canonical zip path
/// (`xl/media/image1.png`). Mirrors `resolveMediaPath` in the TS sidebar.
fn resolve_rel_media_path(drawing_part_path: &str, rel_target: &str) -> String {
    if rel_target.is_empty() {
        return String::new();
    }
    if rel_target.starts_with("xl/") || rel_target.starts_with("/xl/") {
        return rel_target.trim_start_matches('/').to_string();
    }
    let dir = drawing_part_path
        .rsplit_once('/')
        .map(|(d, _)| d)
        .unwrap_or("");
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in rel_target.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    parts.join("/")
}

/// Single anchor coordinate parsed from `<xdr:from>` / `<xdr:to>` (col/row in
/// 0-based cell space + EMU offsets within the cell).
#[derive(Debug, Clone, Copy)]
struct DrawingAnchorCell {
    col: i32,
    col_off_emu: i64,
    row: i32,
    row_off_emu: i64,
}

#[derive(Debug, Clone, Copy)]
struct DrawingAnchorRange {
    from: DrawingAnchorCell,
    to: DrawingAnchorCell,
}

/// Which OOXML anchor element produced a parsed range. Drives the
/// `anchorType` we emit into `SHEET_DRAWING_PLUGIN`: `oneCellAnchor` is
/// position-only (move with cells, fixed size); `twoCellAnchor` is both
/// move + resize. Mapped to Univer's `SheetDrawingAnchorType` enum strings
/// (`"0"` = Position, `"1"` = Both) at emit time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DrawingAnchorKind {
    OneCell,
    TwoCell,
}

/// Read the integer text content of a named child (e.g. `<xdr:col>3</xdr:col>`).
/// Tolerates absent or non-integer children.
fn read_anchor_child_int(block: &str, tag_local: &str) -> Option<i64> {
    // Look for `<xdr:tag>` first, then bare `<tag>`. Walk by string scan to
    // avoid pulling in an XML library — these blocks are tiny and well-formed
    // from real Excel output.
    for cand in [format!("<xdr:{tag_local}>"), format!("<{tag_local}>")] {
        if let Some(s) = block.find(&cand) {
            let after = &block[s + cand.len()..];
            if let Some(e) = after.find('<') {
                return after[..e].trim().parse::<i64>().ok();
            }
        }
    }
    None
}

/// Extract `<xdr:from>...</xdr:from>` (or `<xdr:to>...</xdr:to>`) inner text.
fn extract_anchor_subblock<'a>(anchor_xml: &'a str, tag_local: &str) -> Option<&'a str> {
    for (open, close) in [
        (format!("<xdr:{tag_local}>"), format!("</xdr:{tag_local}>")),
        (format!("<{tag_local}>"), format!("</{tag_local}>")),
    ] {
        if let Some(s) = anchor_xml.find(&open) {
            let body = &anchor_xml[s + open.len()..];
            if let Some(e) = body.find(&close) {
                return Some(&body[..e]);
            }
        }
    }
    None
}

fn parse_anchor_cell(block: &str) -> Option<DrawingAnchorCell> {
    let col = read_anchor_child_int(block, "col")?;
    let row = read_anchor_child_int(block, "row")?;
    let col_off = read_anchor_child_int(block, "colOff").unwrap_or(0);
    let row_off = read_anchor_child_int(block, "rowOff").unwrap_or(0);
    Some(DrawingAnchorCell {
        col: col as i32,
        col_off_emu: col_off,
        row: row as i32,
        row_off_emu: row_off,
    })
}

/// Walk every twoCellAnchor / oneCellAnchor in the drawing XML and return
/// a list of (kind, anchor, embed-rid) tuples. `embed-rid` is the `r:embed`
/// of the inner `<a:blip>`. oneCellAnchor gets its `to` derived from
/// `<xdr:ext>` — the OOXML schema specifies cx/cy in EMU relative to the
/// from anchor. The `kind` is the canonical source-of-truth for which
/// Excel anchor element this came from, used downstream to map to Univer's
/// `SheetDrawingAnchorType` ("0" Position vs "1" Both).
fn parse_drawing_anchors(
    xml: &str,
) -> Vec<(DrawingAnchorKind, DrawingAnchorRange, String)> {
    let mut out = Vec::new();

    // We accept both prefixed (`xdr:twoCellAnchor`) and bare forms, which
    // some non-Excel writers emit.
    for (anchor_tag, kind) in [
        ("twoCellAnchor", DrawingAnchorKind::TwoCell),
        ("oneCellAnchor", DrawingAnchorKind::OneCell),
    ] {
        for (open_str, close_str) in [
            (format!("<xdr:{anchor_tag}"), format!("</xdr:{anchor_tag}>")),
            (format!("<{anchor_tag}"), format!("</{anchor_tag}>")),
        ] {
            let mut cursor = 0;
            while let Some(rel) = xml[cursor..].find(&open_str) {
                let start = cursor + rel;
                let after_open = &xml[start..];
                // Skip past the opening tag attributes to find `>`.
                let Some(gt) = after_open.find('>') else {
                    break;
                };
                let body_start = start + gt + 1;
                let rest = &xml[body_start..];
                let Some(close_rel) = rest.find(&close_str) else {
                    break;
                };
                let block = &xml[body_start..body_start + close_rel];
                cursor = body_start + close_rel + close_str.len();

                // Embed rId lives in `<a:blip r:embed="rIdN"/>`. The attribute
                // is whitespace-tolerant. Fall back to plain `embed=` for
                // odd non-namespaced writers.
                let rid = block
                    .find("r:embed=\"")
                    .map(|s| s + "r:embed=\"".len())
                    .or_else(|| block.find("embed=\"").map(|s| s + "embed=\"".len()))
                    .and_then(|s| block[s..].find('"').map(|e| block[s..s + e].to_string()))
                    .filter(|s| !s.is_empty());
                let Some(rid) = rid else { continue };

                let from_block = match extract_anchor_subblock(block, "from") {
                    Some(b) => b,
                    None => continue,
                };
                let Some(from) = parse_anchor_cell(from_block) else {
                    continue;
                };

                let to = if let Some(to_block) = extract_anchor_subblock(block, "to") {
                    match parse_anchor_cell(to_block) {
                        Some(t) => t,
                        None => continue,
                    }
                } else if kind == DrawingAnchorKind::OneCell {
                    // Derive `to` from `<xdr:ext cx=".." cy=".."/>`.
                    let ext_open = block
                        .find("<xdr:ext")
                        .or_else(|| block.find("<ext"));
                    let (cx, cy) = match ext_open {
                        Some(s) => {
                            let after = &block[s..];
                            let cx = parse_attr(&after[..after.find("/>").unwrap_or(after.len()).min(after.len())], "cx")
                                .and_then(|v| v.parse::<i64>().ok())
                                .unwrap_or(0);
                            let cy = parse_attr(&after[..after.find("/>").unwrap_or(after.len()).min(after.len())], "cy")
                                .and_then(|v| v.parse::<i64>().ok())
                                .unwrap_or(0);
                            (cx, cy)
                        }
                        None => (0, 0),
                    };
                    // Carry ext over the from anchor — we don't know how it
                    // spans into the next cell without column widths, but
                    // Univer's resource manager will treat from/to in EMU as
                    // a hint; downstream skeleton math snaps it to real
                    // grid coords on first paint.
                    DrawingAnchorCell {
                        col: from.col,
                        col_off_emu: from.col_off_emu + cx,
                        row: from.row,
                        row_off_emu: from.row_off_emu + cy,
                    }
                } else {
                    continue;
                };

                out.push((kind, DrawingAnchorRange { from, to }, rid));
            }
        }
    }
    out
}

/// Build the `IResources` entry (`{ name, data }`) for the
/// `SHEET_DRAWING_PLUGIN` hook. Returns `None` when no sheet has any drawing
/// to surface (so callers can skip adding an empty entry).
///
/// Reuses the same drawing XML / rels / media-bytes walk that
/// `_preservedParts` covers — we re-read the parts from the archive rather
/// than threading parsed state through because the parse cost is trivial
/// (drawings are tens of bytes per anchor, media is already in memory once
/// we touch it) and the duplication keeps `_preservedParts` byte-exact.
// #312 Step 8: kept for reference; no longer called. See parse_xlsx_images.
#[allow(dead_code)]
pub(crate) fn build_sheet_drawing_resource<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_order: &[String],
    sheet_names_in_order: &[String],
    sheet_paths: &HashMap<String, String>,
    sheet_drawing_rids: &HashMap<String, String>,
    workbook_unit_id: &str,
) -> (Option<Value>, Vec<CompatibilityWarning>) {
    let mut warnings: Vec<CompatibilityWarning> = Vec::new();
    if sheet_order.len() != sheet_names_in_order.len() {
        return (None, warnings);
    }

    let mut subunit_map: Map<String, Value> = Map::new();

    for (i, sheet_id) in sheet_order.iter().enumerate() {
        let sheet_name = &sheet_names_in_order[i];
        let Some(sheet_part) = sheet_paths.get(sheet_name) else {
            continue;
        };
        let Some(drawing_rid) = sheet_drawing_rids.get(sheet_name) else {
            continue;
        };

        // Resolve rId → drawing part path via sheet rels.
        let sheet_rels_path = sheet_part_to_rels_path(sheet_part);
        let mut sheet_rels_xml = String::new();
        if let Ok(mut entry) = archive.by_name(&sheet_rels_path) {
            let _ = std::io::Read::read_to_string(&mut entry, &mut sheet_rels_xml);
        }
        let sheet_rels = parse_rels(&sheet_rels_xml);
        let Some(drawing_target_rel) = sheet_rels.get(drawing_rid) else {
            continue;
        };
        let drawing_part_path =
            resolve_rel_media_path("xl/worksheets/sheet.xml", drawing_target_rel);
        if drawing_part_path.is_empty() {
            continue;
        }

        // Read drawing XML.
        let mut drawing_xml = String::new();
        if archive
            .by_name(&drawing_part_path)
            .ok()
            .and_then(|mut e| std::io::Read::read_to_string(&mut e, &mut drawing_xml).ok())
            .is_none()
        {
            continue;
        }

        // Read drawing rels (rId → media target).
        let drawing_rels_path = sheet_part_to_rels_path(&drawing_part_path);
        let mut drawing_rels_xml = String::new();
        if let Ok(mut e) = archive.by_name(&drawing_rels_path) {
            let _ = std::io::Read::read_to_string(&mut e, &mut drawing_rels_xml);
        }
        let drawing_rels = parse_rels(&drawing_rels_xml);

        // absoluteAnchor (pixel-positioned anchors) is documented in the
        // parse-anchor header as out-of-scope: Univer's ISheetOverGridPosition
        // is cell-relative and there's no clean lossless conversion. Surface a
        // single warning per sheet so the user knows those drawings are
        // skipped from the in-grid render (bytes still round-trip via
        // `_preservedParts`).
        if drawing_xml.contains("<xdr:absoluteAnchor") || drawing_xml.contains("<absoluteAnchor") {
            warnings.push(CompatibilityWarning {
                severity: "warning".to_string(),
                code: "XLSX_DRAWING_ABSOLUTE_ANCHOR_UNSUPPORTED".to_string(),
                message: format!(
                    "Sheet '{sheet_name}' contains drawings with absoluteAnchor positioning; skipped from in-grid render. Bytes preserved on save via _preservedParts."
                ),
                affected_sheets: Some(vec![sheet_name.clone()]),
            });
        }

        let anchors = parse_drawing_anchors(&drawing_xml);
        if anchors.is_empty() {
            continue;
        }

        let mut order_ids: Vec<Value> = Vec::new();
        let mut data_map: Map<String, Value> = Map::new();

        for (anchor_idx, (anchor_kind, range, embed_rid)) in anchors.iter().enumerate() {
            let Some(media_target_rel) = drawing_rels.get(embed_rid) else {
                continue;
            };
            let media_path = resolve_rel_media_path(&drawing_part_path, media_target_rel);
            if media_path.is_empty() {
                continue;
            }

            // Load media bytes and base64-encode (Univer expects a `data:`
            // URL when imageSourceType is BASE64). Enforce the same 16 MiB
            // per-part cap that `parse_xlsx_preserved_parts` uses so a single
            // huge embedded asset (e.g. a 100 MiB TIFF) can't blow up the
            // snapshot string or the Tauri IPC payload. Oversized media stays
            // in `_preservedParts` (under its own cap there) but is skipped
            // from the in-grid render channel.
            let media_size = archive
                .by_name(&media_path)
                .ok()
                .map(|e| e.size() as usize)
                .unwrap_or(0);
            if media_size > PRESERVED_PART_SIZE_CAP {
                let mb = (media_size as f64) / (1024.0 * 1024.0);
                let cap_mb = (PRESERVED_PART_SIZE_CAP as f64) / (1024.0 * 1024.0);
                warnings.push(CompatibilityWarning {
                    severity: "warning".to_string(),
                    code: "XLSX_DRAWING_MEDIA_TOO_LARGE".to_string(),
                    message: format!(
                        "Embedded image at {media_path} is {mb:.1} MB; in-grid render skipped (cap {cap_mb:.0} MB). Bytes preserved on save via _preservedParts."
                    ),
                    affected_sheets: Some(vec![sheet_name.clone()]),
                });
                continue;
            }
            let mut media_bytes: Vec<u8> = Vec::new();
            if archive
                .by_name(&media_path)
                .ok()
                .and_then(|mut e| std::io::Read::read_to_end(&mut e, &mut media_bytes).ok())
                .is_none()
            {
                continue;
            }
            let ext = media_path
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_string();
            let mime = media_ext_to_mime(&ext);
            // Chromium-based WebView2 can't render TIFF; octet-stream is the
            // unknown-extension fallback and obviously won't render either.
            // Skip from the in-grid render channel and emit a warning so the
            // user knows the image won't be visible (it still round-trips via
            // `_preservedParts`). Browser-renderable: png / jpeg / gif / bmp
            // / svg+xml / webp.
            if mime == "image/tiff" || mime == "application/octet-stream" {
                warnings.push(CompatibilityWarning {
                    severity: "warning".to_string(),
                    code: "XLSX_DRAWING_MEDIA_UNSUPPORTED_MIME".to_string(),
                    message: format!(
                        "Embedded image at {media_path} ({mime}) cannot render in-grid (WebView2 doesn't display this format). Bytes preserved on save via _preservedParts."
                    ),
                    affected_sheets: Some(vec![sheet_name.clone()]),
                });
                continue;
            }
            let data_url = format!("data:{};base64,{}", mime, b64_encode(&media_bytes));

            // Deterministic drawingId derived from (sheet, drawing index, rid)
            // so re-imports of the same xlsx produce a stable id. Univer just
            // requires uniqueness within the subunit; this is stable + unique.
            let drawing_id = format!("coco-img-{}-{}-{}", i, anchor_idx, embed_rid);

            let sheet_transform = json!({
                "from": {
                    "column": range.from.col,
                    "columnOffset": emu_to_px(range.from.col_off_emu),
                    "row": range.from.row,
                    "rowOffset": emu_to_px(range.from.row_off_emu),
                },
                "to": {
                    "column": range.to.col,
                    "columnOffset": emu_to_px(range.to.col_off_emu),
                    "row": range.to.row,
                    "rowOffset": emu_to_px(range.to.row_off_emu),
                },
            });

            // ISheetImage = IImageData & ISheetDrawingBase
            //   IImageData / IDrawingParam: unitId, subUnitId, drawingId,
            //     drawingType (number, DRAWING_IMAGE = 0), imageSourceType
            //     (string enum, "BASE64"), source (data: URL)
            //   ISheetDrawingBase: sheetTransform, axisAlignSheetTransform
            //     (both `from`/`to` with column/columnOffset/row/rowOffset)
            //   anchorType (string enum "0"|"1"|"2") — Position(0)=move with
            //     cells (fixed size), Both(1)=move+resize. Excel
            //     `twoCellAnchor` → Both; `oneCellAnchor` → Position.
            //     absoluteAnchor isn't reached because we skip it earlier.
            // The kind threaded out of `parse_drawing_anchors` is the
            // canonical source for which OOXML element this came from.
            let anchor_type = match anchor_kind {
                DrawingAnchorKind::OneCell => "0",
                DrawingAnchorKind::TwoCell => "1",
            };

            let image_entry = json!({
                "unitId": workbook_unit_id,
                "subUnitId": sheet_id,
                "drawingId": drawing_id,
                "drawingType": 0,                  // DrawingTypeEnum.DRAWING_IMAGE
                "imageSourceType": "BASE64",       // ImageSourceType.BASE64
                "source": data_url,
                "sheetTransform": sheet_transform.clone(),
                "axisAlignSheetTransform": sheet_transform,
                "anchorType": anchor_type,
            });

            order_ids.push(Value::String(drawing_id.clone()));
            data_map.insert(drawing_id, image_entry);
        }

        if !order_ids.is_empty() {
            subunit_map.insert(
                sheet_id.clone(),
                json!({
                    "data": Value::Object(data_map),
                    "order": Value::Array(order_ids),
                }),
            );
        }
    }

    if subunit_map.is_empty() {
        return (None, warnings);
    }

    // The resource hook's parseJson expects a JSON-stringified
    // IDrawingSubunitMap<ISheetImage>. We stringify here so the snapshot's
    // `resources` array matches the IResources shape:
    //   [{ name: "SHEET_DRAWING_PLUGIN", data: "<json>" }]
    let inner = match serde_json::to_string(&Value::Object(subunit_map)) {
        Ok(s) => s,
        Err(_) => return (None, warnings),
    };
    (
        Some(json!({
            "name": "SHEET_DRAWING_PLUGIN",
            "data": inner,
        })),
        warnings,
    )
}

// ============================================================================
// #312: _images normalisation (import) and regeneration (export)
// ============================================================================

/// One embedded image, mirroring the `ImageEntry` TS interface.
#[derive(Debug, Clone)]
pub(crate) struct ImageEntry {
    base64: String,
    ext: String,                // "png" | "jpg" | "gif" | "bmp"
    anchor_row: i32,
    anchor_col: i32,
    width_px: i32,
    height_px: i32,
    name: Option<String>,
    media_path: Option<String>,
}

impl ImageEntry {
    fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("base64".into(), Value::String(self.base64.clone()));
        obj.insert("ext".into(), Value::String(self.ext.clone()));
        obj.insert("anchorRow".into(), json!(self.anchor_row));
        obj.insert("anchorCol".into(), json!(self.anchor_col));
        obj.insert("widthPx".into(), json!(self.width_px));
        obj.insert("heightPx".into(), json!(self.height_px));
        if let Some(n) = &self.name {
            obj.insert("name".into(), Value::String(n.clone()));
        }
        if let Some(p) = &self.media_path {
            obj.insert("mediaPath".into(), Value::String(p.clone()));
        }
        Value::Object(obj)
    }
}

/// Walk every sheet's drawing XML and normalise embedded images into ImageEntry
/// values keyed by sheet id.  Successfully parsed images are removed from
/// _preservedParts.parts (XOR invariant: _images XOR parts[xl/media|drawings/*]).
/// Failures (absoluteAnchor, unsupported MIME, oversized media) are left in
/// _preservedParts and surfaced as warnings.
pub(crate) fn parse_xlsx_images<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_order: &[String],
    sheet_names_in_order: &[String],
    sheet_paths: &HashMap<String, String>,
    sheet_drawing_rids: &HashMap<String, String>,
    preserved_parts: Option<&mut Value>,
) -> (HashMap<String, Vec<ImageEntry>>, Vec<CompatibilityWarning>) {
    let mut warnings: Vec<CompatibilityWarning> = Vec::new();
    let mut result: HashMap<String, Vec<ImageEntry>> = HashMap::new();

    if sheet_order.len() != sheet_names_in_order.len() {
        return (result, warnings);
    }

    let mut normalised_media: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut normalised_drawings: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    for (i, sheet_id) in sheet_order.iter().enumerate() {
        let sheet_name = &sheet_names_in_order[i];
        let Some(sheet_part) = sheet_paths.get(sheet_name) else {
            continue;
        };
        let Some(drawing_rid) = sheet_drawing_rids.get(sheet_name) else {
            continue;
        };

        let sheet_rels_path = sheet_part_to_rels_path(sheet_part);
        let mut sheet_rels_xml = String::new();
        if let Ok(mut e) = archive.by_name(&sheet_rels_path) {
            let _ = std::io::Read::read_to_string(&mut e, &mut sheet_rels_xml);
        }
        let sheet_rels = parse_rels(&sheet_rels_xml);
        let Some(drawing_target_rel) = sheet_rels.get(drawing_rid) else {
            continue;
        };
        let drawing_part_path =
            resolve_rel_media_path("xl/worksheets/sheet.xml", drawing_target_rel);
        if drawing_part_path.is_empty() {
            continue;
        }

        let mut drawing_xml = String::new();
        if archive
            .by_name(&drawing_part_path)
            .ok()
            .and_then(|mut e| std::io::Read::read_to_string(&mut e, &mut drawing_xml).ok())
            .is_none()
        {
            continue;
        }

        // absoluteAnchor: skip normalisation, leave in _preservedParts.
        if drawing_xml.contains("<xdr:absoluteAnchor") || drawing_xml.contains("<absoluteAnchor") {
            warnings.push(CompatibilityWarning {
                severity: "warning".to_string(),
                code: "XLSX_DRAWING_ABSOLUTE_ANCHOR_UNSUPPORTED".to_string(),
                message: format!(
                    "Sheet '{sheet_name}' contains drawings with absoluteAnchor positioning; skipped from _images. Bytes preserved via _preservedParts."
                ),
                affected_sheets: Some(vec![sheet_name.clone()]),
            });
            continue;
        }

        let drawing_rels_path = sheet_part_to_rels_path(&drawing_part_path);
        let mut drawing_rels_xml = String::new();
        if let Ok(mut e) = archive.by_name(&drawing_rels_path) {
            let _ = std::io::Read::read_to_string(&mut e, &mut drawing_rels_xml);
        }
        let drawing_rels = parse_rels(&drawing_rels_xml);

        let anchors = parse_drawing_anchors(&drawing_xml);
        if anchors.is_empty() {
            continue;
        }

        let mut entries: Vec<ImageEntry> = Vec::new();
        let mut sheet_media: Vec<String> = Vec::new();
        let mut all_ok = true;

        for (_anchor_kind, range, embed_rid) in &anchors {
            let Some(media_target_rel) = drawing_rels.get(embed_rid) else {
                all_ok = false;
                continue;
            };
            let media_path = resolve_rel_media_path(&drawing_part_path, media_target_rel);
            if media_path.is_empty() {
                all_ok = false;
                continue;
            }

            let media_size = archive
                .by_name(&media_path)
                .ok()
                .map(|e| e.size() as usize)
                .unwrap_or(0);
            if media_size > PRESERVED_PART_SIZE_CAP {
                let mb = (media_size as f64) / (1024.0 * 1024.0);
                let cap_mb = (PRESERVED_PART_SIZE_CAP as f64) / (1024.0 * 1024.0);
                warnings.push(CompatibilityWarning {
                    severity: "warning".to_string(),
                    code: "XLSX_DRAWING_MEDIA_TOO_LARGE".to_string(),
                    message: format!(
                        "Embedded image at {media_path} is {mb:.1} MB; _images normalisation skipped (cap {cap_mb:.0} MB). Bytes preserved via _preservedParts."
                    ),
                    affected_sheets: Some(vec![sheet_name.clone()]),
                });
                all_ok = false;
                continue;
            }

            let mut media_bytes: Vec<u8> = Vec::new();
            if archive
                .by_name(&media_path)
                .ok()
                .and_then(|mut e| std::io::Read::read_to_end(&mut e, &mut media_bytes).ok())
                .is_none()
            {
                all_ok = false;
                continue;
            }

            let ext_raw = media_path
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            let ext = match ext_raw.as_str() {
                "png" => "png",
                "jpg" | "jpeg" => "jpg",
                "gif" => "gif",
                "bmp" => "bmp",
                _ => {
                    all_ok = false;
                    continue;
                }
            };

            let width_emu = (range.to.col_off_emu - range.from.col_off_emu).max(0);
            let height_emu = (range.to.row_off_emu - range.from.row_off_emu).max(0);

            entries.push(ImageEntry {
                base64: b64_encode(&media_bytes),
                ext: ext.to_string(),
                anchor_row: range.from.row,
                anchor_col: range.from.col,
                width_px: emu_to_px(width_emu),
                height_px: emu_to_px(height_emu),
                name: None,
                media_path: Some(media_path.clone()),
            });

            sheet_media.push(media_path);
        }

        // Only normalise this sheet's images when EVERY anchor parsed cleanly.
        // On partial failure we leave the whole sheet's media + drawing XML in
        // _preservedParts (byte-preserve) and do NOT stamp _images — this keeps
        // the XOR invariant intact in both directions: no image ends up in both
        // _images and _preservedParts, and no successfully-parsed image is
        // dropped from _preservedParts without a home in _images.
        if all_ok && !entries.is_empty() {
            normalised_drawings.insert(drawing_part_path.clone());
            normalised_drawings.insert(drawing_rels_path);
            for media_path in sheet_media {
                normalised_media.insert(media_path);
            }
            result.insert(sheet_id.clone(), entries);
        }
    }

    // Remove normalised entries from _preservedParts.parts (XOR invariant).
    if let Some(pp) = preserved_parts {
        if let Some(parts) = pp.get_mut("parts").and_then(|v| v.as_object_mut()) {
            for key in normalised_media.iter().chain(normalised_drawings.iter()) {
                parts.remove(key);
            }
        }
    }

    (result, warnings)
}

/// Remove all `<drawing .../>` self-closing elements from a worksheet XML
/// string so that `inject_images_to_xlsx` can replace them with a single
/// up-to-date reference without creating duplicates.
fn strip_drawing_elements(sheet_xml: &str) -> String {
    // Match <drawing .../> (self-closing, arbitrary attributes).
    let mut result = String::with_capacity(sheet_xml.len());
    let mut rest = sheet_xml;
    while let Some(start) = rest.find("<drawing ") {
        result.push_str(&rest[..start]);
        // Find the closing '/>' of the self-closing tag.
        let after = &rest[start..];
        if let Some(end_rel) = after.find("/>") {
            rest = &after[end_rel + 2..];
        } else {
            // Malformed: give up and keep the remainder as-is.
            result.push_str(after);
            return result;
        }
    }
    result.push_str(rest);
    result
}

/// Remove all `<Relationship ...>` elements whose `Type` is the drawing
/// relationship type from a sheet rels XML string.  Used by
/// `inject_images_to_xlsx` to avoid leaving dangling drawing references
/// (from the original import) after _images normalisation has removed those
/// drawing files from the zip.
fn strip_drawing_rels(rels_xml: &str) -> String {
    const DRAWING_TYPE: &str =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
    let rels: Vec<PreservedSheetRel> =
        extract_self_closing_or_paired(rels_xml, "Relationship")
            .into_iter()
            .filter_map(|el| PreservedSheetRel::from_xml(&el))
            .filter(|rel| rel.ty != DRAWING_TYPE)
            .collect();
    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    xml.push_str(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n",
    );
    for rel in rels {
        xml.push_str(&rel.raw);
        xml.push('\n');
    }
    xml.push_str("</Relationships>");
    xml
}

/// Re-generate xl/drawings + xl/media from sheets[id]._images in the snapshot.
/// Runs after inject_preserved_parts; uses 9001+ numbering to avoid collision.
pub(crate) fn inject_images_to_xlsx(
    tmp_path: &std::path::Path,
    snapshot: &Value,
    sheet_order: &[Value],
) -> Result<(), String> {
    use std::fs;
    use std::io::Cursor;
    use zip::{write::FileOptions, ZipArchive, ZipWriter};

    let sheets_obj = match snapshot.get("sheets").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return Ok(()),
    };

    let mut per_sheet: Vec<(usize, Vec<Value>)> = Vec::new();
    for (idx, sheet_id_val) in sheet_order.iter().enumerate() {
        let sheet_id = match sheet_id_val.as_str() {
            Some(s) => s,
            None => continue,
        };
        let images = sheets_obj
            .get(sheet_id)
            .and_then(|s| s.get("_images"))
            .and_then(|v| v.as_array())
            .map(|a| a.to_vec())
            .unwrap_or_default();
        if !images.is_empty() {
            per_sheet.push((idx, images));
        }
    }

    if per_sheet.is_empty() {
        return Ok(());
    }

    let original_bytes = fs::read(tmp_path).map_err(|e| e.to_string())?;
    let mut src = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;

    let mut max_img_n: u32 = 0;
    let mut max_drw_n: u32 = 0;
    for i in 0..src.len() {
        if let Ok(e) = src.by_index(i) {
            let name = e.name();
            if let Some(rest) = name.strip_prefix("xl/media/image") {
                if let Ok(n) = rest.split('.').next().unwrap_or("").parse::<u32>() {
                    if n > max_img_n { max_img_n = n; }
                }
            }
            if name.starts_with("xl/drawings/drawing") && name.ends_with(".xml") && !name.contains("_rels") {
                if let Some(rest) = name.strip_prefix("xl/drawings/drawing") {
                    if let Ok(n) = rest.strip_suffix(".xml").unwrap_or("").parse::<u32>() {
                        if n > max_drw_n { max_drw_n = n; }
                    }
                }
            }
        }
    }
    let mut global_img_n = max_img_n.max(9000) + 1;
    let mut global_drw_n = max_drw_n.max(9000) + 1;

    struct NewPart {
        name: String,
        bytes: Vec<u8>,
    }
    let mut new_parts: Vec<NewPart> = Vec::new();
    let mut sheet_drawing_inject: HashMap<usize, (String, String)> = HashMap::new();

    for (sheet_idx, images) in &per_sheet {
        let drawing_n = global_drw_n;
        global_drw_n += 1;

        let drawing_part = format!("xl/drawings/drawing{drawing_n}.xml");
        let drawing_rels_part = format!("xl/drawings/_rels/drawing{drawing_n}.xml.rels");
        let drawing_target = format!("../drawings/drawing{drawing_n}.xml");

        let mut dwg_xml = String::new();
        dwg_xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <xdr:wsDr xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\" \
             xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
             xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\n");

        let mut dwg_rels = String::new();
        dwg_rels.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n");

        let mut local_rid_n = 1u32;

        for img_json in images {
            let img_n = global_img_n;
            global_img_n += 1;

            let base64 = img_json.get("base64").and_then(|v| v.as_str()).unwrap_or("");
            let ext = img_json.get("ext").and_then(|v| v.as_str()).unwrap_or("png");
            let row = img_json.get("anchorRow").and_then(|v| v.as_i64()).unwrap_or(0);
            let col = img_json.get("anchorCol").and_then(|v| v.as_i64()).unwrap_or(0);
            let w = img_json.get("widthPx").and_then(|v| v.as_i64()).unwrap_or(96);
            let h = img_json.get("heightPx").and_then(|v| v.as_i64()).unwrap_or(96);
            let w_emu = w.max(1) * 9525;
            let h_emu = h.max(1) * 9525;
            let local_rid = format!("rId{local_rid_n}");
            local_rid_n += 1;

            if let Some(bytes) = b64_decode(base64) {
                new_parts.push(NewPart { name: format!("xl/media/image{img_n}.{ext}"), bytes });
            }

            dwg_rels.push_str(&format!(
                "<Relationship Id=\"{local_rid}\" \
                 Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" \
                 Target=\"../media/image{img_n}.{ext}\"/>\n"
            ));

            let pic_name = img_json.get("name").and_then(|v| v.as_str()).unwrap_or("Picture");
            let safe_name = encode_xml_text(pic_name);
            dwg_xml.push_str(&format!(
                "  <xdr:oneCellAnchor>\n\
                     <xdr:from><xdr:col>{col}</xdr:col><xdr:colOff>0</xdr:colOff>\
                 <xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>\n\
                     <xdr:ext cx=\"{w_emu}\" cy=\"{h_emu}\"/>\n\
                     <xdr:pic>\n\
                       <xdr:nvPicPr><xdr:cNvPr id=\"{img_n}\" name=\"{safe_name}\"/>\
                 <xdr:cNvPicPr/></xdr:nvPicPr>\n\
                       <xdr:blipFill><a:blip r:embed=\"{local_rid}\"/>\
                 <a:stretch><a:fillRect/></a:stretch></xdr:blipFill>\n\
                       <xdr:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/>\
                 <a:ext cx=\"{w_emu}\" cy=\"{h_emu}\"/></a:xfrm>\
                 <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></xdr:spPr>\n\
                     </xdr:pic>\n\
                     <xdr:clientData/>\n\
                   </xdr:oneCellAnchor>\n"
            ));
        }

        dwg_xml.push_str("</xdr:wsDr>");
        dwg_rels.push_str("</Relationships>");

        new_parts.push(NewPart { name: drawing_part, bytes: dwg_xml.into_bytes() });
        new_parts.push(NewPart { name: drawing_rels_part, bytes: dwg_rels.into_bytes() });

        let preferred_rid = format!("rId{}", 9000 + sheet_idx);
        sheet_drawing_inject.insert(*sheet_idx, (preferred_rid, drawing_target));
    }

    let mut skip_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    skip_names.insert("[Content_Types].xml".to_string());
    for idx in sheet_drawing_inject.keys() {
        let n = idx + 1;
        skip_names.insert(format!("xl/worksheets/sheet{n}.xml"));
        skip_names.insert(format!("xl/worksheets/_rels/sheet{n}.xml.rels"));
    }
    for p in &new_parts {
        skip_names.insert(p.name.clone());
    }

    let opts: FileOptions =
        FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut out_buf: Vec<u8> = Vec::with_capacity(original_bytes.len() + 64 * 1024);
    {
        let mut out = ZipWriter::new(Cursor::new(&mut out_buf));

        let mut src2 = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;
        for i in 0..src2.len() {
            let mut entry = src2.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            if skip_names.contains(&name) { continue; }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;
            out.start_file(&name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, &buf).map_err(|e| e.to_string())?;
        }

        let mut src3 = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;
        for (idx, (preferred_rid, drawing_target)) in &sheet_drawing_inject {
            let n = idx + 1;
            let sheet_entry = format!("xl/worksheets/sheet{n}.xml");
            let rels_entry = format!("xl/worksheets/_rels/sheet{n}.xml.rels");

            let mut sheet_xml = String::new();
            if let Ok(mut e) = src3.by_name(&sheet_entry) {
                let _ = std::io::Read::read_to_string(&mut e, &mut sheet_xml);
            }
            let mut existing_rels = String::new();
            if let Ok(mut e) = src3.by_name(&rels_entry) {
                let _ = std::io::Read::read_to_string(&mut e, &mut existing_rels);
            }

            // Strip any existing drawing rels so the old xl/drawings/drawingN.xml
            // reference (from the original import fixture) is not left dangling
            // after _images normalisation removes those drawing files from the zip.
            let stripped_rels = strip_drawing_rels(&existing_rels);

            let (new_rels, drawing_rid) = merge_sheet_rels(
                &stripped_rels,
                Some(&(preferred_rid.clone(), drawing_target.clone())),
                &[],
            );

            // Strip any existing <drawing .../> elements so the old import-time
            // reference is replaced rather than duplicated.
            let sheet_xml_stripped = strip_drawing_elements(&sheet_xml);
            let sheet_out = if let Some(rid) = &drawing_rid {
                if let Some(pos) = sheet_xml_stripped.rfind("</worksheet>") {
                    let mut s = String::with_capacity(sheet_xml_stripped.len() + 64);
                    s.push_str(&sheet_xml_stripped[..pos]);
                    s.push_str(&format!("<drawing r:id=\"{rid}\"/>"));
                    s.push_str(&sheet_xml_stripped[pos..]);
                    s
                } else { sheet_xml_stripped }
            } else { sheet_xml_stripped };

            out.start_file(&sheet_entry, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, sheet_out.as_bytes()).map_err(|e| e.to_string())?;
            out.start_file(&rels_entry, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, new_rels.as_bytes()).map_err(|e| e.to_string())?;
        }

        for p in &new_parts {
            out.start_file(&p.name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, &p.bytes).map_err(|e| e.to_string())?;
        }

        let mut new_ct = String::new();
        if let Ok(mut e) = src.by_name("[Content_Types].xml") {
            let _ = std::io::Read::read_to_string(&mut e, &mut new_ct);
        }
        let close_pos = new_ct.rfind("</Types>").unwrap_or(new_ct.len());
        let mut ct_adds = String::new();

        for p in &new_parts {
            if p.name.starts_with("xl/drawings/drawing") && p.name.ends_with(".xml") && !p.name.contains("_rels") {
                let part_name = format!("/{}", p.name);
                if !new_ct.contains(&format!("PartName=\"{part_name}\"")) {
                    ct_adds.push_str(&format!(
                        "<Override PartName=\"{part_name}\" ContentType=\"application/vnd.openxmlformats-officedocument.drawing+xml\"/>"
                    ));
                }
            }
        }
        const IMG_CT: &[(&str, &str)] = &[
            ("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"),
            ("gif", "image/gif"), ("bmp", "image/bmp"),
        ];
        for (ext, ct) in IMG_CT {
            if !new_ct.contains(&format!("Extension=\"{ext}\""))
                && !new_ct.contains(&format!("Extension=\"{}\"", ext.to_uppercase()))
            {
                ct_adds.push_str(&format!("<Default Extension=\"{ext}\" ContentType=\"{ct}\"/>"));
            }
        }

        let merged_ct = if ct_adds.is_empty() {
            new_ct
        } else {
            let mut s = String::with_capacity(new_ct.len() + ct_adds.len());
            s.push_str(&new_ct[..close_pos]);
            s.push_str(&ct_adds);
            s.push_str(&new_ct[close_pos..]);
            s
        };
        out.start_file("[Content_Types].xml", opts).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut out, merged_ct.as_bytes()).map_err(|e| e.to_string())?;

        out.finish().map_err(|e| e.to_string())?;
    }

    fs::write(tmp_path, &out_buf).map_err(|e| e.to_string())?;
    Ok(())
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

#[derive(Clone)]
struct PreservedSheetRel {
    id: String,
    ty: String,
    target: String,
    raw: String,
}

impl PreservedSheetRel {
    fn from_xml(el: &str) -> Option<Self> {
        let id = parse_attr(el, "Id")?;
        let ty = parse_attr(el, "Type")?;
        let target = parse_attr(el, "Target")?;
        Some(Self {
            id,
            ty,
            target,
            raw: el.to_string(),
        })
    }

    fn new(id: String, ty: &str, target: String) -> Self {
        let raw = format!(
            "<Relationship Id=\"{}\" Type=\"{}\" Target=\"{}\"/>",
            encode_xml_text(&id),
            encode_xml_text(ty),
            encode_xml_text(&target)
        );
        Self {
            id,
            ty: ty.to_string(),
            target,
            raw,
        }
    }
}

fn next_available_rid(used: &HashSet<String>) -> String {
    let mut n = 1usize;
    loop {
        let rid = format!("rId{n}");
        if !used.contains(&rid) {
            return rid;
        }
        n += 1;
    }
}

fn merge_one_sheet_rel(
    rels: &mut Vec<PreservedSheetRel>,
    used: &mut HashSet<String>,
    preferred_id: &str,
    ty: &str,
    target: &str,
) -> String {
    if let Some(existing) = rels
        .iter()
        .find(|rel| rel.id == preferred_id && rel.ty == ty && rel.target == target)
    {
        return existing.id.clone();
    }

    let id = if used.contains(preferred_id) {
        next_available_rid(used)
    } else {
        preferred_id.to_string()
    };
    used.insert(id.clone());
    rels.push(PreservedSheetRel::new(id.clone(), ty, target.to_string()));
    id
}

fn merge_sheet_rels(
    existing_xml: &str,
    drawing: Option<&(String, String)>,
    pivots: &[(String, String)],
) -> (String, Option<String>) {
    let mut rels: Vec<PreservedSheetRel> =
        extract_self_closing_or_paired(existing_xml, "Relationship")
            .into_iter()
            .filter_map(|el| PreservedSheetRel::from_xml(&el))
            .collect();
    let mut used: HashSet<String> = rels.iter().map(|rel| rel.id.clone()).collect();

    let drawing_rid = drawing.map(|(rid, target)| {
        merge_one_sheet_rel(
            &mut rels,
            &mut used,
            rid,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
            target,
        )
    });
    for (rid, target) in pivots {
        merge_one_sheet_rel(
            &mut rels,
            &mut used,
            rid,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable",
            target,
        );
    }

    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    xml.push_str(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n",
    );
    for rel in rels {
        xml.push_str(&rel.raw);
        xml.push('\n');
    }
    xml.push_str("</Relationships>");
    (xml, drawing_rid)
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
    let ext_link_rels: Vec<(String, String, String)> = preserved
        .get("workbookExternalLinkRels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let o = entry.as_object()?;
                    let rid = o.get("rid").and_then(|v| v.as_str())?.to_string();
                    let target = o.get("target").and_then(|v| v.as_str())?.to_string();
                    let ty = o
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink")
                        .to_string();
                    Some((rid, target, ty))
                })
                .collect()
        })
        .unwrap_or_default();
    let ext_refs_block: Option<String> = preserved
        .get("workbookExternalReferences")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let original_bytes = fs::read(tmp_path).map_err(|e| e.to_string())?;
    let mut src = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;

    let mut out_buf: Vec<u8> = Vec::with_capacity(original_bytes.len() + 4096);
    {
        let mut out = ZipWriter::new(Cursor::new(&mut out_buf));
        let opts: FileOptions =
            FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Track entries we will skip on copy because we're rewriting them.
        // Up to `sheet_order_len` sheet XMLs may need a `<drawing>` injection,
        // and a matching `_rels` file may need to be added/replaced.
        struct SheetRef {
            drawing: Option<(String, String)>, // (rId, target)
            pivots: Vec<(String, String)>,     // [(rId, target), ...]
        }
        let mut sheet_to_refs: HashMap<usize, SheetRef> = HashMap::new();
        for (idx, val) in sheet_refs.iter().enumerate() {
            if idx >= sheet_order_len {
                break;
            }
            let Some(obj) = val.as_object() else { continue };
            let drawing = match (
                obj.get("drawingRid").and_then(|v| v.as_str()),
                obj.get("drawingTarget").and_then(|v| v.as_str()),
            ) {
                (Some(rid), Some(target)) => Some((rid.to_string(), target.to_string())),
                _ => None,
            };
            let pivots: Vec<(String, String)> = obj
                .get("pivotRels")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|entry| {
                            let o = entry.as_object()?;
                            let rid = o.get("rid").and_then(|v| v.as_str())?;
                            let target = o.get("target").and_then(|v| v.as_str())?;
                            Some((rid.to_string(), target.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if drawing.is_some() || !pivots.is_empty() {
                sheet_to_refs.insert(idx, SheetRef { drawing, pivots });
            }
        }

        // We rewrite [Content_Types].xml and sheet XMLs / rels we touch.
        let mut skip_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        skip_names.insert("[Content_Types].xml".to_string());
        for idx in sheet_to_refs.keys() {
            let n = idx + 1;
            skip_names.insert(format!("xl/worksheets/sheet{n}.xml"));
            skip_names.insert(format!("xl/worksheets/_rels/sheet{n}.xml.rels"));
        }
        // Also skip any of the preserved-part target names so a stale empty
        // copy from rust_xlsxwriter (unlikely, but defensive) doesn't survive.
        for name in parts.keys() {
            skip_names.insert(name.clone());
        }
        // Workbook-level rewrites for external-link preservation: we splice
        // `<externalReferences>` back into workbook.xml and append externalLink
        // rels into workbook.xml.rels.
        let rewrite_workbook_xml = ext_refs_block.is_some();
        let rewrite_workbook_rels = !ext_link_rels.is_empty();
        if rewrite_workbook_xml {
            skip_names.insert("xl/workbook.xml".to_string());
        }
        if rewrite_workbook_rels {
            skip_names.insert("xl/_rels/workbook.xml.rels".to_string());
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
        // tail (when a drawing was preserved). Also merge drawing/pivot
        // relationships into any sheet rels that rust_xlsxwriter emitted
        // for hyperlinks, comments, etc. We must reopen src fresh because
        // we already exhausted the iterator above on the borrow that got
        // moved into the loop. Re-create archive.
        let mut src2 = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;
        for (idx, refs) in &sheet_to_refs {
            let n = idx + 1;
            let sheet_name = format!("xl/worksheets/sheet{n}.xml");
            let mut sheet_xml = String::new();
            if let Ok(mut e) = src2.by_name(&sheet_name) {
                let _ = std::io::Read::read_to_string(&mut e, &mut sheet_xml);
            }
            if sheet_xml.is_empty() {
                continue;
            }
            let rels_name = format!("xl/worksheets/_rels/sheet{n}.xml.rels");
            let mut existing_rels_xml = String::new();
            if let Ok(mut e) = src2.by_name(&rels_name) {
                let _ = std::io::Read::read_to_string(&mut e, &mut existing_rels_xml);
            }
            let (rels, drawing_rid) =
                merge_sheet_rels(&existing_rels_xml, refs.drawing.as_ref(), &refs.pivots);

            // Inject `<drawing r:id="..."/>` just before `</worksheet>` when we
            // have a drawing ref. Pivot tables are referenced only through the
            // sheet rels, so no sheet-body element is needed for them.
            let injected = if let Some(rid) = &drawing_rid {
                if let Some(pos) = sheet_xml.rfind("</worksheet>") {
                    let mut s = String::with_capacity(sheet_xml.len() + 64);
                    s.push_str(&sheet_xml[..pos]);
                    s.push_str(&format!("<drawing r:id=\"{rid}\"/>"));
                    s.push_str(&sheet_xml[pos..]);
                    s
                } else {
                    sheet_xml
                }
            } else {
                sheet_xml
            };
            out.start_file(&sheet_name, opts)
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, injected.as_bytes()).map_err(|e| e.to_string())?;

            out.start_file(&rels_name, opts)
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, rels.as_bytes()).map_err(|e| e.to_string())?;
        }

        // Workbook.xml / workbook.xml.rels rewrites for external-link
        // preservation. rust_xlsxwriter doesn't know about `<externalReferences>`
        // or the externalLink rels, so we splice them back in. #55: if a
        // preserved rId collides with rust_xlsxwriter's freshly-emitted ones,
        // we must remap to a fresh id and rewrite both the rels file and the
        // `<externalReference r:id="…">` references in workbook.xml so they
        // continue to point at the same entry.
        let mut wb_rels_xml_for_resolve = String::new();
        if rewrite_workbook_xml || rewrite_workbook_rels {
            if let Ok(mut e) = src.by_name("xl/_rels/workbook.xml.rels") {
                let _ = std::io::Read::read_to_string(&mut e, &mut wb_rels_xml_for_resolve);
            }
        }
        let rid_remap: HashMap<String, String> = if rewrite_workbook_rels {
            resolve_ext_link_rid_remap(&wb_rels_xml_for_resolve, &ext_link_rels)
        } else {
            HashMap::new()
        };
        if rewrite_workbook_xml {
            let mut wb_xml = String::new();
            if let Ok(mut e) = src.by_name("xl/workbook.xml") {
                let _ = std::io::Read::read_to_string(&mut e, &mut wb_xml);
            }
            let new_wb_xml = if let Some(block) = &ext_refs_block {
                let remapped_block = if rid_remap.is_empty() {
                    block.clone()
                } else {
                    remap_ext_reference_rids(block, &rid_remap)
                };
                splice_external_references(&wb_xml, &remapped_block)
            } else {
                wb_xml
            };
            out.start_file("xl/workbook.xml", opts)
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, new_wb_xml.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        if rewrite_workbook_rels {
            let new_wb_rels =
                append_workbook_rels(&wb_rels_xml_for_resolve, &ext_link_rels, &rid_remap);
            out.start_file("xl/_rels/workbook.xml.rels", opts)
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, new_wb_rels.as_bytes())
                .map_err(|e| e.to_string())?;
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
///
/// Also re-adds `<Default Extension="..."/>` entries for image extensions
/// (png/jpg/jpeg/gif/bmp/tiff) so embedded images injected back under
/// `xl/media/` still have a content-type advertised. rust_xlsxwriter drops
/// these Defaults when the workbook has no images of its own.
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

    // Also splice in `<Default Extension="..."/>` entries for image
    // extensions from the original — embedded images injected under
    // `xl/media/` need these or Excel will reject the file.
    const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff"];
    let mut cursor = 0usize;
    while let Some(rel) = original_ct[cursor..].find("<Default") {
        let start = cursor + rel;
        let rest = &original_ct[start..];
        let Some(end) = rest.find("/>") else { break };
        let tag = &original_ct[start..start + end + 2];
        cursor = start + end + 2;
        let ext = parse_attr(tag, "Extension")
            .unwrap_or_default()
            .to_lowercase();
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        if new_ct.contains(&format!("Extension=\"{ext}\""))
            || new_ct.contains(&format!("Extension=\"{}\"", ext.to_uppercase()))
        {
            continue;
        }
        adds.push(tag.to_string());
    }

    if adds.is_empty() {
        return new_ct.to_string();
    }
    // Inject right before the closing </Types>.
    if let Some(pos) = new_ct.rfind("</Types>") {
        let mut out =
            String::with_capacity(new_ct.len() + adds.iter().map(|s| s.len()).sum::<usize>() + 16);
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

/// Splice an `<externalReferences>...</externalReferences>` block into the
/// freshly-emitted `workbook.xml`. The block is inserted just before
/// `</workbook>`. If the new workbook.xml already carries one (defensive — it
/// shouldn't, since rust_xlsxwriter doesn't emit them), the original is left
/// alone.
fn splice_external_references(new_wb: &str, block: &str) -> String {
    if new_wb.contains("<externalReferences") {
        return new_wb.to_string();
    }
    if let Some(pos) = new_wb.rfind("</workbook>") {
        let mut s = String::with_capacity(new_wb.len() + block.len());
        s.push_str(&new_wb[..pos]);
        s.push_str(block);
        s.push_str(&new_wb[pos..]);
        s
    } else {
        new_wb.to_string()
    }
}

/// Append preserved externalLink `<Relationship>` entries to the workbook
/// rels file emitted by rust_xlsxwriter. Existing rels (sheets, styles,
/// shared strings, etc.) are kept; we just splice the new ones before
/// `</Relationships>`. Colliding rIds use the remap produced by
/// `resolve_ext_link_rid_remap` so the rels entry and the matching
/// `<externalReference>` block in workbook.xml agree on the new id.
fn append_workbook_rels(
    new_rels: &str,
    ext_links: &[(String, String, String)],
    rid_remap: &HashMap<String, String>,
) -> String {
    if ext_links.is_empty() {
        return new_rels.to_string();
    }
    let mut adds = String::new();
    for (rid, target, ty) in ext_links {
        let effective_rid = rid_remap.get(rid).cloned().unwrap_or_else(|| rid.clone());
        if new_rels.contains(&format!("Id=\"{effective_rid}\"")) {
            // Should not happen after remap, but be defensive against weird
            // input where a remap target was already used.
            continue;
        }
        adds.push_str(&format!(
            "<Relationship Id=\"{effective_rid}\" Type=\"{ty}\" Target=\"{target}\"/>"
        ));
    }
    if adds.is_empty() {
        return new_rels.to_string();
    }
    if let Some(pos) = new_rels.rfind("</Relationships>") {
        let mut s = String::with_capacity(new_rels.len() + adds.len());
        s.push_str(&new_rels[..pos]);
        s.push_str(&adds);
        s.push_str(&new_rels[pos..]);
        s
    } else {
        new_rels.to_string()
    }
}

/// Build a (old_rid → new_rid) remap for any preserved externalLink rId that
/// would collide with the rels file rust_xlsxwriter just emitted. Picks fresh
/// `rId<N>` values starting past the largest existing N so collisions in the
/// remap target are avoided. Non-colliding rIds map to themselves implicitly
/// (callers fall back to the input rId when the map has no entry).
fn resolve_ext_link_rid_remap(
    new_rels: &str,
    ext_links: &[(String, String, String)],
) -> HashMap<String, String> {
    let mut remap = HashMap::new();
    if ext_links.is_empty() {
        return remap;
    }

    // Highest existing `rId<N>` in the rels file.
    let mut max_n: u64 = 0;
    let mut i = 0;
    let bytes = new_rels.as_bytes();
    let needle = b"Id=\"rId";
    while i + needle.len() < bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let start = i + needle.len();
            let mut j = start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > start {
                if let Ok(s) = std::str::from_utf8(&bytes[start..j]) {
                    if let Ok(n) = s.parse::<u64>() {
                        if n > max_n {
                            max_n = n;
                        }
                    }
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }

    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut next_n = max_n + 1;
    for (rid, _target, _ty) in ext_links {
        let collides = new_rels.contains(&format!("Id=\"{rid}\""));
        if !collides {
            continue;
        }
        // Find a fresh rId<N> not used by the rels file or by an earlier remap.
        let new_rid = loop {
            let candidate = format!("rId{next_n}");
            next_n += 1;
            if !new_rels.contains(&format!("Id=\"{candidate}\"")) && !used.contains(&candidate) {
                break candidate;
            }
        };
        used.insert(new_rid.clone());
        remap.insert(rid.clone(), new_rid);
    }
    remap
}

/// Rewrite each `<externalReference r:id="OLD"/>` in `block` so that OLD is
/// replaced with its remap target when one exists. Walks the block once and
/// emits a fresh string; preserves attribute order and whitespace.
fn remap_ext_reference_rids(block: &str, rid_remap: &HashMap<String, String>) -> String {
    if rid_remap.is_empty() {
        return block.to_string();
    }
    let mut out = String::with_capacity(block.len());
    let mut rest = block;
    let attr_marker = "r:id=\"";
    while let Some(idx) = rest.find(attr_marker) {
        out.push_str(&rest[..idx + attr_marker.len()]);
        let after = &rest[idx + attr_marker.len()..];
        if let Some(end) = after.find('"') {
            let old_rid = &after[..end];
            let new_rid = rid_remap.get(old_rid).cloned().unwrap_or_else(|| old_rid.to_string());
            out.push_str(&new_rid);
            out.push('"');
            rest = &after[end + 1..];
        } else {
            // Malformed input — bail out and emit the rest verbatim.
            out.push_str(after);
            return out;
        }
    }
    out.push_str(rest);
    out
}

// ============================================================================
// Coco extension parts (#105 / #120)
//
// Several feature snapshots — tables, sparklines, outline groups, pivot
// metadata, slicers, scenarios, sheet notes, Coco-authored charts, and the
// threaded-comments extras (replies / resolved / resolvedAt / resolvedBy /
// createdAt) — have no canonical OOXML representation that Coco's writer can
// emit. Rather than silently dropping them, we serialize each family into a
// dedicated JSON part under `xl/cocoExtensions/<feature>.json` inside the
// output xlsx. Excel itself ignores unknown parts under `xl/` so the file
// stays valid for Excel/Sheets; Coco re-reads the parts on import and merges
// the values back into the snapshot at the original locations.
//
// Bundle structure for per-sheet families:
//
//     { "bySheetIndex": { "0": <field-value>, "1": <field-value>, ... } }
//
// The sheet index is the 0-based position in `sheetOrder` (stable across
// round-trip — import always assigns `sheet-{N}` ids in sheet order, so we
// never need to track the original snapshot id).
//
// For `_scenarios` (workbook-root) the file body is the raw field value.
//
// For threaded-comments extras the bundle is per-sheet AND per-cell:
//
//     { "bySheetIndex": { "<idx>": { "<cellRef>": { replies?: [...],
//       resolved?: bool, resolvedAt?: string, resolvedBy?: string,
//       createdAt?: string } } } }
// ============================================================================

/// Per-sheet snapshot fields we preserve via cocoExtensions parts.
/// Tuple: (snapshot key, target file stem). The file stem is appended to
/// `xl/cocoExtensions/` and gets a `.json` extension.
const COCO_EXTENSION_SHEET_FIELDS: &[(&str, &str)] = &[
    ("_outlineRows", "outlineRows"),
    ("_outlineCols", "outlineCols"),
    ("_tables", "tables"),
    ("_sparklines", "sparklines"),
    ("_pivots", "pivots"),
    ("_slicers", "slicers"),
    ("_note", "notes"),
    ("_charts", "charts"),
    // #150 / #183: cell checkboxes + form controls (radio / spin / scroll).
    // The control's *value* lives in a plain cell so it round-trips through
    // xlsx natively; this part preserves the control metadata (which cells
    // are decorated, group ids, min/max/step) that has no OOXML equivalent
    // Coco's writer can emit. Re-read on import and merged back per sheet.
    ("_checkboxes", "checkboxes"),
    ("_formControls", "formControls"),
];

/// Workbook-root fields preserved as standalone JSON parts.
const COCO_EXTENSION_ROOT_FIELDS: &[(&str, &str)] =
    &[("_scenarios", "scenarios"), ("_cameraLinks", "cameraLinks")];

/// Threaded-comments extra-field keys captured per cell inside `_comments[]`.
const COCO_THREADED_COMMENT_KEYS: &[&str] = &[
    "replies",
    "resolved",
    "resolvedAt",
    "resolvedBy",
    "createdAt",
];

/// User-facing label per family — used by the warning emitter so users see
/// concrete field names rather than internal snapshot keys.
fn coco_extension_label_ja(file_stem: &str) -> &'static str {
    match file_stem {
        "outlineRows" => "アウトライン(行)",
        "outlineCols" => "アウトライン(列)",
        "tables" => "テーブル",
        "sparklines" => "スパークライン",
        "pivots" => "ピボットテーブル設定",
        "slicers" => "スライサー",
        "notes" => "シートメモ",
        "charts" => "Coco作成のチャート",
        "scenarios" => "シナリオ",
        "cameraLinks" => "カメラ画像",
        "checkboxes" => "チェックボックス",
        "formControls" => "フォームコントロール",
        "threadedComments" => "コメント返信/解決状態",
        _ => "Coco拡張データ",
    }
}

/// #184 M-1: blank the `dataUrl` of every entry in a `_cameraLinks` array so
/// the xlsx-bound bundle stays small. Each `dataUrl` is a baked PNG that the
/// frontend regenerates from its source range on load; only the link metadata
/// (id, ranges, anchors, broken flag) needs to survive the round trip.
/// Non-array / non-object input is returned untouched.
fn strip_camera_data_urls(val: &Value) -> Value {
    let Some(arr) = val.as_array() else {
        return val.clone();
    };
    let stripped: Vec<Value> = arr
        .iter()
        .map(|entry| {
            let mut e = entry.clone();
            if let Some(obj) = e.as_object_mut() {
                if obj.contains_key("dataUrl") {
                    obj.insert("dataUrl".to_string(), Value::String(String::new()));
                }
            }
            e
        })
        .collect();
    Value::Array(stripped)
}

/// Build the per-feature JSON bundles that must be written into the output
/// xlsx as `xl/cocoExtensions/*.json` parts. Returns:
///   - `bundles`: map from full zip part path → JSON bytes
///   - `families`: ordered list of file stems that actually produced a bundle,
///     used by the export path to emit one CompatibilityWarning per family.
fn build_coco_extension_bundles(
    snapshot: &Value,
    sheet_order: &[Value],
) -> (HashMap<String, Vec<u8>>, Vec<String>) {
    let mut bundles: HashMap<String, Vec<u8>> = HashMap::new();
    let mut families: Vec<String> = Vec::new();

    let sheets_obj = snapshot.get("sheets").and_then(|v| v.as_object());

    // Per-sheet families.
    for (snap_key, file_stem) in COCO_EXTENSION_SHEET_FIELDS {
        let mut by_idx: Map<String, Value> = Map::new();
        if let Some(sheets) = sheets_obj {
            for (idx, sid_val) in sheet_order.iter().enumerate() {
                let Some(sid) = sid_val.as_str() else { continue };
                let Some(sheet) = sheets.get(sid) else { continue };
                if let Some(val) = sheet.get(*snap_key) {
                    if !val.is_null() {
                        by_idx.insert(idx.to_string(), val.clone());
                    }
                }
            }
        }
        if !by_idx.is_empty() {
            let body = json!({ "bySheetIndex": Value::Object(by_idx) });
            if let Ok(bytes) = serde_json::to_vec(&body) {
                bundles.insert(
                    format!("xl/cocoExtensions/{file_stem}.json"),
                    bytes,
                );
                families.push((*file_stem).to_string());
            }
        }
    }

    // Workbook-root families.
    for (snap_key, file_stem) in COCO_EXTENSION_ROOT_FIELDS {
        if let Some(val) = snapshot.get(*snap_key) {
            if !val.is_null() {
                // #184 M-1: a camera link's `dataUrl` is a baked PNG (base64,
                // up to a few hundred KB) — persisting all 50 into the xlsx
                // would bloat the file by tens of MB. Strip every `dataUrl`
                // before serializing; the frontend's live re-render effect
                // re-bakes them from the source range after load. .coco saves
                // (SQLite) keep the dataUrl since size pressure there is lower.
                let payload = if *file_stem == "cameraLinks" {
                    strip_camera_data_urls(val)
                } else {
                    val.clone()
                };
                if let Ok(bytes) = serde_json::to_vec(&payload) {
                    bundles.insert(
                        format!("xl/cocoExtensions/{file_stem}.json"),
                        bytes,
                    );
                    families.push((*file_stem).to_string());
                }
            }
        }
    }

    // Threaded-comments extras. Walk every sheet's `_comments[]`; capture any
    // entry that carries one of `COCO_THREADED_COMMENT_KEYS` keyed by cell
    // ref. The legacy `xl/commentsN.xml` body still carries cell/author/text,
    // so this part only covers the additive fields Excel can't store natively.
    let mut threaded_by_idx: Map<String, Value> = Map::new();
    if let Some(sheets) = sheets_obj {
        for (idx, sid_val) in sheet_order.iter().enumerate() {
            let Some(sid) = sid_val.as_str() else { continue };
            let Some(sheet) = sheets.get(sid) else { continue };
            let Some(arr) = sheet.get("_comments").and_then(|v| v.as_array()) else {
                continue;
            };
            let mut per_cell: Map<String, Value> = Map::new();
            for entry in arr {
                let Some(obj) = entry.as_object() else { continue };
                let cell_ref = obj
                    .get("cell")
                    .and_then(|v| v.as_str())
                    .or_else(|| obj.get("cellRef").and_then(|v| v.as_str()))
                    .map(|s| s.to_string());
                let Some(cell_ref) = cell_ref else { continue };
                let mut extras: Map<String, Value> = Map::new();
                for k in COCO_THREADED_COMMENT_KEYS {
                    if let Some(v) = obj.get(*k) {
                        if !v.is_null() {
                            extras.insert((*k).to_string(), v.clone());
                        }
                    }
                }
                if !extras.is_empty() {
                    per_cell.insert(cell_ref, Value::Object(extras));
                }
            }
            if !per_cell.is_empty() {
                threaded_by_idx.insert(idx.to_string(), Value::Object(per_cell));
            }
        }
    }
    if !threaded_by_idx.is_empty() {
        let body = json!({ "bySheetIndex": Value::Object(threaded_by_idx) });
        if let Ok(bytes) = serde_json::to_vec(&body) {
            bundles.insert(
                "xl/cocoExtensions/threadedComments.json".to_string(),
                bytes,
            );
            families.push("threadedComments".to_string());
        }
    }

    (bundles, families)
}

/// Reopen the freshly-written xlsx at `tmp_path` and append the cocoExtensions
/// JSON parts. Excel ignores unknown `xl/` parts so we don't have to touch
/// `[Content_Types].xml` — Excel only complains when an Override declares a
/// part that doesn't exist, not the other way around. (We deliberately skip
/// declaring our own content type so that the file stays maximally compatible
/// with strict OOXML validators that reject unknown content types.)
fn inject_coco_extensions(
    tmp_path: &std::path::Path,
    bundles: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    use std::fs;
    use std::io::Cursor;
    use zip::{write::FileOptions, ZipArchive, ZipWriter};

    if bundles.is_empty() {
        return Ok(());
    }

    let original_bytes = fs::read(tmp_path).map_err(|e| e.to_string())?;
    let mut src = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;

    let mut out_buf: Vec<u8> = Vec::with_capacity(original_bytes.len() + 4096);
    {
        let mut out = ZipWriter::new(Cursor::new(&mut out_buf));
        let opts: FileOptions =
            FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Skip any pre-existing entries with the same target paths so a
        // round-trip (import → export with the same snapshot) overwrites
        // rather than duplicates.
        let skip: HashSet<String> = bundles.keys().cloned().collect();

        for i in 0..src.len() {
            let mut entry = src.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            if skip.contains(&name) {
                continue;
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;
            out.start_file(&name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, &buf).map_err(|e| e.to_string())?;
        }

        for (name, bytes) in bundles {
            out.start_file(name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, bytes).map_err(|e| e.to_string())?;
        }

        out.finish().map_err(|e| e.to_string())?;
    }

    fs::write(tmp_path, &out_buf).map_err(|e| e.to_string())?;
    Ok(())
}

/// Per-family upper bound on the JSON body we'll merge back from a
/// cocoExtensions part. Defense-in-depth: a hostile or corrupt xlsx must not
/// inflate the snapshot beyond what the export path will accept.
const COCO_EXTENSION_PART_CAP_BYTES: u64 = 16 * 1024 * 1024;

/// Read all `xl/cocoExtensions/*.json` parts from the input archive. Returns
/// a map from file stem (e.g. `"tables"`) → parsed JSON value (the bundle
/// object as produced by `build_coco_extension_bundles`).
fn read_coco_extensions<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> HashMap<String, Value> {
    let mut out: HashMap<String, Value> = HashMap::new();

    // Collect names first to avoid re-borrowing the archive while iterating.
    let mut names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            if name.starts_with("xl/cocoExtensions/")
                && name.ends_with(".json")
                && entry.size() <= COCO_EXTENSION_PART_CAP_BYTES
            {
                names.push(name);
            }
        }
    }

    for name in names {
        let Ok(mut entry) = archive.by_name(&name) else {
            continue;
        };
        let mut buf = String::new();
        if std::io::Read::read_to_string(&mut entry, &mut buf).is_err() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&buf) else {
            continue;
        };
        // Strip path prefix and `.json` suffix to recover the family stem.
        let stem = name
            .strip_prefix("xl/cocoExtensions/")
            .and_then(|s| s.strip_suffix(".json"))
            .unwrap_or("");
        if !stem.is_empty() {
            out.insert(stem.to_string(), val);
        }
    }

    out
}

/// Detect whether the archive looks like a Coco-authored workbook by
/// scanning `docProps/core.xml` for the literal string "Coco" inside either
/// `<dc:creator>` or `<cp:lastModifiedBy>`. Returns true on a match. This is
/// a coarse heuristic — false positives only matter when paired with the
/// "no cocoExtensions parts present" condition (see Bug 4): together they
/// mean the file used to carry Coco extension data that has since been
/// stripped (most likely by Excel re-saving the file). False negatives are
/// preferable to crashing on a malformed core.xml so any read/parse error
/// short-circuits to `false`.
fn xlsx_looks_coco_authored<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> bool {
    let Ok(mut entry) = archive.by_name("docProps/core.xml") else {
        return false;
    };
    let mut buf = String::new();
    if std::io::Read::read_to_string(&mut entry, &mut buf).is_err() {
        return false;
    }
    // Scan only the dc:creator and cp:lastModifiedBy elements so a stray
    // "Coco" in a title/subject field doesn't trigger a false positive.
    contains_coco_in_element(&buf, "dc:creator")
        || contains_coco_in_element(&buf, "cp:lastModifiedBy")
}

// True when the named XML element (taking the first occurrence) has a body
// that contains the substring "Coco" (case-sensitive — matches the exported
// app name). Skips closing tags and empty / self-closed elements.
fn contains_coco_in_element(xml: &str, tag: &str) -> bool {
    // Find `<tag` (open) and then the matching close `</tag>`. We don't try
    // to handle full XML namespaces — `dc:creator` and `cp:lastModifiedBy`
    // are stable in OOXML core.xml.
    let open_marker = format!("<{tag}");
    let close_marker = format!("</{tag}>");
    let Some(open_idx) = xml.find(&open_marker) else {
        return false;
    };
    // Move past the opening tag itself (find the `>` that terminates it).
    let after_open = &xml[open_idx..];
    let Some(gt_off) = after_open.find('>') else {
        return false;
    };
    let body_start = open_idx + gt_off + 1;
    let Some(close_off) = xml[body_start..].find(&close_marker) else {
        return false;
    };
    let body = &xml[body_start..body_start + close_off];
    body.contains("Coco")
}

/// Merge the cocoExtensions bundles back into the snapshot at the locations
/// the export path captured them from. Skips families we don't recognize so
/// future cocoExtension parts written by a newer Coco can round-trip without
/// requiring this reader to know about them (they just won't surface in the
/// in-memory snapshot — an acceptable loss for forward compatibility).
fn merge_coco_extensions_into_snapshot(
    snapshot: &mut Value,
    bundles: &HashMap<String, Value>,
) {
    if bundles.is_empty() {
        return;
    }
    let snap_obj = match snapshot.as_object_mut() {
        Some(o) => o,
        None => return,
    };

    let sheet_order: Vec<String> = snap_obj
        .get("sheetOrder")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // Helper: extract `bySheetIndex` object from a bundle.
    let by_sheet = |bundle: &Value| -> Option<Map<String, Value>> {
        bundle
            .get("bySheetIndex")
            .and_then(|v| v.as_object())
            .cloned()
    };

    // Per-sheet families.
    for (snap_key, file_stem) in COCO_EXTENSION_SHEET_FIELDS {
        let Some(bundle) = bundles.get(*file_stem) else {
            continue;
        };
        let Some(map) = by_sheet(bundle) else { continue };
        let sheets_obj = match snap_obj
            .get_mut("sheets")
            .and_then(|v| v.as_object_mut())
        {
            Some(o) => o,
            None => continue,
        };
        for (idx_str, val) in map {
            let Ok(idx) = idx_str.parse::<usize>() else { continue };
            let Some(sid) = sheet_order.get(idx) else { continue };
            let Some(sheet) = sheets_obj.get_mut(sid).and_then(|v| v.as_object_mut()) else {
                continue;
            };
            sheet.insert((*snap_key).to_string(), val);
        }
    }

    // Workbook-root families.
    for (snap_key, file_stem) in COCO_EXTENSION_ROOT_FIELDS {
        if let Some(bundle) = bundles.get(*file_stem) {
            snap_obj.insert((*snap_key).to_string(), bundle.clone());
        }
    }

    // Threaded-comments extras: merge per-cell extras back into each sheet's
    // `_comments[]` row that matches by cell ref. Skips silently when no
    // `_comments` row matches a recorded cell — the legacy comment must
    // survive even if the extras can't be re-anchored.
    if let Some(bundle) = bundles.get("threadedComments") {
        if let Some(map) = by_sheet(bundle) {
            let sheets_obj = snap_obj
                .get_mut("sheets")
                .and_then(|v| v.as_object_mut());
            if let Some(sheets_obj) = sheets_obj {
                for (idx_str, per_cell_val) in map {
                    let Ok(idx) = idx_str.parse::<usize>() else { continue };
                    let Some(sid) = sheet_order.get(idx) else { continue };
                    let Some(per_cell) = per_cell_val.as_object() else { continue };
                    let Some(sheet) = sheets_obj
                        .get_mut(sid)
                        .and_then(|v| v.as_object_mut())
                    else {
                        continue;
                    };
                    let Some(arr) = sheet
                        .get_mut("_comments")
                        .and_then(|v| v.as_array_mut())
                    else {
                        continue;
                    };
                    for entry in arr.iter_mut() {
                        let Some(obj) = entry.as_object_mut() else { continue };
                        let cell_ref = obj
                            .get("cell")
                            .and_then(|v| v.as_str())
                            .or_else(|| obj.get("cellRef").and_then(|v| v.as_str()))
                            .map(|s| s.to_string());
                        let Some(cell_ref) = cell_ref else { continue };
                        if let Some(extras) = per_cell.get(&cell_ref).and_then(|v| v.as_object()) {
                            for (k, v) in extras {
                                obj.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod camera_link_tests {
    use super::strip_camera_data_urls;
    use serde_json::json;

    #[test]
    fn blanks_data_url_on_every_link() {
        let input = json!([
            { "id": "camera-1", "dataUrl": "data:image/png;base64,AAAA", "broken": false },
            { "id": "camera-2", "dataUrl": "data:image/png;base64,BBBB", "broken": true },
        ]);
        let out = strip_camera_data_urls(&input);
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        for entry in arr {
            assert_eq!(entry.get("dataUrl").unwrap().as_str().unwrap(), "");
        }
        // Non-dataUrl metadata survives untouched.
        assert_eq!(arr[0].get("id").unwrap(), "camera-1");
        assert_eq!(arr[1].get("broken").unwrap(), &json!(true));
    }

    #[test]
    fn leaves_links_without_data_url_alone() {
        let input = json!([{ "id": "camera-1", "broken": false }]);
        let out = strip_camera_data_urls(&input);
        assert!(out.as_array().unwrap()[0].get("dataUrl").is_none());
    }

    #[test]
    fn passes_non_array_through_unchanged() {
        let input = json!({ "not": "an array" });
        assert_eq!(strip_camera_data_urls(&input), input);
    }
}

#[cfg(test)]
mod freeze_projection_tests {
    use super::freeze_field_for_pane;
    use serde_json::json;

    #[test]
    fn frozen_pane_projects_onto_univer_freeze() {
        // A 3-row / 2-col frozen pane on a generously sized sheet.
        let out = freeze_field_for_pane(3, 2, 1000, 100).unwrap();
        assert_eq!(
            out,
            json!({ "xSplit": 2, "ySplit": 3, "startRow": 3, "startColumn": 2 })
        );
    }

    #[test]
    fn row_only_pane_uses_minus_one_column_sentinel() {
        // Horizontal-only split/freeze: startColumn stays at Univer's
        // "no freeze on this axis" sentinel (-1).
        let out = freeze_field_for_pane(5, 0, 1000, 100).unwrap();
        assert_eq!(
            out,
            json!({ "xSplit": 0, "ySplit": 5, "startRow": 5, "startColumn": -1 })
        );
    }

    #[test]
    fn col_only_pane_uses_minus_one_row_sentinel() {
        // Vertical-only split/freeze: startRow stays at the -1 sentinel.
        let out = freeze_field_for_pane(0, 4, 1000, 100).unwrap();
        assert_eq!(
            out,
            json!({ "xSplit": 4, "ySplit": 0, "startRow": -1, "startColumn": 4 })
        );
    }

    #[test]
    fn degenerate_zero_zero_pane_is_dropped() {
        // {0,0} is a no-op pane — no projection.
        assert!(freeze_field_for_pane(0, 0, 1000, 100).is_none());
    }

    #[test]
    fn out_of_bounds_anchor_is_rejected() {
        // Excel-authored splits store pixel/twip offsets in row/col, which can
        // dwarf the sheet. Such an anchor must NOT be projected (clamping
        // would silently shift the freeze line).
        assert!(freeze_field_for_pane(5000, 0, 1000, 100).is_none());
        assert!(freeze_field_for_pane(0, 9999, 1000, 100).is_none());
        // Anchor exactly at the bound is also out of range (0-based indices).
        assert!(freeze_field_for_pane(1000, 0, 1000, 100).is_none());
        assert!(freeze_field_for_pane(0, 100, 1000, 100).is_none());
    }

    #[test]
    fn in_bounds_anchor_just_below_limit_is_kept() {
        // The last valid index (count - 1) still projects.
        let out = freeze_field_for_pane(999, 99, 1000, 100).unwrap();
        assert_eq!(
            out,
            json!({ "xSplit": 99, "ySplit": 999, "startRow": 999, "startColumn": 99 })
        );
    }
}

// ============================================================================
// #309: Coco-new CheckBox OOXML emit
// ============================================================================

/// Unified form control entry for OOXML emit. Covers CheckBox (#309) as well
/// as Radio, Spinner, and ScrollBar (#322).
#[derive(Debug)]
enum CocoNewFormControl {
    CheckBox {
        row: u32,
        col: u32,
        label: String,
        checked: bool,
        fmla_link: Option<String>,
    },
    Radio {
        row: u32,
        col: u32,
        label: String,
        checked: bool,
        first_button: bool,
        fmla_link: Option<String>,
    },
    Spinner {
        row: u32,
        col: u32,
        min: i64,
        max: i64,
        inc: i64,
        page: i64,
        fmla_link: Option<String>,
    },
    ScrollBar {
        row: u32,
        col: u32,
        min: i64,
        max: i64,
        inc: i64,
        page: i64,
        horiz: bool,
        fmla_link: Option<String>,
    },
}

impl CocoNewFormControl {
    fn row(&self) -> u32 {
        match self {
            Self::CheckBox { row, .. } | Self::Radio { row, .. }
            | Self::Spinner { row, .. } | Self::ScrollBar { row, .. } => *row,
        }
    }
    fn col(&self) -> u32 {
        match self {
            Self::CheckBox { col, .. } | Self::Radio { col, .. }
            | Self::Spinner { col, .. } | Self::ScrollBar { col, .. } => *col,
        }
    }
}

fn collect_coco_new_checkboxes(
    snapshot: &Value,
    sheet_order: &[Value],
) -> Vec<(usize, Vec<CocoNewFormControl>)> {
    let mut result: Vec<(usize, Vec<CocoNewFormControl>)> = Vec::new();
    let Some(sheets_obj) = snapshot.get("sheets").and_then(|v| v.as_object()) else {
        return result;
    };
    for (sheet_idx, sid_val) in sheet_order.iter().enumerate() {
        let Some(sid) = sid_val.as_str() else { continue };
        let Some(sheet) = sheets_obj.get(sid) else { continue };

        let mut controls: Vec<CocoNewFormControl> = Vec::new();

        // --- _checkboxes (CheckBox, #309) ---
        if let Some(arr) = sheet.get("_checkboxes").and_then(|v| v.as_array()) {
            for cb_val in arr {
                let Some(obj) = cb_val.as_object() else { continue };
                let provenance = obj.get("_provenance").and_then(|v| v.as_str()).unwrap_or("");
                if provenance != "coco-new" {
                    continue;
                }
                controls.push(CocoNewFormControl::CheckBox {
                    row: obj.get("row").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    col: obj.get("col").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    label: obj
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or("CheckBox")
                        .to_string(),
                    checked: obj.get("checked").and_then(|v| v.as_bool()).unwrap_or(false),
                    fmla_link: obj
                        .get("fmlaLink")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
        }

        // --- _formControls (Radio / Spinner / ScrollBar, #322) ---
        if let Some(arr) = sheet.get("_formControls").and_then(|v| v.as_array()) {
            for fc_val in arr {
                let Some(obj) = fc_val.as_object() else { continue };
                let provenance = obj.get("_provenance").and_then(|v| v.as_str()).unwrap_or("");
                if provenance != "coco-new" {
                    continue;
                }
                let kind = obj.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                // Resolve (row, col): prefer explicit fields, else parse `cell` A1 ref.
                let (row, col) = if let (Some(r), Some(c)) = (
                    obj.get("row").and_then(|v| v.as_u64()),
                    obj.get("col").and_then(|v| v.as_u64()),
                ) {
                    (r as u32, c as u32)
                } else if let Some(cell_str) = obj.get("cell").and_then(|v| v.as_str()) {
                    match parse_a1(cell_str) {
                        Some((r, c)) => (r, c),
                        None => continue,
                    }
                } else {
                    continue;
                };
                let fmla_link = obj
                    .get("fmlaLink")
                    .or_else(|| obj.get("linkedCell"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                match kind {
                    "radio" => {
                        controls.push(CocoNewFormControl::Radio {
                            row,
                            col,
                            label: obj.get("label").and_then(|v| v.as_str())
                                .unwrap_or("Option").to_string(),
                            checked: obj.get("checked").and_then(|v| v.as_bool()).unwrap_or(false),
                            first_button: obj.get("firstButton").and_then(|v| v.as_bool()).unwrap_or(false),
                            fmla_link,
                        });
                    }
                    "spin" => {
                        controls.push(CocoNewFormControl::Spinner {
                            row,
                            col,
                            min: obj.get("min").and_then(|v| v.as_i64()).unwrap_or(0),
                            max: obj.get("max").and_then(|v| v.as_i64()).unwrap_or(100),
                            inc: obj.get("step").and_then(|v| v.as_i64()).unwrap_or(1),
                            page: obj.get("page").and_then(|v| v.as_i64()).unwrap_or(10),
                            fmla_link,
                        });
                    }
                    "scroll" => {
                        controls.push(CocoNewFormControl::ScrollBar {
                            row,
                            col,
                            min: obj.get("min").and_then(|v| v.as_i64()).unwrap_or(0),
                            max: obj.get("max").and_then(|v| v.as_i64()).unwrap_or(100),
                            inc: obj.get("step").and_then(|v| v.as_i64()).unwrap_or(1),
                            page: obj.get("page").and_then(|v| v.as_i64()).unwrap_or(10),
                            horiz: obj.get("horiz").and_then(|v| v.as_bool()).unwrap_or(false),
                            fmla_link,
                        });
                    }
                    _ => {}
                }
            }
        }

        if !controls.is_empty() {
            result.push((sheet_idx, controls));
        }
    }
    result
}

fn build_ctrl_prop_xml_309(fc: &CocoNewFormControl) -> String {
    match fc {
        CocoNewFormControl::CheckBox { checked, fmla_link, .. } => {
            let checked_attr = if *checked { "Checked" } else { "Unchecked" };
            let fmla_link_attr = fmla_link
                .as_deref()
                .map(|l| format!(" fmlaLink=\"{}\"", encode_xml_text(l)))
                .unwrap_or_default();
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
\n<formControlPr xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main\" \
objectType=\"CheckBox\" checked=\"{checked_attr}\"{fmla_link_attr} \
lockText=\"1\" defaultSize=\"0\" noThreeD=\"1\"/>\n"
            )
        }
        CocoNewFormControl::Radio { checked, first_button, fmla_link, .. } => {
            let checked_attr = if *checked { "Checked" } else { "Unchecked" };
            let first_attr = if *first_button { " firstButton=\"1\"" } else { "" };
            let fmla_link_attr = fmla_link
                .as_deref()
                .map(|l| format!(" fmlaLink=\"{}\"", encode_xml_text(l)))
                .unwrap_or_default();
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
\n<formControlPr xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main\" \
objectType=\"Radio\" checked=\"{checked_attr}\"{first_attr}{fmla_link_attr} \
lockText=\"1\" defaultSize=\"0\" noThreeD=\"1\"/>\n"
            )
        }
        CocoNewFormControl::Spinner { min, max, inc, page, fmla_link, .. } => {
            let fmla_link_attr = fmla_link
                .as_deref()
                .map(|l| format!(" fmlaLink=\"{}\"", encode_xml_text(l)))
                .unwrap_or_default();
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
\n<formControlPr xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main\" \
objectType=\"Spinner\" min=\"{min}\" max=\"{max}\" inc=\"{inc}\" page=\"{page}\"{fmla_link_attr} \
lockText=\"1\" defaultSize=\"0\"/>\n"
            )
        }
        CocoNewFormControl::ScrollBar { min, max, inc, page, horiz, fmla_link, .. } => {
            let horiz_attr = if *horiz { " horiz=\"1\"" } else { "" };
            let fmla_link_attr = fmla_link
                .as_deref()
                .map(|l| format!(" fmlaLink=\"{}\"", encode_xml_text(l)))
                .unwrap_or_default();
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
\n<formControlPr xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main\" \
objectType=\"Scroll\" min=\"{min}\" max=\"{max}\" inc=\"{inc}\" page=\"{page}\"{horiz_attr}{fmla_link_attr} \
lockText=\"1\" defaultSize=\"0\"/>\n"
            )
        }
    }
}

fn build_vml_shape_309(shape_id: u32, fc: &CocoNewFormControl) -> String {
    let row = fc.row();
    let col = fc.col();
    let right_col = col + 2;
    let bottom_row = row + 1;
    let anchor = format!("{col}, 0, {row}, 0, {right_col}, 0, {bottom_row}, 0");
    let shape_id_str = format!("_x0000_s{shape_id}");

    match fc {
        CocoNewFormControl::CheckBox { checked, fmla_link, label, .. } => {
            let checked_el = if *checked { "<x:Checked>1</x:Checked>\n      " } else { "" };
            let fmla_link_el = fmla_link
                .as_deref()
                .map(|l| format!("<x:FmlaLink>{}</x:FmlaLink>\n      ", encode_xml_text(l)))
                .unwrap_or_default();
            let label_escaped = encode_xml_text(label);
            format!(
                "  <v:shape id=\"{shape_id_str}\" type=\"#_x0000_t201\" \
style=\"position:absolute;margin-left:36pt;margin-top:3pt;\
width:108pt;height:14.25pt;z-index:1\" \
fillcolor=\"window\" strokecolor=\"windowText\" filled=\"f\" stroked=\"f\">\n\
    <v:path shadowok=\"f\" o:connecttype=\"none\"/>\n\
    <v:textbox style=\"mso-direction-alt:auto\">\
<div style=\"text-align:left\"><span>{label_escaped}</span></div></v:textbox>\n\
    <x:ClientData ObjectType=\"Checkbox\">\n\
      <x:Anchor>{anchor}</x:Anchor>\n\
      <x:PrintObject/>\n\
      <x:AutoFill>False</x:AutoFill>\n\
      {checked_el}{fmla_link_el}<x:NoThreeD/>\n\
    </x:ClientData>\n\
  </v:shape>\n"
            )
        }
        CocoNewFormControl::Radio { checked, first_button, fmla_link, label, .. } => {
            let checked_el = if *checked { "<x:Checked>1</x:Checked>\n      " } else { "" };
            let first_el = if *first_button { "<x:FirstButton/>\n      " } else { "" };
            let fmla_link_el = fmla_link
                .as_deref()
                .map(|l| format!("<x:FmlaLink>{}</x:FmlaLink>\n      ", encode_xml_text(l)))
                .unwrap_or_default();
            let label_escaped = encode_xml_text(label);
            format!(
                "  <v:shape id=\"{shape_id_str}\" type=\"#_x0000_t204\" \
style=\"position:absolute;margin-left:36pt;margin-top:3pt;\
width:108pt;height:14.25pt;z-index:1\" \
fillcolor=\"window\" strokecolor=\"windowText\" filled=\"f\" stroked=\"f\">\n\
    <v:path shadowok=\"f\" o:connecttype=\"none\"/>\n\
    <v:textbox style=\"mso-direction-alt:auto\">\
<div style=\"text-align:left\"><span>{label_escaped}</span></div></v:textbox>\n\
    <x:ClientData ObjectType=\"Radio\">\n\
      <x:Anchor>{anchor}</x:Anchor>\n\
      <x:PrintObject/>\n\
      <x:AutoFill>False</x:AutoFill>\n\
      {checked_el}{first_el}{fmla_link_el}<x:NoThreeD/>\n\
    </x:ClientData>\n\
  </v:shape>\n"
            )
        }
        CocoNewFormControl::Spinner { min, max, inc, page, fmla_link, .. } => {
            let fmla_link_el = fmla_link
                .as_deref()
                .map(|l| format!("<x:FmlaLink>{}</x:FmlaLink>\n      ", encode_xml_text(l)))
                .unwrap_or_default();
            format!(
                "  <v:shape id=\"{shape_id_str}\" type=\"#_x0000_t172\" \
style=\"position:absolute;margin-left:36pt;margin-top:3pt;\
width:12pt;height:20pt;z-index:1\" filled=\"f\" stroked=\"f\">\n\
    <v:path shadowok=\"f\" o:connecttype=\"none\"/>\n\
    <x:ClientData ObjectType=\"Spin\">\n\
      <x:Anchor>{anchor}</x:Anchor>\n\
      <x:PrintObject/>\n\
      <x:AutoFill>False</x:AutoFill>\n\
      <x:Min>{min}</x:Min>\n\
      <x:Max>{max}</x:Max>\n\
      <x:Inc>{inc}</x:Inc>\n\
      <x:Page>{page}</x:Page>\n\
      {fmla_link_el}</x:ClientData>\n\
  </v:shape>\n"
            )
        }
        CocoNewFormControl::ScrollBar { min, max, inc, page, horiz, fmla_link, .. } => {
            let horiz_el = if *horiz { "<x:Horiz/>\n      " } else { "" };
            let fmla_link_el = fmla_link
                .as_deref()
                .map(|l| format!("<x:FmlaLink>{}</x:FmlaLink>\n      ", encode_xml_text(l)))
                .unwrap_or_default();
            format!(
                "  <v:shape id=\"{shape_id_str}\" type=\"#_x0000_t173\" \
style=\"position:absolute;margin-left:36pt;margin-top:3pt;\
width:108pt;height:12pt;z-index:1\" filled=\"f\" stroked=\"f\">\n\
    <v:path shadowok=\"f\" o:connecttype=\"none\"/>\n\
    <x:ClientData ObjectType=\"Scroll\">\n\
      <x:Anchor>{anchor}</x:Anchor>\n\
      <x:PrintObject/>\n\
      <x:AutoFill>False</x:AutoFill>\n\
      <x:Min>{min}</x:Min>\n\
      <x:Max>{max}</x:Max>\n\
      <x:Inc>{inc}</x:Inc>\n\
      <x:Page>{page}</x:Page>\n\
      {horiz_el}{fmla_link_el}</x:ClientData>\n\
  </v:shape>\n"
            )
        }
    }
}

fn build_vml_drawing_xml_309(shape_base: u32, controls: &[CocoNewFormControl]) -> String {
    let mut shapes = String::new();
    for (i, fc) in controls.iter().enumerate() {
        shapes.push_str(&build_vml_shape_309(shape_base + i as u32, fc));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<xml xmlns:v=\"urn:schemas-microsoft-com:vml\"\n\
     xmlns:o=\"urn:schemas-microsoft-com:office:office\"\n\
     xmlns:x=\"urn:schemas-microsoft-com:office:excel\">\n\
  <o:shapelayout v:ext=\"edit\">\n\
    <o:idmap v:ext=\"edit\" data=\"1\"/>\n\
  </o:shapelayout>\n\
  <v:shapetype id=\"#_x0000_t201\" coordsize=\"21600,21600\" o:spt=\"201\"\n\
               path=\"m,l,21600r21600,xe\">\n\
    <v:stroke joinstyle=\"miter\"/>\n\
    <v:path shadowok=\"f\" o:connecttype=\"none\"/>\n\
  </v:shapetype>\n\
{shapes}</xml>\n"
    )
}

fn build_vml_drawing_rels_309(ctrl_prop_base: u32, count: usize) -> String {
    let mut rels = String::new();
    for i in 0..count {
        let ctrl_n = ctrl_prop_base + i as u32;
        rels.push_str(&format!(
            "<Relationship Id=\"rId{rid}\" \
Type=\"http://schemas.microsoft.com/office/2006/relationships/ctrlProp\" \
Target=\"../ctrlProps/ctrlProp{ctrl_n}.xml\"/>\n",
            rid = i + 1
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n\
{rels}</Relationships>\n"
    )
}

/// Inject OOXML form-control parts for Coco-new checkboxes after the base xlsx is written.
fn inject_coco_form_controls(
    tmp_path: &std::path::Path,
    snapshot: &Value,
    sheet_order: &[Value],
) -> Result<(), String> {
    use std::fs;
    use std::io::Cursor;
    use zip::{write::FileOptions, ZipArchive, ZipWriter};

    let sheets_with_checkboxes = collect_coco_new_checkboxes(snapshot, sheet_order);
    if sheets_with_checkboxes.is_empty() {
        return Ok(());
    }

    const SHAPE_BASE: u32 = 9000;
    const CTRL_BASE: u32 = 9000;
    const VML_BASE: u32 = 9000;

    let original_bytes = fs::read(tmp_path).map_err(|e| e.to_string())?;

    let mut new_parts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut sheet_xml_rewrites: HashMap<String, Vec<u8>> = HashMap::new();
    let mut sheet_rels_rewrites: HashMap<String, Vec<u8>> = HashMap::new();
    let mut ct_overrides: Vec<String> = Vec::new();

    for (sheet_idx, checkboxes) in &sheets_with_checkboxes {
        let sheet_n = sheet_idx + 1;
        let vml_n = VML_BASE + *sheet_idx as u32;
        let ctrl_base = CTRL_BASE + *sheet_idx as u32 * 100;
        let shape_base = SHAPE_BASE + *sheet_idx as u32 * 100;

        // ctrlProp parts (one per checkbox).
        for (i, cb) in checkboxes.iter().enumerate() {
            let ctrl_n = ctrl_base + i as u32;
            let ctrl_path = format!("xl/ctrlProps/ctrlProp{ctrl_n}.xml");
            let xml = build_ctrl_prop_xml_309(cb);
            new_parts.push((ctrl_path.clone(), xml.into_bytes()));
            ct_overrides.push(format!(
                "<Override PartName=\"/{ctrl_path}\" \
ContentType=\"application/vnd.ms-excel.controlproperties+xml\"/>"
            ));
        }

        // vmlDrawing part.
        let vml_path = format!("xl/drawings/vmlDrawing{vml_n}.vml");
        let vml_xml = build_vml_drawing_xml_309(shape_base, checkboxes);
        new_parts.push((vml_path.clone(), vml_xml.into_bytes()));
        ct_overrides.push(format!(
            "<Override PartName=\"/{vml_path}\" \
ContentType=\"application/vnd.openxmlformats-officedocument.vmlDrawing\"/>"
        ));

        // vmlDrawing rels.
        let vml_rels_path = format!("xl/drawings/_rels/vmlDrawing{vml_n}.vml.rels");
        let vml_rels_xml = build_vml_drawing_rels_309(ctrl_base, checkboxes.len());
        new_parts.push((vml_rels_path, vml_rels_xml.into_bytes()));

        // Sheet XML: inject <legacyDrawing>.
        let vml_rid = format!("rIdVml{sheet_n}");
        let sheet_xml_path = format!("xl/worksheets/sheet{sheet_n}.xml");
        let sheet_xml: String = {
            let mut arc = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;
            let mut s = String::new();
            if let Ok(mut e) = arc.by_name(&sheet_xml_path) {
                let _ = std::io::Read::read_to_string(&mut e, &mut s);
            }
            s
        };
        if !sheet_xml.is_empty() && !sheet_xml.contains("<legacyDrawing") {
            if let Some(pos) = sheet_xml.rfind("</worksheet>") {
                let mut s = String::with_capacity(sheet_xml.len() + 64);
                s.push_str(&sheet_xml[..pos]);
                s.push_str(&format!("<legacyDrawing r:id=\"{vml_rid}\"/>"));
                s.push_str(&sheet_xml[pos..]);
                sheet_xml_rewrites.insert(sheet_xml_path, s.into_bytes());
            }
        }

        // Sheet rels: inject vmlDrawing relationship.
        let sheet_rels_path = format!("xl/worksheets/_rels/sheet{sheet_n}.xml.rels");
        let existing_rels: String = {
            let mut arc = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;
            let mut s = String::new();
            if let Ok(mut e) = arc.by_name(&sheet_rels_path) {
                let _ = std::io::Read::read_to_string(&mut e, &mut s);
            }
            s
        };
        if !existing_rels.contains(&vml_rid) {
            let vml_rel = format!(
                "<Relationship Id=\"{vml_rid}\" \
Type=\"http://schemas.microsoft.com/office/2006/relationships/vmlDrawing\" \
Target=\"../drawings/vmlDrawing{vml_n}.vml\"/>"
            );
            let new_rels = if existing_rels.trim().is_empty() {
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n\
{vml_rel}\n</Relationships>\n"
                )
            } else if let Some(close_pos) = existing_rels.rfind("</Relationships>") {
                let mut s = String::with_capacity(existing_rels.len() + vml_rel.len() + 2);
                s.push_str(&existing_rels[..close_pos]);
                s.push_str(&vml_rel);
                s.push('\n');
                s.push_str(&existing_rels[close_pos..]);
                s
            } else {
                existing_rels.clone()
            };
            sheet_rels_rewrites.insert(sheet_rels_path, new_rels.into_bytes());
        }
    }

    let mut skip_names: HashSet<String> = HashSet::new();
    skip_names.insert("[Content_Types].xml".to_string());
    for (name, _) in &new_parts {
        skip_names.insert(name.clone());
    }
    for name in sheet_xml_rewrites.keys() {
        skip_names.insert(name.clone());
    }
    for name in sheet_rels_rewrites.keys() {
        skip_names.insert(name.clone());
    }

    let mut src = ZipArchive::new(Cursor::new(&original_bytes)).map_err(|e| e.to_string())?;
    let mut out_buf: Vec<u8> = Vec::with_capacity(original_bytes.len() + 65536);
    {
        let mut out = ZipWriter::new(Cursor::new(&mut out_buf));
        let opts: FileOptions =
            FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let mut ct_xml = String::new();
        for i in 0..src.len() {
            let mut entry = src.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            if name == "[Content_Types].xml" {
                let _ = std::io::Read::read_to_string(&mut entry, &mut ct_xml);
                continue;
            }
            if skip_names.contains(&name) {
                let mut _buf = Vec::new();
                let _ = std::io::Read::read_to_end(&mut entry, &mut _buf);
                continue;
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| e.to_string())?;
            out.start_file(&name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, &buf).map_err(|e| e.to_string())?;
        }

        for (name, bytes) in &new_parts {
            out.start_file(name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, bytes).map_err(|e| e.to_string())?;
        }
        for (name, bytes) in &sheet_xml_rewrites {
            out.start_file(name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, bytes).map_err(|e| e.to_string())?;
        }
        for (name, bytes) in &sheet_rels_rewrites {
            out.start_file(name, opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, bytes).map_err(|e| e.to_string())?;
        }

        // [Content_Types].xml with new Overrides spliced in.
        if !ct_overrides.is_empty() && !ct_xml.is_empty() {
            let close_tag = "</Types>";
            let insert_before = ct_xml.rfind(close_tag).unwrap_or(ct_xml.len());
            let mut new_ct = String::with_capacity(ct_xml.len() + ct_overrides.len() * 120);
            new_ct.push_str(&ct_xml[..insert_before]);
            for ov in &ct_overrides {
                if !ct_xml.contains(ov.as_str()) {
                    new_ct.push_str(ov);
                    new_ct.push('\n');
                }
            }
            new_ct.push_str(&ct_xml[insert_before..]);
            out.start_file("[Content_Types].xml", opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, new_ct.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            out.start_file("[Content_Types].xml", opts).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, ct_xml.as_bytes()).map_err(|e| e.to_string())?;
        }

        out.finish().map_err(|e| e.to_string())?;
    }

    fs::write(tmp_path, &out_buf).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================

#[cfg(test)]
mod external_ref_tests {
    use super::{cached_formula_result, formula_is_external_ref};
    use serde_json::json;

    #[test]
    fn detects_external_book_references() {
        assert!(formula_is_external_ref("=[1]Sheet1!A1"));
        assert!(formula_is_external_ref("=[Other.xlsx]Sheet1!A1"));
        assert!(formula_is_external_ref("='[1]Sheet 1'!A1"));
        assert!(formula_is_external_ref("=SUM([2]Data!B2:B9)"));
        assert!(formula_is_external_ref("=[1]Sheet1!A1+[1]Sheet1!A2"));
    }

    #[test]
    fn rejects_non_external_formulas() {
        assert!(!formula_is_external_ref("=SUM(A1:A10)"));
        assert!(!formula_is_external_ref("=Sheet2!A1"));
        // Structured table references use brackets but no sheet `!`.
        assert!(!formula_is_external_ref("=SUM(Table1[Amount])"));
        assert!(!formula_is_external_ref("=Table1[Col]+Table1[Other]"));
        assert!(!formula_is_external_ref("=A1"));
        // Unbalanced bracket — treated as non-external rather than panicking.
        assert!(!formula_is_external_ref("=[1Sheet1!A1"));
    }

    #[test]
    fn cached_result_stringifies_value_types() {
        assert_eq!(
            cached_formula_result(&json!({ "f": "=[1]S!A1", "v": 42 })),
            Some("42".to_string())
        );
        assert_eq!(
            cached_formula_result(&json!({ "f": "=[1]S!A1", "v": "hello" })),
            Some("hello".to_string())
        );
        assert_eq!(
            cached_formula_result(&json!({ "f": "=[1]S!A1", "v": true })),
            Some("TRUE".to_string())
        );
        // No cached value, or empty string, or null → None (leave default 0).
        assert_eq!(cached_formula_result(&json!({ "f": "=[1]S!A1" })), None);
        assert_eq!(
            cached_formula_result(&json!({ "f": "=[1]S!A1", "v": "" })),
            None
        );
        assert_eq!(
            cached_formula_result(&json!({ "f": "=[1]S!A1", "v": null })),
            None
        );
    }
}

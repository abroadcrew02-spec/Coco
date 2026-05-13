use std::collections::HashMap;
use std::path::PathBuf;

use calamine::{open_workbook, Data, Reader, Xlsx};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatPattern, Workbook};
use serde_json::{json, Map, Value};

use crate::commands::workbook::{
    rotate_backups, temp_save_path, CompatibilityWarning, ExportResult, ImportWorkbookResult,
    WorkbookHandle,
};

const MIN_ROWS: usize = 1000;
const MIN_COLS: usize = 100;
const LARGE_SHEET_THRESHOLD: usize = 100_000;

/// Normalized cell style extracted from xl/styles.xml + per-sheet `<c s="..."/>` refs.
/// Scope: font (bold/italic/color) + fill (color) + alignment (horizontal/vertical).
/// Borders, number formats, and rich text are intentionally out of scope.
#[derive(Default, Clone, PartialEq, Eq, Hash)]
struct CellStyle {
    bold: bool,
    italic: bool,
    font_color: Option<String>,    // "#RRGGBB"
    fill_color: Option<String>,    // "#RRGGBB"
    h_align: Option<String>,       // "left" | "center" | "right" | "fill" | "justify"
    v_align: Option<String>,       // "top" | "middle" | "bottom"
}

impl CellStyle {
    fn is_empty(&self) -> bool {
        !self.bold
            && !self.italic
            && self.font_color.is_none()
            && self.fill_color.is_none()
            && self.h_align.is_none()
            && self.v_align.is_none()
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
        Some(s)
    }
}

/// Workbook-wide raw style indexes parsed from `xl/styles.xml`.
struct ParsedStyles {
    /// One CellStyle per cellXfs entry (index = xf id). Empty styles are still kept
    /// to preserve indexing semantics.
    cell_xfs: Vec<CellStyle>,
    /// sheet xml name (e.g. "sheet1") → map of (row0, col0) → xf index
    per_sheet: HashMap<String, HashMap<(u32, u32), usize>>,
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
    let (fonts, fills, cell_xfs_raw) = parse_styles_xml(&styles_xml);

    // 2. resolve each cellXf to a normalized CellStyle
    let cell_xfs: Vec<CellStyle> = cell_xfs_raw
        .iter()
        .map(|x| resolve_xf(x, &fonts, &fills))
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

    Ok(ParsedStyles { cell_xfs, per_sheet })
}

/// Returns (fonts, fills, raw_xfs). Each font/fill is a (bold,italic,color)/(color) tuple.
fn parse_styles_xml(xml: &str) -> (Vec<RawFont>, Vec<RawFill>, Vec<RawXf>) {
    let mut fonts: Vec<RawFont> = Vec::new();
    let mut fills: Vec<RawFill> = Vec::new();
    let mut xfs: Vec<RawXf> = Vec::new();

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

    // cellXfs: <cellXfs ...> <xf ...><alignment .../></xf> ... </cellXfs>
    if let Some(xfs_block) = extract_block(xml, "<cellXfs", "</cellXfs>") {
        for xf_el in extract_elements(&xfs_block, "<xf", "</xf>") {
            let mut x = RawXf::default();
            x.font_id = parse_attr(&xf_el, "fontId").and_then(|s| s.parse().ok());
            x.fill_id = parse_attr(&xf_el, "fillId").and_then(|s| s.parse().ok());
            x.apply_font = parse_attr(&xf_el, "applyFont").as_deref() == Some("1");
            x.apply_fill = parse_attr(&xf_el, "applyFill").as_deref() == Some("1");
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
                x.apply_font = parse_attr(&xf_el, "applyFont").as_deref() == Some("1");
                x.apply_fill = parse_attr(&xf_el, "applyFill").as_deref() == Some("1");
                x.apply_alignment = parse_attr(&xf_el, "applyAlignment").as_deref() == Some("1");
                if let Some(align) = find_tag(&xf_el, "<alignment") {
                    x.h_align = parse_attr(&align, "horizontal");
                    x.v_align = parse_attr(&align, "vertical");
                }
                xfs.push(x);
            }
        }
    }

    (fonts, fills, xfs)
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
struct RawXf {
    font_id: Option<usize>,
    fill_id: Option<usize>,
    apply_font: bool,
    apply_fill: bool,
    apply_alignment: bool,
    h_align: Option<String>,
    v_align: Option<String>,
}

fn resolve_xf(xf: &RawXf, fonts: &[RawFont], fills: &[RawFill]) -> CellStyle {
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
    if let Some(nf) = num_format {
        fmt = fmt.set_num_format(nf);
    }
    fmt
}

fn data_to_cell(d: &Data) -> Option<Value> {
    match d {
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
    }
}

/// Inspects the ZIP for unsupported feature directories and returns a list of
/// CompatibilityWarning entries describing what will be silently dropped on
/// save-back. Pure-Rust: takes the path so it's testable from cargo test.
pub fn detect_unsupported_features(path: &str) -> Result<Vec<CompatibilityWarning>, String> {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid xlsx (zip): {e}"))?;

    let mut has_charts = false;
    let mut has_pivot = false;
    let mut has_external_links = false;
    let mut has_vba = false;
    let mut has_embeddings = false;
    let mut has_drawings = false;
    // Collect worksheet entry indices first; conditional-formatting needs to read
    // their content, but reading requires a mutable borrow of the archive that
    // can't coexist with the iteration borrow.
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

    // Conditional formatting lives inside each worksheet XML body — scan only
    // until the first hit. We do not parse workbook.xml to map sheet ids back
    // to display names; affected_sheets stays None per spec (keep it simple).
    let mut has_conditional_formatting = false;
    for i in worksheet_indices {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let mut content = String::new();
        if entry.read_to_string(&mut content).is_ok()
            && content.contains("<conditionalFormatting")
        {
            has_conditional_formatting = true;
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

    Ok(warnings)
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

    let feature_warnings = detect_unsupported_features(&path).unwrap_or_default();

    // Per-cell styles: parsed straight from the xlsx ZIP (calamine 0.24 doesn't
    // expose them). Tolerant of failure — missing styles just degrade to "no styles".
    let parsed_styles = parse_xlsx_styles(&path).ok();

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

                // Resolve a style id (if any) for this cell.
                let style_id: Option<String> = sheet_style_lookup
                    .and_then(|m| m.get(&(abs_r, abs_c)).copied())
                    .and_then(|xf_idx| parsed_styles.as_ref()?.cell_xfs.get(xf_idx).cloned())
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
                    if let Some(cached) = data_to_cell(cell) {
                        if let Value::Object(cached_map) = cached {
                            for (k, v) in cached_map.into_iter() {
                                cell_obj.insert(k, v);
                            }
                        }
                    }
                    if let Some(sid) = &style_id {
                        cell_obj.insert("s".into(), Value::String(sid.clone()));
                    }
                    row_map.insert(c.to_string(), Value::Object(cell_obj));
                    non_empty_cells += 1;
                    continue;
                }

                if let Some(mut v) = data_to_cell(cell) {
                    if let Some(sid) = &style_id {
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert("s".into(), Value::String(sid.clone()));
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

        let sheet_obj = json!({
            "id": sheet_id,
            "name": name,
            "rowCount": row_count,
            "columnCount": col_count,
            "cellData": Value::Object(cell_data),
        });
        sheets_map.insert(sheet_id, sheet_obj);
    }

    let snapshot = json!({
        "id": workbook_id,
        "name": "Imported Workbook",
        "appVersion": "0.1.0",
        "locale": "enUS",
        "styles": Value::Object(styles_map),
        "sheetOrder": sheet_order,
        "sheets": Value::Object(sheets_map),
        "namedRanges": named_ranges,
    });

    let snapshot_json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;

    let mut warnings: Vec<CompatibilityWarning> = prepended_warnings;
    warnings.extend(feature_warnings);
    warnings.push(CompatibilityWarning {
        severity: "info".to_string(),
        code: "XLSX_POC_IMPORT".to_string(),
        message:
            "xlsx PoC import: borders, number formats, and merges are not yet preserved (named ranges + font/fill/alignment styles are preserved)"
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
    // Cache keyed on (style_id, num_format) so identical (style, format) combos
    // reuse the same rust_xlsxwriter Format object.
    let mut format_cache: HashMap<(String, String), Format> = HashMap::new();
    let mut named_range_failures: Vec<String> = Vec::new();
    let mut scoped_names_downgraded: Vec<String> = Vec::new();

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

            let worksheet = workbook.add_worksheet();
            worksheet
                .set_name(&safe_name)
                .map_err(|e| e.to_string())?;

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
            "xlsx PoC export: {sheet_count} sheets, {cell_count} cells, {formula_count} formulas. Borders, merges, column widths, and rich text are not yet preserved (named ranges + font/fill/alignment styles are preserved)."
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

    Ok(ExportResult {
        success: true,
        path,
        warnings,
        error: None,
    })
}

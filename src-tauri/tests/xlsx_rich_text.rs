use calamine::{open_workbook, Data, Reader, Xlsx};
use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Color, Format, Workbook};
use serde_json::Value;
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// Pull `xl/sharedStrings.xml` out of an xlsx so tests can grep for rich-text
/// fragments after export. Returns the empty string if no sharedStrings entry
/// exists (e.g. when the writer used inline strings only).
fn read_shared_strings_xml(path: &PathBuf) -> String {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;
    let f = File::open(path).expect("open xlsx for sharedStrings read");
    let mut z = ZipArchive::new(f).expect("zip");
    let mut s = String::new();
    if let Ok(mut e) = z.by_name("xl/sharedStrings.xml") {
        e.read_to_string(&mut s).expect("read sharedStrings");
    }
    s
}

/// Pull a worksheet's raw XML out of an xlsx so tests can confirm inline-string
/// cells were written when expected.
fn read_worksheet_xml(path: &PathBuf, sheet_index: usize) -> String {
    use std::fs::File;
    use std::io::Read;
    use zip::ZipArchive;
    let f = File::open(path).expect("open xlsx for sheet read");
    let mut z = ZipArchive::new(f).expect("zip");
    let mut s = String::new();
    let name = format!("xl/worksheets/sheet{}.xml", sheet_index);
    if let Ok(mut e) = z.by_name(&name) {
        e.read_to_string(&mut s).expect("read sheet");
    }
    s
}

#[test]
fn bold_run_plus_plain_run_round_trips() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("rich_bold_plain.xlsx");
    let exported = tmp.path().join("rich_bold_plain_exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("R").expect("name");
        let bold = Format::new().set_bold();
        let plain = Format::default();
        // "Hello " (bold) + "world" (plain).
        let segments = [(&bold, "Hello "), (&plain, "world")];
        ws.write_rich_string(0, 0, &segments).expect("rich_string");
        wb.save(&fixture).expect("save fixture");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(&imported.handle.snapshot_json.clone().unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let runs = cell
        .get("_richRuns")
        .and_then(|v| v.as_array())
        .expect("expected _richRuns on the rich cell");
    assert_eq!(runs.len(), 2, "expected 2 runs, got {}", cell);
    assert_eq!(runs[0]["text"], "Hello ");
    assert_eq!(runs[0]["bold"], true);
    assert_eq!(runs[1]["text"], "world");
    assert!(
        runs[1].get("bold").is_none(),
        "plain run should not be marked bold, got {}",
        runs[1]
    );
    // Plain-text fallback in `v` should still concatenate to the full string.
    let plain = cell["v"].as_str().unwrap_or("");
    assert!(
        plain.contains("Hello") && plain.contains("world"),
        "expected plain v fallback to contain 'Hello world', got {}",
        cell
    );

    // Round-trip — export must preserve at least one run with bold styling.
    let export_res =
        export_xlsx_core(path_str(&exported), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(
        export_res.success,
        "export should succeed: {:?}",
        export_res.error
    );
    let ss = read_shared_strings_xml(&exported);
    assert!(
        ss.contains("<r>") || ss.contains("<r "),
        "exported sharedStrings should contain `<r>` runs: {}",
        ss
    );
    assert!(
        ss.contains("<b/>")
            || ss.contains("<b val=\"true\"")
            || ss.contains("<b ")
            || ss.contains("<b>"),
        "exported sharedStrings should mark a bold run: {}",
        ss
    );
    // And the concatenated text must still appear.
    assert!(
        ss.contains("Hello") && ss.contains("world"),
        "round-tripped sharedStrings missing text: {}",
        ss
    );
}

#[test]
fn three_runs_bold_italic_colored() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("rich_three.xlsx");
    let exported = tmp.path().join("rich_three_exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("M").expect("name");
        let bold = Format::new().set_bold();
        let italic = Format::new().set_italic();
        let red = Format::new().set_font_color(Color::RGB(0xFF0000));
        let segments = [(&bold, "Bold"), (&italic, "Italic"), (&red, "Red")];
        ws.write_rich_string(0, 0, &segments).expect("rich_string");
        wb.save(&fixture).expect("save fixture");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(&imported.handle.snapshot_json.clone().unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let runs = cell
        .get("_richRuns")
        .and_then(|v| v.as_array())
        .expect("expected _richRuns on cell");
    assert_eq!(runs.len(), 3, "expected 3 runs, got {}", cell);

    let by_text: std::collections::HashMap<&str, &Value> = runs
        .iter()
        .map(|r| (r["text"].as_str().unwrap_or(""), r))
        .collect();
    assert_eq!(by_text["Bold"]["bold"], true, "Bold run should be bold");
    assert_eq!(
        by_text["Italic"]["italic"], true,
        "Italic run should be italic"
    );
    let red_color = by_text["Red"]["color"]
        .as_str()
        .unwrap_or("")
        .to_ascii_uppercase();
    assert_eq!(red_color, "#FF0000", "Red run color should be #FF0000");

    // Export and confirm runs survive.
    let export_res =
        export_xlsx_core(path_str(&exported), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(export_res.success);

    let ss = read_shared_strings_xml(&exported);
    assert!(ss.contains("Bold") && ss.contains("Italic") && ss.contains("Red"));
    // At least one of these markers must reach the file.
    assert!(
        ss.contains("<b/>") || ss.contains("<b "),
        "expected bold marker in sharedStrings: {ss}"
    );
    assert!(
        ss.contains("<i/>") || ss.contains("<i "),
        "expected italic marker in sharedStrings: {ss}"
    );
    assert!(
        ss.to_ascii_uppercase().contains("FF0000"),
        "expected red rgb in sharedStrings: {ss}"
    );
}

/// Build an xlsx by hand with a `t="inlineStr"` cell containing rich runs so
/// we can confirm the import path covers the inline-string code branch (not
/// just shared strings, which rust_xlsxwriter emits by default).
#[test]
fn inline_string_rich_runs() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("inline_rich.xlsx");

    // Compose a minimal xlsx zip with one sheet using inline rich text.
    let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr">
        <is>
          <r><rPr><b/></rPr><t xml:space="preserve">Bold </t></r>
          <r><t>plain</t></r>
        </is>
      </c>
    </row>
  </sheetData>
</worksheet>"#;
    let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Inline" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>"#;
    let workbook_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;

    {
        use std::fs::File;
        use zip::write::FileOptions;
        use zip::ZipWriter;
        let f = File::create(&fixture).expect("create");
        let mut z = ZipWriter::new(f);
        let opts: FileOptions = FileOptions::default();
        z.start_file("[Content_Types].xml", opts).unwrap();
        std::io::Write::write_all(&mut z, content_types.as_bytes()).unwrap();
        z.start_file("_rels/.rels", opts).unwrap();
        std::io::Write::write_all(&mut z, root_rels.as_bytes()).unwrap();
        z.start_file("xl/workbook.xml", opts).unwrap();
        std::io::Write::write_all(&mut z, workbook_xml.as_bytes()).unwrap();
        z.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        std::io::Write::write_all(&mut z, workbook_rels.as_bytes()).unwrap();
        z.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        std::io::Write::write_all(&mut z, sheet_xml.as_bytes()).unwrap();
        z.finish().expect("zip finish");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value = serde_json::from_str(&imported.handle.snapshot_json.unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    let runs = cell
        .get("_richRuns")
        .and_then(|v| v.as_array())
        .expect("expected _richRuns on inline cell");
    assert_eq!(
        runs.len(),
        2,
        "expected 2 runs from inline string, got {}",
        cell
    );
    assert_eq!(runs[0]["text"], "Bold ");
    assert_eq!(runs[0]["bold"], true);
    assert_eq!(runs[1]["text"], "plain");
}

/// Plain strings must not gain a spurious `_richRuns` field; they round-trip
/// through the legacy v-only path.
#[test]
fn plain_string_has_no_rich_runs() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("plain.xlsx");
    let exported = tmp.path().join("plain_exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("P").expect("name");
        ws.write_string(0, 0, "just text").expect("plain");
        wb.save(&fixture).expect("save fixture");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snap: Value =
        serde_json::from_str(&imported.handle.snapshot_json.clone().unwrap()).unwrap();
    let cell = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"];
    assert_eq!(cell["v"], "just text");
    assert!(
        cell.get("_richRuns").is_none(),
        "plain cell should NOT have _richRuns, got {}",
        cell
    );

    let export_res =
        export_xlsx_core(path_str(&exported), imported.handle.snapshot_json.unwrap()).unwrap();
    assert!(export_res.success);

    let mut wb: Xlsx<_> = open_workbook(&exported).unwrap();
    let range = wb.worksheet_range("P").unwrap();
    let v = range.get_value((0, 0)).unwrap();
    match v {
        Data::String(s) => assert_eq!(s, "just text"),
        other => panic!("expected plain string after round-trip, got {:?}", other),
    }
    // Sanity: the exported sheet shouldn't carry inline-rich markers either.
    let ws_xml = read_worksheet_xml(&exported, 1);
    assert!(
        !ws_xml.contains("t=\"inlineStr\""),
        "plain string should not be exported as inlineStr: {ws_xml}"
    );
}

#[test]
fn poc_banner_lists_rich_text_as_preserved() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("any.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("X").expect("name");
        ws.write_string(0, 0, "hi").expect("a1");
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let poc = imported
        .warnings
        .iter()
        .find(|w| w.code == "XLSX_POC_IMPORT")
        .expect("PoC banner present");
    // The not-yet-preserved list (everything before "are not yet preserved" /
    // "is not yet preserved") must NOT contain "rich text" anymore.
    let lead = poc.message.split("not yet preserved").next().unwrap_or("");
    assert!(
        !lead.contains("rich text"),
        "import banner should no longer list rich text as not preserved: {}",
        poc.message
    );
    // The preserved-list segment (after "are not yet preserved" / "is not yet
    // preserved") MUST mention rich text.
    assert!(
        poc.message.contains("rich text"),
        "import banner should mention rich text as preserved: {}",
        poc.message
    );
}

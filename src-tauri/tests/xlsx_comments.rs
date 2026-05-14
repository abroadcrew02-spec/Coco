//! Round-trip tests for xlsx cell comments / notes.
//!
//! These exercise: a single comment (author + text) survives import → snapshot →
//! export → re-import; multiple comments on different cells survive the same
//! cycle; and a workbook with no comments produces no `_comments` snapshot
//! field and no `xl/comments*.xml` part in the exported zip.
//!
//! UPSTREAM BUG NOTE (rust_xlsxwriter 0.77): `Note::set_author("Alice")` writes
//! "Alice" into `xl/comments1.xml`'s `<authors>` list, but the per-comment
//! `authorId` attribute and the bold prefix run (`<t>Author:</t>`) point at a
//! stray hard-coded "Author" entry the library injects into the same list
//! (observed list: `[Alice, Author, Bob]`, A1 authorId="1" → "Author"). The
//! library's read-back is also wrong, so building a fixture via the library
//! cannot exercise author preservation. We sidestep the bug by post-processing
//! the fixture zip and rewriting `xl/comments1.xml` ourselves with correctly
//! mapped authorIds — this is the same shape the export side produces, so we
//! are testing the real import → export → re-import path.

use coco_lib::commands::xlsx_io::{export_xlsx_core, import_xlsx_core};
use rust_xlsxwriter::{Note, Workbook};
use serde_json::Value;
use std::fmt::Write as _;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use tempfile::TempDir;

fn path_str(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

fn encode_xml(s: &str) -> String {
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

/// Build a correctly-mapped `xl/comments1.xml` body for the given
/// `(cell, author, text)` tuples. Mirrors the shape Excel itself emits: an
/// `<authors>` list with unique entries and per-comment `authorId` indices that
/// actually agree with the bold-prefix run inside the comment text.
fn build_comments_xml(notes: &[(&str, &str, &str)]) -> String {
    let mut authors: Vec<String> = Vec::new();
    for (_, a, _) in notes {
        let s = (*a).to_string();
        if !authors.iter().any(|x| x == &s) {
            authors.push(s);
        }
    }
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    out.push_str("<comments xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">");
    out.push_str("<authors>");
    for a in &authors {
        let _ = write!(out, "<author>{}</author>", encode_xml(a));
    }
    out.push_str("</authors><commentList>");
    for (cell, author, text) in notes {
        let id = authors.iter().position(|a| a == *author).unwrap();
        let _ = write!(
            out,
            "<comment ref=\"{}\" authorId=\"{}\"><text>",
            encode_xml(cell),
            id
        );
        let _ = write!(
            out,
            "<r><rPr><b/><sz val=\"8\"/><color indexed=\"81\"/><rFont val=\"Tahoma\"/><family val=\"2\"/></rPr><t xml:space=\"preserve\">{}:</t></r>",
            encode_xml(author)
        );
        let body = format!("\n{}", text);
        let _ = write!(
            out,
            "<r><rPr><sz val=\"8\"/><color indexed=\"81\"/><rFont val=\"Tahoma\"/><family val=\"2\"/></rPr><t xml:space=\"preserve\">{}</t></r>",
            encode_xml(&body)
        );
        out.push_str("</text></comment>");
    }
    out.push_str("</commentList></comments>");
    out
}

/// Post-process a rust_xlsxwriter-built fixture xlsx by overwriting
/// `xl/comments1.xml` with a correctly-mapped body. Required because
/// rust_xlsxwriter 0.77's emitted commentsN.xml has the upstream authorId bug
/// described in this module's header doc-comment.
fn rewrite_fixture_comments_xml(path: &PathBuf, notes: &[(&str, &str, &str)]) {
    let bytes = std::fs::read(path).expect("read fixture");
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).expect("open zip");
    let xml = build_comments_xml(notes);
    let mut out_buf: Vec<u8> = Vec::with_capacity(bytes.len());
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut out_buf));
        let opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let name = entry.name().to_string();
            writer.start_file(name.clone(), opts).expect("start_file");
            if name == "xl/comments1.xml" {
                writer.write_all(xml.as_bytes()).expect("write xml");
            } else {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).expect("read entry");
                writer.write_all(&data).expect("write entry");
            }
        }
        writer.finish().expect("zip finish");
    }
    std::fs::write(path, &out_buf).expect("write fixture");
}

/// True when the exported zip carries any `xl/comments*.xml` part.
fn has_comments_part(path: &PathBuf) -> bool {
    let file = std::fs::File::open(path).expect("open xlsx");
    let mut archive = zip::ZipArchive::new(file).expect("zip");
    (0..archive.len()).any(|i| {
        archive
            .by_index(i)
            .map(|e| {
                let name = e.name().to_string();
                name.starts_with("xl/comments") && name.ends_with(".xml")
            })
            .unwrap_or(false)
    })
}

#[test]
fn single_comment_round_trips_author_and_text() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("fixture.xlsx");
    let exported = tmp.path().join("exported.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "hello").unwrap();
        let note = Note::new("Watch this cell").set_author("Alice");
        ws.insert_note(0, 0, &note).expect("insert note");
        wb.save(&fixture).expect("save");
    }
    // Work around rust_xlsxwriter 0.77's broken authorId mapping (see module
    // doc) so the importer sees the author we actually requested.
    rewrite_fixture_comments_xml(&fixture, &[("A1", "Alice", "Watch this cell")]);

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.clone().expect("snapshot");
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");

    let notes = snap["sheets"]["sheet-1"]["_comments"]
        .as_array()
        .expect("_comments should be present on the sheet");
    assert_eq!(notes.len(), 1, "exactly one comment captured");
    assert_eq!(notes[0]["cell"].as_str(), Some("A1"));
    assert_eq!(notes[0]["author"].as_str(), Some("Alice"));
    assert_eq!(
        notes[0]["text"].as_str(),
        Some("Watch this cell"),
        "the 'Alice:\\n' prefix Excel adds must be stripped on import"
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).expect("parse");
    let re_notes = re_snap["sheets"]["sheet-1"]["_comments"]
        .as_array()
        .expect("_comments after round-trip");
    assert_eq!(re_notes.len(), 1);
    assert_eq!(re_notes[0]["cell"].as_str(), Some("A1"));
    assert_eq!(re_notes[0]["author"].as_str(), Some("Alice"));
    assert_eq!(
        re_notes[0]["text"].as_str(),
        Some("Watch this cell"),
        "text must remain stable across a second round-trip (no double-prefix)"
    );
}

#[test]
fn multiple_comments_on_distinct_cells_survive_round_trip() {
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("multi.xlsx");
    let exported = tmp.path().join("multi_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.insert_note(0, 0, &Note::new("first").set_author("Alice"))
            .expect("insert note A1");
        ws.insert_note(2, 1, &Note::new("second").set_author("Bob"))
            .expect("insert note B3");
        ws.insert_note(4, 3, &Note::new("third").set_author("Alice"))
            .expect("insert note D5");
        wb.save(&fixture).expect("save");
    }
    rewrite_fixture_comments_xml(
        &fixture,
        &[
            ("A1", "Alice", "first"),
            ("B3", "Bob", "second"),
            ("D5", "Alice", "third"),
        ],
    );

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.unwrap();
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    let notes = snap["sheets"]["sheet-1"]["_comments"]
        .as_array()
        .expect("comments captured");
    assert_eq!(notes.len(), 3);

    // Index by cell so the assertion is order-independent.
    let mut by_cell: std::collections::HashMap<String, &Value> = Default::default();
    for n in notes {
        by_cell.insert(n["cell"].as_str().unwrap().to_string(), n);
    }
    assert_eq!(by_cell["A1"]["author"].as_str(), Some("Alice"));
    assert_eq!(by_cell["A1"]["text"].as_str(), Some("first"));
    assert_eq!(by_cell["B3"]["author"].as_str(), Some("Bob"));
    assert_eq!(by_cell["B3"]["text"].as_str(), Some("second"));
    assert_eq!(by_cell["D5"]["author"].as_str(), Some("Alice"));
    assert_eq!(by_cell["D5"]["text"].as_str(), Some("third"));

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    let re = import_xlsx_core(path_str(&exported)).expect("re-import");
    let re_snap: Value =
        serde_json::from_str(re.handle.snapshot_json.as_ref().unwrap()).expect("parse");
    let re_notes = re_snap["sheets"]["sheet-1"]["_comments"]
        .as_array()
        .expect("comments after round-trip");
    assert_eq!(re_notes.len(), 3);

    let mut re_by_cell: std::collections::HashMap<String, &Value> = Default::default();
    for n in re_notes {
        re_by_cell.insert(n["cell"].as_str().unwrap().to_string(), n);
    }
    assert_eq!(re_by_cell["A1"]["author"].as_str(), Some("Alice"));
    assert_eq!(re_by_cell["A1"]["text"].as_str(), Some("first"));
    assert_eq!(re_by_cell["B3"]["author"].as_str(), Some("Bob"));
    assert_eq!(re_by_cell["B3"]["text"].as_str(), Some("second"));
    assert_eq!(re_by_cell["D5"]["author"].as_str(), Some("Alice"));
    assert_eq!(re_by_cell["D5"]["text"].as_str(), Some("third"));
}

#[test]
fn no_comments_yields_no_comments_field_and_no_comments_part() {
    // Regression: a workbook with NO cell comments must not emit a `_comments`
    // field on the snapshot, and the exported zip must not contain any
    // `xl/comments*.xml` part (which would be a malformed empty payload).
    let tmp = TempDir::new().expect("tempdir");
    let fixture = tmp.path().join("clean.xlsx");
    let exported = tmp.path().join("clean_out.xlsx");

    {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Sheet1").unwrap();
        ws.write_string(0, 0, "no comments here").unwrap();
        wb.save(&fixture).expect("save");
    }

    let imported = import_xlsx_core(path_str(&fixture)).expect("import");
    let snapshot_json = imported.handle.snapshot_json.unwrap();
    let snap: Value = serde_json::from_str(&snapshot_json).expect("parse");
    assert!(
        snap["sheets"]["sheet-1"].get("_comments").is_none(),
        "sheets with no comments must not emit _comments: {}",
        snap["sheets"]["sheet-1"]
    );

    let export = export_xlsx_core(path_str(&exported), snapshot_json).expect("export");
    assert!(export.success, "export ok: {:?}", export.error);

    assert!(
        !has_comments_part(&exported),
        "clean workbook must not produce an xl/comments*.xml part"
    );
}

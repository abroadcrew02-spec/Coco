//! B2: `.coco` files saved by v0.8.1 or earlier stored cell styles in a
//! private `{font, fill, alignment, borders}` shape. v0.8.2 switched
//! `CellStyle::to_json` to Univer's `IStyleData` shape and taught
//! `CellStyle::from_json` to read both, but nothing normalized snapshots
//! already sitting in `.coco` files — so bold/fill/borders/alignment saved
//! before v0.8.2 silently stopped rendering on open.
//!
//! These tests exercise every read path that can hand a legacy-shaped
//! snapshot back to the frontend: a plain open, a recovery restore, and
//! opening an older entry from the in-file snapshot history.

use nicel_lib::commands::recovery::autosave_temp_core;
use nicel_lib::commands::workbook::{
    list_snapshots_core, open_nicel_core, open_snapshot_core, restore_backup_core, save_core,
};
use serde_json::{json, Value};
use tempfile::TempDir;

fn path_str(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// One legacy-shaped style entry (bold + red font, red-ish fill, centered,
/// thin top border) referenced from the top-level `styles` map — the shape
/// every `.coco` written by v0.8.1 or earlier used.
fn legacy_only_snapshot() -> String {
    json!({
        "id": "wb-legacy",
        "sheets": {},
        "styles": {
            "s1": {
                "font": { "bold": true, "color": "#00FF00" },
                "fill": { "color": "#123456" },
                "alignment": { "horizontal": "center", "vertical": "middle" },
                "borders": { "top": { "style": "thin", "color": "#111111" } }
            }
        }
    })
    .to_string()
}

/// A style entry already in the Univer `IStyleData` shape (what v0.8.2+
/// writes and what the grid itself writes when the user formats a cell).
fn univer_only_snapshot() -> String {
    json!({
        "id": "wb-univer",
        "sheets": {},
        "styles": {
            "s1": { "bl": 1, "cl": { "rgb": "#FF0000" }, "n": { "pattern": "0.00%" } }
        }
    })
    .to_string()
}

/// One sheet with one legacy-shaped style entry and one already-Univer style
/// entry side by side, for the mixed case (acceptance criterion 3).
fn mixed_snapshot() -> String {
    json!({
        "id": "wb-mixed",
        "sheets": {
            "sheet-1": {
                "id": "sheet-1",
                "name": "Sheet1",
                "cellData": {
                    "0": {
                        "0": { "v": "legacy", "s": "s-legacy" },
                        "1": { "v": "univer", "s": "s-univer" }
                    }
                }
            }
        },
        "styles": {
            "s-legacy": {
                "font": { "bold": true, "color": "#00FF00" },
                "fill": { "color": "#123456" },
                "alignment": { "horizontal": "center", "vertical": "middle" }
            },
            "s-univer": {
                "bd": { "b": { "s": 1, "cl": { "rgb": "#000000" } } }
            }
        }
    })
    .to_string()
}

#[test]
fn open_nicel_migrates_legacy_style_shape() {
    let app_dir = TempDir::new().unwrap();
    let wb_dir = TempDir::new().unwrap();
    let path = wb_dir.path().join("legacy.coco");
    save_core(
        "wb-legacy".into(),
        Some(path_str(&path)),
        legacy_only_snapshot(),
    )
    .unwrap();

    let result = open_nicel_core(app_dir.path(), &path_str(&path)).unwrap();
    let snap: Value =
        serde_json::from_str(result.handle.snapshot_json.as_deref().unwrap()).unwrap();
    let style = &snap["styles"]["s1"];

    // Univer shape now present.
    assert_eq!(style["bl"], 1);
    assert_eq!(style["bg"]["rgb"], "#123456");
    assert_eq!(style["ht"], 2);
    assert_eq!(style["vt"], 2);
    assert_eq!(style["bd"]["t"]["cl"]["rgb"], "#111111");
    // Legacy keys must be gone, or the grid falls back to ignoring the whole
    // object again on a future read that only understands Univer's shape.
    assert!(style.get("font").is_none());
    assert!(style.get("fill").is_none());
    assert!(style.get("alignment").is_none());
    assert!(style.get("borders").is_none());
}

#[test]
fn open_nicel_leaves_univer_style_byte_identical() {
    let app_dir = TempDir::new().unwrap();
    let wb_dir = TempDir::new().unwrap();
    let path = wb_dir.path().join("univer.coco");
    let original = univer_only_snapshot();
    save_core("wb-univer".into(), Some(path_str(&path)), original.clone()).unwrap();

    let result = open_nicel_core(app_dir.path(), &path_str(&path)).unwrap();
    // Idempotence per the PM brief: an already-Univer .coco must come back
    // byte-for-byte identical, not just deep-equal.
    assert_eq!(
        result.handle.snapshot_json.as_deref(),
        Some(original.as_str())
    );
}

#[test]
fn open_nicel_handles_mixed_legacy_and_univer_styles() {
    let app_dir = TempDir::new().unwrap();
    let wb_dir = TempDir::new().unwrap();
    let path = wb_dir.path().join("mixed.coco");
    save_core("wb-mixed".into(), Some(path_str(&path)), mixed_snapshot()).unwrap();

    let result = open_nicel_core(app_dir.path(), &path_str(&path)).unwrap();
    let snap: Value =
        serde_json::from_str(result.handle.snapshot_json.as_deref().unwrap()).unwrap();

    let legacy_style = &snap["styles"]["s-legacy"];
    assert_eq!(legacy_style["bl"], 1);
    assert_eq!(legacy_style["bg"]["rgb"], "#123456");
    assert_eq!(legacy_style["ht"], 2);
    assert!(legacy_style.get("font").is_none());

    // The already-Univer entry must be untouched by the pass over the legacy
    // one — per-entry handling, not an all-or-nothing conversion.
    let univer_style = &snap["styles"]["s-univer"];
    assert_eq!(
        univer_style,
        &json!({ "bd": { "b": { "s": 1, "cl": { "rgb": "#000000" } } } })
    );
}

#[test]
fn open_nicel_migrates_inline_legacy_style_on_cell() {
    // Univer's own `ICellData.s` type is `IStyleData | string`, so a style can
    // in principle sit inline on the cell rather than in the top-level
    // `styles` map. No writer in this codebase produces that shape today
    // (confirmed by reading xlsx_io's importer and Univer's own snapshot
    // typedef), but the normalizer handles it defensively.
    let app_dir = TempDir::new().unwrap();
    let wb_dir = TempDir::new().unwrap();
    let path = wb_dir.path().join("inline.coco");
    let snapshot = json!({
        "id": "wb-inline",
        "sheets": {
            "sheet-1": {
                "id": "sheet-1",
                "cellData": {
                    "0": {
                        "0": {
                            "v": "x",
                            "s": {
                                "font": { "bold": true },
                                "alignment": { "horizontal": "right" }
                            }
                        }
                    }
                }
            }
        },
        "styles": {}
    })
    .to_string();
    save_core("wb-inline".into(), Some(path_str(&path)), snapshot).unwrap();

    let result = open_nicel_core(app_dir.path(), &path_str(&path)).unwrap();
    let snap: Value =
        serde_json::from_str(result.handle.snapshot_json.as_deref().unwrap()).unwrap();
    let inline_style = &snap["sheets"]["sheet-1"]["cellData"]["0"]["0"]["s"];
    assert_eq!(inline_style["bl"], 1);
    assert_eq!(inline_style["ht"], 3);
    assert!(inline_style.get("font").is_none());
}

#[test]
fn restore_backup_migrates_legacy_style_shape() {
    let app_dir = TempDir::new().unwrap();
    autosave_temp_core(app_dir.path(), "wb-recover", &legacy_only_snapshot(), None).unwrap();

    let result = restore_backup_core(app_dir.path(), "wb-recover").unwrap();
    let snap: Value =
        serde_json::from_str(result.handle.snapshot_json.as_deref().unwrap()).unwrap();
    assert_eq!(snap["styles"]["s1"]["bl"], 1);
    assert!(snap["styles"]["s1"].get("font").is_none());
}

#[test]
fn open_snapshot_migrates_legacy_style_shape() {
    let wb_dir = TempDir::new().unwrap();
    let path = wb_dir.path().join("history.coco");
    save_core(
        "wb-hist".into(),
        Some(path_str(&path)),
        legacy_only_snapshot(),
    )
    .unwrap();
    save_core("wb-hist".into(), Some(path_str(&path)), "{\"v\":2}".into()).unwrap();

    let snapshots = list_snapshots_core(&path_str(&path)).unwrap();
    let older = snapshots[1].snapshot_id; // [0] is the newest ("v":2) save.

    let result = open_snapshot_core(&path_str(&path), older).unwrap();
    let snap: Value =
        serde_json::from_str(result.handle.snapshot_json.as_deref().unwrap()).unwrap();
    assert_eq!(snap["styles"]["s1"]["bl"], 1);
    assert!(snap["styles"]["s1"].get("font").is_none());
}

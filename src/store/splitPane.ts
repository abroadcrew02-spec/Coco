// Pure helpers for the "ウィンドウ分割" (window split) feature — #156.
//
// Excel exposes two related but distinct view features on `<sheetView><pane>`:
//   * `state="frozen"` — the top-left rows/cols are locked in place, scrolling
//     only happens in the bottom-right pane. This is the "freeze panes" UX.
//   * `state="split"` — the sheet is cut into 2 or 4 viewports at an arbitrary
//     row/col, and EACH viewport scrolls independently. The split bar can be
//     dragged. There is no "locked" top-left region.
//
// Coco's xlsx I/O layer (`src-tauri/src/commands/xlsx_io.rs`) already
// round-trips both states via `sheets.<id>._freezePane = { row, col, state,
// topLeft? }`. This module wraps that snapshot field with split-pane-specific
// helpers and a `mode` discriminator so the UI can offer 2 / 4 split modes
// without growing the on-disk schema (`mode` is derived from row & col).
//
// On-disk encoding for #156:
//   `_freezePane = { row, col, state: "split", topLeft?: string }`
//
// `mode` mapping (derived, not stored):
//   * row > 0 && col > 0  → "both"        (4-pane split — H+V)
//   * row > 0 && col == 0 → "horizontal"  (2-pane horizontal split)
//   * row == 0 && col > 0 → "vertical"    (2-pane vertical split)
//   * row == 0 && col == 0 → null         (no split)
//
// Univer 0.5.x does not expose a dedicated split-pane renderer — only
// `setFreeze`. The editor-side wiring uses `setFreeze` as the in-memory visual
// approximation (4 independent scroll viewports), and the `state="split"`
// marker survives via the snapshot for xlsx round-trip parity.

export type SplitMode = "horizontal" | "vertical" | "both";

export interface SplitPaneEntry {
  /** 0-based row index of the split anchor (== ySplit; rows 0..row are in the top pane). */
  row: number;
  /** 0-based column index of the split anchor (== xSplit; cols 0..col are in the left pane). */
  col: number;
  /** Optional A1-style top-left visible cell in the bottom-right pane (e.g. "C5"). */
  topLeft?: string;
}

export interface SplitSnapshotShape {
  sheets?: Record<
    string,
    | undefined
    | {
        _freezePane?: {
          row?: number;
          col?: number;
          state?: string;
          topLeft?: string;
        };
        // Univer's native IWorksheetData.freeze. Coco mirrors `_freezePane`
        // onto this field at write time so a Univer remount (e.g. after
        // cocoUndo, which bumps editorRevision and re-creates the unit) keeps
        // the multi-viewport layout visible. xlsx round-trip is still driven
        // by `_freezePane` (carries the `state` discriminator); `freeze` is
        // recomputed on every write.
        freeze?: {
          xSplit: number;
          ySplit: number;
          startRow: number;
          startColumn: number;
        };
      }
  >;
}

/**
 * Derive the split mode (horizontal / vertical / both) from a row/col anchor.
 * Returns `null` when the entry is degenerate (both 0) — the snapshot writer
 * omits `_freezePane` entirely in that case to mirror Rust's "omit when empty"
 * convention.
 */
export function splitModeFor(row: number, col: number): SplitMode | null {
  const r = row > 0;
  const c = col > 0;
  if (r && c) return "both";
  if (r) return "horizontal";
  if (c) return "vertical";
  return null;
}

/**
 * Compute the split-pane entry for a given active cell position and mode.
 * - "both": split runs through the active cell (row = activeRow, col = activeCol)
 * - "horizontal": split runs above the active row (col = 0)
 * - "vertical": split runs left of the active col (row = 0)
 *
 * Negative inputs are clamped to 0. When both row and col collapse to 0 (e.g.
 * the user tries to split at A1 with no offset) the function returns `null` —
 * the caller should treat this as "no-op, do not write a split".
 */
export function computeSplitEntry(
  activeRow: number,
  activeCol: number,
  mode: SplitMode,
): SplitPaneEntry | null {
  const row = Math.max(0, Math.floor(activeRow));
  const col = Math.max(0, Math.floor(activeCol));
  let outRow = 0;
  let outCol = 0;
  switch (mode) {
    case "both":
      outRow = row;
      outCol = col;
      break;
    case "horizontal":
      outRow = row;
      outCol = 0;
      break;
    case "vertical":
      outRow = 0;
      outCol = col;
      break;
  }
  if (outRow === 0 && outCol === 0) return null;
  return { row: outRow, col: outCol };
}

/**
 * Read the split-pane entry for a sheet from a snapshot JSON string.
 * Returns `null` for: malformed JSON, missing sheet, no `_freezePane`, or
 * `state !== "split"` (the entry represents a frozen pane, not a split).
 *
 * This is the read side of #156 — frozen panes are intentionally not
 * surfaced here so the View → Split menu only toggles split state.
 */
export function readSplitPane(
  snapshotJson: string | null | undefined,
  sheetId: string | null | undefined,
): SplitPaneEntry | null {
  if (!snapshotJson || !sheetId) return null;
  let parsed: SplitSnapshotShape;
  try {
    parsed = JSON.parse(snapshotJson) as SplitSnapshotShape;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const fp = parsed.sheets?.[sheetId]?._freezePane;
  if (!fp) return null;
  if (fp.state !== "split") return null;
  const row = typeof fp.row === "number" && fp.row >= 0 ? Math.floor(fp.row) : 0;
  const col = typeof fp.col === "number" && fp.col >= 0 ? Math.floor(fp.col) : 0;
  if (row === 0 && col === 0) return null;
  const out: SplitPaneEntry = { row, col };
  if (typeof fp.topLeft === "string" && fp.topLeft) out.topLeft = fp.topLeft;
  return out;
}

/**
 * Return `true` iff the snapshot has a split (state="split") declared on the
 * given sheet. Convenience wrapper around `readSplitPane` for command-enable
 * checks (e.g. "分割を解除" is only enabled when a split exists).
 */
export function hasSplitPane(
  snapshotJson: string | null | undefined,
  sheetId: string | null | undefined,
): boolean {
  return readSplitPane(snapshotJson, sheetId) !== null;
}

/**
 * Write the given split entry into a snapshot object (in place) under
 * `sheets.<sheetId>._freezePane = { row, col, state: "split", topLeft? }`.
 *
 * Pass `entry === null` to clear the split (deletes `_freezePane` entirely,
 * matching the Rust "omit when empty" convention).
 *
 * Returns `true` when the snapshot was mutated, `false` when no change was
 * needed (missing sheet, idempotent clear, etc.). The caller is responsible
 * for re-stringifying and pushing through `applyMutatedSnapshot`.
 *
 * Note: this OVERWRITES any prior `_freezePane`, so calling this on a sheet
 * that currently has `state="frozen"` will replace it with a split. That's
 * intentional — the two modes are mutually exclusive in OOXML (one `<pane>`
 * element per sheet view).
 */
export function writeSplitPaneInto(
  snapshot: SplitSnapshotShape,
  sheetId: string,
  entry: SplitPaneEntry | null,
): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!snapshot.sheets) return false;
  const sheet = snapshot.sheets[sheetId];
  if (!sheet) return false;
  if (entry === null) {
    let mutated = false;
    if (sheet._freezePane !== undefined) {
      delete sheet._freezePane;
      mutated = true;
    }
    // Reset Univer's native freeze marker so a remount doesn't keep showing
    // the old split. The sentinel `{-1,-1,-1,-1}` is the Univer convention
    // for "no freeze" (see IFreeze in @univerjs/core typedef).
    if (sheet.freeze !== undefined) {
      sheet.freeze = { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 };
      mutated = true;
    }
    return mutated;
  }
  const row = Math.max(0, Math.floor(entry.row));
  const col = Math.max(0, Math.floor(entry.col));
  const out: { row: number; col: number; state: string; topLeft?: string } = {
    row,
    col,
    state: "split",
  };
  if (entry.topLeft && entry.topLeft.trim()) out.topLeft = entry.topLeft.trim();
  sheet._freezePane = out;
  // Mirror onto Univer's native freeze so the renderer picks it up after
  // a remount (cocoUndo / cocoRedo bumps editorRevision → createUnit). For a
  // horizontal-only split (col=0), startColumn stays at -1 (Univer's "no
  // freeze in this axis" sentinel); same for vertical-only (startRow=-1).
  sheet.freeze = {
    xSplit: col,
    ySplit: row,
    startRow: row > 0 ? row : -1,
    startColumn: col > 0 ? col : -1,
  };
  return true;
}

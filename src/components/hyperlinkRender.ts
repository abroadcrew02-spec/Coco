// In-grid hyperlink rendering (Phase 2).
//
// The xlsx round-trip stores per-sheet hyperlinks at `sheets.<sid>._hyperlinks`
// (entries: { cell: "A1", target: "https://...", display?, tooltip? }). This
// module is the glue that turns that metadata into a visible, clickable cell
// in Univer:
//
//   1. `patchHyperlinkRenders(snapshot)` — pure, called before handing a
//      snapshot to `univer.createUnit`. For each hyperlink entry, it sets the
//      anchor cell's value to `display ?? target` and folds blue+underline
//      into the cell's inline style (the `s` field). We use an inline IStyleData
//      rather than registering against the snapshot's `styles` table so the
//      patch is composable with whatever style the cell already carries.
//
//   2. `parseA1` / `lookupHyperlink` — tiny query helpers used by the click
//      handler in EditorScreen to resolve a (sheetId, row, col) hit-test back
//      to the target URL, so a click on a styled cell opens the link.
//
// We deliberately go through the snapshot's `cellData` rather than Univer's
// rich-text `p` field: a full IDocumentData paragraph is overkill for a single
// styled run and would fight with later cell edits. The `s` + `v` shape is also
// what the rest of the xlsx_io.rs writer expects on round-trip, so this
// renderer is purely a display concern — it never mutates `_hyperlinks` itself.

export interface HyperlinkEntry {
  cell: string;
  target: string;
  display?: string;
  tooltip?: string;
}

export interface CellCoord {
  row: number;
  col: number;
}

/**
 * Color + underline applied to every hyperlink cell. Matches Excel's default
 * Hyperlink style closely enough to read as a link without theming work.
 */
export const HYPERLINK_STYLE = {
  cl: { rgb: "#1155cc" },
  ul: { s: 1 as const },
};

/**
 * Parse an A1-style single-cell ref (e.g. "B12", "AA3") into 0-based row/col.
 * Returns null on malformed input — callers treat the entry as unprocessable
 * and skip it rather than throwing, matching the rest of Coco's best-effort
 * snapshot patching (compare to `_dataValidations` / `_comments`).
 */
export function parseA1(cell: string): CellCoord | null {
  const m = /^([A-Z]+)(\d+)$/.exec(cell.trim().toUpperCase());
  if (!m) return null;
  const letters = m[1];
  const rowNum = Number.parseInt(m[2], 10);
  if (!Number.isFinite(rowNum) || rowNum < 1) return null;
  let col = 0;
  for (const ch of letters) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: rowNum - 1, col: col - 1 };
}

type SnapshotShape = {
  sheets?: Record<
    string,
    {
      cellData?: Record<string, Record<string, unknown>>;
      _hyperlinks?: HyperlinkEntry[];
    }
  >;
};

/**
 * Return a *new* snapshot with hyperlink cells styled in place. The input is
 * not mutated, so callers can reuse the original for diffing. We:
 *
 *   - Skip entries whose `cell` doesn't parse — malformed metadata.
 *   - Initialize `cellData[row][col]` if the cell is empty so a hyperlink on
 *     a previously-blank cell still renders (Excel itself does this — the
 *     authoring dialog seeds `display` from the existing value, but it can
 *     also be blank).
 *   - Set `v` to `display ?? target` *only when the cell has no existing
 *     value*. We don't clobber user-typed text, only fill in the link label.
 *   - Merge HYPERLINK_STYLE into the existing inline `s` (when it's an
 *     object) or replace `s` outright when it's a string-keyed reference
 *     (the snapshot styles-table case). The string-replace path loses the
 *     prior style ref, but Excel's default Hyperlink style does the same — a
 *     link cell shouldn't carry an unrelated font/fill.
 */
export function patchHyperlinkRenders<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  // Cheap structural clone — snapshots are plain JSON in practice. Falls back
  // to returning the input on any serialization error (e.g. cycles, which
  // Univer snapshots don't have but we stay defensive).
  let cloned: SnapshotShape;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
  } catch {
    return snapshot;
  }

  const sheets = cloned.sheets;
  if (!sheets) return cloned as unknown as T;

  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId];
    const links = sheet?._hyperlinks;
    if (!Array.isArray(links) || links.length === 0) continue;

    const cellData = (sheet.cellData ?? (sheet.cellData = {})) as Record<
      string,
      Record<string, unknown>
    >;

    for (const link of links) {
      if (!link || typeof link.cell !== "string" || typeof link.target !== "string") {
        continue;
      }
      const coord = parseA1(link.cell);
      if (!coord) continue;
      const rowKey = String(coord.row);
      const colKey = String(coord.col);
      const row = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<string, unknown>;
      const existing = (row[colKey] as Record<string, unknown> | undefined) ?? {};

      // Fill in the visible label only if the cell is otherwise empty. We
      // check `v` and `p` because Univer may have either depending on how
      // the cell was authored.
      const hasValue =
        existing.v !== undefined && existing.v !== null && existing.v !== "";
      const label = link.display && link.display.length > 0 ? link.display : link.target;
      const nextValue = hasValue ? existing.v : label;

      // Fold the hyperlink style into the inline style. We always emit an
      // object here; the on-export style writer accepts both forms and we
      // prefer the inline form since it survives the snapshot round-trip
      // without needing a styles-table entry.
      const baseStyle =
        typeof existing.s === "object" && existing.s !== null
          ? (existing.s as Record<string, unknown>)
          : {};
      const mergedStyle = {
        ...baseStyle,
        cl: HYPERLINK_STYLE.cl,
        ul: HYPERLINK_STYLE.ul,
      };

      row[colKey] = {
        ...existing,
        v: nextValue,
        s: mergedStyle,
      };
    }
  }

  return cloned as unknown as T;
}

/**
 * Look up a hyperlink entry by (sheetId, row, col). Returns null when the
 * cell has no link or the snapshot is malformed. Used by the click handler
 * to decide whether to open something on cell click.
 */
export function lookupHyperlink(
  snapshotJson: string | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): HyperlinkEntry | null {
  if (!snapshotJson) return null;
  let snap: SnapshotShape;
  try {
    snap = JSON.parse(snapshotJson) as SnapshotShape;
  } catch {
    return null;
  }
  const links = snap.sheets?.[sheetId]?._hyperlinks;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    if (!link || typeof link.cell !== "string") continue;
    const coord = parseA1(link.cell);
    if (!coord) continue;
    if (coord.row === row && coord.col === col) return link;
  }
  return null;
}

/**
 * Classify a hyperlink target. Internal links look like `#Sheet2!A1` (the
 * Rust round-trip canonicalizes them to a leading `#`); everything else is
 * treated as external and handed to the OS shell. Returns null for empty
 * targets.
 */
export type HyperlinkKind =
  | { kind: "internal"; sheet: string; cell: string }
  | { kind: "external"; url: string };

export function classifyHyperlink(target: string): HyperlinkKind | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) {
    // Strip leading `#` then split on `!`. Accept both `Sheet!A1` and
    // bare `Sheet` (no cell) — the latter is rare but valid in Excel.
    const body = trimmed.slice(1);
    const bang = body.indexOf("!");
    if (bang < 0) return { kind: "internal", sheet: body, cell: "A1" };
    const sheet = body.slice(0, bang);
    const cell = body.slice(bang + 1) || "A1";
    return { kind: "internal", sheet, cell };
  }
  return { kind: "external", url: trimmed };
}

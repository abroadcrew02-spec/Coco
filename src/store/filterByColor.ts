// Pure helpers for the Excel-style "Filter by Color" (色でフィルター).
//
// Extends AutoFilter semantics: instead of matching cell values, we match the
// fill (background) or font color of cells in a chosen column. Rows whose
// colored cell is NOT in `selectedColors` get `rowData[r].hd = 1` (hidden).
//
// Snapshot shape (Univer 0.5.x — same convention used by advancedFilter.ts,
// cellStyles.ts, and formatPainter.ts):
//   {
//     styles?: { [styleId: string]: IStyleData },
//     sheets: {
//       <sheetId>: {
//         cellData?: { [row: string]: { [col: string]: { s?: string | IStyleData } } },
//         rowData?:  { [row: string]: { hd?: 0 | 1 } },
//       }
//     }
//   }
//
// Cell.s may be either:
//   - a string id (interned in workbook.styles), or
//   - an inline IStyleData-shaped object (`{ bg?: { rgb }, cl?: { rgb }, ... }`)
//
// Color extraction returns a canonicalised "#RRGGBB" hex (upper-case) so two
// equivalent values are deduped (e.g. "#fff" vs "#FFFFFF" vs "FFFFFF" become
// "#FFFFFF"). A null return means the cell has no explicit color of that kind.
//
// Kept side-effect free so the dialog can preview and unit tests can drive it
// without instantiating Univer. Mirrors the style+contract of sortByColor.ts
// (companion module — extractCellColor is duplicated here intentionally; a
// future merge can hoist it into a shared helper).

export interface ColorRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface FilterByColorParams {
  /** 0-based source rectangle (header row at r1 is preserved — never hidden). */
  range: ColorRect;
  /** 0-based column index to inspect for colors (must lie within `range`). */
  column: number;
  /** Which color attribute to filter on. */
  kind: "fill" | "font";
  /**
   * Canonicalised "#RRGGBB" colors to keep. Rows whose colored cell matches
   * one of these are visible; every other row is hidden. The sentinel
   * "__none__" matches cells that have no explicit color of that kind (so
   * users can include / exclude "uncolored" rows).
   */
  selectedColors: string[];
}

// ---------------------------------------------------------------------------
// Color extraction
// ---------------------------------------------------------------------------

// Canonicalise to upper-case "#RRGGBB". Accepts "#fff" / "fff" / "#FFFFFF" /
// "FFFFFF" / 8-char "#RRGGBBAA" (alpha stripped). Returns null on garbage.
function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith("#")) s = s.slice(1);
  // Strip alpha channel if present (Univer/xlsx occasionally serialise ARGB).
  if (s.length === 8) s = s.slice(0, 6);
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return "#" + s.toUpperCase();
}

/**
 * Extract a fill (bg) or font (cl) color from a cell's inline style object.
 * Returns null when the cell has no explicit color of that kind. Style ID
 * references (`s: "abc"`) are resolved upstream by `listDistinctColors` /
 * `applyFilterByColor` (which have access to `styles`); callers passing an
 * isolated cell with a string id will get null back.
 *
 * Local copy — duplicated in sortByColor.ts for now. Merge later.
 */
export function extractCellColor(
  cell: { s?: unknown },
  kind: "fill" | "font",
): string | null {
  if (!cell || typeof cell !== "object") return null;
  const s = (cell as { s?: unknown }).s;
  if (!s || typeof s !== "object") return null;
  const style = s as Record<string, unknown>;
  const key = kind === "fill" ? "bg" : "cl";
  const entry = style[key];
  if (!entry || typeof entry !== "object") return null;
  const rgb = (entry as { rgb?: unknown }).rgb;
  return normalizeHex(rgb);
}

// ---------------------------------------------------------------------------
// Distinct colors in a column
// ---------------------------------------------------------------------------

// Sentinel used in `selectedColors` to represent "no explicit color".
export const NO_COLOR_SENTINEL = "__none__";

type CellLike = { s?: unknown };
type CellDataLike =
  | Record<string, Record<string, CellLike | undefined> | undefined>
  | undefined;
type StylesLike = Record<string, Record<string, unknown> | undefined> | undefined;

// Read an inline-style object for a cell, resolving a string `s` id through
// the workbook-level `styles` table when present. Returns null when the cell
// has no style information at all.
function readInlineStyle(
  cell: CellLike | undefined,
  styles: StylesLike,
): Record<string, unknown> | null {
  if (!cell || typeof cell !== "object") return null;
  const s = (cell as { s?: unknown }).s;
  if (s === null || s === undefined) return null;
  if (typeof s === "object") return s as Record<string, unknown>;
  if (typeof s === "string") {
    const resolved = styles?.[s];
    return resolved && typeof resolved === "object" ? resolved : null;
  }
  return null;
}

// Pull a color from either an inline style object or a string-id reference.
// Encapsulates the styles-table lookup so callers don't repeat the dance.
function colorOfCell(
  cell: CellLike | undefined,
  kind: "fill" | "font",
  styles: StylesLike,
): string | null {
  const inline = readInlineStyle(cell, styles);
  if (!inline) return null;
  const key = kind === "fill" ? "bg" : "cl";
  const entry = inline[key];
  if (!entry || typeof entry !== "object") return null;
  return normalizeHex((entry as { rgb?: unknown }).rgb);
}

/**
 * Enumerate every distinct color that appears in `column` within the data
 * portion of `range` (the header row at `range.r1` is intentionally scanned
 * too — Excel includes header colors in the "Filter by Color" dropdown).
 *
 * Returns hex strings sorted lexicographically; if any cell in scope has no
 * explicit color of the requested kind, the `NO_COLOR_SENTINEL` is appended
 * last so the UI can render an "No Color" option.
 *
 * Accepts the snapshot's full sheet object (not just cellData) so it can
 * resolve string-id style references through the workbook `styles` table —
 * pass `{ cellData, styles }`.
 */
export function listDistinctColors(
  cellData: CellDataLike,
  range: ColorRect,
  column: number,
  kind: "fill" | "font",
  styles?: StylesLike,
): string[] {
  if (column < range.c1 || column > range.c2) return [];
  const r1 = Math.min(range.r1, range.r2);
  const r2 = Math.max(range.r1, range.r2);
  const seen = new Set<string>();
  let sawUncolored = false;
  for (let r = r1; r <= r2; r++) {
    const cell = cellData?.[String(r)]?.[String(column)];
    const color = colorOfCell(cell, kind, styles);
    if (color === null) {
      sawUncolored = true;
    } else {
      seen.add(color);
    }
  }
  const out = Array.from(seen).sort();
  if (sawUncolored) out.push(NO_COLOR_SENTINEL);
  return out;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

// Loose snapshot type — callers pass whatever Univer's `workbook.save()` emits.
interface SnapshotShape {
  styles?: StylesLike;
  sheets?: Record<
    string,
    | {
        cellData?: CellDataLike;
        rowData?: Record<string, { hd?: 0 | 1 } | undefined>;
      }
    | undefined
  >;
}

/**
 * Hide every row in `params.range` whose colored cell (at `params.column`,
 * filtered by `params.kind`) is NOT in `params.selectedColors`. The header
 * row (`range.r1`) is always kept visible and explicitly marked `hd: 0` in
 * case it was previously hidden by a different filter.
 *
 * Does NOT mutate the input; returns a new snapshot object plus counts.
 *
 * Behaviour matches Excel:
 *   - Empty `selectedColors` hides every data row (nothing matches).
 *   - The `NO_COLOR_SENTINEL` matches cells with no explicit color.
 *   - Style-id references in `s` are resolved through `snapshot.styles`.
 */
export function applyFilterByColor(
  snapshot: object,
  sheetId: string,
  params: FilterByColorParams,
): { snapshotMutated: object; matchedRows: number; hiddenRows: number } {
  // Defensive clone — re-parse via JSON so caller's object stays untouched.
  const cloned = JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
  const sheet = cloned.sheets?.[sheetId];
  if (!sheet) {
    return { snapshotMutated: cloned, matchedRows: 0, hiddenRows: 0 };
  }
  const styles = cloned.styles;
  const cellData = sheet.cellData;
  const r1 = Math.min(params.range.r1, params.range.r2);
  const r2 = Math.max(params.range.r1, params.range.r2);
  if (r1 < 0 || r2 < r1) {
    return { snapshotMutated: cloned, matchedRows: 0, hiddenRows: 0 };
  }
  if (params.column < params.range.c1 || params.column > params.range.c2) {
    return { snapshotMutated: cloned, matchedRows: 0, hiddenRows: 0 };
  }

  // Use a Set for O(1) membership lookup against selected colors.
  const selected = new Set(params.selectedColors);

  if (!sheet.rowData) sheet.rowData = {};
  const rowData = sheet.rowData as Record<string, { hd?: 0 | 1 }>;

  // Keep the header row visible even if it would otherwise be hidden.
  rowData[String(r1)] = { ...(rowData[String(r1)] ?? {}), hd: 0 };

  let matched = 0;
  let hidden = 0;
  for (let r = r1 + 1; r <= r2; r++) {
    const cell = cellData?.[String(r)]?.[String(params.column)];
    const color = colorOfCell(cell, params.kind, styles);
    const key = color ?? NO_COLOR_SENTINEL;
    const keep = selected.has(key);
    const prev = rowData[String(r)] ?? {};
    rowData[String(r)] = { ...prev, hd: keep ? 0 : 1 };
    if (keep) matched++;
    else hidden++;
  }

  return { snapshotMutated: cloned, matchedRows: matched, hiddenRows: hidden };
}

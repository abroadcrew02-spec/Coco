// In-grid rendering for Excel-style tables (ListObject).
//
// Mirrors the shape of `conditionalFormatRender.ts` and `hyperlinkRender.ts`:
// reads `sheets.<sid>._tables` out of the snapshot, then applies header
// styling, banded rows, and a bordered rectangle to the table range
// directly inside `cellData`. Pure / idempotent — the on-disk `_tables`
// array is the source of truth for the xlsx round-trip, so the inline
// styling we add here is purely cosmetic and won't drift on re-export.
//
// Order in the pipeline: this patch runs BEFORE patchCfRenders so that
// conditional-format highlights can OVERRIDE table colours on collision
// (Excel's precedence: CF > table style > base cell style). The merge
// strategy below mirrors patchCfRenders — "first-write wins per style key"
// — so when CF runs second, its writes can fill keys we haven't set yet
// without us clobbering them on top.
//
// Snapshot shape consumed (see `src/store/tables.ts` for the authoring side):
//   sheets.<sid>._tables: Array<{ name, range:{r1,c1,r2,c2}, headerRow,
//     totalsRow?, columns:[{name, totalsFunction?}], style?,
//     showBandedRows?, showFilterButton? }>

import type { TableEntry, TableStylePreset } from "../store/tables";

interface SnapshotShape {
  sheets?: Record<
    string,
    {
      cellData?: Record<string, Record<string, unknown>>;
      _tables?: TableEntry[];
    } | undefined
  >;
}

/** Per-preset colour bundle. Each entry maps loosely to the OOXML default
 *  for the same preset name, scaled down to two tones (header + band) plus
 *  a border — enough to make a table visually distinct from a plain range.
 *  Unknown presets fall back to TableStyleMedium2. */
const STYLE_PRESETS: Record<
  TableStylePreset,
  { headerBg: string; headerFg: string; bandBg: string; borderRgb: string }
> = {
  TableStyleLight1: {
    headerBg: "#000000",
    headerFg: "#ffffff",
    bandBg: "#f2f2f2",
    borderRgb: "#bfbfbf",
  },
  TableStyleMedium2: {
    headerBg: "#4472C4",
    headerFg: "#ffffff",
    bandBg: "#D9E1F2",
    borderRgb: "#8EA9DB",
  },
  TableStyleDark1: {
    headerBg: "#1F1F1F",
    headerFg: "#ffffff",
    bandBg: "#404040",
    borderRgb: "#7F7F7F",
  },
};

function presetFor(style: TableStylePreset | undefined): {
  headerBg: string;
  headerFg: string;
  bandBg: string;
  borderRgb: string;
} {
  if (style && Object.prototype.hasOwnProperty.call(STYLE_PRESETS, style)) {
    return STYLE_PRESETS[style];
  }
  return STYLE_PRESETS.TableStyleMedium2;
}

/** "First-write wins" merge — only fills style keys not already present on
 *  the existing cell style. Matches the merge contract in patchCfRenders so
 *  the higher-priority CF patch (which runs after us) can still override. */
function mergeStyle(
  existing: Record<string, unknown> | undefined,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const k of Object.keys(delta)) {
    if (!(k in merged)) merged[k] = delta[k];
  }
  return merged;
}

/** Apply a style delta to a single cell, going through `cellData[row][col].s`.
 *  Creates intermediate row/col objects when they don't exist yet, so a table
 *  authored over an empty range still gets styled. */
function applyCellStyle(
  cellData: Record<string, Record<string, unknown>>,
  row: number,
  col: number,
  delta: Record<string, unknown>,
): void {
  const rowKey = String(row);
  const colKey = String(col);
  const rowMap = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<string, unknown>;
  const existing = (rowMap[colKey] as Record<string, unknown> | undefined) ?? {};
  const baseStyle =
    typeof existing.s === "object" && existing.s !== null
      ? (existing.s as Record<string, unknown>)
      : undefined;
  rowMap[colKey] = {
    ...existing,
    s: mergeStyle(baseStyle, delta),
  };
}

/**
 * Build the four-sided border delta for the cells along the edge of the
 * table rectangle. We assemble per-cell `bd` objects so the border draws on
 * the OUTSIDE of the table (no internal cell-edge borders — those would
 * conflict with banding contrast).
 *
 * Univer's border shape: `bd: { t?: BorderLine, b?: BorderLine, l?: ..., r?: ... }`
 * with each BorderLine = `{ s: number, cl: { rgb: string } }` (`s: 1` = thin).
 */
function borderEdges(
  row: number,
  col: number,
  range: { r1: number; c1: number; r2: number; c2: number },
  colorRgb: string,
): Record<string, unknown> | null {
  const line = { s: 1, cl: { rgb: colorRgb } };
  const bd: Record<string, unknown> = {};
  if (row === range.r1) bd.t = line;
  if (row === range.r2) bd.b = line;
  if (col === range.c1) bd.l = line;
  if (col === range.c2) bd.r = line;
  return Object.keys(bd).length > 0 ? { bd } : null;
}

/**
 * Return a new snapshot with every table in `sheets.<sid>._tables` rendered
 * in-place: header row bold + filled, data rows optionally banded, an
 * outer border around the rectangle. Pure — does not mutate the input.
 *
 * Tolerates malformed / missing `_tables` entries (silently skips).
 */
export function patchTableRenders<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
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
    const tables = sheet?._tables;
    if (!Array.isArray(tables) || tables.length === 0) continue;
    const cellData = (sheet!.cellData ?? (sheet!.cellData = {})) as Record<
      string,
      Record<string, unknown>
    >;

    for (const table of tables) {
      if (!table || typeof table !== "object") continue;
      const range = table.range;
      if (
        !range ||
        typeof range !== "object" ||
        !Number.isFinite(range.r1) ||
        !Number.isFinite(range.r2) ||
        !Number.isFinite(range.c1) ||
        !Number.isFinite(range.c2)
      ) {
        continue;
      }
      // Normalise the rectangle (defensive — the authoring helpers already
      // normalise, but a hand-edited snapshot could feed us a flipped range).
      const r1 = Math.min(range.r1, range.r2);
      const r2 = Math.max(range.r1, range.r2);
      const c1 = Math.min(range.c1, range.c2);
      const c2 = Math.max(range.c1, range.c2);
      const norm = { r1, c1, r2, c2 };

      const preset = presetFor(table.style);
      const headerRow = table.headerRow !== false;
      const banded = table.showBandedRows !== false;

      for (let row = r1; row <= r2; row++) {
        const isHeader = headerRow && row === r1;
        // Banding rows: alternate the BAND fill on every second DATA row,
        // starting AFTER the header. We pick "every other row" relative to
        // the first data row so the immediate next row after the header
        // stays unbanded (Excel default — header, data, band, data, band).
        const dataRowIndex = headerRow ? row - r1 - 1 : row - r1;
        const isBanded = banded && !isHeader && dataRowIndex >= 0 && dataRowIndex % 2 === 1;

        for (let col = c1; col <= c2; col++) {
          // Build the style delta. Always include border edges for outer
          // cells; layer header / banding on top.
          const delta: Record<string, unknown> = {};

          if (isHeader) {
            delta.bl = 1;
            delta.bg = { rgb: preset.headerBg };
            delta.cl = { rgb: preset.headerFg };
          } else if (isBanded) {
            delta.bg = { rgb: preset.bandBg };
          }

          const edges = borderEdges(row, col, norm, preset.borderRgb);
          if (edges) Object.assign(delta, edges);

          if (Object.keys(delta).length === 0) continue;
          applyCellStyle(cellData, row, col, delta);
        }
      }
    }
  }

  return cloned as unknown as T;
}

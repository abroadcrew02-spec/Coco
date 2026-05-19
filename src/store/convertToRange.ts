// Pure helpers for Excel's "Convert to Range" feature — drops the ListObject
// table metadata from a sheet while leaving the cell values intact. When the
// caller asks to preserve formatting, we BAKE the visual style produced by
// `patchTableRenders` (header fill + bold, banded rows, outer border) into
// each cell's `cellData[r][c].s` so the converted range still LOOKS like a
// table even though the `_tables` entry is gone.
//
// Snapshot shape (Univer 0.5.x + Coco extension, mirrors src/store/tables.ts):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: { [row]: { [col]: { v?: unknown, s?: object } } },
//         _tables?: Array<{
//           name: string;
//           range: { r1: number; c1: number; r2: number; c2: number };
//           headerRow: boolean;
//           totalsRow?: boolean;
//           columns: Array<{ name: string; totalsFunction?: ... }>;
//           style?: TableStylePreset;
//           showBandedRows?: boolean;
//           showFilterButton?: boolean;
//         }>;
//       }
//     }
//   }
//
// Side-effect free — operates on a JSON-cloned copy of the input snapshot and
// returns it. The caller (EditorScreen) is responsible for handing the result
// to `applyMutatedSnapshot` so Univer + the snapshot-history stack pick it up.
//
// IMPORTANT: keep the style baking logic in lock-step with `tableRender.ts`.
// We deliberately duplicate the preset table + edge-detection here (instead
// of importing from `tableRender.ts`) because that module's `patchTableRenders`
// mutates its input via JSON deep-clone, which is overkill for a single-table
// rewrite and would also re-render every OTHER table on the sheet. The two
// modules share the same intent; if you tweak presets in one, mirror them.

import type { TableEntry, TableStylePreset, TableRange } from "./tables";

export interface ConvertToRangeParams {
  tableName: string;
  preserveStyles: boolean;
}

export interface ConvertToRangeResult {
  snapshotMutated: object;
  cellsTouched: number;
}

interface SheetShape {
  cellData?: Record<string, Record<string, unknown>>;
  _tables?: TableEntry[];
  [k: string]: unknown;
}

interface SnapshotShape {
  sheets?: Record<string, SheetShape | undefined>;
  [k: string]: unknown;
}

// Per-preset colour bundle. Kept in-sync with `STYLE_PRESETS` inside
// `src/components/tableRender.ts` — unknown presets fall back to
// TableStyleMedium2 so a hand-edited snapshot never breaks the convert.
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

// "First-write wins" — only fills style keys not already present on the
// existing cell style. Same semantics as tableRender.ts so a cell that already
// had user-authored fill/font is preserved when we bake.
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

// Build the four-sided OUTER border delta — internal cells get nothing.
function borderEdges(
  row: number,
  col: number,
  range: TableRange,
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
 * Convert a single named table on the given sheet back into a plain range.
 *
 * Steps:
 *  1. Clone the snapshot (JSON round-trip — same pattern as tableRender.ts).
 *  2. Find the matching table by name on `sheets[sheetId]._tables`. When not
 *     found, return the cloned snapshot unchanged with `cellsTouched: 0` so
 *     the caller can no-op gracefully without throwing.
 *  3. If `preserveStyles` is true, walk the table rectangle and bake the
 *     header / banding / border style into each cell's `.s` using the same
 *     logic as `patchTableRenders`.
 *  4. Drop the table entry from `_tables` (filter, not splice — the clone is
 *     already isolated).
 *
 * Returns:
 *   - `snapshotMutated`: the modified snapshot (safe to JSON.stringify).
 *   - `cellsTouched`: how many cells received a baked style delta (0 when
 *     `preserveStyles` is false, or when the rectangle was empty / malformed).
 */
export function applyConvertToRange(
  snapshot: unknown,
  sheetId: string,
  params: ConvertToRangeParams,
): ConvertToRangeResult {
  // Defensive clone — never mutate the caller's object.
  const cloned: SnapshotShape = (() => {
    if (!snapshot || typeof snapshot !== "object") return {};
    try {
      return JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
    } catch {
      return {};
    }
  })();

  const sheets = cloned.sheets;
  if (!sheets || typeof sheets !== "object") {
    return { snapshotMutated: cloned, cellsTouched: 0 };
  }
  const sheet = sheets[sheetId];
  if (!sheet || typeof sheet !== "object") {
    return { snapshotMutated: cloned, cellsTouched: 0 };
  }

  const tables = Array.isArray(sheet._tables) ? sheet._tables : [];
  const target = tables.find((t) => t && typeof t === "object" && t.name === params.tableName);
  if (!target) {
    return { snapshotMutated: cloned, cellsTouched: 0 };
  }

  let cellsTouched = 0;

  if (params.preserveStyles) {
    const range = target.range;
    const valid =
      range &&
      typeof range === "object" &&
      Number.isFinite(range.r1) &&
      Number.isFinite(range.r2) &&
      Number.isFinite(range.c1) &&
      Number.isFinite(range.c2);

    if (valid) {
      // Normalise the rectangle (defensive against hand-edited flipped ranges).
      const r1 = Math.min(range.r1, range.r2);
      const r2 = Math.max(range.r1, range.r2);
      const c1 = Math.min(range.c1, range.c2);
      const c2 = Math.max(range.c1, range.c2);
      const norm: TableRange = { r1, c1, r2, c2 };

      const preset = presetFor(target.style);
      const headerRow = target.headerRow !== false;
      const banded = target.showBandedRows !== false;

      const cellData = (sheet.cellData ?? (sheet.cellData = {})) as Record<
        string,
        Record<string, unknown>
      >;

      for (let row = r1; row <= r2; row++) {
        const isHeader = headerRow && row === r1;
        // Mirror tableRender.ts banding: alternate AFTER the header so the
        // first data row stays unbanded.
        const dataRowIndex = headerRow ? row - r1 - 1 : row - r1;
        const isBanded = banded && !isHeader && dataRowIndex >= 0 && dataRowIndex % 2 === 1;

        for (let col = c1; col <= c2; col++) {
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
          cellsTouched++;
        }
      }
    }
  }

  // Drop the table from _tables. We keep a fresh array to avoid sharing
  // references with the original (mostly belt-and-braces — we already cloned).
  sheet._tables = tables.filter((t) => !(t && typeof t === "object" && t.name === params.tableName));

  return { snapshotMutated: cloned, cellsTouched };
}

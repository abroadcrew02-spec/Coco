// Sparkline helpers (Phase 2 — inline mini-charts).
//
// Snapshot shape (Coco extension to Univer 0.5.x workbook data):
//   {
//     sheets: {
//       <sheetId>: {
//         _sparklines?: Array<{
//           cell: string;            // A1 anchor, e.g. "D5" — single cell
//           sourceRange: string;     // A1 range, e.g. "A5:C5" or "Sheet1!A5:C5"
//           type: "line" | "column" | "winloss";
//           color?: string;          // default "#5B9BD5"
//           negativeColor?: string;  // winloss only; default "#C00000"
//           showMarkers?: boolean;   // line only; high/low markers
//           axis?: boolean;          // winloss only; draw zero axis
//         }>
//       }
//     }
//   }
//
// The MVP renders sparklines as Unicode block characters into the anchor
// cell's `v` field (with a monospace font in `s`). A future iteration may
// swap this for a Univer custom-cell renderer that draws actual SVG, but
// the snapshot shape itself is forward-compatible: only the *render* layer
// (sparklineRender.ts) needs to change.
//
// All helpers in this module are pure and side-effect free so the same
// code can drive both the snapshot patch and the authoring dialog preview.
// Mirrors the dataValidation.ts / conditionalFormatRender.ts conventions.
//
// Public surface:
//   - `SparklineEntry`, `SparklineSnapshot` interfaces
//   - `parseA1Range(range)` — handles bare and sheet-qualified A1 ranges
//   - `readRangeValues(sheet, range)` — pulls numeric values from cellData
//   - `renderLineSparkline(values)` — up-to-8-char block-bar string
//   - `renderColumnSparkline(values)` — same block-bar set (column = line for the unicode-art MVP)
//   - `renderWinLossSparkline(values)` — ▲ / ▼ / ─ string
//   - `addSparkline(sheet, entry)` — append/replace at the anchor cell
//   - `removeSparkline(sheet, cell)` — remove by anchor

export type SparklineType = "line" | "column" | "winloss";

export interface SparklineEntry {
  cell: string;
  sourceRange: string;
  type: SparklineType;
  color?: string;
  negativeColor?: string;
  showMarkers?: boolean;
  axis?: boolean;
}

export interface SparklineSheet {
  cellData?: Record<string, Record<string, unknown>>;
  _sparklines?: SparklineEntry[];
  name?: string;
}

export interface SparklineSnapshot {
  sheets?: Record<string, SparklineSheet | undefined>;
}

export const DEFAULT_SPARKLINE_COLOR = "#5B9BD5";
export const DEFAULT_SPARKLINE_NEGATIVE_COLOR = "#C00000";

/** Line-sparkline glyph set, 8 levels, low → high. */
const LINE_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Decode an A1 column-letter run into a 0-based column index. Returns -1
 * on malformed input.
 */
function colLettersToIndex(letters: string): number {
  const up = letters.toUpperCase();
  let n = 0;
  for (const ch of up) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export interface ParsedA1Range {
  sheetName?: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/**
 * Parse a (possibly sheet-qualified) A1 range. Accepts:
 *   - "A1" / "$A$1" — single cell (r1==r2, c1==c2)
 *   - "A1:C3" / "$A$1:$C$3" — rectangle, normalized so r1<=r2 / c1<=c2
 *   - "Sheet1!A1:C3" / "'Other Sheet'!A1:C3" — captures sheetName
 * Quoted sheet names strip the surrounding `'` and unescape `''` → `'`.
 * Returns null on any malformed component.
 */
export function parseA1Range(range: string): ParsedA1Range | null {
  if (typeof range !== "string") return null;
  let body = range.trim();
  if (!body) return null;
  let sheetName: string | undefined;

  // Sheet-qualified — split on the *last* `!` so quoted names with `!` in
  // them parse correctly. Quoted sheet names take precedence.
  const bang = body.lastIndexOf("!");
  if (bang >= 0) {
    let sheetPart = body.slice(0, bang);
    body = body.slice(bang + 1);
    if (sheetPart.startsWith("'") && sheetPart.endsWith("'") && sheetPart.length >= 2) {
      sheetPart = sheetPart.slice(1, -1).replace(/''/g, "'");
    }
    sheetName = sheetPart;
  }

  const colon = body.indexOf(":");
  const m1 = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(
    colon < 0 ? body : body.slice(0, colon),
  );
  if (!m1) return null;
  const c1 = colLettersToIndex(m1[1]);
  const r1n = Number.parseInt(m1[2], 10);
  if (c1 < 0 || !Number.isFinite(r1n) || r1n < 1) return null;
  const r1 = r1n - 1;

  if (colon < 0) {
    return { sheetName, r1, c1, r2: r1, c2: c1 };
  }
  const m2 = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(body.slice(colon + 1));
  if (!m2) return null;
  const c2raw = colLettersToIndex(m2[1]);
  const r2n = Number.parseInt(m2[2], 10);
  if (c2raw < 0 || !Number.isFinite(r2n) || r2n < 1) return null;
  const r2raw = r2n - 1;
  return {
    sheetName,
    r1: Math.min(r1, r2raw),
    c1: Math.min(c1, c2raw),
    r2: Math.max(r1, r2raw),
    c2: Math.max(c1, c2raw),
  };
}

/** Parse a single A1 cell ref into 0-based row/col. Null on malformed. */
export function parseA1Cell(cell: string): { row: number; col: number } | null {
  const parsed = parseA1Range(cell);
  if (!parsed) return null;
  if (parsed.r1 !== parsed.r2 || parsed.c1 !== parsed.c2) return null;
  return { row: parsed.r1, col: parsed.c1 };
}

function readCellValue(
  cellData: Record<string, Record<string, unknown>> | undefined,
  row: number,
  col: number,
): unknown {
  if (!cellData) return undefined;
  const r = cellData[String(row)];
  if (!r) return undefined;
  const cell = r[String(col)] as Record<string, unknown> | undefined;
  if (!cell) return undefined;
  return cell.v;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pull every numeric value out of `sheet.cellData` for the given A1 range.
 * Non-numeric / blank cells are skipped. Iterates row-major (top→bottom,
 * left→right) so the resulting array preserves the visual order of the
 * source range — required by the renderers so the bar string reads in the
 * same direction as the data.
 */
export function readRangeValues(sheet: SparklineSheet | undefined, range: string): number[] {
  if (!sheet) return [];
  const parsed = parseA1Range(range);
  if (!parsed) return [];
  const out: number[] = [];
  for (let r = parsed.r1; r <= parsed.r2; r++) {
    for (let c = parsed.c1; c <= parsed.c2; c++) {
      const n = toFiniteNumber(readCellValue(sheet.cellData, r, c));
      if (n !== null) out.push(n);
    }
  }
  return out;
}

/**
 * Down-sample `values` to at most `target` points by averaging contiguous
 * buckets. Returns the input unchanged when it already fits. Empty input
 * yields an empty array.
 */
function downsample(values: number[], target: number): number[] {
  if (values.length <= target) return values.slice();
  const out: number[] = [];
  const bucket = values.length / target;
  for (let i = 0; i < target; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.min(values.length, Math.floor((i + 1) * bucket));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += values[j];
      count++;
    }
    out.push(count > 0 ? sum / count : values[start] ?? 0);
  }
  return out;
}

/**
 * Map a normalized value [0, 1] to one of the 8 line-bar glyphs. Clamps
 * out-of-range inputs; NaN falls back to the lowest bar.
 */
function levelToBar(level: number): string {
  if (!Number.isFinite(level)) return LINE_BARS[0];
  const idx = Math.max(0, Math.min(7, Math.round(level * 7)));
  return LINE_BARS[idx];
}

/**
 * Render a "line" sparkline as up to 8 block characters. The line and
 * column variants both render bottom-up bars in this MVP — true SVG line
 * vs. column rendering will land with the Univer custom-cell renderer
 * later, but the data layout is the same and the unicode-art bar shape
 * conveys the trend regardless. Returns "" on empty input.
 */
export function renderLineSparkline(values: number[]): string {
  if (!Array.isArray(values) || values.length === 0) return "";
  const sampled = downsample(values, 8);
  let min = Infinity;
  let max = -Infinity;
  for (const v of sampled) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Flat series: render the mid-bar so the cell shows something rather
  // than all-zeros (which would look empty in some fonts).
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return sampled.map(() => LINE_BARS[3]).join("");
  }
  const range = max - min;
  return sampled.map((v) => levelToBar((v - min) / range)).join("");
}

/** Column sparkline shares the line glyph set in the unicode-art MVP. */
export function renderColumnSparkline(values: number[]): string {
  return renderLineSparkline(values);
}

/**
 * Render a win/loss sparkline: one glyph per source value.
 *   - positive → ▲
 *   - negative → ▼
 *   - zero / non-numeric → ─
 * Truncated to 32 glyphs so the cell stays readable; the original count is
 * still summarized by trailing "…" when we truncate.
 */
export function renderWinLossSparkline(values: number[]): string {
  if (!Array.isArray(values) || values.length === 0) return "";
  const MAX = 32;
  const slice = values.length > MAX ? values.slice(0, MAX) : values;
  let out = "";
  for (const v of slice) {
    if (!Number.isFinite(v)) {
      out += "─";
    } else if (v > 0) {
      out += "▲";
    } else if (v < 0) {
      out += "▼";
    } else {
      out += "─";
    }
  }
  if (values.length > MAX) out += "…";
  return out;
}

/**
 * Append a sparkline to the sheet's `_sparklines` array, replacing any
 * existing entry at the same anchor cell. Returns the new array (the
 * caller decides whether to mutate the sheet object or clone).
 */
export function addSparkline(
  sheet: SparklineSheet | undefined,
  sparkline: SparklineEntry,
): SparklineEntry[] {
  const existing = (sheet?._sparklines ?? []).filter(
    (s) => s && s.cell !== sparkline.cell,
  );
  existing.push(sparkline);
  return existing;
}

/** Remove the sparkline at `cell` from the sheet's `_sparklines` array. */
export function removeSparkline(
  sheet: SparklineSheet | undefined,
  cell: string,
): SparklineEntry[] {
  return (sheet?._sparklines ?? []).filter((s) => s && s.cell !== cell);
}

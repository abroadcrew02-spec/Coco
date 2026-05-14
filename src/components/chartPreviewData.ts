// Pure helpers for extracting chart preview data out of a Univer workbook
// snapshot JSON string. Used by the in-grid chart preview panel
// (EditorScreen) so authored `_charts` entries surface a small SVG render
// without needing the @univerjs/sheets-chart plugin (which isn't in this
// build). Kept side-effect free so it can be unit-tested without standing
// up Univer.
//
// Snapshot shape (Univer 0.5.x + Coco extension; mirrors xlsx_io.rs):
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         cellData?: { [row]: { [col]: { v?: string | number, ... } } },
//         _charts?: Array<{ range: string, type: "bar"|"line"|"pie", title?: string }>
//       }
//     }
//   }
//
// The PoC reads `cellData[r][c].v` only; rich-text (`p`) and formula values
// (`f`) are out of scope — same constraint as conditionalFormatRender.ts.

export type ChartType = "bar" | "line" | "pie";

export interface ChartPreview {
  sheetId: string;
  sheetName: string;
  range: string;
  type: ChartType;
  title?: string;
  /** Category labels (row/col headers). Length = data.length. */
  labels: string[];
  /** Numeric values aligned to `labels`. NaN entries are dropped. */
  data: number[];
}

interface ChartSnapshot {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<string, Record<string, { v?: unknown }>>;
        _charts?: Array<{ range?: unknown; type?: unknown; title?: unknown }>;
      }
    | undefined
  >;
}

// A1 range parsing — accepts "A1", "A1:B10", or "Sheet!A1:B10". Sheet
// qualifier is stripped (chart preview always reads from the owning sheet's
// cellData, matching how the dialog records the entry).
const RANGE_RE = /^(?:[^!]+!)?\$?([A-Za-z]+)\$?([1-9]\d*)(?::\$?([A-Za-z]+)\$?([1-9]\d*))?$/;

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

export interface RangeBox {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/**
 * Parse an A1 range into 0-based row/col bounds. Returns null on malformed
 * input. Single-cell refs collapse to r0==r1, c0==c1.
 */
export function parseRange(range: string): RangeBox | null {
  if (typeof range !== "string") return null;
  const m = RANGE_RE.exec(range.trim());
  if (!m) return null;
  const c0 = colLettersToIndex(m[1]);
  const r0 = Number.parseInt(m[2], 10) - 1;
  const c1 = m[3] !== undefined ? colLettersToIndex(m[3]) : c0;
  const r1 = m[4] !== undefined ? Number.parseInt(m[4], 10) - 1 : r0;
  if (c0 < 0 || c1 < 0 || r0 < 0 || r1 < 0) return null;
  return {
    r0: Math.min(r0, r1),
    r1: Math.max(r0, r1),
    c0: Math.min(c0, c1),
    c1: Math.max(c0, c1),
  };
}

function readCell(
  cellData: Record<string, Record<string, { v?: unknown }>> | undefined,
  row: number,
  col: number,
): unknown {
  if (!cellData) return undefined;
  const r = cellData[String(row)];
  if (!r) return undefined;
  const cell = r[String(col)];
  if (!cell) return undefined;
  return cell.v;
}

function toLabel(v: unknown, fallback: string): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : fallback;
  if (typeof v === "string") return v;
  return fallback;
}

function toNumberOrNaN(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

/**
 * Pull labels + numeric series out of a cellData block over a parsed range.
 *
 * Heuristics (keep it simple, match Excel's "single series" PoC behaviour):
 *   - 2+ columns wide: column 0 = labels, column 1 = values
 *   - 1 column wide, 2+ rows: row 0 = (skip / title), rest = values, labels
 *     are the 1-based row indices ("1","2",...)
 *   - 1 row tall, 2+ columns: column 0 = (skip / title), rest = values
 *     labels are the column letters
 *   - degenerate 1x1: a single point labeled "1"
 *
 * Non-numeric cells in the values column are skipped (not zero-filled) so
 * the bar/line chart doesn't display fake data.
 */
export function extractSeries(
  cellData: Record<string, Record<string, { v?: unknown }>> | undefined,
  box: RangeBox,
): { labels: string[]; data: number[] } {
  const rows = box.r1 - box.r0 + 1;
  const cols = box.c1 - box.c0 + 1;
  const labels: string[] = [];
  const data: number[] = [];

  // Two-or-more-column path: labels from col 0, values from col 1.
  if (cols >= 2 && rows >= 1) {
    for (let r = box.r0; r <= box.r1; r++) {
      const labRaw = readCell(cellData, r, box.c0);
      const valRaw = readCell(cellData, r, box.c0 + 1);
      const n = toNumberOrNaN(valRaw);
      if (Number.isNaN(n)) continue;
      labels.push(toLabel(labRaw, String(r - box.r0 + 1)));
      data.push(n);
    }
    return { labels, data };
  }

  // Single-column path: values from the only column, labels are 1-based indices.
  if (cols === 1 && rows >= 1) {
    for (let r = box.r0; r <= box.r1; r++) {
      const valRaw = readCell(cellData, r, box.c0);
      const n = toNumberOrNaN(valRaw);
      if (Number.isNaN(n)) continue;
      labels.push(String(r - box.r0 + 1));
      data.push(n);
    }
    return { labels, data };
  }

  return { labels, data };
}

/**
 * Returns a flat list of chart previews across all sheets in the snapshot,
 * preserving the snapshot's `sheetOrder` so the UI lists sheets in tab
 * order. Within each sheet, charts retain their array order.
 *
 * Tolerates malformed JSON, missing sheets, missing `_charts`, and bad
 * entries (silently skips them). A null / empty / unparseable input
 * returns [] so callers can render unconditionally.
 */
export function computeChartPreviews(
  snapshotJson: string | null | undefined,
): ChartPreview[] {
  if (!snapshotJson) return [];
  let parsed: ChartSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as ChartSnapshot;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const sheets = parsed.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  const order =
    Array.isArray(parsed.sheetOrder) && parsed.sheetOrder.length > 0
      ? parsed.sheetOrder.filter((id) => typeof id === "string")
      : Object.keys(sheets);

  const out: ChartPreview[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const arr = sheet._charts;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sheetName = typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const range = typeof entry.range === "string" ? entry.range : null;
      const typeRaw = typeof entry.type === "string" ? entry.type : null;
      if (!range || !typeRaw) continue;
      if (typeRaw !== "bar" && typeRaw !== "line" && typeRaw !== "pie") continue;
      const box = parseRange(range);
      if (!box) continue;
      const { labels, data } = extractSeries(sheet.cellData, box);
      const preview: ChartPreview = {
        sheetId,
        sheetName,
        range,
        type: typeRaw,
        labels,
        data,
      };
      if (typeof entry.title === "string" && entry.title) {
        preview.title = entry.title;
      }
      out.push(preview);
    }
  }
  return out;
}

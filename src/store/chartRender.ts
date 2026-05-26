// Pure SVG renderers for live chart display.
//
// Distinct from chartPreviewData.ts: that module produces single-series
// preview tuples for the sidebar list, whereas this module is the live
// canvas backend — it accepts MULTI-series data and a richer set of
// chart options (legend, axis labels, palettes, stacked/grouped bars,
// data labels). The two modules deliberately do NOT share types so the
// integrator can swap independently.
//
// All renderers return SVG markup as a plain string so the consumer can
// drop it through `dangerouslySetInnerHTML` without React having to
// reconcile every <rect> / <path>. Keeps re-render cost flat regardless
// of category count.
//
// Snapshot shape we read from (Univer 0.5.x + Coco extension):
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         cellData?: { [row]: { [col]: { v?: unknown } } },
//         _charts?: Array<{
//           range: string,
//           type: "line"|"bar"|"pie"|"scatter"|"area"|"doughnut",
//           title?: string,
//           xAxisLabel?: string,
//           yAxisLabel?: string,
//           showLegend?: boolean,        // default true
//           showDataLabels?: boolean,    // default false
//           stacked?: boolean,           // bar only
//           seriesColors?: string[],     // hex per series; default palette
//           hasHeaderRow?: boolean,      // first row = series names; default true
//           hasHeaderCol?: boolean,      // first col = category labels; default true
//         }>
//       }
//     }
//   }
//
// Side-effect free; safe to test without Univer or a DOM.

export type LiveChartType =
  | "line"
  | "bar"
  | "pie"
  | "scatter"
  | "area"
  | "doughnut";

export interface ChartEntry {
  range: string;
  type: LiveChartType;
  title?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  showLegend?: boolean;
  showDataLabels?: boolean;
  stacked?: boolean;
  seriesColors?: string[];
  hasHeaderRow?: boolean;
  hasHeaderCol?: boolean;
  // In-grid placement fields (Step 3).
  anchorRow?: number;
  anchorCol?: number;
  widthPx?: number;
  heightPx?: number;
}

export interface ChartListing {
  sheetId: string;
  sheetName: string;
  index: number;
  entry: ChartEntry;
}

export interface ChartData {
  /** Names of each series; length === values.length. */
  seriesNames: string[];
  /** X-axis categories (or x-values stringified for scatter). */
  categories: string[];
  /** values[seriesIdx][categoryIdx]; NaN indicates a missing point. */
  values: number[][];
}

export interface RenderOpts {
  width: number;
  height: number;
  title?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  showLegend: boolean;
  showDataLabels: boolean;
  palette: string[];
}

/** Default Excel-ish palette. Cycles when fewer colors than series. */
export const DEFAULT_PALETTE = [
  "#5B9BD5",
  "#ED7D31",
  "#A5A5A5",
  "#FFC000",
  "#4472C4",
  "#70AD47",
  "#264478",
  "#9E480E",
];

// ---------- snapshot / range parsing ----------

interface SnapshotShape {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<string, Record<string, { v?: unknown }>>;
        _charts?: ChartEntry[];
      }
    | undefined
  >;
}

const RANGE_RE =
  /^(?:([^!]+)!)?\$?([A-Za-z]+)\$?([1-9]\d*)(?::\$?([A-Za-z]+)\$?([1-9]\d*))?$/;

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

interface ParsedRange {
  sheetName: string | null;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

function parseRange(range: string): ParsedRange | null {
  if (typeof range !== "string") return null;
  const m = RANGE_RE.exec(range.trim());
  if (!m) return null;
  let sheetName: string | null = m[1] ?? null;
  if (sheetName && sheetName.startsWith("'") && sheetName.endsWith("'")) {
    sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
  }
  const c0 = colLettersToIndex(m[2]);
  const r0 = Number.parseInt(m[3], 10) - 1;
  const c1 = m[4] !== undefined ? colLettersToIndex(m[4]) : c0;
  const r1 = m[5] !== undefined ? Number.parseInt(m[5], 10) - 1 : r0;
  if (c0 < 0 || c1 < 0 || r0 < 0 || r1 < 0) return null;
  return {
    sheetName,
    r0: Math.min(r0, r1),
    r1: Math.max(r0, r1),
    c0: Math.min(c0, c1),
    c1: Math.max(c0, c1),
  };
}

function findSheetByName(
  snapshot: SnapshotShape,
  name: string,
): {
  sheetId: string;
  cellData: Record<string, Record<string, { v?: unknown }>> | undefined;
} | null {
  if (!snapshot.sheets) return null;
  for (const sid of Object.keys(snapshot.sheets)) {
    const s = snapshot.sheets[sid];
    if (s && typeof s === "object" && s.name === name) {
      return { sheetId: sid, cellData: s.cellData };
    }
  }
  return null;
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

function colIndexToLetters(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

/**
 * Flatten every authored chart in the workbook into a single ordered list,
 * preserving `sheetOrder` so the dropdown lists sheets in tab order. Each
 * entry includes the originating sheetId so the renderer can resolve the
 * source range against the correct sheet's cellData.
 */
export function listAllCharts(snapshotJson: string | null | undefined): ChartListing[] {
  if (!snapshotJson) return [];
  let snap: SnapshotShape;
  try {
    snap = JSON.parse(snapshotJson) as SnapshotShape;
  } catch {
    return [];
  }
  if (!snap || typeof snap !== "object") return [];
  const sheets = snap.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  const order =
    Array.isArray(snap.sheetOrder) && snap.sheetOrder.length > 0
      ? snap.sheetOrder.filter((id): id is string => typeof id === "string")
      : Object.keys(sheets);

  const out: ChartListing[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const arr = sheet._charts;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sheetName =
      typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    arr.forEach((entry, i) => {
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.range !== "string") return;
      const type = entry.type;
      if (
        type !== "line" &&
        type !== "bar" &&
        type !== "pie" &&
        type !== "scatter" &&
        type !== "area" &&
        type !== "doughnut"
      ) {
        return;
      }
      out.push({ sheetId, sheetName, index: i, entry });
    });
  }
  return out;
}

/**
 * Pull the cells covered by a chart's source range into a multi-series
 * `ChartData` block. Honours `hasHeaderRow` / `hasHeaderCol` to peel
 * series names off the top row and category labels off the left column.
 *
 * When the range lives on a different sheet (e.g. "Sheet2!A1:C5"), the
 * sheet prefix is resolved against `snapshot.sheets` by name. When the
 * range is unqualified the caller's `defaultSheetId` is used.
 *
 * Returns an empty-but-valid ChartData on parse failure so renderers can
 * still produce a "no data" SVG rather than crashing.
 */
export function extractChartData(
  snapshotJson: string | null | undefined,
  chart: { entry: ChartEntry; sheetId: string },
): ChartData {
  const empty: ChartData = { seriesNames: [], categories: [], values: [] };
  if (!snapshotJson) return empty;
  let snap: SnapshotShape;
  try {
    snap = JSON.parse(snapshotJson) as SnapshotShape;
  } catch {
    return empty;
  }
  if (!snap || !snap.sheets) return empty;
  const parsed = parseRange(chart.entry.range);
  if (!parsed) return empty;

  let cellData:
    | Record<string, Record<string, { v?: unknown }>>
    | undefined;
  if (parsed.sheetName) {
    const found = findSheetByName(snap, parsed.sheetName);
    cellData = found?.cellData;
  } else {
    const sheet = snap.sheets[chart.sheetId];
    cellData = sheet?.cellData;
  }

  const hasHeaderRow = chart.entry.hasHeaderRow !== false;
  const hasHeaderCol = chart.entry.hasHeaderCol !== false;

  const rTop = parsed.r0;
  const rBot = parsed.r1;
  const cLeft = parsed.c0;
  const cRight = parsed.c1;

  const firstDataRow = hasHeaderRow ? rTop + 1 : rTop;
  const firstDataCol = hasHeaderCol ? cLeft + 1 : cLeft;

  // Pathological: header eats all rows/cols.
  if (firstDataRow > rBot || firstDataCol > cRight) return empty;

  // Series names (from header row) — one per data column.
  const seriesNames: string[] = [];
  for (let c = firstDataCol; c <= cRight; c++) {
    if (hasHeaderRow) {
      seriesNames.push(
        toLabel(readCell(cellData, rTop, c), `Series ${seriesNames.length + 1}`),
      );
    } else {
      seriesNames.push(`Series ${seriesNames.length + 1}`);
    }
  }

  // Category labels (from header column) — one per data row.
  const categories: string[] = [];
  for (let r = firstDataRow; r <= rBot; r++) {
    if (hasHeaderCol) {
      categories.push(
        toLabel(readCell(cellData, r, cLeft), `${categories.length + 1}`),
      );
    } else {
      // Fall back to A1 row letters so scatter / no-header data still
      // shows a meaningful x-axis tick.
      categories.push(`${colIndexToLetters(cLeft)}${r + 1}`);
    }
  }

  // values[seriesIdx][categoryIdx]
  const values: number[][] = seriesNames.map(() => []);
  for (let r = firstDataRow; r <= rBot; r++) {
    for (let c = firstDataCol; c <= cRight; c++) {
      const sIdx = c - firstDataCol;
      values[sIdx].push(toNumberOrNaN(readCell(cellData, r, c)));
    }
  }

  return { seriesNames, categories, values };
}

// ---------- SVG render utilities ----------

/** Escape a string for safe embedding inside SVG text / attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Allowlist-based color sanitizer for SVG attribute values.
 *
 * Accepts:
 *   - #RGB      (#abc)
 *   - #RRGGBB   (#aabbcc)
 *   - #RRGGBBAA (#aabbccdd)
 *   - CSS named colors (e.g. "red", "steelblue")
 *   - rgb() / rgba() functional notation
 *   - hsl() / hsla() functional notation
 *   - "none" / "transparent"
 *
 * Anything that does not match is replaced with the first DEFAULT_PALETTE
 * color so a rogue value never reaches the SVG attribute.
 */
const COLOR_ALLOWLIST =
  /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)|hsl\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*\)|hsla\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*,\s*[\d.]+\s*\)|[a-z]{2,30}|none|transparent)$/i;

export function sanitizeColor(color: string): string {
  const trimmed = color.trim();
  if (COLOR_ALLOWLIST.test(trimmed)) {
    return esc(trimmed);
  }
  return DEFAULT_PALETTE[0];
}

function pickColor(palette: string[], idx: number): string {
  const raw =
    palette.length === 0
      ? DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length]
      : palette[idx % palette.length];
  return sanitizeColor(raw);
}

/**
 * "Nice" axis tick step — produces 1/2/5 × 10^n increments so the y-axis
 * shows round numbers instead of awkward fractions. Mirrors the convention
 * used by Excel / Sheets when the user hasn't fixed the bounds manually.
 */
function niceStep(span: number, target: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / mag;
  let step: number;
  if (normalized < 1.5) step = 1;
  else if (normalized < 3) step = 2;
  else if (normalized < 7) step = 5;
  else step = 10;
  return step * mag;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 10_000) return (n / 1_000).toFixed(1) + "k";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

/** Wrap children inside the outer <svg> with title + axis labels. */
function svgFrame(opts: RenderOpts, plot: PlotBox, inner: string, legend: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}" font-family="Segoe UI, sans-serif" font-size="11">`,
    `<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="#ffffff"/>`,
    opts.title
      ? `<text x="${opts.width / 2}" y="16" text-anchor="middle" font-size="13" font-weight="600" fill="#1f2937">${esc(opts.title)}</text>`
      : "",
    opts.yAxisLabel
      ? `<text x="12" y="${plot.y + plot.h / 2}" text-anchor="middle" fill="#4b5563" font-size="11" transform="rotate(-90 12 ${plot.y + plot.h / 2})">${esc(opts.yAxisLabel)}</text>`
      : "",
    opts.xAxisLabel
      ? `<text x="${plot.x + plot.w / 2}" y="${opts.height - 6}" text-anchor="middle" fill="#4b5563" font-size="11">${esc(opts.xAxisLabel)}</text>`
      : "",
    inner,
    legend,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("");
}

interface PlotBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Compute the inner plot rectangle, leaving room for title, axis labels,
 * and a legend strip on the right when enabled. Coordinates are in SVG
 * user units (matches `width` / `height`).
 */
function computePlot(opts: RenderOpts, hasLegend: boolean, axisStyle: "xy" | "none"): PlotBox {
  const padTop = opts.title ? 30 : 12;
  const padBottom = (opts.xAxisLabel ? 32 : 14) + (axisStyle === "xy" ? 18 : 0);
  const padLeft = (opts.yAxisLabel ? 32 : 12) + (axisStyle === "xy" ? 36 : 0);
  const padRight = hasLegend && opts.showLegend ? 96 : 12;
  return {
    x: padLeft,
    y: padTop,
    w: Math.max(20, opts.width - padLeft - padRight),
    h: Math.max(20, opts.height - padTop - padBottom),
  };
}

/**
 * Right-side legend strip — one swatch per series, cropped to whatever
 * fits in the reserved 96px column. Returns "" when the caller disabled
 * legends or there's nothing to label.
 */
function renderLegend(
  opts: RenderOpts,
  plot: PlotBox,
  names: string[],
): string {
  if (!opts.showLegend || names.length === 0) return "";
  const x = plot.x + plot.w + 12;
  const lineH = 16;
  const maxRows = Math.floor(plot.h / lineH) || 1;
  const visible = names.slice(0, maxRows);
  const parts: string[] = [];
  visible.forEach((name, i) => {
    const y = plot.y + i * lineH + 4;
    const color = pickColor(opts.palette, i);
    parts.push(
      `<rect x="${x}" y="${y}" width="10" height="10" fill="${color}"/>`,
      `<text x="${x + 14}" y="${y + 9}" fill="#374151">${esc(name.length > 12 ? name.slice(0, 11) + "…" : name)}</text>`,
    );
  });
  if (names.length > visible.length) {
    const y = plot.y + visible.length * lineH + 9;
    parts.push(
      `<text x="${x}" y="${y}" fill="#6b7280">+${names.length - visible.length}…</text>`,
    );
  }
  return parts.join("");
}

/**
 * Collect every finite cell across all series so renderers can derive
 * shared y-axis bounds. Excludes NaN (returned by toNumberOrNaN for blank
 * / non-numeric cells) so missing points don't drag the axis to zero.
 */
function flatten(values: number[][]): number[] {
  const out: number[] = [];
  for (const row of values) {
    for (const v of row) if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Common empty-state renderer for charts with no usable data. */
function emptyChart(opts: RenderOpts, message: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}" font-family="Segoe UI, sans-serif" font-size="12">`,
    `<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="#f9fafb"/>`,
    opts.title
      ? `<text x="${opts.width / 2}" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="#374151">${esc(opts.title)}</text>`
      : "",
    `<text x="${opts.width / 2}" y="${opts.height / 2}" text-anchor="middle" fill="#9ca3af">${esc(message)}</text>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("");
}

/**
 * Cartesian axes + grid + tick labels. Returned as an SVG fragment so the
 * caller can layer series geometry on top. Excludes the plot rectangle's
 * own background so bar/line/area can blend cleanly.
 */
function renderAxes(
  plot: PlotBox,
  yMin: number,
  yMax: number,
  xTicks: string[],
): string {
  const parts: string[] = [];
  const step = niceStep(yMax - yMin, 5);
  const ticks: number[] = [];
  const start = Math.ceil(yMin / step) * step;
  for (let v = start; v <= yMax + step * 0.001; v += step) ticks.push(v);
  for (const t of ticks) {
    const y = plot.y + plot.h - ((t - yMin) / (yMax - yMin || 1)) * plot.h;
    parts.push(
      `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="#e5e7eb"/>`,
      `<text x="${plot.x - 4}" y="${y + 3}" text-anchor="end" fill="#6b7280">${esc(fmtNum(t))}</text>`,
    );
  }
  // Zero line, when the axis crosses it.
  if (yMin < 0 && yMax > 0) {
    const y = plot.y + plot.h - ((0 - yMin) / (yMax - yMin)) * plot.h;
    parts.push(
      `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="#9ca3af"/>`,
    );
  }
  // x axis baseline
  const baseline = plot.y + plot.h;
  parts.push(
    `<line x1="${plot.x}" y1="${baseline}" x2="${plot.x + plot.w}" y2="${baseline}" stroke="#9ca3af"/>`,
    `<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${baseline}" stroke="#9ca3af"/>`,
  );
  // X-axis labels — show first, last, and as many in between as fit
  // without overlapping (rough heuristic: 1 label per ~48px).
  if (xTicks.length > 0) {
    const maxLabels = Math.max(2, Math.floor(plot.w / 48));
    const stride = Math.max(1, Math.ceil(xTicks.length / maxLabels));
    xTicks.forEach((label, i) => {
      if (i !== xTicks.length - 1 && i % stride !== 0) return;
      const x =
        xTicks.length === 1
          ? plot.x + plot.w / 2
          : plot.x + (i / (xTicks.length - 1)) * plot.w;
      parts.push(
        `<text x="${x}" y="${baseline + 12}" text-anchor="middle" fill="#6b7280">${esc(label.length > 8 ? label.slice(0, 7) + "…" : label)}</text>`,
      );
    });
  }
  return parts.join("");
}

// ---------- Line ----------

export function renderLineChart(data: ChartData, opts: RenderOpts): string {
  if (data.values.length === 0 || data.categories.length === 0) {
    return emptyChart(opts, "No data");
  }
  const flat = flatten(data.values);
  if (flat.length === 0) return emptyChart(opts, "No numeric data");
  const yMin = Math.min(0, ...flat);
  const yMax = Math.max(0, ...flat);
  const plot = computePlot(opts, true, "xy");
  const stepX =
    data.categories.length > 1 ? plot.w / (data.categories.length - 1) : 0;
  const yScale = (v: number) =>
    plot.y + plot.h - ((v - yMin) / (yMax - yMin || 1)) * plot.h;

  const seriesParts: string[] = [];
  data.values.forEach((series, sIdx) => {
    const color = pickColor(opts.palette, sIdx);
    let path = "";
    let pen = false;
    series.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      const x =
        data.categories.length === 1 ? plot.x + plot.w / 2 : plot.x + i * stepX;
      const y = yScale(v);
      path += `${pen ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)} `;
      pen = true;
    });
    seriesParts.push(
      `<path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linejoin="round"/>`,
    );
    series.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x =
        data.categories.length === 1 ? plot.x + plot.w / 2 : plot.x + i * stepX;
      const y = yScale(v);
      seriesParts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.5" fill="${color}"/>`);
      if (opts.showDataLabels) {
        seriesParts.push(
          `<text x="${x.toFixed(2)}" y="${(y - 5).toFixed(2)}" text-anchor="middle" font-size="9" fill="#1f2937">${esc(fmtNum(v))}</text>`,
        );
      }
    });
  });

  const inner =
    renderAxes(plot, yMin, yMax, data.categories) + seriesParts.join("");
  const legend = renderLegend(opts, plot, data.seriesNames);
  return svgFrame(opts, plot, inner, legend);
}

// ---------- Bar ----------

export function renderBarChart(
  data: ChartData,
  opts: RenderOpts,
  stacked: boolean,
): string {
  if (data.values.length === 0 || data.categories.length === 0) {
    return emptyChart(opts, "No data");
  }
  const seriesCount = data.values.length;
  const catCount = data.categories.length;

  // Per-category totals for stacked, otherwise raw min/max across series.
  let yMin = 0;
  let yMax = 0;
  if (stacked) {
    for (let c = 0; c < catCount; c++) {
      let posSum = 0;
      let negSum = 0;
      for (let s = 0; s < seriesCount; s++) {
        const v = data.values[s][c];
        if (!Number.isFinite(v)) continue;
        if (v >= 0) posSum += v;
        else negSum += v;
      }
      if (posSum > yMax) yMax = posSum;
      if (negSum < yMin) yMin = negSum;
    }
  } else {
    const flat = flatten(data.values);
    if (flat.length === 0) return emptyChart(opts, "No numeric data");
    yMin = Math.min(0, ...flat);
    yMax = Math.max(0, ...flat);
  }
  if (yMin === yMax) yMax = yMin + 1;

  const plot = computePlot(opts, true, "xy");
  const slot = plot.w / catCount;
  const groupPad = slot * 0.18;
  const groupW = slot - groupPad * 2;
  const barW = stacked ? groupW : groupW / Math.max(1, seriesCount);
  const yScale = (v: number) =>
    plot.y + plot.h - ((v - yMin) / (yMax - yMin)) * plot.h;
  const zeroY = yScale(0);

  const parts: string[] = [];
  for (let c = 0; c < catCount; c++) {
    let posOffset = 0;
    let negOffset = 0;
    for (let s = 0; s < seriesCount; s++) {
      const v = data.values[s][c];
      if (!Number.isFinite(v)) continue;
      const color = pickColor(opts.palette, s);
      let x: number;
      let y: number;
      let h: number;
      if (stacked) {
        x = plot.x + c * slot + groupPad;
        if (v >= 0) {
          const top = yScale(posOffset + v);
          const bot = yScale(posOffset);
          posOffset += v;
          y = top;
          h = Math.max(1, bot - top);
        } else {
          const top = yScale(negOffset);
          const bot = yScale(negOffset + v);
          negOffset += v;
          y = top;
          h = Math.max(1, bot - top);
        }
      } else {
        x = plot.x + c * slot + groupPad + s * barW;
        if (v >= 0) {
          y = yScale(v);
          h = Math.max(1, zeroY - y);
        } else {
          y = zeroY;
          h = Math.max(1, yScale(v) - zeroY);
        }
      }
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}"/>`,
      );
      if (opts.showDataLabels) {
        const labelY = v >= 0 ? y - 3 : y + h + 10;
        parts.push(
          `<text x="${(x + barW / 2).toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle" font-size="9" fill="#1f2937">${esc(fmtNum(v))}</text>`,
        );
      }
    }
  }

  const inner = renderAxes(plot, yMin, yMax, data.categories) + parts.join("");
  const legend = renderLegend(opts, plot, data.seriesNames);
  return svgFrame(opts, plot, inner, legend);
}

// ---------- Pie / Doughnut ----------

function renderPieLike(
  data: ChartData,
  opts: RenderOpts,
  innerRatio: number,
): string {
  if (data.values.length === 0 || data.categories.length === 0) {
    return emptyChart(opts, "No data");
  }
  // Pie uses only the first series. Categories drive the slices.
  const series = data.values[0];
  if (!series) return emptyChart(opts, "No data");
  const positives = series.map((v) => (Number.isFinite(v) ? Math.abs(v) : 0));
  const total = positives.reduce((a, b) => a + b, 0);

  const plot = computePlot(opts, true, "none");
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const r = Math.max(8, Math.min(plot.w, plot.h) / 2 - 4);
  const ir = innerRatio > 0 ? r * innerRatio : 0;

  if (total === 0) {
    const empty = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#e5e7eb"/>${ir > 0 ? `<circle cx="${cx}" cy="${cy}" r="${ir}" fill="#ffffff"/>` : ""}`;
    return svgFrame(opts, plot, empty, renderLegend(opts, plot, data.categories));
  }

  let acc = 0;
  const parts: string[] = [];
  positives.forEach((v, i) => {
    if (v === 0) return;
    const start = (acc / total) * Math.PI * 2;
    acc += v;
    const end = (acc / total) * Math.PI * 2;
    const color = pickColor(opts.palette, i);

    if (positives.filter((p) => p > 0).length === 1) {
      // Single non-zero slice — draw a full disk (arc paths can't close
      // a full circle in one segment).
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
      if (ir > 0) parts.push(`<circle cx="${cx}" cy="${cy}" r="${ir}" fill="#ffffff"/>`);
    } else {
      const x1 = cx + r * Math.cos(start - Math.PI / 2);
      const y1 = cy + r * Math.sin(start - Math.PI / 2);
      const x2 = cx + r * Math.cos(end - Math.PI / 2);
      const y2 = cy + r * Math.sin(end - Math.PI / 2);
      const large = end - start > Math.PI ? 1 : 0;
      if (ir > 0) {
        const ix1 = cx + ir * Math.cos(start - Math.PI / 2);
        const iy1 = cy + ir * Math.sin(start - Math.PI / 2);
        const ix2 = cx + ir * Math.cos(end - Math.PI / 2);
        const iy2 = cy + ir * Math.sin(end - Math.PI / 2);
        const d = [
          `M${x1.toFixed(2)},${y1.toFixed(2)}`,
          `A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`,
          `L${ix2.toFixed(2)},${iy2.toFixed(2)}`,
          `A${ir},${ir} 0 ${large} 0 ${ix1.toFixed(2)},${iy1.toFixed(2)}`,
          "Z",
        ].join(" ");
        parts.push(
          `<path d="${d}" fill="${color}" stroke="#ffffff" stroke-width="1"/>`,
        );
      } else {
        const d = `M${cx.toFixed(2)},${cy.toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
        parts.push(
          `<path d="${d}" fill="${color}" stroke="#ffffff" stroke-width="1"/>`,
        );
      }
    }

    if (opts.showDataLabels) {
      // Mid-slice label
      const mid = (start + end) / 2;
      const lr = ir > 0 ? (r + ir) / 2 : r * 0.6;
      const lx = cx + lr * Math.cos(mid - Math.PI / 2);
      const ly = cy + lr * Math.sin(mid - Math.PI / 2);
      const pct = ((v / total) * 100).toFixed(0) + "%";
      parts.push(
        `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="middle" font-size="10" fill="#ffffff" font-weight="600">${esc(pct)}</text>`,
      );
    }
  });

  const legend = renderLegend(opts, plot, data.categories);
  return svgFrame(opts, plot, parts.join(""), legend);
}

export function renderPieChart(data: ChartData, opts: RenderOpts): string {
  return renderPieLike(data, opts, 0);
}

export function renderDoughnutChart(data: ChartData, opts: RenderOpts): string {
  return renderPieLike(data, opts, 0.55);
}

// ---------- Scatter ----------

export function renderScatterChart(data: ChartData, opts: RenderOpts): string {
  // For scatter we re-interpret the data: each series is plotted as
  // (categoryNumeric, value). When the first column was strings, fall back
  // to 1-based indices on the x-axis. Negative values handled naturally
  // by y-axis bounds.
  if (data.values.length === 0 || data.categories.length === 0) {
    return emptyChart(opts, "No data");
  }
  const xNum: number[] = data.categories.map((c, i) => {
    const n = Number(c);
    return Number.isFinite(n) ? n : i + 1;
  });
  const flat = flatten(data.values);
  if (flat.length === 0) return emptyChart(opts, "No numeric data");
  const yMin = Math.min(0, ...flat);
  const yMax = Math.max(0, ...flat);
  const xMin = Math.min(...xNum);
  const xMax = Math.max(...xNum);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const plot = computePlot(opts, true, "xy");
  const parts: string[] = [];
  data.values.forEach((series, sIdx) => {
    const color = pickColor(opts.palette, sIdx);
    series.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = plot.x + ((xNum[i] - xMin) / xSpan) * plot.w;
      const y = plot.y + plot.h - ((v - yMin) / ySpan) * plot.h;
      parts.push(
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.5" fill="${color}" fill-opacity="0.75" stroke="${color}"/>`,
      );
      if (opts.showDataLabels) {
        parts.push(
          `<text x="${x.toFixed(2)}" y="${(y - 6).toFixed(2)}" text-anchor="middle" font-size="9" fill="#1f2937">${esc(fmtNum(v))}</text>`,
        );
      }
    });
  });

  // Use numeric x-axis ticks rather than category labels for scatter.
  const xTickStep = niceStep(xSpan, 5);
  const xLabels: string[] = [];
  for (let t = Math.ceil(xMin / xTickStep) * xTickStep; t <= xMax + xTickStep * 0.001; t += xTickStep) {
    xLabels.push(fmtNum(t));
  }
  if (xLabels.length === 0) xLabels.push(fmtNum(xMin), fmtNum(xMax));

  const inner = renderAxes(plot, yMin, yMax, xLabels) + parts.join("");
  const legend = renderLegend(opts, plot, data.seriesNames);
  return svgFrame(opts, plot, inner, legend);
}

// ---------- Area ----------

export function renderAreaChart(data: ChartData, opts: RenderOpts): string {
  if (data.values.length === 0 || data.categories.length === 0) {
    return emptyChart(opts, "No data");
  }
  const flat = flatten(data.values);
  if (flat.length === 0) return emptyChart(opts, "No numeric data");
  const yMin = Math.min(0, ...flat);
  const yMax = Math.max(0, ...flat);
  const plot = computePlot(opts, true, "xy");
  const stepX =
    data.categories.length > 1 ? plot.w / (data.categories.length - 1) : 0;
  const yScale = (v: number) =>
    plot.y + plot.h - ((v - yMin) / (yMax - yMin || 1)) * plot.h;
  const zeroY = yScale(0);

  // Render later series first so earlier series sit on top (matches Excel
  // default area stacking visual). For un-stacked overlap we just lower
  // opacity so all series remain visible.
  const parts: string[] = [];
  data.values.forEach((series, sIdx) => {
    const color = pickColor(opts.palette, sIdx);
    // Build a filled polygon: top edge from data, bottom edge along baseline.
    const top: Array<{ x: number; y: number }> = [];
    series.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x =
        data.categories.length === 1 ? plot.x + plot.w / 2 : plot.x + i * stepX;
      const y = yScale(v);
      top.push({ x, y });
    });
    if (top.length === 0) return;
    const head = top.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    const tail = `${top[top.length - 1].x.toFixed(2)},${zeroY.toFixed(2)} ${top[0].x.toFixed(2)},${zeroY.toFixed(2)}`;
    parts.push(
      `<polygon points="${head} ${tail}" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="1.5"/>`,
    );
    if (opts.showDataLabels) {
      top.forEach((p, i) => {
        const v = series.filter(Number.isFinite)[i];
        if (v === undefined) return;
        parts.push(
          `<text x="${p.x.toFixed(2)}" y="${(p.y - 5).toFixed(2)}" text-anchor="middle" font-size="9" fill="#1f2937">${esc(fmtNum(v))}</text>`,
        );
      });
    }
  });

  const inner =
    renderAxes(plot, yMin, yMax, data.categories) + parts.join("");
  const legend = renderLegend(opts, plot, data.seriesNames);
  return svgFrame(opts, plot, inner, legend);
}

// ---------- Dispatch ----------

/**
 * Pick the renderer matching `chart.type` and apply it. Centralizes
 * the option-defaulting logic (palette fallback, legend default true)
 * so callers only need to pass the entry + dimensions.
 */
export function renderChart(
  data: ChartData,
  entry: ChartEntry,
  width: number,
  height: number,
): string {
  const opts: RenderOpts = {
    width,
    height,
    title: entry.title,
    xAxisLabel: entry.xAxisLabel,
    yAxisLabel: entry.yAxisLabel,
    showLegend: entry.showLegend !== false,
    showDataLabels: entry.showDataLabels === true,
    palette:
      Array.isArray(entry.seriesColors) && entry.seriesColors.length > 0
        ? entry.seriesColors
        : DEFAULT_PALETTE,
  };
  switch (entry.type) {
    case "line":
      return renderLineChart(data, opts);
    case "bar":
      return renderBarChart(data, opts, entry.stacked === true);
    case "pie":
      return renderPieChart(data, opts);
    case "doughnut":
      return renderDoughnutChart(data, opts);
    case "scatter":
      return renderScatterChart(data, opts);
    case "area":
      return renderAreaChart(data, opts);
  }
}

// Pure helpers for the Excel-style "Recommended Charts" picker.
//
// Given a rectangular range of cell values (already extracted from the active
// selection), inspect its shape + data types and propose the chart types most
// likely to be useful. The output is rendered by RecommendedChartsDialog as a
// gallery of mini-SVG previews — picking one writes a new entry directly into
// `sheets.<id>._charts` so the user skips the full chart-authoring dialog.
//
// No Univer / React imports — kept side-effect free so it can be reasoned
// about in isolation. The integrator in EditorScreen reads values from the
// snapshot, calls `analyzeRange`, and passes the result into the dialog.
//
// Snapshot shape (Univer 0.5.x + Coco extension) the consumer eventually
// writes to:
//   {
//     sheets: {
//       <sheetId>: {
//         _charts?: Array<{
//           range: string,
//           type: "line"|"bar"|"pie"|"scatter"|"area"|"doughnut",
//           title?: string, ...
//         }>
//       }
//     }
//   }
//
// `rangeValues` here is the already-extracted `[row][col]` slice of `v`s
// (same convention as quickAnalysis.ts).
//
// SVG previews are produced via chartRender.ts's renderers, fed a synthetic
// ChartData built from the actual range so the thumbnail matches the user's
// data shape (within reason — large ranges are subsampled).

import {
  DEFAULT_PALETTE,
  renderAreaChart,
  renderBarChart,
  renderDoughnutChart,
  renderLineChart,
  renderPieChart,
  renderScatterChart,
  type ChartData,
  type RenderOpts,
} from "./chartRender";

export type RecommendedChartType =
  | "line"
  | "bar"
  | "column"
  | "pie"
  | "area"
  | "scatter"
  | "doughnut";

export interface ChartRecommendation {
  /** Chart type identifier; "column" is rendered as a vertical bar chart. */
  type: RecommendedChartType;
  /** Heuristic ranking; higher = better fit for this data shape. */
  score: number;
  /** Localized one-line rationale shown under the preview. */
  reason: string;
  /** Inline SVG markup (width=200, height=120 by default). */
  svgPreview: string;
}

// ---------- value classification ----------

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

function toNumberOrNaN(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return Number.NaN;
    if (!/^-?\d+(?:\.\d+)?$/.test(t)) return Number.NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

function isNumericLike(v: unknown): boolean {
  return !Number.isNaN(toNumberOrNaN(v));
}

function isTextLike(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0 && !isNumericLike(v);
}

// Loose date heuristic: ISO-ish (2024-01-15), slash dates (1/15/24), or year
// integers in [1900, 2100]. Mirrors Excel's "looks like a date" detection used
// when deciding whether to default to a line chart over a bar chart.
function looksLikeDate(v: unknown): boolean {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  if (typeof v === "number") return v >= 1900 && v <= 2100 && Number.isInteger(v);
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t) return false;
  if (/^\d{4}-\d{1,2}(?:-\d{1,2})?$/.test(t)) return true;
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(t)) return true;
  if (/^\d{4}\/\d{1,2}(?:\/\d{1,2})?$/.test(t)) return true;
  // Month names ("Jan 2024", "January", "2024 Q1")
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
  if (/^Q[1-4]\b|^\d{4}\s*Q[1-4]/i.test(t)) return true;
  return false;
}

// ---------- shape analysis ----------

interface RangeShape {
  rows: number;
  cols: number;
  /** Total non-blank cells, used for "few data points" tie-breakers. */
  nonBlank: number;
  /** True if every non-blank, non-header cell is numeric. */
  allNumericBody: boolean;
  /** True if first row is mostly text — interpreted as series header. */
  hasHeaderRow: boolean;
  /** True if first column is mostly text/dates — interpreted as labels. */
  hasHeaderCol: boolean;
  /** True if first column reads like a time axis. */
  firstColIsDate: boolean;
  /** Number of distinct first-column labels (proxy for category count). */
  categoryCount: number;
  /** Count of columns whose data rows are numeric. */
  numericCols: number;
  /** Count of columns whose data rows are text. */
  textCols: number;
}

function inferShape(values: unknown[][], hasHeaders: boolean): RangeShape {
  const rows = values.length;
  const cols =
    rows === 0
      ? 0
      : Math.max(...values.map((r) => (Array.isArray(r) ? r.length : 0)));

  let nonBlank = 0;
  for (const row of values) {
    if (!Array.isArray(row)) continue;
    for (const v of row) if (!isBlank(v)) nonBlank++;
  }

  // Detect header row: caller's hint wins, otherwise sniff the first row.
  const firstRow = Array.isArray(values[0]) ? values[0] : [];
  const firstRowText = firstRow.filter(isTextLike).length;
  const firstRowNumeric = firstRow.filter(isNumericLike).length;
  const hasHeaderRow =
    hasHeaders ||
    (rows >= 2 && firstRowText > 0 && firstRowText >= firstRowNumeric);

  // Detect header column: first column mostly text or date-shaped.
  let firstColText = 0;
  let firstColDate = 0;
  let firstColNumeric = 0;
  const firstColStartRow = hasHeaderRow ? 1 : 0;
  for (let r = firstColStartRow; r < rows; r++) {
    const v = values[r]?.[0];
    if (isBlank(v)) continue;
    if (looksLikeDate(v)) firstColDate++;
    else if (isTextLike(v)) firstColText++;
    else if (isNumericLike(v)) firstColNumeric++;
  }
  const firstColLabels = firstColText + firstColDate;
  const hasHeaderCol =
    cols >= 2 && firstColLabels > 0 && firstColLabels >= firstColNumeric;
  const firstColIsDate = hasHeaderCol && firstColDate >= firstColText;

  // Per-column numeric/text counts for the *body* rows + non-label cols.
  const bodyRowStart = hasHeaderRow ? 1 : 0;
  const bodyColStart = hasHeaderCol ? 1 : 0;
  let numericCols = 0;
  let textCols = 0;
  let allNumericBody = true;
  for (let c = bodyColStart; c < cols; c++) {
    let num = 0;
    let txt = 0;
    let cellsSeen = 0;
    for (let r = bodyRowStart; r < rows; r++) {
      const v = values[r]?.[c];
      if (isBlank(v)) continue;
      cellsSeen++;
      if (isNumericLike(v)) num++;
      else if (isTextLike(v)) txt++;
    }
    if (cellsSeen === 0) continue;
    if (num / cellsSeen >= 0.8) numericCols++;
    else if (txt / cellsSeen >= 0.8) textCols++;
    if (num / cellsSeen < 0.95) allNumericBody = false;
  }

  // Category count = distinct first-column labels (or row count when no col labels).
  let categoryCount: number;
  if (hasHeaderCol) {
    const seen = new Set<string>();
    for (let r = bodyRowStart; r < rows; r++) {
      const v = values[r]?.[0];
      if (isBlank(v)) continue;
      seen.add(String(v));
    }
    categoryCount = seen.size;
  } else {
    categoryCount = Math.max(0, rows - bodyRowStart);
  }

  return {
    rows,
    cols,
    nonBlank,
    allNumericBody,
    hasHeaderRow,
    hasHeaderCol,
    firstColIsDate,
    categoryCount,
    numericCols,
    textCols,
  };
}

// ---------- sample-data extraction for previews ----------

/**
 * Build a small (≤ 8 category × ≤ 4 series) ChartData mirroring the source
 * range, so each thumbnail visually matches the user's data. When the range
 * is larger than the preview limit we sub-sample evenly to keep shape.
 */
function buildSampleData(values: unknown[][], shape: RangeShape): ChartData {
  const PREVIEW_CATS = 8;
  const PREVIEW_SERIES = 4;
  const bodyRowStart = shape.hasHeaderRow ? 1 : 0;
  const bodyColStart = shape.hasHeaderCol ? 1 : 0;
  const dataRows = Math.max(0, shape.rows - bodyRowStart);
  const dataCols = Math.max(0, shape.cols - bodyColStart);

  if (dataRows === 0 || dataCols === 0) {
    return { seriesNames: [], categories: [], values: [] };
  }

  const catCount = Math.min(PREVIEW_CATS, dataRows);
  const serCount = Math.min(PREVIEW_SERIES, dataCols);
  const rowStride = Math.max(1, Math.floor(dataRows / catCount));
  const colStride = Math.max(1, Math.floor(dataCols / serCount));

  const seriesNames: string[] = [];
  for (let s = 0; s < serCount; s++) {
    const srcCol = bodyColStart + s * colStride;
    if (shape.hasHeaderRow) {
      const v = values[0]?.[srcCol];
      seriesNames.push(typeof v === "string" && v ? v : `Series ${s + 1}`);
    } else {
      seriesNames.push(`Series ${s + 1}`);
    }
  }

  const categories: string[] = [];
  const out: number[][] = seriesNames.map(() => []);
  for (let i = 0; i < catCount; i++) {
    const r = bodyRowStart + i * rowStride;
    const label = shape.hasHeaderCol
      ? String(values[r]?.[0] ?? i + 1)
      : `${i + 1}`;
    categories.push(label.length > 6 ? label.slice(0, 6) : label);
    for (let s = 0; s < serCount; s++) {
      const c = bodyColStart + s * colStride;
      out[s].push(toNumberOrNaN(values[r]?.[c]));
    }
  }
  // If extraction yielded nothing usable, synthesize a tiny ramp so the
  // preview still has shape (matches Excel's "live thumbnail" fallback).
  const hasNumeric = out.some((row) => row.some(Number.isFinite));
  if (!hasNumeric) {
    const fallback: number[] = [3, 5, 4, 7, 6, 8];
    return {
      seriesNames: ["Sample"],
      categories: fallback.map((_, i) => String(i + 1)),
      values: [fallback],
    };
  }
  return { seriesNames, categories, values: out };
}

// ---------- mini SVG generation ----------

/**
 * Render a compact preview SVG for the given chart type using the shared
 * chartRender.ts pipeline. Disables legends + axis labels and trims data
 * labels so the result reads cleanly at 200×120.
 */
export function generateMiniSvg(
  type: RecommendedChartType,
  sample: ChartData,
  width = 200,
  height = 120,
): string {
  const opts: RenderOpts = {
    width,
    height,
    showLegend: false,
    showDataLabels: false,
    palette: DEFAULT_PALETTE,
  };
  switch (type) {
    case "line":
      return renderLineChart(sample, opts);
    case "area":
      return renderAreaChart(sample, opts);
    case "bar":
    case "column":
      // Both render via renderBarChart; rotation differentiates in the
      // full chart canvas, but for the mini preview we use the same
      // vertical-bar layout — it's the most-recognized shape in Excel's
      // recommended-charts gallery.
      return renderBarChart(sample, opts, false);
    case "pie":
      return renderPieChart(sample, opts);
    case "doughnut":
      return renderDoughnutChart(sample, opts);
    case "scatter":
      return renderScatterChart(sample, opts);
  }
}

// ---------- main entry ----------

/**
 * Score the candidate chart types against the range shape and return the
 * top 5 (sorted by descending score). Each entry includes a pre-rendered
 * mini SVG preview so the dialog can drop it straight into the DOM.
 *
 * Scoring is intentionally simple — additive bonuses per matching heuristic.
 * Anything scoring 0 is excluded so the gallery never recommends a chart
 * that's a poor fit for the data.
 */
export function analyzeRange(
  values: unknown[][],
  hasHeaders: boolean,
): ChartRecommendation[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const shape = inferShape(values, hasHeaders);
  if (shape.nonBlank === 0) return [];

  const sample = buildSampleData(values, shape);

  type Cand = { type: RecommendedChartType; score: number; reason: string };
  const cands: Cand[] = [];

  // Number of "value" columns (post-label).
  const valueCols = shape.numericCols;
  const cats = shape.categoryCount;
  const manyPoints = cats > 20;
  const fewCats = cats > 0 && cats < 8;
  const singleRow = shape.rows - (shape.hasHeaderRow ? 1 : 0) === 1;
  const singleNumericCol = valueCols === 1;

  // ----- Column / Bar (categorical + numeric) -----
  if (shape.textCols >= 1 && valueCols >= 1) {
    let s = 70;
    if (fewCats) s += 10;
    if (manyPoints) s -= 20;
    cands.push({
      type: "column",
      score: s + 5,
      reason: "カテゴリ比較に最適",
    });
    cands.push({
      type: "bar",
      score: s,
      reason: "横向きでラベルが読みやすい",
    });
  }

  // ----- Line / Area (time series or numeric trend) -----
  if (valueCols >= 1 && cats >= 2) {
    let lineScore = 50;
    let areaScore = 35;
    if (shape.firstColIsDate) {
      lineScore += 30;
      areaScore += 15;
    }
    if (manyPoints) {
      lineScore += 15;
      areaScore += 10;
    }
    if (singleNumericCol && shape.allNumericBody) {
      lineScore += 10;
      areaScore += 8;
    }
    cands.push({
      type: "line",
      score: lineScore,
      reason: shape.firstColIsDate
        ? "時系列の推移を表示"
        : "値の推移を把握",
    });
    cands.push({
      type: "area",
      score: areaScore,
      reason: "推移と累積量を強調",
    });
  }

  // ----- Pie / Doughnut (single dimension, small category count) -----
  if (fewCats && valueCols >= 1) {
    let pieScore = 40;
    if (singleRow) pieScore += 30;
    if (singleNumericCol && cats <= 6) pieScore += 20;
    if (manyPoints) pieScore -= 50;
    if (pieScore > 0) {
      cands.push({
        type: "pie",
        score: pieScore,
        reason: "構成比を直感的に把握",
      });
      cands.push({
        type: "doughnut",
        score: pieScore - 5,
        reason: "中央にラベルを配置できる",
      });
    }
  }
  // Special-case single-row of numbers → pie/doughnut shine.
  if (singleRow && shape.cols >= 2 && valueCols >= 2) {
    cands.push({
      type: "pie",
      score: 80,
      reason: "1 行のデータの内訳に最適",
    });
  }

  // ----- Scatter (two numeric columns, no clear labels) -----
  if (valueCols >= 2 && shape.textCols === 0) {
    let s = 65;
    if (manyPoints) s += 20;
    if (valueCols === 2) s += 10;
    cands.push({
      type: "scatter",
      score: s,
      reason: "2 つの数値の相関を確認",
    });
  }
  // If first col is numeric (treated as x) and there's at least one value col.
  if (valueCols >= 1 && !shape.hasHeaderCol && shape.allNumericBody && cats >= 5) {
    cands.push({
      type: "scatter",
      score: 55,
      reason: "数値ペアの分布を可視化",
    });
  }

  if (cands.length === 0) {
    // Fallback: always offer a column chart so the user has somewhere to go.
    cands.push({
      type: "column",
      score: 10,
      reason: "汎用的なグラフ",
    });
  }

  // Deduplicate by type — keep the highest score for each.
  const byType = new Map<RecommendedChartType, Cand>();
  for (const c of cands) {
    const prev = byType.get(c.type);
    if (!prev || c.score > prev.score) byType.set(c.type, c);
  }

  return Array.from(byType.values())
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((c) => ({
      type: c.type,
      score: c.score,
      reason: c.reason,
      svgPreview: generateMiniSvg(c.type, sample),
    }));
}

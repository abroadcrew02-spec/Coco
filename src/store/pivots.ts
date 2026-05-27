// Pure helpers for Excel-style Pivot Tables (MVP).
//
// A pivot table cross-tabs a source range: the user picks Rows fields, Cols
// fields, and one or more Values fields (each with an aggregator), plus
// optional Filters. The engine groups source rows by the row/col tuples,
// aggregates each cell's values, and writes the result as a 2-D matrix.
//
// The matrix shape:
//   - Top-left corner: a single blank cell (when both rows & cols exist) or a
//     header label otherwise.
//   - First (#cols) rows = column-header levels (one row per cols field).
//   - First (#rows) columns = row-header levels (one column per rows field).
//   - Remaining cells = aggregated values. When multiple Values fields are
//     configured, each contributes (cols × values) columns — the inner level
//     of column headers is the value field's display label
//     (e.g. "SUM of Amount").
//   - Trailing "Total" column on the right and "Total" row at the bottom.
//
// Snapshot shape (Univer 0.5.x + Coco extension) — the slice we touch:
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         cellData?: { [row]: { [col]: { v?: unknown, s?: object } } },
//         _pivots?: PivotEntry[],
//       }
//     }
//   }
//
// Source kinds:
//   - "sheet": reads rows from a rectangular cellData range (legacy / default).
//   - "model": reads rows from a CocoDataModel table; measure values are
//     evaluated via the DAX engine with per-cell filter contexts.
//
// We persist PivotEntry records on the *destination* sheet (for model pivots)
// or the *source* sheet (for sheet pivots) so `addPivot` and `refreshPivot`
// only touch _pivots and the destination cellData; everything else is the
// caller's responsibility (writing output cells, calling applyMutatedSnapshot
// for undo, etc.).
//
// Kept side-effect free so the dialog can preview and so it can be unit-
// tested without Univer.

import type { DataModel } from "./daxEngine";
import type { CocoDataModel } from "./cocoDataModel";
import { evaluateStoredMeasure, applyCalculatedColumns, toDataModel } from "./cocoDataModel";

export type PivotAggregator = "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN";

export interface PivotRange {
  /** 0-based inclusive top row. */
  r1: number;
  /** 0-based inclusive left column. */
  c1: number;
  /** 0-based inclusive bottom row. */
  r2: number;
  /** 0-based inclusive right column. */
  c2: number;
}

/**
 * Discriminated union for pivot data sources.
 *   - "sheet": the classic mode — rows come from a rectangular cellData range.
 *   - "model": rows come from a named table in the Coco Data Model.
 */
export type PivotSource =
  | { kind: "sheet"; sheetId: string; range: PivotRange }
  | { kind: "model"; tableName: string };

/**
 * Discriminated union for pivot value fields.
 *   - "column": aggregate a raw column from the source data.
 *   - "measure": evaluate a DAX measure from the Coco Data Model.
 */
export type PivotValueField =
  | { kind: "column"; field: string; agg: PivotAggregator }
  | { kind: "measure"; measureName: string };

export interface PivotFilter {
  /** Header name from source. */
  field: string;
  /** Include rows whose stringified value matches any of these. */
  values: string[];
}

export interface PivotConfig {
  source: PivotSource;
  /** 0-based destination top-left in absolute sheet coords. */
  destination: { row: number; col: number };
  rows: string[];
  cols: string[];
  values: PivotValueField[];
  filters?: PivotFilter[];
  /**
   * Only meaningful for sheet-source pivots. Model pivots read all rows from
   * the table directly and do not have a header row concept.
   */
  hasHeader: boolean;
}

export interface PivotEntry extends PivotConfig {
  /** Workbook-unique name, e.g. "Pivot1". */
  name: string;
  /**
   * Number of rows written by the most recent refresh. Used by `refreshPivot`
   * to wipe the previous output footprint before drawing the new matrix so a
   * shrunk pivot doesn't leave stale Total rows / cells behind. Optional for
   * backward compat with snapshots authored before this field existed.
   */
  lastOutputRows?: number;
  /** Companion to `lastOutputRows` — number of cols in the last refresh. */
  lastOutputCols?: number;
}

/**
 * Normalize a PivotEntry that may have been authored before the discriminated
 * union was introduced (i.e. a "legacy" snapshot entry). Mutates the entry
 * in-place for efficiency — callers hold the only reference at the normalise
 * call site.
 *
 * Legacy shapes handled:
 *   - `source` with no `kind` field (has `sheetId` + `range`) → `{ kind: 'sheet', ... }`
 *   - `values[]` items with no `kind` field (have `field` + `agg`) → `{ kind: 'column', ... }`
 */
export function normalizePivotEntry(entry: PivotEntry): PivotEntry {
  // Normalize source.
  const src = entry.source as unknown as Record<string, unknown>;
  if (typeof src.kind !== "string") {
    // Legacy sheet-source entry: { sheetId, range } with no kind.
    (entry as unknown as Record<string, unknown>).source = {
      kind: "sheet",
      sheetId: src.sheetId,
      range: src.range,
    };
  }

  // Normalize values array.
  if (Array.isArray(entry.values)) {
    entry.values = entry.values.map((v) => {
      const vr = v as unknown as Record<string, unknown>;
      if (typeof vr.kind !== "string") {
        // Legacy column value: { field, agg } with no kind.
        return { kind: "column", field: vr.field, agg: vr.agg } as PivotValueField;
      }
      return v;
    });
  }

  return entry;
}

export interface PivotResult {
  /** 2-D matrix the caller writes into destination cells. */
  output: Array<Array<unknown>>;
  /** Number of rows in `output`. */
  rowCount: number;
  /** Number of columns in `output`. */
  colCount: number;
}

export interface SheetWithPivots {
  name?: string;
  cellData?: Record<string, Record<string, { v?: unknown; s?: unknown } | undefined> | undefined>;
  _pivots?: PivotEntry[];
  [k: string]: unknown;
}

export interface WorkbookPivotSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, SheetWithPivots | undefined>;
}

const PIVOT_NAME_RE = /^Pivot(\d+)$/;
const DEFAULT_FIELD_PREFIX = "Column";
const TOTAL_LABEL = "Total";

// ---------- name + field inference ----------

/**
 * Pick the smallest unused "PivotN" (N ≥ 1) against an existing name list.
 * Mirrors generateTableName so users get a familiar auto-naming pattern.
 */
export function generatePivotName(existingNames: string[]): string {
  const used = new Set<number>();
  const verbatim = new Set<string>();
  for (const n of existingNames) {
    if (typeof n !== "string") continue;
    verbatim.add(n);
    const m = PIVOT_NAME_RE.exec(n);
    if (m) {
      const idx = Number.parseInt(m[1], 10);
      if (Number.isFinite(idx) && idx >= 1) used.add(idx);
    }
  }
  let i = 1;
  while (i < 1_000_000) {
    if (!used.has(i) && !verbatim.has(`Pivot${i}`)) return `Pivot${i}`;
    i++;
  }
  // #16: 1M cap exhausted. Use a random nonce instead of `Pivot1000000` so
  // the 1,000,001st pivot is guaranteed unique. Format keeps the prefix for
  // filterability + tags the overflow case so it's visible in audits.
  while (true) {
    const nonce = Math.random().toString(36).slice(2, 8);
    const candidate = `Pivot1m_${nonce}`;
    if (!verbatim.has(candidate)) return candidate;
  }
}

// Read the displayable value of a cell. Same convention as subtotals.ts —
// Univer's ICellData has `.v` for the raw user value; we don't try to
// evaluate `.f` here.
function readCellValue(
  cellData: SheetWithPivots["cellData"] | undefined,
  row: number,
  col: number,
): unknown {
  if (!cellData) return undefined;
  const rowObj = cellData[String(row)];
  if (!rowObj) return undefined;
  const cell = rowObj[String(col)];
  if (cell === undefined || cell === null) return undefined;
  if (typeof cell !== "object") return cell;
  return (cell as { v?: unknown }).v;
}

/**
 * Pull the header names from the top row of a range. When `hasHeader` is
 * false (or a header cell is blank) we synthesise "Column1", "Column2", ...
 * Duplicate header values get a numeric suffix so the dialog can list them
 * unambiguously. The returned array has exactly `range.c2 - range.c1 + 1`
 * entries.
 */
export function inferFieldNames(
  cellData: SheetWithPivots["cellData"] | undefined,
  range: PivotRange,
  hasHeader: boolean,
): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  const width = Math.max(1, range.c2 - range.c1 + 1);
  for (let i = 0; i < width; i++) {
    const col = range.c1 + i;
    let name = `${DEFAULT_FIELD_PREFIX}${i + 1}`;
    if (hasHeader) {
      const v = readCellValue(cellData, range.r1, col);
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        name = String(v).trim();
      }
    }
    const lower = name.toLowerCase();
    const count = seen.get(lower) ?? 0;
    if (count === 0) {
      seen.set(lower, 1);
    } else {
      seen.set(lower, count + 1);
      name = `${name}${count + 1}`;
    }
    out.push(name);
  }
  return out;
}

// ---------- numeric coercion + aggregation ----------

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return NaN;
}

/**
 * Excel-style aggregation. Non-numeric / NaN entries are skipped for
 * SUM/AVERAGE/MAX/MIN. COUNT counts numeric entries only. Returns 0 for
 * empty SUM/COUNT and NaN for empty AVERAGE/MAX/MIN — callers can render
 * NaN as blank.
 */
export function aggregate(values: number[], op: PivotAggregator): number {
  const nums: number[] = [];
  for (const v of values) {
    if (Number.isFinite(v)) nums.push(v);
  }
  switch (op) {
    case "SUM": {
      let s = 0;
      for (const n of nums) s += n;
      return s;
    }
    case "AVERAGE": {
      if (nums.length === 0) return NaN;
      let s = 0;
      for (const n of nums) s += n;
      return s / nums.length;
    }
    case "COUNT":
      return nums.length;
    case "MAX": {
      if (nums.length === 0) return NaN;
      let m = nums[0];
      for (let i = 1; i < nums.length; i++) if (nums[i] > m) m = nums[i];
      return m;
    }
    case "MIN": {
      if (nums.length === 0) return NaN;
      let m = nums[0];
      for (let i = 1; i < nums.length; i++) if (nums[i] < m) m = nums[i];
      return m;
    }
  }
}

// ---------- core: computePivot ----------

/** Display label for a value field, matching Excel ("SUM of Amount"). */
function valueLabel(v: PivotValueField): string {
  if (v.kind === "measure") return v.measureName;
  return `${v.agg} of ${v.field}`;
}

// Stable group key from a list of raw cell values. Stringified + joined with a
// delimiter that won't collide with normal data. Empty values become "".
const KEY_DELIM = " ";
function tupleKey(values: unknown[]): string {
  const parts: string[] = [];
  for (const v of values) {
    if (v === undefined || v === null) parts.push("");
    else parts.push(String(v));
  }
  return parts.join(KEY_DELIM);
}

/**
 * Compute the pivot 2-D matrix from a rectangular `sourceCells` block (the
 * matrix is laid out row-first, so `sourceCells[r][c]` is the cell at
 * relative row r, col c).
 *
 * Algorithm:
 *   1. Read header row -> map field names to column indices.
 *   2. Apply filters (drop rows whose filter value isn't in the allowed set).
 *   3. For each remaining detail row, compute its row-tuple and col-tuple
 *      keys and bucket the value-field numbers.
 *   4. Sort row & col tuples by their first-seen order (stable, matches Excel
 *      default behaviour for unsorted input).
 *   5. Emit the matrix with column headers, row headers, aggregated cells,
 *      and a trailing Total row + Total column.
 *
 * If neither `rows` nor `cols` is configured, the matrix collapses to a
 * single grand-total row per value field. If `values` is empty, COUNT of
 * source rows is used as a fallback so the table still has data cells.
 */
export function computePivot(
  sourceCells: Array<Array<unknown>>,
  config: PivotConfig,
): PivotResult {
  const hasHeader = config.hasHeader;
  const headerRow = hasHeader && sourceCells.length > 0 ? sourceCells[0] : null;
  const width = headerRow ? headerRow.length : sourceCells[0]?.length ?? 0;

  // Map header name -> column index in sourceCells.
  const fieldIndex = new Map<string, number>();
  if (headerRow) {
    for (let i = 0; i < headerRow.length; i++) {
      const v = headerRow[i];
      const name = v === undefined || v === null ? "" : String(v).trim();
      if (name && !fieldIndex.has(name)) fieldIndex.set(name, i);
    }
  } else {
    for (let i = 0; i < width; i++) fieldIndex.set(`${DEFAULT_FIELD_PREFIX}${i + 1}`, i);
  }

  const rowsIdx = config.rows
    .map((f) => fieldIndex.get(f))
    .filter((n): n is number => typeof n === "number");
  const colsIdx = config.cols
    .map((f) => fieldIndex.get(f))
    .filter((n): n is number => typeof n === "number");
  // computePivot only handles column-kind value fields (sheet-source pivots).
  // Measure-kind fields require a DataModel and are handled by computeModelPivot.
  const columnValueFields: Array<{ kind: "column"; field: string; agg: PivotAggregator }> =
    config.values.length > 0
      ? (config.values.filter(
          (v) => v.kind === "column" && fieldIndex.has(v.field),
        ) as Array<{ kind: "column"; field: string; agg: PivotAggregator }>)
      : // No values configured -> fall back to COUNT of the first source field.
        // We invent a placeholder so the matrix still has data cells.
        [
          {
            kind: "column",
            field: headerRow ? String(headerRow[0] ?? "Row") : "Row",
            agg: "COUNT",
          },
        ];
  const valueFields: PivotValueField[] = columnValueFields;
  const valueIdx = columnValueFields.map((v) => fieldIndex.get(v.field) ?? 0);

  // Filter index lookup: field -> Set of allowed stringified values.
  const filterSets = new Map<number, Set<string>>();
  for (const f of config.filters ?? []) {
    const i = fieldIndex.get(f.field);
    if (i === undefined) continue;
    filterSets.set(i, new Set(f.values));
  }

  // Walk detail rows (everything below the header).
  const start = hasHeader ? 1 : 0;
  type RowKeyMeta = { key: string; parts: unknown[]; order: number };
  const rowKeys = new Map<string, RowKeyMeta>();
  const colKeys = new Map<string, RowKeyMeta>();
  // bucket[rowKey][colKey][valueIndex] = number[]
  const buckets = new Map<string, Map<string, number[][]>>();
  let rowOrder = 0;
  let colOrder = 0;

  for (let r = start; r < sourceCells.length; r++) {
    const detail = sourceCells[r];
    if (!detail) continue;
    // Apply filters
    let drop = false;
    for (const [colIdx, allowed] of filterSets) {
      const v = detail[colIdx];
      const s = v === undefined || v === null ? "" : String(v);
      if (!allowed.has(s)) {
        drop = true;
        break;
      }
    }
    if (drop) continue;

    const rowParts = rowsIdx.map((i) => detail[i]);
    const colParts = colsIdx.map((i) => detail[i]);
    const rk = tupleKey(rowParts);
    const ck = tupleKey(colParts);
    if (!rowKeys.has(rk)) rowKeys.set(rk, { key: rk, parts: rowParts, order: rowOrder++ });
    if (!colKeys.has(ck)) colKeys.set(ck, { key: ck, parts: colParts, order: colOrder++ });

    let byCol = buckets.get(rk);
    if (!byCol) {
      byCol = new Map();
      buckets.set(rk, byCol);
    }
    let perValue = byCol.get(ck);
    if (!perValue) {
      perValue = valueFields.map(() => []);
      byCol.set(ck, perValue);
    }
    for (let vi = 0; vi < valueFields.length; vi++) {
      perValue[vi].push(toNumber(detail[valueIdx[vi]]));
    }
  }

  // Sort row & col tuple keys by first-seen order (stable).
  const sortedRowKeys = [...rowKeys.values()].sort((a, b) => a.order - b.order);
  const sortedColKeys = [...colKeys.values()].sort((a, b) => a.order - b.order);

  // Matrix dimensions:
  //   headerRowsCount = max(colsIdx.length, 1) + (valueFields.length > 1 ? 1 : 0)
  //     – one row per cols-field plus an extra row for value-field sub-labels
  //       when there's more than one value field.
  //   rowHeaderColsCount = max(rowsIdx.length, 1)
  //   dataColsCount      = max(sortedColKeys.length, 1) * valueFields.length
  //   + 1 trailing Total column, + 1 trailing Total row.
  const colLevels = Math.max(colsIdx.length, 0);
  const showValueLabelRow = valueFields.length > 1 || colsIdx.length === 0;
  const headerRowCount = Math.max(colLevels + (showValueLabelRow ? 1 : 0), 1);
  const rowHeaderColCount = Math.max(rowsIdx.length, 1);
  const colKeyCount = Math.max(sortedColKeys.length, 1);
  const dataColCount = colKeyCount * valueFields.length;
  const totalCols = rowHeaderColCount + dataColCount + 1; // + Total col
  const totalRows = headerRowCount + sortedRowKeys.length + 1; // + Total row

  // Initialise blank matrix.
  const matrix: Array<Array<unknown>> = [];
  for (let r = 0; r < totalRows; r++) {
    const row: Array<unknown> = new Array(totalCols).fill("");
    matrix.push(row);
  }

  // Top-left labels: rows-field names along the bottom header row.
  const lastHeaderRow = headerRowCount - 1;
  for (let i = 0; i < rowsIdx.length; i++) {
    matrix[lastHeaderRow][i] = config.rows[i];
  }
  if (rowsIdx.length === 0) {
    matrix[lastHeaderRow][0] = TOTAL_LABEL;
  }

  // Column header levels (one row per cols field).
  for (let lvl = 0; lvl < colLevels; lvl++) {
    let prev: unknown = undefined;
    for (let ci = 0; ci < sortedColKeys.length; ci++) {
      const parts = sortedColKeys[ci].parts;
      const v = parts[lvl];
      const start = rowHeaderColCount + ci * valueFields.length;
      // Collapse repeated values on the same level so the header reads cleanly
      // (Excel-style). We only set the label on the first occurrence.
      if (lvl > 0 || ci === 0 || String(v) !== String(prev)) {
        matrix[lvl][start] = v;
      }
      prev = v;
    }
  }
  // Value-field sub-label row (only when needed).
  if (showValueLabelRow) {
    for (let ci = 0; ci < colKeyCount; ci++) {
      for (let vi = 0; vi < valueFields.length; vi++) {
        const col = rowHeaderColCount + ci * valueFields.length + vi;
        matrix[lastHeaderRow][col] = valueLabel(valueFields[vi]);
      }
    }
  }
  // Total column header (top + bottom header rows).
  matrix[lastHeaderRow][totalCols - 1] = TOTAL_LABEL;

  // Body rows.
  for (let ri = 0; ri < sortedRowKeys.length; ri++) {
    const meta = sortedRowKeys[ri];
    const matrixRow = headerRowCount + ri;
    // Row headers
    if (rowsIdx.length === 0) {
      matrix[matrixRow][0] = "";
    } else {
      for (let i = 0; i < meta.parts.length; i++) {
        matrix[matrixRow][i] = meta.parts[i];
      }
    }
    // Data cells: per (colKey × valueField).
    const byCol = buckets.get(meta.key) ?? new Map<string, number[][]>();
    const rowGrandPerValue = valueFields.map(() => [] as number[]);
    for (let ci = 0; ci < sortedColKeys.length; ci++) {
      const ck = sortedColKeys[ci].key;
      const perValue = byCol.get(ck);
      for (let vi = 0; vi < columnValueFields.length; vi++) {
        const col = rowHeaderColCount + ci * columnValueFields.length + vi;
        const nums = perValue ? perValue[vi] : [];
        const v = aggregate(nums, columnValueFields[vi].agg);
        matrix[matrixRow][col] = Number.isFinite(v) ? v : "";
        if (nums && nums.length) rowGrandPerValue[vi].push(...nums);
      }
    }
    // Row total (sum across columns, per first value field). Excel uses the
    // same aggregator as the value field. For multi-value rows we collapse
    // all numbers across all value fields by the *first* value field's
    // aggregator — pragmatic MVP choice that matches Excel's "Grand Total"
    // column when a single agg is in play.
    const totalCol = totalCols - 1;
    const flat: number[] = [];
    for (const arr of rowGrandPerValue) flat.push(...arr);
    const rowTotal = aggregate(flat, columnValueFields[0].agg);
    matrix[matrixRow][totalCol] = Number.isFinite(rowTotal) ? rowTotal : "";
  }

  // Grand-total row at the bottom.
  const totalRow = totalRows - 1;
  matrix[totalRow][0] = TOTAL_LABEL;
  // Per-column grand totals (per value field).
  for (let ci = 0; ci < sortedColKeys.length; ci++) {
    const ck = sortedColKeys[ci].key;
    for (let vi = 0; vi < columnValueFields.length; vi++) {
      const col = rowHeaderColCount + ci * columnValueFields.length + vi;
      const allNums: number[] = [];
      for (const meta of sortedRowKeys) {
        const byCol = buckets.get(meta.key);
        const perValue = byCol?.get(ck);
        if (perValue && perValue[vi]) allNums.push(...perValue[vi]);
      }
      const v = aggregate(allNums, columnValueFields[vi].agg);
      matrix[totalRow][col] = Number.isFinite(v) ? v : "";
    }
  }
  // Bottom-right grand-grand total (sum-style aggregate of all numbers using
  // the first value field's aggregator — same pragmatic choice as row total).
  const grandFlat: number[] = [];
  for (const meta of sortedRowKeys) {
    const byCol = buckets.get(meta.key) ?? new Map<string, number[][]>();
    for (const ck of sortedColKeys.map((c) => c.key)) {
      const perValue = byCol.get(ck);
      if (!perValue) continue;
      for (const arr of perValue) grandFlat.push(...arr);
    }
  }
  const grand = aggregate(grandFlat, columnValueFields[0].agg);
  matrix[totalRow][totalCols - 1] = Number.isFinite(grand) ? grand : "";

  return { output: matrix, rowCount: totalRows, colCount: totalCols };
}

// ---------- workbook helpers ----------

/**
 * Append a PivotEntry to the appropriate sheet's `_pivots`. Returns the
 * workbook snapshot (mutated in place — pass a fresh clone if you need
 * immutability).
 *
 * Sheet-source pivots: stored on the source sheet (legacy behaviour).
 * Model-source pivots: stored on the destination sheet (the sheet at
 *   `destination.row/col`). The caller must supply `destSheetId` for model
 *   pivots; without it the entry cannot be persisted and the function is a
 *   no-op.
 *
 * Side-effect: when the caller did not pre-populate `lastOutputRows` /
 * `lastOutputCols`, we compute them from the current config so that the next
 * `refreshPivot` call has the data it needs to wipe the prior footprint.
 * (`addPivot` doesn't itself write cells — the caller does that — but we
 * record the dimensions of the matrix the caller will write.)
 *
 * @param cocoModel  Required when `entry.source.kind === 'model'` so that the
 *   footprint seed can call `computeModelPivot`.
 * @param destSheetId  The sheet id where the output will be written (required
 *   for model pivots; ignored for sheet pivots which derive it from the source).
 */
export function addPivot(
  workbook: WorkbookPivotSnapshot,
  entry: PivotEntry,
  cocoModel?: CocoDataModel,
  destSheetId?: string,
): WorkbookPivotSnapshot {
  normalizePivotEntry(entry);

  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return workbook;

  let sheet: SheetWithPivots | undefined;
  if (entry.source.kind === "model") {
    if (!destSheetId) return workbook;
    sheet = sheets[destSheetId];
  } else {
    sheet = sheets[entry.source.sheetId];
  }
  if (!sheet || typeof sheet !== "object") return workbook;

  const list = Array.isArray(sheet._pivots) ? sheet._pivots.slice() : [];
  // Seed footprint dimensions so subsequent refresh can wipe stale cells if
  // the data later shrinks.
  if (entry.lastOutputRows === undefined || entry.lastOutputCols === undefined) {
    try {
      if (entry.source.kind === "model" && cocoModel) {
        const runtimeModel = applyCalculatedColumnsForPivot(cocoModel);
        const result = computeModelPivot(runtimeModel, cocoModel, entry);
        entry.lastOutputRows = result.rowCount;
        entry.lastOutputCols = result.colCount;
      } else if (entry.source.kind === "sheet") {
        const matrix = readSourceMatrix(sheet.cellData, entry.source.range);
        const result = computePivot(matrix, entry);
        entry.lastOutputRows = result.rowCount;
        entry.lastOutputCols = result.colCount;
      }
    } catch {
      // Best-effort: leave fields undefined if compute fails; refresh will
      // simply skip the wipe step.
    }
  }
  list.push(entry);
  sheet._pivots = list;
  return workbook;
}

export interface PivotListing {
  sheetId: string;
  sheetName: string;
  pivot: PivotEntry;
}

/**
 * Flat list of every pivot in the workbook, preserving `sheetOrder`. Within
 * each sheet, pivots retain authored order. `sheetName` falls back to the
 * sheet id when no `name` is set.
 */
export function listAllPivots(workbook: WorkbookPivotSnapshot): PivotListing[] {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return [];
  const order =
    Array.isArray(workbook.sheetOrder) && workbook.sheetOrder.length > 0
      ? workbook.sheetOrder.filter((id): id is string => typeof id === "string")
      : Object.keys(sheets);
  const out: PivotListing[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const list = sheet._pivots;
    if (!Array.isArray(list) || list.length === 0) continue;
    const sheetName = typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    for (const p of list) {
      if (!p || typeof p !== "object" || typeof p.name !== "string") continue;
      out.push({ sheetId, sheetName, pivot: p });
    }
  }
  return out;
}

/** Convenience: collect every existing pivot name across the workbook. */
export function collectAllPivotNames(workbook: WorkbookPivotSnapshot): string[] {
  return listAllPivots(workbook).map((e) => e.pivot.name);
}

// Slice the source rectangle out of the source sheet's cellData into a
// rectangular 2-D array suitable for computePivot. Empty cells become
// undefined.
function readSourceMatrix(
  cellData: SheetWithPivots["cellData"] | undefined,
  range: PivotRange,
): Array<Array<unknown>> {
  const rows: Array<Array<unknown>> = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const out: Array<unknown> = [];
    for (let c = range.c1; c <= range.c2; c++) {
      out.push(readCellValue(cellData, r, c));
    }
    rows.push(out);
  }
  return rows;
}

// ---------- model pivot engine ----------

function applyCalculatedColumnsForPivot(cocoModel: CocoDataModel): DataModel {
  return applyCalculatedColumns(toDataModel(cocoModel), cocoModel);
}

/**
 * Compute the pivot 2-D matrix from a Coco Data Model table.
 *
 * Unlike `computePivot` (which reads from a flat cellData rectangle), this
 * function operates directly on the in-memory model rows. Value fields may be
 * either column aggregates OR DAX measure evaluations.
 *
 * The output matrix shape is identical to `computePivot` so the same write
 * path can be reused.
 *
 * @param runtimeModel  DataModel produced by `applyCalculatedColumns` — has
 *   calculated columns already injected into table rows.
 * @param cocoModel  CocoDataModel used to look up measure definitions.
 * @param config  PivotConfig with `source.kind === 'model'`.
 */
export function computeModelPivot(
  runtimeModel: DataModel,
  cocoModel: CocoDataModel,
  config: PivotConfig,
): PivotResult {
  if (config.source.kind !== "model") {
    throw new Error("computeModelPivot requires source.kind === 'model'");
  }
  const { tableName } = config.source;

  const table = runtimeModel.tables.find((t) => t.name === tableName);
  const baseRows: Array<Record<string, unknown>> = table ? table.rows.slice() : [];

  // Apply filter fields (PivotFilter.field matches column values in the table).
  const filterSets = new Map<string, Set<string>>();
  for (const f of config.filters ?? []) {
    filterSets.set(f.field, new Set(f.values));
  }
  const baseFiltered =
    filterSets.size === 0
      ? baseRows
      : baseRows.filter((row) => {
          for (const [field, allowed] of filterSets) {
            const v = row[field];
            const s = v === undefined || v === null ? "" : String(v);
            if (!allowed.has(s)) return false;
          }
          return true;
        });

  // Extract unique row/col tuples (first-seen order, same as computePivot).
  type RowKeyMeta = { key: string; parts: unknown[]; order: number };
  const rowKeys = new Map<string, RowKeyMeta>();
  const colKeys = new Map<string, RowKeyMeta>();
  let rowOrder = 0;
  let colOrder = 0;

  for (const row of baseFiltered) {
    const rowParts = config.rows.map((f) => row[f]);
    const colParts = config.cols.map((f) => row[f]);
    const rk = tupleKey(rowParts);
    const ck = tupleKey(colParts);
    if (!rowKeys.has(rk)) rowKeys.set(rk, { key: rk, parts: rowParts, order: rowOrder++ });
    if (!colKeys.has(ck)) colKeys.set(ck, { key: ck, parts: colParts, order: colOrder++ });
  }

  const sortedRowKeys = [...rowKeys.values()].sort((a, b) => a.order - b.order);
  const sortedColKeys = [...colKeys.values()].sort((a, b) => a.order - b.order);

  const valueFields = config.values.length > 0 ? config.values : [];

  // Matrix dimensions (same formula as computePivot).
  const colLevels = Math.max(config.cols.length, 0);
  const showValueLabelRow = valueFields.length > 1 || config.cols.length === 0;
  const headerRowCount = Math.max(colLevels + (showValueLabelRow ? 1 : 0), 1);
  const rowHeaderColCount = Math.max(config.rows.length, 1);
  const colKeyCount = Math.max(sortedColKeys.length, 1);
  const dataColCount = colKeyCount * Math.max(valueFields.length, 1);
  const totalCols = rowHeaderColCount + dataColCount + 1;
  const totalRows = headerRowCount + sortedRowKeys.length + 1;

  const matrix: Array<Array<unknown>> = [];
  for (let r = 0; r < totalRows; r++) {
    matrix.push(new Array(totalCols).fill(""));
  }

  // Top-left: row-field labels in last header row.
  const lastHeaderRow = headerRowCount - 1;
  for (let i = 0; i < config.rows.length; i++) {
    matrix[lastHeaderRow][i] = config.rows[i];
  }
  if (config.rows.length === 0) {
    matrix[lastHeaderRow][0] = TOTAL_LABEL;
  }

  // Column headers.
  for (let lvl = 0; lvl < colLevels; lvl++) {
    let prev: unknown = undefined;
    for (let ci = 0; ci < sortedColKeys.length; ci++) {
      const v = sortedColKeys[ci].parts[lvl];
      const start = rowHeaderColCount + ci * Math.max(valueFields.length, 1);
      if (lvl > 0 || ci === 0 || String(v) !== String(prev)) {
        matrix[lvl][start] = v;
      }
      prev = v;
    }
  }

  if (showValueLabelRow) {
    for (let ci = 0; ci < colKeyCount; ci++) {
      for (let vi = 0; vi < Math.max(valueFields.length, 1); vi++) {
        const col = rowHeaderColCount + ci * Math.max(valueFields.length, 1) + vi;
        matrix[lastHeaderRow][col] = valueFields[vi] ? valueLabel(valueFields[vi]) : "";
      }
    }
  }
  matrix[lastHeaderRow][totalCols - 1] = TOTAL_LABEL;

  /**
   * Evaluate a single value field for a given set of rows. For column-kind
   * fields we aggregate numerically; for measure-kind fields we call the DAX
   * engine with a per-cell filter context.
   */
  function evalValueForRows(
    vf: PivotValueField,
    cellRows: Array<Record<string, unknown>>,
  ): unknown {
    if (vf.kind === "measure") {
      const filterContext = new Map([[tableName, cellRows]]);
      return evaluateStoredMeasure(runtimeModel, cocoModel, vf.measureName, filterContext);
    }
    // column aggregation
    const nums = cellRows.map((r) => toNumber(r[vf.field]));
    const v = aggregate(nums, vf.agg);
    return Number.isFinite(v) ? v : "";
  }

  // Body rows — per (rowTuple × colTuple × valueField).
  for (let ri = 0; ri < sortedRowKeys.length; ri++) {
    const rowMeta = sortedRowKeys[ri];
    const matrixRow = headerRowCount + ri;

    if (config.rows.length === 0) {
      matrix[matrixRow][0] = "";
    } else {
      for (let i = 0; i < rowMeta.parts.length; i++) {
        matrix[matrixRow][i] = rowMeta.parts[i];
      }
    }

    // Filter base rows to those matching this row tuple.
    const rowMatchedRows = baseFiltered.filter((row) => {
      for (let i = 0; i < config.rows.length; i++) {
        if (String(row[config.rows[i]] ?? "") !== String(rowMeta.parts[i] ?? "")) return false;
      }
      return true;
    });

    for (let ci = 0; ci < sortedColKeys.length; ci++) {
      const colMeta = sortedColKeys[ci];
      const vfCount = Math.max(valueFields.length, 1);

      // Filter to rows matching both row and col tuples.
      const cellRows = rowMatchedRows.filter((row) => {
        for (let i = 0; i < config.cols.length; i++) {
          if (String(row[config.cols[i]] ?? "") !== String(colMeta.parts[i] ?? "")) return false;
        }
        return true;
      });

      for (let vi = 0; vi < vfCount; vi++) {
        const col = rowHeaderColCount + ci * vfCount + vi;
        if (!valueFields[vi]) {
          matrix[matrixRow][col] = "";
          continue;
        }
        matrix[matrixRow][col] = evalValueForRows(valueFields[vi], cellRows);
      }
    }

    // Total column: row ALL (all col groups combined), per first value field.
    const totalCol = totalCols - 1;
    if (valueFields.length > 0) {
      matrix[matrixRow][totalCol] = evalValueForRows(valueFields[0], rowMatchedRows);
    }
  }

  // Grand-total row.
  const totalRow = totalRows - 1;
  matrix[totalRow][0] = TOTAL_LABEL;

  for (let ci = 0; ci < sortedColKeys.length; ci++) {
    const colMeta = sortedColKeys[ci];
    const vfCount = Math.max(valueFields.length, 1);

    const colMatchedRows = baseFiltered.filter((row) => {
      for (let i = 0; i < config.cols.length; i++) {
        if (String(row[config.cols[i]] ?? "") !== String(colMeta.parts[i] ?? "")) return false;
      }
      return true;
    });

    for (let vi = 0; vi < vfCount; vi++) {
      const col = rowHeaderColCount + ci * vfCount + vi;
      if (!valueFields[vi]) {
        matrix[totalRow][col] = "";
        continue;
      }
      matrix[totalRow][col] = evalValueForRows(valueFields[vi], colMatchedRows);
    }
  }

  // Bottom-right corner: grand total over all filtered rows.
  if (valueFields.length > 0) {
    matrix[totalRow][totalCols - 1] = evalValueForRows(valueFields[0], baseFiltered);
  }

  return { output: matrix, rowCount: totalRows, colCount: totalCols };
}

/**
 * Recompute a pivot by name and rewrite its destination cells in place on the
 * snapshot. The caller is responsible for persisting the snapshot back into
 * Univer (typically via applyMutatedSnapshot).
 *
 * Returns `{ ok: true }` when the pivot was found and rewritten,
 * `{ ok: false }` when the pivot doesn't exist or the source sheet is gone.
 *
 * @param cocoModel  Required for model-source pivots (`source.kind === 'model'`).
 *   Without it, model pivots return `{ ok: false }`.
 * @param destSheetId  The sheet id where the pivot output should be written.
 *   Required for model-source pivots; for sheet-source pivots the destination
 *   defaults to the source sheet (legacy behaviour).
 */
export function refreshPivot(
  workbook: WorkbookPivotSnapshot,
  name: string,
  cocoModel?: CocoDataModel,
  destSheetId?: string,
): { ok: boolean } {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return { ok: false };

  // Find the pivot entry (it may live on any sheet's _pivots list).
  let entry: PivotEntry | null = null;
  for (const sid of Object.keys(sheets)) {
    const list = sheets[sid]?._pivots;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (p && p.name === name) {
        entry = p;
        break;
      }
    }
    if (entry) break;
  }
  if (!entry) return { ok: false };

  normalizePivotEntry(entry);

  let result: PivotResult;
  let destSheet: SheetWithPivots;

  if (entry.source.kind === "model") {
    if (!cocoModel) return { ok: false };
    const resolvedDestSheetId = destSheetId ?? Object.keys(sheets)[0];
    const ds = sheets[resolvedDestSheetId];
    if (!ds) return { ok: false };
    destSheet = ds;
    const runtimeModel = applyCalculatedColumnsForPivot(cocoModel);
    result = computeModelPivot(runtimeModel, cocoModel, entry);
  } else {
    const sourceSheet = sheets[entry.source.sheetId];
    if (!sourceSheet) return { ok: false };
    const matrix = readSourceMatrix(sourceSheet.cellData, entry.source.range);
    result = computePivot(matrix, entry);
    // The destination sheet defaults to the source sheet.
    destSheet = sheets[destSheetId ?? entry.source.sheetId] ?? sourceSheet;
  }

  const cellData = (destSheet.cellData ?? {}) as Record<
    string,
    Record<string, { v?: unknown; s?: unknown; f?: unknown } | undefined> | undefined
  >;
  // Wipe the previous output footprint so a shrunk pivot doesn't leave stale
  // Total rows / Total columns behind. We delete cells (rather than blanking
  // them) so any per-cell metadata the user attached outside the new
  // footprint is dropped cleanly. The new write below covers the current
  // footprint; anything outside it that we wrote in a previous refresh gets
  // removed here.
  const prevRows = typeof entry.lastOutputRows === "number" ? entry.lastOutputRows : 0;
  const prevCols = typeof entry.lastOutputCols === "number" ? entry.lastOutputCols : 0;
  if (prevRows > 0 && prevCols > 0) {
    for (let r = 0; r < prevRows; r++) {
      const absRow = entry.destination.row + r;
      const rowObj = cellData[String(absRow)];
      if (!rowObj) continue;
      for (let c = 0; c < prevCols; c++) {
        const absCol = entry.destination.col + c;
        delete rowObj[String(absCol)];
      }
    }
  }
  for (let r = 0; r < result.rowCount; r++) {
    const absRow = entry.destination.row + r;
    const rowKey = String(absRow);
    let rowObj = cellData[rowKey];
    if (!rowObj) {
      rowObj = {};
      cellData[rowKey] = rowObj;
    }
    for (let c = 0; c < result.colCount; c++) {
      const absCol = entry.destination.col + c;
      const colKey = String(absCol);
      const v = result.output[r][c];
      // Preserve any pre-existing style (`.s`) on the destination cell — the
      // pivot wrap may have been styled with banded rows / borders / number
      // formats by the user or by `applyPivotStyle`, and we don't want refresh
      // to strip that. Clear `.f` because pivot outputs are values, not
      // formulas; a stale formula at the destination would race the value.
      const existing = rowObj[colKey];
      const nextV = v === "" || v === undefined ? "" : v;
      rowObj[colKey] = existing
        ? { ...existing, v: nextV, f: undefined }
        : { v: nextV };
    }
  }
  destSheet.cellData = cellData;
  // Record the new footprint so the next refresh can wipe correctly.
  entry.lastOutputRows = result.rowCount;
  entry.lastOutputCols = result.colCount;
  return { ok: true };
}

/**
 * Replace an existing pivot entry (identified by `newEntry.name`) in-place on
 * its source sheet. The old output footprint is wiped from destination cellData
 * before the new entry is registered and the output is left for the caller to
 * rewrite (use `refreshPivot` after calling this, or write cells manually).
 *
 * Steps:
 *  1. Locate the old entry by `newEntry.name` on its source sheet.
 *  2. Wipe the old output footprint (lastOutputRows × lastOutputCols from
 *     `entry.destination`) using the same delete-cell strategy as `refreshPivot`.
 *  3. Splice the old entry out of `_pivots` and push the new one.
 *
 * Returns `{ ok: true }` on success, `{ ok: false }` when the pivot name is
 * not found or the source sheet is missing.
 */
export function replacePivotInSheet(
  workbook: WorkbookPivotSnapshot,
  newEntry: PivotEntry,
): { ok: boolean } {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return { ok: false };

  // Find the old entry — it lives on the source sheet.
  let foundSheetId: string | null = null;
  let oldEntry: PivotEntry | null = null;
  for (const sid of Object.keys(sheets)) {
    const list = sheets[sid]?._pivots;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (p && p.name === newEntry.name) {
        foundSheetId = sid;
        oldEntry = p;
        break;
      }
    }
    if (foundSheetId) break;
  }
  if (!foundSheetId || !oldEntry) return { ok: false };

  normalizePivotEntry(newEntry);

  const sheet = sheets[foundSheetId];
  if (!sheet) return { ok: false };

  // Wipe old output footprint.
  const prevRows = typeof oldEntry.lastOutputRows === "number" ? oldEntry.lastOutputRows : 0;
  const prevCols = typeof oldEntry.lastOutputCols === "number" ? oldEntry.lastOutputCols : 0;
  if (prevRows > 0 && prevCols > 0) {
    const cellData = (sheet.cellData ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    for (let r = 0; r < prevRows; r++) {
      const absRow = oldEntry.destination.row + r;
      const rowObj = cellData[String(absRow)];
      if (!rowObj) continue;
      for (let c = 0; c < prevCols; c++) {
        const absCol = oldEntry.destination.col + c;
        delete rowObj[String(absCol)];
      }
    }
    sheet.cellData = cellData as SheetWithPivots["cellData"];
  }

  // Splice old entry out, push new entry.
  const list = Array.isArray(sheet._pivots) ? sheet._pivots.slice() : [];
  const idx = list.findIndex((p) => p && p.name === newEntry.name);
  if (idx >= 0) {
    list.splice(idx, 1);
  }
  list.push(newEntry);
  sheet._pivots = list;
  return { ok: true };
}

// ---------- A1 helpers (shared with dialog / panel) ----------

export function colIndexToLetters(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

export function letterToColIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function rangeToA1(range: PivotRange): string {
  const a = `${colIndexToLetters(range.c1)}${range.r1 + 1}`;
  if (range.r1 === range.r2 && range.c1 === range.c2) return a;
  return `${a}:${colIndexToLetters(range.c2)}${range.r2 + 1}`;
}

export function cellToA1(row: number, col: number): string {
  return `${colIndexToLetters(col)}${row + 1}`;
}

/** Parse "A1" or "Sheet1!A1" — returns null on malformed input. */
export function parseA1Cell(input: string): { sheetName: string | null; row: number; col: number } | null {
  if (typeof input !== "string") return null;
  let body = input.trim();
  if (!body) return null;
  let sheetName: string | null = null;
  const bang = body.indexOf("!");
  if (bang >= 0) {
    sheetName = body.slice(0, bang).replace(/^'(.*)'$/, "$1");
    body = body.slice(bang + 1);
  }
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(body);
  if (!m) return null;
  const col = letterToColIndex(m[1]);
  const row = Number.parseInt(m[2], 10) - 1;
  if (col < 0 || row < 0 || !Number.isFinite(row)) return null;
  return { sheetName, row, col };
}

/** Parse "A1:B5" / "Sheet1!A1:B5". Returns null on malformed input. */
export function parseA1Range(input: string): { sheetName: string | null; range: PivotRange } | null {
  if (typeof input !== "string") return null;
  let body = input.trim();
  if (!body) return null;
  let sheetName: string | null = null;
  const bang = body.indexOf("!");
  if (bang >= 0) {
    sheetName = body.slice(0, bang).replace(/^'(.*)'$/, "$1");
    body = body.slice(bang + 1);
  }
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(body);
  if (!m) return null;
  const c1 = letterToColIndex(m[1]);
  const r1 = Number.parseInt(m[2], 10) - 1;
  if (c1 < 0 || r1 < 0 || !Number.isFinite(r1)) return null;
  if (m[3] === undefined) {
    return { sheetName, range: { r1, c1, r2: r1, c2: c1 } };
  }
  const c2 = letterToColIndex(m[3]);
  const r2 = Number.parseInt(m[4], 10) - 1;
  if (c2 < 0 || r2 < 0 || !Number.isFinite(r2)) return null;
  return {
    sheetName,
    range: {
      r1: Math.min(r1, r2),
      c1: Math.min(c1, c2),
      r2: Math.max(r1, r2),
      c2: Math.max(c1, c2),
    },
  };
}

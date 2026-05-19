// Pure helpers for Excel "Data → Subtotal".
//
// Walks a range row-by-row, sorted by a group-by column, and emits summary
// rows ("<group> Total") plus a final "Grand Total" row. The transformation
// is one-shot: we mutate cellData by inserting new rows rather than storing
// a persistent rule. Coco-managed snapshot undo (applyMutatedSnapshot) is
// the recovery path if the user wants to roll back.
//
// Snapshot shape (Univer 0.5.x + Coco extension) — the slice we touch:
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: Record<string, Record<string, ICellData>>;
//                                  // ^ keyed by stringified row/col indices
//         rowData?:  Record<string, { h?: number; hd?: 0 | 1; ... }>;
//         _outlineRows?: Array<{ start, end, level, collapsed? }>;
//       }
//     }
//   }
//
// The caller is responsible for writing newCellData back into the snapshot
// and (when addOutline) for appending outlineGroups into _outlineRows.
// Kept side-effect free so the dialog can preview and unit tests can run
// without Univer.
//
// Sorting: callers are expected to pre-sort the range by the group-by
// column before invoking applySubtotals — the dialog confirms this with
// the user. If the input is not sorted, "groups" will simply be contiguous
// runs of equal keys, matching how Excel behaves when sort is skipped.

export type SubtotalFunction =
  | "SUM"
  | "AVERAGE"
  | "COUNT"
  | "MAX"
  | "MIN"
  | "PRODUCT";

export interface SubtotalRange {
  /** 0-based inclusive top row. */
  r1: number;
  /** 0-based inclusive left column. */
  c1: number;
  /** 0-based inclusive bottom row. */
  r2: number;
  /** 0-based inclusive right column. */
  c2: number;
}

export interface SubtotalParams {
  /** Region (0-based inclusive) the subtotal operates over. */
  range: SubtotalRange;
  /** 1-based column index *within* the range (1 = first column of range). */
  groupByCol: number;
  aggregate: SubtotalFunction;
  /** 1-based target column indices *within* the range. May be multiple. */
  targetCols: number[];
  /** When true, the first row of `range` is treated as a header and skipped. */
  hasHeader: boolean;
  /** When true, return outline groups so detail rows can be collapsed. */
  addOutline: boolean;
}

export interface SubtotalOutlineGroup {
  start: number;
  end: number;
  level: number;
  collapsed?: boolean;
}

export interface SubtotalResult {
  /**
   * Full replacement cellData for the affected sheet. The caller writes this
   * back wholesale — it's easier to reason about than computing a diff.
   */
  newCellData: Record<string, Record<string, unknown>>;
  /** New total row count after insertion (may be needed for row metadata). */
  newRowCount: number;
  /**
   * Outline groups to append to _outlineRows when `addOutline` was set.
   * Detail-row ranges at level 1 (summary rows stay at level 0 i.e. visible).
   */
  outlineGroups?: SubtotalOutlineGroup[];
}

// Read the displayable value of a cell — Univer's ICellData has `.v` for the
// raw user value. We deliberately don't try to evaluate `.f` (formula) here:
// the caller can't trust pre-eval results, and Excel itself aggregates over
// the *displayed* numeric value, not the formula text.
function readCellValue(
  cellData: Record<string, Record<string, unknown> | undefined> | undefined,
  row: number,
  col: number,
): unknown {
  if (!cellData) return undefined;
  const rowObj = cellData[String(row)];
  if (!rowObj) return undefined;
  const cell = rowObj[String(col)];
  if (cell === undefined || cell === null) return undefined;
  if (typeof cell !== "object") return cell;
  const v = (cell as { v?: unknown }).v;
  return v;
}

// Best-effort numeric coercion: numbers pass through, numeric strings are
// parsed, everything else returns NaN so the aggregate can skip it.
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
 * Aggregate a list of values using the requested Excel-style function.
 * Non-numeric / NaN entries are skipped (matching SUM/AVERAGE/... behavior).
 * COUNT counts numeric entries only (Excel COUNT ignores text). Returns 0
 * for empty sums/counts and NaN for AVERAGE/MAX/MIN/PRODUCT over empty
 * inputs (caller can decide to display blank).
 */
export function aggregate(fn: SubtotalFunction, values: number[]): number {
  const nums: number[] = [];
  for (const v of values) {
    if (Number.isFinite(v)) nums.push(v);
  }
  switch (fn) {
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
    case "PRODUCT": {
      if (nums.length === 0) return NaN;
      let p = 1;
      for (const n of nums) p *= n;
      return p;
    }
  }
}

// Label suffix used in the group column to identify summary rows. Matches the
// Excel convention ("North Total", "Grand Total"). The dialog's "remove all
// existing subtotals" action keys off this suffix.
const TOTAL_SUFFIX = " Total";
const GRAND_TOTAL_LABEL = "Grand Total";

// Read a representative key from the group-by column. Numbers and strings
// both stringify the same way so they compare with `===` after toString().
function groupKey(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

type SheetSnapshot = {
  cellData?: Record<string, Record<string, unknown> | undefined>;
  rowData?: Record<string, unknown>;
};

/**
 * Compute new cellData with subtotal + grand-total rows inserted. Pure: the
 * input sheet object is never mutated. Returns the *full* new cellData map
 * so the caller can assign it directly.
 *
 * Algorithm:
 *  1. Clone the rows above the range as-is.
 *  2. Walk rows inside the range. Each time the group-by column value
 *     changes, emit a summary row aggregating the targetCols since the
 *     last break. Then emit the current detail row.
 *  3. After the last detail row, emit the final group summary + a grand
 *     total summary across all detail rows.
 *  4. Append any rows below the range unchanged, shifted down by the total
 *     number of inserted summary rows.
 *
 * When `targetCols` is empty, no aggregated values are written but the
 * summary rows are still inserted so the structure remains visible.
 */
export function applySubtotals(
  sheet: SheetSnapshot | undefined | null,
  params: SubtotalParams,
): SubtotalResult {
  const cellData = (sheet?.cellData ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const { range, groupByCol, aggregate: fn, targetCols, hasHeader, addOutline } = params;

  // Validate & normalize inputs early so the rest can assume sane bounds.
  const r1 = Math.min(range.r1, range.r2);
  const r2 = Math.max(range.r1, range.r2);
  const c1 = Math.min(range.c1, range.c2);
  const c2 = Math.max(range.c1, range.c2);
  const width = c2 - c1 + 1;
  // Translate 1-based "within-range" indices to absolute 0-based columns.
  // Clamp out-of-range entries to the nearest valid column to fail soft.
  const clampCol = (n: number) => {
    const idx = c1 + (n - 1);
    if (idx < c1) return c1;
    if (idx > c2) return c2;
    return idx;
  };
  const absGroupCol = clampCol(groupByCol);
  const absTargets = Array.from(
    new Set(targetCols.filter((n) => Number.isInteger(n) && n >= 1 && n <= width).map(clampCol)),
  );

  const firstDetailRow = hasHeader ? r1 + 1 : r1;
  if (firstDetailRow > r2) {
    // No detail rows — nothing to subtotalize. Return a verbatim clone so
    // callers can still write the result back without special-casing.
    return cloneAsResult(cellData, sheet, addOutline);
  }

  // Pull every detail row from the cellData inside the range — we need the
  // raw cell objects (for formats / styles) so we can carry them forward.
  type DetailRow = Record<string, Record<string, unknown> | undefined>;
  const details: { srcRow: number; cells: DetailRow; key: string; numByCol: Record<number, number> }[] = [];
  for (let r = firstDetailRow; r <= r2; r++) {
    const src = cellData[String(r)] ?? {};
    const cells: DetailRow = {};
    for (let c = c1; c <= c2; c++) {
      const cell = src[String(c)];
      if (cell !== undefined) cells[String(c)] = cell as Record<string, unknown>;
    }
    const key = groupKey(readCellValue(cellData, r, absGroupCol));
    const numByCol: Record<number, number> = {};
    for (const tc of absTargets) {
      numByCol[tc] = toNumber(readCellValue(cellData, r, tc));
    }
    details.push({ srcRow: r, cells, key, numByCol });
  }

  // Emit the new cellData. Start by copying every row that's NOT in the
  // mutated band (header included if hasHeader is false, since the header
  // row's content is preserved verbatim above).
  const out: Record<string, Record<string, unknown>> = {};
  const sourceMaxRow = computeMaxRow(cellData);
  // 1) Rows above the affected region (and the header row when hasHeader).
  const aboveCutoff = hasHeader ? r1 + 1 : r1;
  for (const key of Object.keys(cellData)) {
    const r = Number(key);
    if (!Number.isFinite(r)) continue;
    if (r < aboveCutoff) {
      const row = cellData[key];
      if (row) out[String(r)] = shallowCloneRow(row);
    }
  }

  // 2) Walk details, inserting summary rows on key change. Track a running
  // write cursor so summary rows land on the correct absolute row index.
  let writeRow = firstDetailRow;
  let currentKey: string | null = null;
  let groupStartWriteRow = -1; // first detail row of current group (write-space)
  let groupNums: Record<number, number[]> = {};
  const grandNums: Record<number, number[]> = {};
  for (const tc of absTargets) grandNums[tc] = [];
  const groupSummaryRows: number[] = [];
  // Outline groups span detail rows of each group. We collect contiguous
  // detail spans here; the grand total stays outside any group.
  const outlineGroups: SubtotalOutlineGroup[] = [];

  const flushGroupSummary = (forKey: string) => {
    // Emit a summary row at writeRow. Group label goes in the group column,
    // aggregate values go in each target column.
    const summary: Record<string, unknown> = {};
    summary[String(absGroupCol)] = { v: `${forKey}${TOTAL_SUFFIX}` };
    for (const tc of absTargets) {
      const v = aggregate(fn, groupNums[tc] ?? []);
      summary[String(tc)] = { v: Number.isFinite(v) ? v : "" };
    }
    out[String(writeRow)] = summary;
    groupSummaryRows.push(writeRow);
    // If we want outline grouping, record the detail-row span (everything
    // between groupStartWriteRow and writeRow-1) as a level-1 group so the
    // user can collapse it. We skip empty groups defensively.
    if (addOutline && groupStartWriteRow >= 0 && writeRow - 1 >= groupStartWriteRow) {
      outlineGroups.push({
        start: groupStartWriteRow,
        end: writeRow - 1,
        level: 1,
      });
    }
    writeRow += 1;
  };

  for (const detail of details) {
    if (currentKey === null) {
      currentKey = detail.key;
      groupStartWriteRow = writeRow;
      groupNums = {};
      for (const tc of absTargets) groupNums[tc] = [];
    } else if (detail.key !== currentKey) {
      // Group break — emit summary for the previous group, then start a new.
      flushGroupSummary(currentKey);
      currentKey = detail.key;
      groupStartWriteRow = writeRow;
      groupNums = {};
      for (const tc of absTargets) groupNums[tc] = [];
    }
    // Write the detail row (carrying its original cells) at writeRow.
    out[String(writeRow)] = shallowCloneRow(detail.cells);
    // Accumulate aggregates for both the running group and the grand total.
    for (const tc of absTargets) {
      const n = detail.numByCol[tc];
      if (Number.isFinite(n)) {
        groupNums[tc].push(n);
        grandNums[tc].push(n);
      }
    }
    writeRow += 1;
  }
  // Final group summary (currentKey is non-null because firstDetailRow<=r2).
  if (currentKey !== null) flushGroupSummary(currentKey);

  // Grand total row — outside any outline group so it's never hidden.
  const grand: Record<string, unknown> = {};
  grand[String(absGroupCol)] = { v: GRAND_TOTAL_LABEL };
  for (const tc of absTargets) {
    const v = aggregate(fn, grandNums[tc]);
    grand[String(tc)] = { v: Number.isFinite(v) ? v : "" };
  }
  out[String(writeRow)] = grand;
  const grandRow = writeRow;
  writeRow += 1;

  // 3) Shift any rows that lived BELOW the original range down by the number
  // of summary rows inserted (groupSummaryRows.length + 1 for the grand).
  const insertedCount = groupSummaryRows.length + 1;
  for (const key of Object.keys(cellData)) {
    const r = Number(key);
    if (!Number.isFinite(r) || r <= r2) continue;
    const row = cellData[key];
    if (!row) continue;
    out[String(r + insertedCount)] = shallowCloneRow(row);
  }

  const newRowCount = Math.max(sourceMaxRow + 1 + insertedCount, grandRow + 1);

  return {
    newCellData: out,
    newRowCount,
    outlineGroups: addOutline ? outlineGroups : undefined,
  };
}

// Build a SubtotalResult that's just a verbatim clone of the input cellData —
// used for the "nothing to do" early-return path.
function cloneAsResult(
  cellData: Record<string, Record<string, unknown> | undefined>,
  sheet: SheetSnapshot | undefined | null,
  addOutline: boolean,
): SubtotalResult {
  const out: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(cellData)) {
    const row = cellData[key];
    if (row) out[key] = shallowCloneRow(row);
  }
  // rowData isn't part of the result shape we own, but newRowCount needs the
  // larger of cellData / rowData extents so the caller can size correctly.
  const rowDataMax = sheet?.rowData
    ? Object.keys(sheet.rowData)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .reduce((m, n) => (n > m ? n : m), -1) + 1
    : 0;
  const cellMax = computeMaxRow(cellData) + 1;
  return {
    newCellData: out,
    newRowCount: Math.max(cellMax, rowDataMax),
    outlineGroups: addOutline ? [] : undefined,
  };
}

function shallowCloneRow(
  row: Record<string, Record<string, unknown> | undefined> | Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    const v = (row as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function computeMaxRow(
  cellData: Record<string, Record<string, unknown> | undefined> | undefined,
): number {
  if (!cellData) return -1;
  let max = -1;
  for (const k of Object.keys(cellData)) {
    const n = Number(k);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Strip previously-inserted subtotal rows from cellData. A row is considered
 * a subtotal when the cell at `groupCol` (0-based absolute) contains a string
 * value ending in " Total" or equal to "Grand Total". Returns a new cellData
 * with the matching rows removed and the remaining rows shifted up.
 *
 * Used by the dialog's "Remove all existing subtotals" button — the user can
 * clear a previous run before applying a new one with different parameters.
 */
export function stripSubtotalRows(
  cellData: Record<string, Record<string, unknown> | undefined> | undefined,
  groupCol: number,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!cellData) return out;
  // Sort by numeric row so we can shift up while iterating.
  const rows = Object.keys(cellData)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  let shift = 0;
  for (const r of rows) {
    const v = readCellValue(cellData, r, groupCol);
    const s = typeof v === "string" ? v : "";
    const isSubtotal = s === GRAND_TOTAL_LABEL || s.endsWith(TOTAL_SUFFIX);
    if (isSubtotal) {
      shift += 1;
      continue;
    }
    const row = cellData[String(r)];
    if (row) out[String(r - shift)] = shallowCloneRow(row);
  }
  return out;
}

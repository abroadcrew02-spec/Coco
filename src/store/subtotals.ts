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
  mergeData?: unknown[];
  _conditionalFormatting?: unknown[];
  _dataValidations?: unknown[];
  _hyperlinks?: unknown[];
  _comments?: unknown[];
  _sparklines?: unknown[];
  _outlineRows?: Array<{ start: number; end: number; level: number; collapsed?: boolean }>;
};

/**
 * Compute new cellData with subtotal + grand-total rows inserted. Returns
 * the *full* new cellData map so the caller can assign it directly.
 *
 * Side effects (Bug 2 fix): when `insertedCount > 0`, the helper also shifts
 * every row-indexed structure on `sheet` (mergeData / _conditionalFormatting
 * / _dataValidations / _hyperlinks / _comments / _sparklines / _outlineRows
 * / rowData) down by `insertedCount` for any entry whose row was below the
 * subtotal range. Without this, adjacent CF rules, merges, comments,
 * hyperlinks etc. silently mis-target after the insert. The mutation is
 * applied directly on `sheet` because the caller already re-assigns
 * `sheet.cellData = result.newCellData` immediately after — so the input is
 * already understood to be writable.
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
 *  5. Shift all sheet-level row-indexed structures (see "Side effects").
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

  // Bug 1 fix: rather than rely on `sourceMaxRow + 1 + insertedCount` (which
  // undercounts when `sourceMaxRow` lived inside the replaced band), derive
  // the new row count from the actual keys of the result. The grand-total row
  // is always the bottom of the inserted summary block, so we also take the
  // max against `grandRow + 1` for the empty-below case.
  const outMaxRow = computeMaxRow(out);
  const newRowCount = Math.max(outMaxRow + 1, grandRow + 1);

  // Bug 2 fix: shift every row-indexed sheet structure that lived below the
  // affected range so adjacent CF rules / merges / hyperlinks / comments /
  // sparklines / outline groups / row-data don't dangle after the insert.
  // The shift is applied directly to `sheet` because the caller already
  // re-assigns `sheet.cellData = result.newCellData` immediately after this
  // call returns.
  if (sheet && insertedCount > 0) {
    shiftSheetRowsBelow(sheet as Record<string, unknown>, r2 + 1, insertedCount);
  }

  return {
    newCellData: out,
    newRowCount,
    outlineGroups: addOutline ? outlineGroups : undefined,
  };
}

/**
 * Shift every row-indexed structure on a sheet down by `delta` when the row
 * is at or below `fromRow`. Mirrors what Excel does when rows are inserted:
 * merges, conditional-formatting sqrefs, data-validation sqrefs, hyperlinks,
 * comments, sparklines, outline groups, and the `rowData` map all need to be
 * kept in sync with the new row positions, otherwise the user sees CF
 * rules mis-target, merges silently dangle, comments stick to the wrong cell,
 * etc.
 *
 * The function is intentionally non-mutating at the field level: it rebuilds
 * each affected array/map so the caller can freely assign without worrying
 * about aliasing. Returns void; mutations are applied in-place on `sheet`
 * because that mirrors how `applySubtotals` already writes back `cellData`.
 *
 * Test-case expectations (kept here so behavior is auditable without unit
 * tests):
 *
 *   // sheet with merge {2,3,0,1} (rows 2-3, cols A-B) + subtotal range
 *   // {0,0,5,5} inserts 2 rows
 *   // → merge unchanged (rows 2-3 are inside the range and get replaced)
 *   // → merge at {10,11} becomes {12,13}
 *
 *   // sheet with CF sqref "A8:A20" and 3 rows inserted at fromRow=6
 *   // → sqref becomes "A11:A23"
 *
 *   // sheet with hyperlink at "B12" and 2 rows inserted at fromRow=8
 *   // → hyperlink moves to "B14"
 *
 *   // sheet with outline group {start:8, end:10} and 2 rows inserted at
 *   // fromRow=7 → outline becomes {start:10, end:12}
 *
 * @param sheet Mutable sheet snapshot object (mergeData, _conditionalFormatting,
 *   _dataValidations, _hyperlinks, _comments, _sparklines, _outlineRows,
 *   rowData are inspected/updated).
 * @param fromRow 0-based row index — rows with index >= fromRow shift down.
 * @param delta Number of rows to insert (must be positive to insert; pass a
 *   negative number to shift up, used by removal flows).
 */
export function shiftSheetRowsBelow(
  sheet: Record<string, unknown> | undefined | null,
  fromRow: number,
  delta: number,
): void {
  if (!sheet || delta === 0) return;
  if (!Number.isInteger(fromRow) || fromRow < 0) return;
  if (!Number.isInteger(delta)) return;

  // 1) mergeData[]: array of { startRow, endRow, startCol, endCol }.
  const merges = (sheet as { mergeData?: unknown }).mergeData;
  if (Array.isArray(merges)) {
    const out: unknown[] = [];
    for (const m of merges) {
      if (!m || typeof m !== "object") {
        out.push(m);
        continue;
      }
      const obj = m as { startRow?: unknown; endRow?: unknown; startCol?: unknown; endCol?: unknown };
      const startRow = typeof obj.startRow === "number" ? obj.startRow : NaN;
      const endRow = typeof obj.endRow === "number" ? obj.endRow : NaN;
      if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) {
        out.push(m);
        continue;
      }
      // Only shift merges whose top is at/below fromRow. Merges fully above
      // fromRow are unaffected; merges that straddle fromRow are also left
      // untouched (Excel's behavior — straddled merges are typically inside
      // the replaced region and were either preserved verbatim or removed
      // by the caller before invoking us).
      if (startRow >= fromRow) {
        out.push({ ...obj, startRow: startRow + delta, endRow: endRow + delta });
      } else {
        out.push(m);
      }
    }
    (sheet as { mergeData?: unknown[] }).mergeData = out;
  }

  // 2) _conditionalFormatting[]: each entry has a `sqref` string with one or
  // more space-separated A1 tokens. Rewrite each token.
  const cf = (sheet as { _conditionalFormatting?: unknown }).
    _conditionalFormatting;
  if (Array.isArray(cf)) {
    for (const entry of cf) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as { sqref?: unknown };
      if (typeof obj.sqref !== "string") continue;
      obj.sqref = shiftSqrefRows(obj.sqref, fromRow, delta);
    }
  }

  // 3) _dataValidations[]: same shape — `sqref` string with A1 tokens.
  const dv = (sheet as { _dataValidations?: unknown })._dataValidations;
  if (Array.isArray(dv)) {
    for (const entry of dv) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as { sqref?: unknown };
      if (typeof obj.sqref !== "string") continue;
      obj.sqref = shiftSqrefRows(obj.sqref, fromRow, delta);
    }
  }

  // 4) _hyperlinks[]: `cell` is a single A1 cell ref.
  const hyperlinks = (sheet as { _hyperlinks?: unknown })._hyperlinks;
  if (Array.isArray(hyperlinks)) {
    for (const entry of hyperlinks) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as { cell?: unknown };
      if (typeof obj.cell !== "string") continue;
      obj.cell = shiftA1CellRow(obj.cell, fromRow, delta);
    }
  }

  // 5) _comments[]: `cell` or `cellRef` is a single A1 cell ref.
  const comments = (sheet as { _comments?: unknown })._comments;
  if (Array.isArray(comments)) {
    for (const entry of comments) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as { cell?: unknown; cellRef?: unknown };
      if (typeof obj.cell === "string") {
        obj.cell = shiftA1CellRow(obj.cell, fromRow, delta);
      }
      if (typeof obj.cellRef === "string") {
        obj.cellRef = shiftA1CellRow(obj.cellRef, fromRow, delta);
      }
    }
  }

  // 6) _sparklines[]: `cell` (anchor) is a single A1 cell ref; `sourceRange`
  // can be a range, optionally sheet-qualified (`Sheet1!A5:C5`).
  const sparklines = (sheet as { _sparklines?: unknown })._sparklines;
  if (Array.isArray(sparklines)) {
    for (const entry of sparklines) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as { cell?: unknown; sourceRange?: unknown };
      if (typeof obj.cell === "string") {
        obj.cell = shiftA1CellRow(obj.cell, fromRow, delta);
      }
      if (typeof obj.sourceRange === "string") {
        obj.sourceRange = shiftA1RangeRow(obj.sourceRange, fromRow, delta);
      }
    }
  }

  // 7) _outlineRows[]: array of { start, end, level, collapsed? }. Shift any
  // group whose start is at/below fromRow.
  const outline = (sheet as { _outlineRows?: unknown })._outlineRows;
  if (Array.isArray(outline)) {
    for (const entry of outline) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as { start?: unknown; end?: unknown };
      const start = typeof obj.start === "number" ? obj.start : NaN;
      const end = typeof obj.end === "number" ? obj.end : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start >= fromRow) {
        obj.start = start + delta;
        obj.end = end + delta;
      }
    }
  }

  // 8) rowData map (Record<rowIndex, {...}>): shift keys at/below fromRow.
  const rowData = (sheet as { rowData?: unknown }).rowData;
  if (rowData && typeof rowData === "object" && !Array.isArray(rowData)) {
    const src = rowData as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      const n = Number(k);
      if (!Number.isFinite(n)) {
        next[k] = src[k];
        continue;
      }
      if (n >= fromRow) {
        next[String(n + delta)] = src[k];
      } else {
        next[k] = src[k];
      }
    }
    (sheet as { rowData?: Record<string, unknown> }).rowData = next;
  }
}

// Parse a single A1 column-letter run into a 0-based column index. Returns
// -1 on malformed input. Kept local to subtotals.ts so the row-shift helpers
// don't acquire a hard dependency on dataValidation.ts.
function colLettersToIndexLocal(letters: string): number {
  const up = letters.toUpperCase();
  let n = 0;
  for (let i = 0; i < up.length; i++) {
    const c = up.charCodeAt(i);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// Rewrite a single A1 cell ref (e.g. "B12") so its row shifts by `delta` if
// the original row is at/below `fromRow`. Returns the input unchanged if
// parsing fails — defense-in-depth so a malformed snapshot doesn't crash.
function shiftA1CellRow(ref: string, fromRow: number, delta: number): string {
  const m = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(ref.trim());
  if (!m) return ref;
  const row = parseInt(m[4], 10) - 1;
  if (!Number.isFinite(row) || row < 0) return ref;
  if (row < fromRow) return ref;
  const newRow = row + delta;
  if (newRow < 0) return ref;
  return `${m[1]}${m[2]}${m[3]}${newRow + 1}`;
}

// Rewrite a single A1 range token (e.g. "A1:B10", "B12", "Sheet1!A5:C5") so
// any row inside the token shifts by `delta` if it was at/below `fromRow`.
function shiftA1RangeToken(token: string, fromRow: number, delta: number): string {
  const trimmed = token.trim();
  if (!trimmed) return token;
  // Strip optional sheet prefix.
  let sheetPrefix = "";
  let body = trimmed;
  const bangIdx = body.indexOf("!");
  if (bangIdx >= 0) {
    sheetPrefix = body.slice(0, bangIdx + 1);
    body = body.slice(bangIdx + 1);
  }
  const m = /^(\$?)([A-Za-z]+)(\$?)(\d+)(?::(\$?)([A-Za-z]+)(\$?)(\d+))?$/.exec(body);
  if (!m) return token;
  const r1 = parseInt(m[4], 10) - 1;
  if (!Number.isFinite(r1) || r1 < 0) return token;
  const c1Letters = m[2];
  // Validate column letters (we won't shift columns but we want to reject
  // malformed tokens early so we don't emit a garbled rewrite).
  if (colLettersToIndexLocal(c1Letters) < 0) return token;
  const newR1 = r1 >= fromRow ? Math.max(0, r1 + delta) : r1;
  if (m[5] === undefined) {
    return `${sheetPrefix}${m[1]}${c1Letters}${m[3]}${newR1 + 1}`;
  }
  const r2 = parseInt(m[8], 10) - 1;
  if (!Number.isFinite(r2) || r2 < 0) return token;
  const c2Letters = m[6];
  if (colLettersToIndexLocal(c2Letters) < 0) return token;
  const newR2 = r2 >= fromRow ? Math.max(0, r2 + delta) : r2;
  return `${sheetPrefix}${m[1]}${c1Letters}${m[3]}${newR1 + 1}:${m[5]}${c2Letters}${m[7]}${newR2 + 1}`;
}

// Rewrite a whole sqref expression (space-separated A1 tokens) by shifting
// every token's rows. Preserves the original separators.
function shiftSqrefRows(sqref: string, fromRow: number, delta: number): string {
  return sqref
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) || part === "" ? part : shiftA1RangeToken(part, fromRow, delta)))
    .join("");
}

// Wrapper for a single sparkline-style sourceRange (single token, but we go
// through the same helper to handle the optional sheet prefix uniformly).
function shiftA1RangeRow(range: string, fromRow: number, delta: number): string {
  return shiftA1RangeToken(range, fromRow, delta);
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

// Pure helpers for the "Filter Search" (値で検索フィルター) feature — a richer
// dialog version of Excel's autofilter dropdown search box. Unlike
// `filterByColor` (matches cell color) or `advancedFilter` (matches a
// criteria range), this matches a user-curated set of distinct cell *values*
// in a single column, much like Excel's Autofilter dropdown checkbox list.
//
// Flow:
//   1. `listColumnDistinctValues` enumerates every distinct value in the
//      column with its occurrence count (so the UI can show frequency).
//   2. The user ticks the values they want to keep in `selectedValues`.
//   3. `applyFilterSearch` hides every row in `range` whose value at
//      `column` is NOT in `selectedValues` (via `rowData[r].hd = 1`).
//
// Snapshot shape (Univer 0.5.x — same convention used by filterByColor.ts,
// advancedFilter.ts, formatPainter.ts, etc.):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: { [row: string]: { [col: string]: { v?: unknown } } },
//         rowData?:  { [row: string]: { hd?: 0 | 1 } },
//       }
//     }
//   }
//
// The header row at `range.r1` is always kept visible and explicitly marked
// `hd: 0` in case a previous filter hid it. Blank values are represented by
// the sentinel `BLANK_VALUE_SENTINEL` so the UI / API can treat "empty" as
// an explicit choice (Excel's "(空白)" entry).
//
// Kept side-effect free so the dialog can preview without a Univer instance.

export interface FilterSearchRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface FilterSearchParams {
  /** 0-based source rectangle (header row at r1 is preserved — never hidden). */
  range: FilterSearchRect;
  /** 0-based column index whose values drive the filter (must lie within `range`). */
  column: number;
  /**
   * Canonicalised string values to keep. Rows whose column value matches one
   * of these are visible; every other row is hidden. The sentinel
   * `BLANK_VALUE_SENTINEL` matches cells with no value (empty / undefined).
   */
  selectedValues: string[];
  /**
   * When false (the default), value comparison is case-insensitive (matching
   * Excel's autofilter, which is case-blind). When true, exact string match.
   */
  caseSensitive: boolean;
}

/** Sentinel used in `selectedValues` to represent "blank / no value". */
export const BLANK_VALUE_SENTINEL = "__blank__";

// ---------------------------------------------------------------------------
// Cell value extraction
// ---------------------------------------------------------------------------

type CellLike = { v?: unknown } | undefined;
type CellDataLike =
  | Record<string, Record<string, CellLike> | undefined>
  | undefined;

// Pull a primitive cell value from cellData[row][col]. Returns the raw value
// (number / string / boolean) or undefined when the cell is missing / blank.
function readCellValue(cellData: CellDataLike, row: number, col: number): unknown {
  if (!cellData) return undefined;
  const r = cellData[String(row)];
  if (!r) return undefined;
  const c = r[String(col)];
  if (!c || typeof c !== "object") return undefined;
  return (c as { v?: unknown }).v;
}

// Convert a raw cell value to the comparison string used by both
// `listColumnDistinctValues` and `applyFilterSearch`. Blank / nullish values
// collapse to the BLANK sentinel so the API treats them uniformly.
function toCompareKey(value: unknown, caseSensitive: boolean): string {
  if (value === undefined || value === null) return BLANK_VALUE_SENTINEL;
  const s = typeof value === "string" ? value : String(value);
  if (s.trim() === "") return BLANK_VALUE_SENTINEL;
  return caseSensitive ? s : s.toLowerCase();
}

// ---------------------------------------------------------------------------
// Distinct values in a column (with counts)
// ---------------------------------------------------------------------------

/**
 * Enumerate every distinct value that appears in `column` within the data
 * portion of `range` (rows `r1+1` .. `r2`; the header at `r1` is excluded).
 *
 * Returns an array sorted by display value (lexicographic, blanks last). The
 * `value` field is the original display string — the UI shows this verbatim;
 * matching uses `caseSensitive: false` by default so "Apple" and "apple" are
 * grouped into one entry. The first-seen casing wins for display.
 *
 * `count` is the number of rows the value appears on (handy for the UI to
 * render a visual frequency bar / sort by frequency).
 */
export function listColumnDistinctValues(
  cellData: CellDataLike,
  range: FilterSearchRect,
  column: number,
): Array<{ value: string; count: number }> {
  if (column < range.c1 || column > range.c2) return [];
  const r1 = Math.min(range.r1, range.r2);
  const r2 = Math.max(range.r1, range.r2);
  // Map from case-insensitive key → { display, count }. Using a map preserves
  // insertion order for the "first-seen casing wins" rule, and lets us look
  // up an existing bucket in O(1) per row.
  const buckets = new Map<string, { display: string; count: number }>();
  let blankCount = 0;
  // Skip the header row (r1). If the range is a single row, treat it as data.
  const dataStart = r2 > r1 ? r1 + 1 : r1;
  for (let r = dataStart; r <= r2; r++) {
    const raw = readCellValue(cellData, r, column);
    if (raw === undefined || raw === null) {
      blankCount++;
      continue;
    }
    const display = typeof raw === "string" ? raw : String(raw);
    if (display.trim() === "") {
      blankCount++;
      continue;
    }
    const key = display.toLowerCase();
    const existing = buckets.get(key);
    if (existing) existing.count++;
    else buckets.set(key, { display, count: 1 });
  }
  const out: Array<{ value: string; count: number }> = Array.from(buckets.values())
    .map((b) => ({ value: b.display, count: b.count }))
    .sort((a, b) => {
      const al = a.value.toLowerCase();
      const bl = b.value.toLowerCase();
      return al < bl ? -1 : al > bl ? 1 : 0;
    });
  if (blankCount > 0) {
    out.push({ value: BLANK_VALUE_SENTINEL, count: blankCount });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

// Loose snapshot type — callers pass whatever Univer's `workbook.save()` emits.
interface SnapshotShape {
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
 * Hide every row in `params.range` whose value at `params.column` is NOT in
 * `params.selectedValues`. The header row (`range.r1`) is always kept
 * visible and explicitly marked `hd: 0`.
 *
 * Does NOT mutate the input; returns a new snapshot object plus counts.
 *
 * Behaviour:
 *   - Empty `selectedValues` hides every data row (nothing matches).
 *   - `BLANK_VALUE_SENTINEL` matches cells whose value is undefined / null /
 *     whitespace-only.
 *   - `caseSensitive: false` (default) folds casing for ASCII text match,
 *     mirroring Excel's autofilter.
 */
export function applyFilterSearch(
  snapshot: object,
  sheetId: string,
  params: FilterSearchParams,
): { snapshotMutated: object; matchedRows: number; hiddenRows: number } {
  // Defensive clone — re-parse via JSON so the caller's object stays untouched.
  const cloned = JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
  const sheet = cloned.sheets?.[sheetId];
  if (!sheet) {
    return { snapshotMutated: cloned, matchedRows: 0, hiddenRows: 0 };
  }
  const cellData = sheet.cellData;
  const r1 = Math.min(params.range.r1, params.range.r2);
  const r2 = Math.max(params.range.r1, params.range.r2);
  if (r1 < 0 || r2 < r1) {
    return { snapshotMutated: cloned, matchedRows: 0, hiddenRows: 0 };
  }
  if (params.column < params.range.c1 || params.column > params.range.c2) {
    return { snapshotMutated: cloned, matchedRows: 0, hiddenRows: 0 };
  }

  // Build the comparison set up-front so the row scan is a single Set lookup.
  // We normalise each selected value with the same caseSensitive rule used
  // for cell values to guarantee symmetric matching.
  const selectedKeys = new Set<string>();
  for (const v of params.selectedValues) {
    if (v === BLANK_VALUE_SENTINEL) {
      selectedKeys.add(BLANK_VALUE_SENTINEL);
    } else {
      selectedKeys.add(params.caseSensitive ? v : v.toLowerCase());
    }
  }

  if (!sheet.rowData) sheet.rowData = {};
  const rowData = sheet.rowData as Record<string, { hd?: 0 | 1 }>;

  // Keep the header row visible even if it would otherwise be hidden.
  rowData[String(r1)] = { ...(rowData[String(r1)] ?? {}), hd: 0 };

  let matched = 0;
  let hidden = 0;
  for (let r = r1 + 1; r <= r2; r++) {
    const raw = readCellValue(cellData, r, params.column);
    const key = toCompareKey(raw, params.caseSensitive);
    const keep = selectedKeys.has(key);
    const prev = rowData[String(r)] ?? {};
    rowData[String(r)] = { ...prev, hd: keep ? 0 : 1 };
    if (keep) matched++;
    else hidden++;
  }

  return { snapshotMutated: cloned, matchedRows: matched, hiddenRows: hidden };
}

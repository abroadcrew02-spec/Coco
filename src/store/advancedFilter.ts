// Pure helpers for Excel's "Advanced Filter" (フィルターの詳細設定).
//
// Unlike AutoFilter (per-column dropdown), Advanced Filter uses a separate
// "criteria range" — a rectangle whose first row holds column headers that
// must match the source headers, and whose subsequent rows define filter
// conditions. Multiple criteria rows are OR-combined; multiple non-empty
// cells in the same row are AND-combined within that row.
//
// Example:
//   Source        : Name | Age | City
//                   Alice | 30  | Tokyo
//                   Bob   | 25  | Osaka
//                   Carol | 35  | Tokyo
//   Criteria      : City  | Age
//                   Tokyo | >25
//   Matches       : Alice, Carol
//
// Two output modes:
//   - "inPlace" — set rowData[r].hd = 1 on non-matching source rows so the
//     spreadsheet hides them (matches Excel's "Filter the list, in place").
//   - "copyTo"  — emit matching rows as a 2-D array that callers can drop into
//     a destination range starting at `destination`.
//
// Snapshot shape (Univer 0.5.x):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: { [row: string]: { [col: string]: { v?: unknown } } },
//         rowData?:  { [row: string]: { hd?: 0 | 1 } },
//       }
//     }
//   }
//
// Kept side-effect free so the dialog can preview / unit tests can drive it
// without instantiating Univer.

export interface CellRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface AdvancedFilterParams {
  /** 0-based source rectangle including the header row at r1. */
  sourceRange: CellRect;
  /** 0-based criteria rectangle including the header row at r1. */
  criteriaRange: CellRect;
  /** "inPlace" hides non-matching source rows; "copyTo" emits matching rows. */
  mode: "inPlace" | "copyTo";
  /** Required when mode === "copyTo". Top-left of the output range. */
  destination?: { row: number; col: number };
  /** Drop duplicate matching rows (cellwise equality on the source columns). */
  uniqueRecordsOnly?: boolean;
}

export interface AdvancedFilterResult {
  /** Absolute 0-based row indices in the source sheet that satisfied criteria. */
  matchedRows: number[];
  /** Materialised matching rows (header row first) — only populated for copyTo. */
  copyOutput?: Array<Array<unknown>>;
}

/**
 * Parsed comparison expression for one criteria cell. Operators:
 *   "="   — equality (string or number); literal cells with no operator also
 *           use "=" so callers don't have to special-case bare values.
 *   "<>"  — inequality
 *   ">", "<", ">=", "<="  — numeric ordering (string fallback for non-numerics)
 */
export interface ParsedExpression {
  op: "=" | "<>" | ">" | "<" | ">=" | "<=";
  value: unknown;
}

/**
 * Parse an Excel-style criteria cell. Recognised prefixes (longest-first so
 * ">=" wins over ">"): "<>", ">=", "<=", "=", ">", "<". Anything else is
 * treated as a literal equality target. Empty / whitespace-only inputs are
 * treated as a no-op equality with an empty string so callers can short-circuit.
 */
export function parseExpression(expr: string): ParsedExpression {
  const raw = expr.trim();
  if (!raw) return { op: "=", value: "" };

  const PREFIXES: Array<ParsedExpression["op"]> = ["<>", ">=", "<=", "=", ">", "<"];
  for (const op of PREFIXES) {
    if (raw.startsWith(op)) {
      const rest = raw.slice(op.length).trim();
      // Try numeric coercion so ">25" compares numerically. Fall back to the
      // raw string so ">B" still works as an alphabetical comparison.
      const n = Number(rest);
      const value = rest !== "" && Number.isFinite(n) ? n : rest;
      return { op, value };
    }
  }
  // Literal: equality. Coerce to number when the entire string parses.
  const n = Number(raw);
  return { op: "=", value: Number.isFinite(n) && raw !== "" ? n : raw };
}

// Case-insensitive string equality for non-numeric comparisons, matching
// Excel's default which is case-insensitive for text criteria.
function eqLoose(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null) return b === undefined || b === null || b === "";
  if (b === undefined || b === null) return a === "";
  if (typeof a === "number" && typeof b === "number") return a === b;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// Three-way compare: numeric when both sides coerce to finite numbers, otherwise
// case-insensitive string. Returns NaN if either side is blank so the caller
// can short-circuit to "no match" for ordering operators.
function compareValues(a: unknown, b: unknown): number {
  if (a === undefined || a === null || a === "") return Number.NaN;
  if (b === undefined || b === null || b === "") return Number.NaN;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const an = typeof a === "string" ? Number(a) : Number.NaN;
  const bn = typeof b === "string" ? Number(b) : Number.NaN;
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  const as = String(a).toLowerCase();
  const bs = String(b).toLowerCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Evaluate one parsed expression against a candidate value. Blank candidate
 * values match only an explicit equality against an empty string; ordering
 * operators (">", "<", ">=", "<=") on blanks return false.
 */
function evaluate(parsed: ParsedExpression, candidate: unknown): boolean {
  switch (parsed.op) {
    case "=":
      return eqLoose(candidate, parsed.value);
    case "<>":
      return !eqLoose(candidate, parsed.value);
    case ">":
    case "<":
    case ">=":
    case "<=": {
      const cmp = compareValues(candidate, parsed.value);
      if (Number.isNaN(cmp)) return false;
      switch (parsed.op) {
        case ">":
          return cmp > 0;
        case "<":
          return cmp < 0;
        case ">=":
          return cmp >= 0;
        case "<=":
          return cmp <= 0;
      }
      return false;
    }
  }
}

/**
 * Does a source row satisfy the criteria?
 *
 * - `row`              : header-keyed map of the candidate row's cells
 * - `sourceHeaders`    : ordered header labels for the source range
 * - `criteriaRows`     : header-keyed maps for each criteria row (= OR group)
 * - `criteriaHeaders`  : ordered header labels for the criteria range
 *
 * Returns true if ANY criteria row matches all of its non-empty cells (OR
 * across rows; AND within a row). An entirely empty criteria row matches
 * everything — matches Excel's behaviour, which is occasionally surprising
 * but documented.
 */
export function matchesCriteria(
  row: Record<string, unknown>,
  sourceHeaders: string[],
  criteriaRows: Array<Record<string, unknown>>,
  criteriaHeaders: string[],
): boolean {
  if (criteriaRows.length === 0) return true;
  // Pre-lower the source headers so we can do case-insensitive matching once.
  const sourceLower = new Set(sourceHeaders.map((h) => String(h ?? "").toLowerCase()));

  for (const critRow of criteriaRows) {
    let rowMatches = true;
    let anyCondition = false;
    for (const critHeader of criteriaHeaders) {
      const cell = critRow[critHeader];
      if (cell === undefined || cell === null || (typeof cell === "string" && cell.trim() === "")) {
        continue;
      }
      anyCondition = true;
      // Criteria headers must match a source header (case-insensitive) to be
      // applicable; mismatched headers are silently skipped so the user can
      // leave an unused column in the criteria range without breaking the filter.
      if (!sourceLower.has(String(critHeader).toLowerCase())) {
        continue;
      }
      const candidate = row[critHeader] ?? row[String(critHeader).toLowerCase()];
      const parsed = parseExpression(String(cell));
      if (!evaluate(parsed, candidate)) {
        rowMatches = false;
        break;
      }
    }
    if (rowMatches && (anyCondition || criteriaHeaders.length === 0)) {
      // Empty criteria row (no conditions) is the "match everything" wildcard.
      return true;
    }
    if (rowMatches && !anyCondition) return true;
  }
  return false;
}

// Snapshot type aliases — kept loose so a caller can pass the raw shape Univer
// emits without prior coercion.
type SheetData = {
  cellData?: Record<string, Record<string, { v?: unknown } | undefined> | undefined>;
  rowData?: Record<string, { hd?: 0 | 1 } | undefined>;
};
type SheetsBag = Record<string, SheetData | undefined>;

// Pull a primitive cell value from cellData[row][col], tolerating gaps.
function readCellValue(
  cellData: SheetData["cellData"] | undefined,
  row: number,
  col: number,
): unknown {
  if (!cellData) return undefined;
  const r = cellData[String(row)];
  if (!r) return undefined;
  const c = r[String(col)];
  if (!c || typeof c !== "object") return undefined;
  return (c as { v?: unknown }).v;
}

/**
 * Apply an Advanced Filter to a single sheet within the snapshot. The sheet
 * argument is mutated in place when `mode === "inPlace"` (row hd flags). For
 * `copyTo`, the result includes a `copyOutput` 2-D array that the caller is
 * expected to write into the destination range itself — we deliberately do not
 * mutate cellData here so the dialog can preview the row count without touching
 * the live workbook.
 *
 * Returns the matched row indices (absolute, in the source range's row space)
 * and, for copyTo, the materialised rows in source-column order including the
 * header row at index 0.
 */
export function applyAdvancedFilter(
  sheet: SheetData,
  params: AdvancedFilterParams,
): AdvancedFilterResult & { mutatedSheet?: SheetData } {
  const cellData = sheet.cellData;
  const { sourceRange, criteriaRange, mode, destination, uniqueRecordsOnly } = params;

  // Build source headers from the first row of sourceRange.
  const sourceHeaders: string[] = [];
  for (let c = sourceRange.c1; c <= sourceRange.c2; c++) {
    const v = readCellValue(cellData, sourceRange.r1, c);
    sourceHeaders.push(v === undefined || v === null ? "" : String(v));
  }
  // Build criteria headers from the first row of criteriaRange.
  const criteriaHeaders: string[] = [];
  for (let c = criteriaRange.c1; c <= criteriaRange.c2; c++) {
    const v = readCellValue(cellData, criteriaRange.r1, c);
    criteriaHeaders.push(v === undefined || v === null ? "" : String(v));
  }
  // Build criteria rows as header-keyed maps.
  const criteriaRows: Array<Record<string, unknown>> = [];
  for (let r = criteriaRange.r1 + 1; r <= criteriaRange.r2; r++) {
    const rowMap: Record<string, unknown> = {};
    let hasAny = false;
    criteriaHeaders.forEach((h, idx) => {
      const v = readCellValue(cellData, r, criteriaRange.c1 + idx);
      if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) {
        rowMap[h] = v;
        hasAny = true;
      }
    });
    if (hasAny) criteriaRows.push(rowMap);
  }

  const matchedRows: number[] = [];
  const copyRows: Array<Array<unknown>> = [];
  // Track seen tuples for "unique records only". JSON-stringifying a small
  // array is cheap and avoids hand-rolling a tuple hash.
  const seen = uniqueRecordsOnly ? new Set<string>() : null;

  for (let r = sourceRange.r1 + 1; r <= sourceRange.r2; r++) {
    const rowMap: Record<string, unknown> = {};
    const rowArr: unknown[] = [];
    sourceHeaders.forEach((h, idx) => {
      const v = readCellValue(cellData, r, sourceRange.c1 + idx);
      rowMap[h] = v;
      rowArr.push(v);
    });
    if (!matchesCriteria(rowMap, sourceHeaders, criteriaRows, criteriaHeaders)) continue;
    if (seen) {
      const key = JSON.stringify(rowArr);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    matchedRows.push(r);
    if (mode === "copyTo") copyRows.push(rowArr);
  }

  if (mode === "inPlace") {
    // Hide every non-matching source row; ensure header stays visible.
    const matchedSet = new Set(matchedRows);
    const mutated: SheetData = {
      ...sheet,
      rowData: { ...(sheet.rowData ?? {}) },
    };
    const rowData = mutated.rowData as Record<string, { hd?: 0 | 1 }>;
    // Header row: explicit hd=0 in case it was hidden previously.
    rowData[String(sourceRange.r1)] = { ...(rowData[String(sourceRange.r1)] ?? {}), hd: 0 };
    for (let r = sourceRange.r1 + 1; r <= sourceRange.r2; r++) {
      const prev = rowData[String(r)] ?? {};
      rowData[String(r)] = { ...prev, hd: matchedSet.has(r) ? 0 : 1 };
    }
    return { matchedRows, mutatedSheet: mutated };
  }

  // copyTo: prepend the header row so the destination range mirrors the source's
  // column layout, then return — the caller is responsible for writing this
  // into the workbook at `destination`.
  if (mode === "copyTo" && destination) {
    return {
      matchedRows,
      copyOutput: [sourceHeaders.slice(), ...copyRows],
    };
  }
  return { matchedRows, copyOutput: [sourceHeaders.slice(), ...copyRows] };
}

/**
 * Convenience wrapper that mutates a full sheets-bag in place for inPlace mode.
 * Returns the result for caller inspection (matched row count, etc).
 */
export function applyAdvancedFilterToSheets(
  sheets: SheetsBag | undefined,
  sheetId: string,
  params: AdvancedFilterParams,
): AdvancedFilterResult | null {
  if (!sheets) return null;
  const sheet = sheets[sheetId];
  if (!sheet) return null;
  const result = applyAdvancedFilter(sheet, params);
  if (params.mode === "inPlace" && result.mutatedSheet) {
    sheets[sheetId] = result.mutatedSheet;
  }
  return result;
}

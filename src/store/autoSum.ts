// Pure helpers for AutoSum (Σ / Alt+=). Side-effect free so they can be
// unit-tested without standing up Univer.
//
// Excel's AutoSum heuristic in a nutshell: when the user presses Alt+= on a
// cell, Excel looks for a contiguous block of numeric cells *above* the active
// cell first; if none, it scans to the *left*. The resulting =SUM(range) is
// written into the active cell. We mirror that here on the Univer snapshot.
//
// Snapshot shape mirrors formatPainter.ts:
//   sheets[sheetId].cellData[row][col] = { v?: number|string, f?: string, ... }
// Numeric detection: prefer the `v` field; a cell containing a formula whose
// cached `v` is a number also counts. Strings, blanks, and missing cells stop
// the scan.

interface AutoSumSnapshot {
  sheets?: Record<
    string,
    {
      cellData?: Record<
        string,
        Record<string, { v?: unknown; f?: unknown } | undefined> | undefined
      > | undefined;
    } | undefined
  >;
}

/**
 * Inferred range for an AutoSum at (row, col). startRow/endRow are inclusive
 * 0-based. `direction` records which scan picked the range so callers can
 * surface a hint in tests / UX. Returns null when there are no numeric
 * neighbours in either direction.
 */
export interface AutoSumRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  direction: "above" | "left";
}

function isNumericCell(
  cell: { v?: unknown; f?: unknown } | undefined,
): boolean {
  if (!cell) return false;
  const v = cell.v;
  if (typeof v === "number" && Number.isFinite(v)) return true;
  // Univer sometimes stores numeric `v` as a numeric string when the cell was
  // entered via the editor. Be lenient: a string that parses cleanly as a
  // finite number counts.
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return true;
  }
  return false;
}

/**
 * Scan upward from (row-1, col) collecting contiguous numeric rows. Returns
 * the top row of the run, or null if (row-1, col) is not numeric.
 */
function scanAbove(
  cellData: Record<string, Record<string, { v?: unknown; f?: unknown } | undefined> | undefined>,
  row: number,
  col: number,
): number | null {
  if (row <= 0) return null;
  const colKey = String(col);
  let top = row - 1;
  const probe = cellData[String(top)]?.[colKey];
  if (!isNumericCell(probe)) return null;
  while (top - 1 >= 0) {
    const next = cellData[String(top - 1)]?.[colKey];
    if (!isNumericCell(next)) break;
    top -= 1;
  }
  return top;
}

/**
 * Scan leftward from (row, col-1) collecting contiguous numeric columns.
 */
function scanLeft(
  cellData: Record<string, Record<string, { v?: unknown; f?: unknown } | undefined> | undefined>,
  row: number,
  col: number,
): number | null {
  if (col <= 0) return null;
  const rowKey = String(row);
  let left = col - 1;
  const probe = cellData[rowKey]?.[String(left)];
  if (!isNumericCell(probe)) return null;
  while (left - 1 >= 0) {
    const next = cellData[rowKey]?.[String(left - 1)];
    if (!isNumericCell(next)) break;
    left -= 1;
  }
  return left;
}

/**
 * Infer the AutoSum range for a click at (row, col) in the given sheet.
 * Returns null when neither above nor left has a numeric neighbour.
 *
 * Heuristic: above first, then left. Matches Excel's AutoSum behaviour.
 */
export function inferAutoSumRange(
  snapshotJson: string | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): AutoSumRange | null {
  if (!snapshotJson) return null;
  let parsed: AutoSumSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as AutoSumSnapshot;
  } catch {
    return null;
  }
  const cellData = parsed?.sheets?.[sheetId]?.cellData;
  if (!cellData) return null;

  const top = scanAbove(cellData, row, col);
  if (top !== null) {
    return {
      startRow: top,
      endRow: row - 1,
      startCol: col,
      endCol: col,
      direction: "above",
    };
  }
  const left = scanLeft(cellData, row, col);
  if (left !== null) {
    return {
      startRow: row,
      endRow: row,
      startCol: left,
      endCol: col - 1,
      direction: "left",
    };
  }
  return null;
}

/**
 * Convert a 0-based (row, col) to A1 notation. Used by the AutoSum formula
 * builder so the inferred range round-trips cleanly through Univer's formula
 * engine.
 */
export function toA1(row: number, col: number): string {
  let n = col;
  let letters = "";
  while (true) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    const next = Math.floor(n / 26) - 1;
    if (next < 0) break;
    n = next;
  }
  return `${letters}${row + 1}`;
}

/**
 * Build the `=SUM(A1:A5)` string for an inferred range. Single-cell range
 * collapses to `=SUM(A1)` (rare but harmless — Univer handles it).
 */
export function buildSumFormula(range: AutoSumRange): string {
  const start = toA1(range.startRow, range.startCol);
  const end = toA1(range.endRow, range.endCol);
  if (start === end) return `=SUM(${start})`;
  return `=SUM(${start}:${end})`;
}

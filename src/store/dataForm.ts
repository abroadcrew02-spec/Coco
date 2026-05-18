// Pure helpers for Excel's legacy "Data → Form" row-by-row editor.
//
// A Data Form is opened over a rectangular range (`r1..r2`, `c1..c2`,
// inclusive, 0-based). When `hasHeader` is true the first row of the range
// provides column labels; otherwise we synthesise "Column N" labels so the
// dialog always has something to render.
//
// All helpers below operate on Univer's snapshot `cellData` shape and stay
// side-effect free so they can be unit-tested without Univer:
//
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: { [row]: { [col]: { v?: unknown, s?: unknown } } }
//       }
//     }
//   }
//
// A `DataFormRow` is keyed by the absolute 0-based column index (as a string,
// matching the snapshot key shape) so callers don't need to remember whether
// the index is range-relative or absolute. Values are whatever the cell `v`
// held; the dialog renders them through `String(...)` and writes back as
// strings (with empty-string coerced to "clear cell").
//
// Snapshot-cell shape:
//   { v?: unknown; s?: unknown; f?: unknown; ... }
// We preserve `s` (style) on round-trip and only rewrite `v`. Pure-formula
// cells (`.f` present) are skipped on writeRow so the Form doesn't clobber
// formulas the user authored elsewhere.

export interface DataFormRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface DataFormParams {
  range: DataFormRange;
  hasHeader: boolean;
}

/** Keyed by absolute 0-based column index (string). Values are the raw cell
 *  `v` (whatever type Univer happened to store). */
export type DataFormRow = Record<string, unknown>;

/** Shape of one snapshot cell we care about. Everything is optional so
 *  callers can hand us partial cells without a cast. */
interface SnapshotCell {
  v?: unknown;
  s?: unknown;
  f?: unknown;
  [k: string]: unknown;
}

/** Snapshot `cellData` shape: { [row]: { [col]: SnapshotCell | undefined } }. */
export type SnapshotCellData = Record<
  string,
  Record<string, SnapshotCell | undefined> | undefined
>;

/** Number of editable data rows in the range, excluding the header row when
 *  `hasHeader` is true. Always ≥ 0. */
export function getDataRowCount(range: DataFormRange, hasHeader: boolean): number {
  const total = Math.max(0, range.r2 - range.r1 + 1);
  return hasHeader ? Math.max(0, total - 1) : total;
}

/** Convert a range-relative data row index (0 = first non-header row) to its
 *  absolute snapshot row number. */
function dataRowToAbs(range: DataFormRange, hasHeader: boolean, rowIdxInRange: number): number {
  const base = hasHeader ? range.r1 + 1 : range.r1;
  return base + rowIdxInRange;
}

/**
 * Read every column's `v` from one data row of the range. Missing cells map
 * to `undefined`. The returned object always has an entry for every column
 * in the range so the caller can render a labelled input per column without
 * undefined-key gymnastics.
 */
export function readRow(
  cellData: SnapshotCellData | undefined,
  range: DataFormRange,
  rowIdxInRange: number,
  hasHeader: boolean = true,
): DataFormRow {
  const absRow = dataRowToAbs(range, hasHeader, rowIdxInRange);
  const out: DataFormRow = {};
  const rowObj = cellData?.[String(absRow)];
  for (let c = range.c1; c <= range.c2; c++) {
    const cell = rowObj?.[String(c)];
    out[String(c)] = cell?.v;
  }
  return out;
}

/**
 * Write a row back into snapshot `cellData`. Returns a freshly-cloned
 * `newCellData` so callers can swap it in without worrying about shared
 * references with the original snapshot.
 *
 * Behaviour:
 *  - Cells whose new value is `""`, `null`, or `undefined` are cleared
 *    (deleted from the row object) — matches Excel's "blank the field to
 *    delete the value" affordance.
 *  - Cells with a formula (`.f` present) are skipped — the Form is for
 *    literal data entry, not formula authoring.
 *  - Style (`.s`) is preserved on round-trip.
 *  - Columns outside the range are left untouched, even on the same row.
 */
export function writeRow(
  sheetCellData: SnapshotCellData | undefined,
  range: DataFormRange,
  rowIdxInRange: number,
  row: DataFormRow,
  hasHeader: boolean = true,
): { newCellData: SnapshotCellData } {
  const absRow = dataRowToAbs(range, hasHeader, rowIdxInRange);
  const newCellData: SnapshotCellData = { ...(sheetCellData ?? {}) };
  const srcRow = newCellData[String(absRow)] ?? {};
  const newRow: Record<string, SnapshotCell | undefined> = { ...srcRow };

  for (let c = range.c1; c <= range.c2; c++) {
    const key = String(c);
    const existing: SnapshotCell = newRow[key] ?? {};
    // Don't trample a formula cell — the Form is for literal values only.
    if (existing.f !== undefined && existing.f !== null && existing.f !== "") continue;

    const v = row[key];
    const isBlank = v === undefined || v === null || (typeof v === "string" && v === "");
    if (isBlank) {
      // Clear the value but keep style: setting v to undefined deletes the
      // value layer while leaving formatting intact. If there's nothing left
      // worth keeping, drop the cell entirely.
      if (existing.s !== undefined && existing.s !== null) {
        const next: SnapshotCell = { ...existing };
        delete next.v;
        newRow[key] = next;
      } else {
        delete newRow[key];
      }
    } else {
      newRow[key] = { ...existing, v };
    }
  }

  newCellData[String(absRow)] = newRow;
  return { newCellData };
}

/**
 * Append a blank data row by extending the range's last row by 1 and
 * returning the (cellData, newRowIdx) pair. The returned `newRowIdx` is the
 * range-relative index of the just-added row, suitable for handing to
 * `writeRow` / `readRow`.
 *
 * NOTE: the caller is responsible for also extending `range.r2` in whatever
 * state holds the active Form params — pure helpers don't mutate inputs.
 */
export function appendBlankRow(
  sheetCellData: SnapshotCellData | undefined,
  range: DataFormRange,
  hasHeader: boolean = true,
): { newCellData: SnapshotCellData; newRowIdx: number } {
  const existingCount = getDataRowCount(range, hasHeader);
  // Extending the range by one row means the new row sits at index
  // existingCount (0-based). Its absolute row is r2 + 1 in the *new* range.
  const newRowIdx = existingCount;
  const absRow = dataRowToAbs(range, hasHeader, newRowIdx);
  const newCellData: SnapshotCellData = { ...(sheetCellData ?? {}) };
  // Materialise an empty row object so subsequent writeRow calls have
  // somewhere to deposit cells. An empty object is harmless for the rest of
  // the snapshot pipeline.
  if (!newCellData[String(absRow)]) {
    newCellData[String(absRow)] = {};
  }
  return { newCellData, newRowIdx };
}

/**
 * Delete a data row, shifting every subsequent row inside the range up by
 * one position to fill the gap. The bottom-most row inside the range gets
 * cleared (within the column window only) so the range's row count
 * effectively shrinks by one when paired with a range adjustment on the
 * caller side.
 *
 * Only columns inside `[range.c1, range.c2]` are touched; cells outside the
 * column window — even on the same row — are left in place to avoid
 * collateral damage when the Form's range is narrower than the sheet.
 */
export function deleteRowAt(
  sheetCellData: SnapshotCellData | undefined,
  range: DataFormRange,
  rowIdxInRange: number,
  hasHeader: boolean = true,
): SnapshotCellData {
  const rowCount = getDataRowCount(range, hasHeader);
  if (rowIdxInRange < 0 || rowIdxInRange >= rowCount) {
    return { ...(sheetCellData ?? {}) };
  }
  const newCellData: SnapshotCellData = { ...(sheetCellData ?? {}) };

  // Shift rows [rowIdxInRange+1 .. rowCount-1] up by one.
  for (let r = rowIdxInRange; r < rowCount - 1; r++) {
    const destAbs = dataRowToAbs(range, hasHeader, r);
    const srcAbs = dataRowToAbs(range, hasHeader, r + 1);
    const destRow: Record<string, SnapshotCell | undefined> = {
      ...(newCellData[String(destAbs)] ?? {}),
    };
    const srcRow = newCellData[String(srcAbs)] ?? {};
    for (let c = range.c1; c <= range.c2; c++) {
      const key = String(c);
      const srcCell = srcRow[key];
      if (srcCell === undefined) {
        delete destRow[key];
      } else {
        destRow[key] = { ...srcCell };
      }
    }
    newCellData[String(destAbs)] = destRow;
  }

  // Clear the now-vacated bottom-most data row inside the column window.
  const lastAbs = dataRowToAbs(range, hasHeader, rowCount - 1);
  const lastRow: Record<string, SnapshotCell | undefined> = {
    ...(newCellData[String(lastAbs)] ?? {}),
  };
  for (let c = range.c1; c <= range.c2; c++) {
    delete lastRow[String(c)];
  }
  // If the row is now empty, drop it entirely so the snapshot stays tidy.
  if (Object.keys(lastRow).length === 0) {
    delete newCellData[String(lastAbs)];
  } else {
    newCellData[String(lastAbs)] = lastRow;
  }

  return newCellData;
}

/**
 * Extract human-readable column labels. When `hasHeader` is true the first
 * row of the range is read; empty / non-string header cells fall back to
 * "Column N" so every column always has a label. When `hasHeader` is false
 * every column gets a synthetic "Column N" label.
 *
 * "N" here is 1-based and counts from the first column of the range, so a
 * range starting at column D produces labels "Column1", "Column2", ...
 * rather than "ColumnD" / "Column4" — matches Excel's Form behaviour.
 */
export function getColumnHeaders(
  cellData: SnapshotCellData | undefined,
  range: DataFormRange,
  hasHeader: boolean,
): string[] {
  const out: string[] = [];
  const headerRow = hasHeader ? cellData?.[String(range.r1)] : undefined;
  for (let i = 0; i < Math.max(1, range.c2 - range.c1 + 1); i++) {
    const col = range.c1 + i;
    let label = `Column${i + 1}`;
    if (headerRow) {
      const cell = headerRow[String(col)];
      const v = cell?.v;
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        label = String(v).trim();
      }
    }
    out.push(label);
  }
  return out;
}

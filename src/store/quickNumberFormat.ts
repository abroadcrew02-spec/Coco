// Pure helper for quick-format toolbar buttons (通貨 / %). Writes a number
// format code onto every cell in the given inclusive range via the snapshot's
// per-cell `_fmt` field — same path NumberFormatDialog/applyNumberFormat
// uses, so the round-trip through xlsx_io.rs stays clean.
//
// Kept side-effect free + framework-free so tests don't need Univer.

interface QuickFmtSnapshot {
  sheets?: Record<
    string,
    {
      cellData?: Record<
        string,
        Record<string, Record<string, unknown> | undefined> | undefined
      > | undefined;
    } | undefined
  >;
}

/** #98: hard cap on how many cells a single quick-format invocation can
 *  touch. Whole-column / whole-row selections (1M rows or 16K cols) would
 *  otherwise generate cellData entries for every empty cell, blow up the
 *  snapshot to 100MB+ and freeze the UI. Past this cap we restrict writes
 *  to cells that already exist in cellData — Excel-style "format only
 *  used cells" behaviour. */
const QUICK_FMT_MAX_NEW_CELLS = 100_000;

/**
 * Apply `fmtCode` to every cell in the inclusive rectangle. Returns a new
 * snapshot JSON string. No-ops (returns input) when the snapshot is malformed,
 * the sheet is missing, or the range is degenerate.
 *
 * Empty fmtCode deletes the `_fmt` key (mirrors applyNumberFormat's "General"
 * branch). Cells outside cellData are created so the format sticks to blank
 * cells too — Excel does the same. #98: when the range is bigger than
 * QUICK_FMT_MAX_NEW_CELLS we only touch cells that already exist.
 */
export function applyQuickNumberFormat(
  snapshotJson: string,
  sheetId: string,
  range: { startRow: number; endRow: number; startCol: number; endCol: number },
  fmtCode: string,
): string {
  if (range.startRow > range.endRow || range.startCol > range.endCol) return snapshotJson;
  let parsed: QuickFmtSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as QuickFmtSnapshot;
  } catch {
    return snapshotJson;
  }
  if (!parsed || typeof parsed !== "object") return snapshotJson;
  const sheet = parsed.sheets?.[sheetId];
  if (!sheet) return snapshotJson;
  if (!sheet.cellData) sheet.cellData = {};
  const cellData = sheet.cellData;
  const code = fmtCode.trim();
  const rangeCellCount =
    (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  const usedRangeOnly = rangeCellCount > QUICK_FMT_MAX_NEW_CELLS;

  for (let r = range.startRow; r <= range.endRow; r++) {
    const rowKey = String(r);
    const rowExists = cellData[rowKey] !== undefined;
    if (usedRangeOnly && !rowExists) continue;
    if (!cellData[rowKey]) cellData[rowKey] = {};
    const row = cellData[rowKey]!;
    for (let c = range.startCol; c <= range.endCol; c++) {
      const colKey = String(c);
      const existing = row[colKey];
      if (usedRangeOnly && existing === undefined) continue;
      if (code) {
        const cell = (existing ?? {}) as Record<string, unknown>;
        cell._fmt = code;
        row[colKey] = cell;
      } else if (existing) {
        delete (existing as Record<string, unknown>)._fmt;
      }
    }
  }
  return JSON.stringify(parsed);
}

/** Format codes for the two preset buttons. Match Excel's defaults. */
export const QUICK_FMT_CURRENCY = "$#,##0.00";
export const QUICK_FMT_PERCENT = "0%";

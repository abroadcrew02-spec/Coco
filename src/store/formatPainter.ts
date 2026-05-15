// Pure helpers for the Format Painter (書式コピー) tool. Kept side-effect free
// so they can be unit-tested without standing up Univer.
//
// Approach: we operate on the Univer 0.5.x workbook snapshot directly because
// FRange has no public `setStyle(IStyleData)` in this build — only granular
// setters (setFontStyle, setBorder, ...) which don't compose cleanly into a
// "copy everything from cell A to cell B" semantic. The snapshot path is the
// same one used by NumberFormatDialog / Sort / data-validation enforcement.
//
// Snapshot shape (Univer 0.5.x):
//   {
//     styles: { [styleId: string]: IStyleData },
//     sheets: {
//       [sheetId: string]: {
//         cellData: { [row: string]: { [col: string]: { s?: string | IStyleData, ... } } }
//       }
//     }
//   }
// Cell.s may be either a string (id into workbook.styles) or an inline
// IStyleData object. We preserve whichever form the source uses.
//
// We don't dedup/intern inline styles into workbook.styles — that's the
// xlsx_io.rs export path's job. Inline `s` round-trips fine through Univer.

/**
 * A copyable style payload. Either a string id (interned in workbook.styles)
 * or an inline IStyleData-shaped object. We use `Record<string, unknown>` for
 * the inline form to avoid coupling to Univer's IStyleData type at the helper
 * boundary (the helpers stay framework-free).
 */
export type CellStyle = string | Record<string, unknown>;

interface FormatPainterSnapshot {
  styles?: Record<string, Record<string, unknown> | undefined>;
  sheets?: Record<
    string,
    {
      cellData?: Record<
        string,
        Record<string, { s?: CellStyle } | undefined> | undefined
      >;
    } | undefined
  >;
}

/**
 * Read the style of a single cell from a snapshot. Returns the style as an
 * inline object even when the source cell uses a style-id reference (we
 * resolve the id through workbook.styles so the caller can apply it to a
 * different cell without worrying about the id mapping).
 *
 * Returns null when:
 *   - snapshot is null/empty or malformed
 *   - the sheet doesn't exist
 *   - the cell has no `s` field (no style at all)
 *   - the cell uses a style id that isn't present in workbook.styles
 */
export function extractCellStyle(
  snapshotJson: string | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): Record<string, unknown> | null {
  if (!snapshotJson) return null;
  let parsed: FormatPainterSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as FormatPainterSnapshot;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const cell = parsed.sheets?.[sheetId]?.cellData?.[String(row)]?.[String(col)];
  if (!cell || typeof cell !== "object") return null;
  const s = cell.s;
  if (s === undefined || s === null) return null;
  if (typeof s === "string") {
    const resolved = parsed.styles?.[s];
    if (!resolved || typeof resolved !== "object") return null;
    // Return a shallow clone so callers can mutate without affecting the
    // workbook's interned style table.
    return { ...resolved };
  }
  if (typeof s === "object") {
    return { ...(s as Record<string, unknown>) };
  }
  return null;
}

/**
 * Apply a style object to every cell in the given inclusive rectangle. Returns
 * a *new* snapshot JSON string (we re-parse + re-stringify so the caller's
 * input is left untouched — matches the pattern used by the rest of Coco's
 * snapshot helpers).
 *
 * Creates missing cells: applying formatting to a blank cell is legitimate
 * (Excel keeps style on empty cells too). The style is stored inline on each
 * cell's `s` field; we never write into workbook.styles.
 *
 * No-ops (returns the original snapshot string unchanged) when:
 *   - snapshot is malformed
 *   - sheet doesn't exist
 *   - style is null or empty object
 *   - range is degenerate (startRow > endRow or startCol > endCol)
 */
export function applyCellStyle(
  snapshotJson: string,
  sheetId: string,
  range: { startRow: number; endRow: number; startCol: number; endCol: number },
  style: Record<string, unknown> | null,
): string {
  if (!style || Object.keys(style).length === 0) return snapshotJson;
  if (range.startRow > range.endRow || range.startCol > range.endCol) return snapshotJson;
  let parsed: FormatPainterSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as FormatPainterSnapshot;
  } catch {
    return snapshotJson;
  }
  if (!parsed || typeof parsed !== "object") return snapshotJson;
  const sheet = parsed.sheets?.[sheetId];
  if (!sheet) return snapshotJson;
  if (!sheet.cellData) sheet.cellData = {};
  const cellData = sheet.cellData;
  // #98: same UI-freeze cap as quickNumberFormat. Whole-column / whole-row
  // selections (1M rows) would otherwise generate cellData entries for
  // every empty cell. Past the cap we only paint cells that already exist.
  const FORMAT_PAINTER_MAX_NEW_CELLS = 100_000;
  const rangeCellCount =
    (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  const usedRangeOnly = rangeCellCount > FORMAT_PAINTER_MAX_NEW_CELLS;
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
      const cell = existing ?? {};
      // Shallow clone the style so the caller can apply the same style payload
      // to multiple targets without aliasing.
      cell.s = { ...style };
      row[colKey] = cell;
    }
  }
  return JSON.stringify(parsed);
}

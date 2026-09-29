// Shared planning + execution helpers for every "apply a number format" entry
// point in Nicel: the Number Format dialog, the quick-format toolbar buttons,
// the Cell Styles gallery's Comma / Currency / Percent presets, the ribbon's
// comma / decimal buttons and the Number Format Manager.
//
// Where a number format lives (Univer 0.24 + @univerjs/sheets-numfmt 0.24):
//   - Univer renders a cell's format from its style: `cell.s` is a style id
//     into the workbook `styles` table, and that style's `n.pattern` is the
//     format code. The numfmt interceptor (sheets-numfmt
//     SheetsNumfmtCellContentController) reads nothing else.
//   - Nicel's xlsx importer additionally writes a per-cell `_fmt` string
//     (xlsx_io.rs `data_to_cell`). Nothing here writes or clears it.
//
// Why the formats are applied through Univer rather than the store snapshot:
// the store (`useWorkbookStore.updateSnapshot`) never pushes cell changes back
// into Univer, and the Univer -> store sync replaces the store with
// `FWorkbook.save()` output, so a format written only into the store is not
// painted and is lost on the next sync. Applying through
// `FRange.setNumberFormat` / `setNumberFormats` (or `SetNumfmtCommand` for a
// sparse cell list — the same command the facade wraps) repaints the grid
// immediately, lands on Univer's undo stack, survives `save()`, and lets
// Univer intern the resulting style under a new id, so other cells sharing
// the previous style id keep their own formatting.
//
// A cell keeps its imported `_fmt` after an apply. Export still matches the
// grid because Rust 側 xlsx_io.rs が style の n.pattern を優先する; `_fmt` is
// only read for a cell with no resolvable style id (see resolveCellNumberFormat).
//
// Everything in this file is framework-free: Univer is reached only through
// the small interfaces below, so tests can drive it with plain mocks.

/** Hard cap on how many cells a single apply may cover as a dense rectangle.
 *  Whole-column / whole-row selections (1M rows or 16K columns) would
 *  otherwise create a styled cell for every empty position and freeze the
 *  UI. Past this cap only cells that already exist are formatted
 *  ("format only used cells", as in #98). */
export const NUMBER_FORMAT_MAX_CELLS = 100_000;

/** Inclusive cell rectangle (0-based rows / columns). */
export interface CellRect {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface CellPos {
  row: number;
  col: number;
}

/** One cell's target format. An empty `pattern` removes the format. */
export interface NumberFormatWrite extends CellPos {
  pattern: string;
}

/** A sheet's `cellData` in snapshot shape (`{ [row]: { [col]: cell } }`). The
 *  live `Worksheet.getCellMatrix().getMatrix()` has the same shape. */
export type SheetCellData = Record<
  string,
  Record<string, unknown> | undefined
>;

/** Resolves a style id to its style object. */
export type StyleLookup = (id: string) => unknown;

/** A unit of work for the numfmt facade / command. */
export type NumberFormatJob =
  /** One pattern over a dense rectangle — `FRange.setNumberFormat`. */
  | { kind: "uniform"; sheetId: string; rect: CellRect; pattern: string }
  /** Per-cell patterns over a dense rectangle — `FRange.setNumberFormats`.
   *  `patterns[i][j]` is the pattern for (startRow + i, startCol + j). */
  | { kind: "grid"; sheetId: string; rect: CellRect; patterns: string[][] }
  /** A sparse list of cells — `SetNumfmtCommand`. */
  | { kind: "cells"; sheetId: string; writes: NumberFormatWrite[] };

// --- Reading formats ---------------------------------------------------------

/** Normalise a user-supplied format code. Surrounding whitespace is dropped,
 *  and Excel's "General" is treated as "no format" (empty string) so it
 *  removes the pattern instead of storing a literal "General". */
export function normalizeNumberFormatCode(code: string): string {
  const trimmed = code.trim();
  return /^general$/i.test(trimmed) ? "" : trimmed;
}

function patternOfStyle(style: unknown): string {
  if (!style || typeof style !== "object") return "";
  const n = (style as { n?: unknown }).n;
  if (!n || typeof n !== "object") return "";
  const pattern = (n as { pattern?: unknown }).pattern;
  return typeof pattern === "string" ? pattern : "";
}

/** Builds a StyleLookup over a snapshot's `styles` table. */
export function styleLookupFromTable(
  styles: Record<string, unknown> | null | undefined,
): StyleLookup {
  return (id) => (styles && typeof styles === "object" ? styles[id] : undefined);
}

/**
 * The number format a cell currently has, as the grid renders it. When the
 * cell's `s` is a style id that resolves, that style decides — including "no
 * format": after "標準" the numfmt command leaves the cell on a style without
 * `n` while an imported `_fmt` stays behind, and that stale `_fmt` must not
 * count. Otherwise an inline style's pattern, then the `_fmt` sidecar (cells
 * never touched by the numfmt command: CSV import, templates, smart-date
 * conversion, older Nicel builds). Returns "" when the cell has no format.
 */
export function resolveCellNumberFormat(cell: unknown, lookup: StyleLookup): string {
  if (!cell || typeof cell !== "object") return "";
  const s = (cell as { s?: unknown }).s;
  if (typeof s === "string") {
    const style = lookup(s);
    if (style && typeof style === "object") return patternOfStyle(style);
  } else {
    const inline = patternOfStyle(s);
    if (inline.trim() !== "") return inline;
  }
  const fmt = (cell as { _fmt?: unknown })._fmt;
  return typeof fmt === "string" && fmt.trim() !== "" ? fmt : "";
}

// --- Planning ----------------------------------------------------------------

/** Swap reversed corners; null for a rectangle with a negative corner. */
export function normalizeRect(rect: CellRect): CellRect | null {
  const startRow = Math.min(rect.startRow, rect.endRow);
  const endRow = Math.max(rect.startRow, rect.endRow);
  const startCol = Math.min(rect.startCol, rect.endCol);
  const endCol = Math.max(rect.startCol, rect.endCol);
  if (startRow < 0 || startCol < 0) return null;
  if (![startRow, endRow, startCol, endCol].every(Number.isInteger)) return null;
  return { startRow, endRow, startCol, endCol };
}

export function rectCellCount(rect: CellRect): number {
  return (rect.endRow - rect.startRow + 1) * (rect.endCol - rect.startCol + 1);
}

/** Cells that already exist in `cellData` inside `rect`, row-major. Walks the
 *  populated keys only, so a whole-column rectangle stays cheap. */
export function existingCellsInRect(
  cellData: SheetCellData | null | undefined,
  rect: CellRect,
): CellPos[] {
  const out: CellPos[] = [];
  if (!cellData || typeof cellData !== "object") return out;
  const rowKeys = Object.keys(cellData)
    .map(Number)
    .filter((r) => Number.isInteger(r) && r >= rect.startRow && r <= rect.endRow)
    .sort((a, b) => a - b);
  for (const row of rowKeys) {
    const cols = cellData[String(row)];
    if (!cols || typeof cols !== "object") continue;
    const colKeys = Object.keys(cols)
      .map(Number)
      .filter((c) => Number.isInteger(c) && c >= rect.startCol && c <= rect.endCol)
      .sort((a, b) => a - b);
    for (const col of colKeys) {
      const cell = cols[String(col)];
      if (cell && typeof cell === "object") out.push({ row, col });
    }
  }
  return out;
}

/**
 * Plan "apply `code` to every cell in `rect`". Up to NUMBER_FORMAT_MAX_CELLS
 * cells this is one dense `setNumberFormat` (blank cells get the format too,
 * as in Excel). Past the cap only the cells already present in `cellData`
 * are targeted. Returns null when there is nothing to do.
 */
export function planUniformNumberFormat(
  sheetId: string,
  rect: CellRect,
  code: string,
  cellData?: SheetCellData | null,
): NumberFormatJob | null {
  const r = normalizeRect(rect);
  if (!r) return null;
  const pattern = normalizeNumberFormatCode(code);
  if (rectCellCount(r) <= NUMBER_FORMAT_MAX_CELLS) {
    return { kind: "uniform", sheetId, rect: r, pattern };
  }
  const writes = existingCellsInRect(cellData, r).map((p) => ({ ...p, pattern }));
  return writes.length > 0 ? { kind: "cells", sheetId, writes } : null;
}

/**
 * Plan a per-cell transformation of the current format (the ribbon's comma /
 * increase-decimal / decrease-decimal buttons): each target cell gets
 * `step(currentFormat)`. Same cap rule as planUniformNumberFormat.
 */
export function planSteppedNumberFormat(
  sheetId: string,
  rect: CellRect,
  step: (prev: string) => string,
  cellData: SheetCellData | null | undefined,
  lookup: StyleLookup,
): NumberFormatJob | null {
  const r = normalizeRect(rect);
  if (!r) return null;
  const cellAt = (row: number, col: number): unknown =>
    cellData?.[String(row)]?.[String(col)];
  const nextFor = (row: number, col: number): string =>
    normalizeNumberFormatCode(step(resolveCellNumberFormat(cellAt(row, col), lookup)));

  if (rectCellCount(r) <= NUMBER_FORMAT_MAX_CELLS) {
    const patterns: string[][] = [];
    for (let row = r.startRow; row <= r.endRow; row++) {
      const line: string[] = [];
      for (let col = r.startCol; col <= r.endCol; col++) line.push(nextFor(row, col));
      patterns.push(line);
    }
    return { kind: "grid", sheetId, rect: r, patterns };
  }
  const writes = existingCellsInRect(cellData, r).map((p) => ({
    ...p,
    pattern: nextFor(p.row, p.col),
  }));
  return writes.length > 0 ? { kind: "cells", sheetId, writes } : null;
}

// --- Execution ---------------------------------------------------------------

/** The slice of `FRange` (with the sheets-numfmt facade mixin) used here. */
export interface NumfmtRange {
  setNumberFormat(pattern: string): unknown;
  setNumberFormats(patterns: string[][]): unknown;
}

/** The slice of `FWorksheet` used here. */
export interface NumfmtSheet {
  getRange(row: number, column: number, numRows: number, numColumns: number): NumfmtRange;
}

/** Read-only access to the live (not cloned) cells of one sheet, for reading
 *  a cell's current format without a `save()` round-trip. */
export interface LiveCellAccess {
  getCellRaw(row: number, col: number): unknown;
  lookupStyle: StyleLookup;
}

export interface NumberFormatDeps {
  /** Facade worksheet for dense jobs. */
  getSheet(sheetId: string): NumfmtSheet | null | undefined;
  /** Runs `SetNumfmtCommand` for a sparse job; returns the command result. */
  setCells(sheetId: string, writes: NumberFormatWrite[]): boolean;
}

/**
 * Run one job through Univer. Returns false when the sheet is missing or the
 * sparse command reports failure. A dense job returns true once the facade
 * call is made: the facade returns the range, not the command result.
 * Throws whatever the facade / command throws; callers surface the error.
 */
export function runNumberFormatJob(job: NumberFormatJob, deps: NumberFormatDeps): boolean {
  if (job.kind === "cells") {
    if (job.writes.length === 0) return false;
    return deps.setCells(job.sheetId, job.writes);
  }
  const sheet = deps.getSheet(job.sheetId);
  if (!sheet) return false;
  const { startRow, endRow, startCol, endCol } = job.rect;
  const range = sheet.getRange(
    startRow,
    startCol,
    endRow - startRow + 1,
    endCol - startCol + 1,
  );
  if (job.kind === "uniform") range.setNumberFormat(job.pattern);
  else range.setNumberFormats(job.patterns);
  return true;
}

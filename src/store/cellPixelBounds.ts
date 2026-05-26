// #236 In-grid chart — pure pixel-bounds helper.
//
// Univer 0.24's facade doesn't expose stable per-cell pixel coordinates
// (the WorkbookViewService methods are internal). For in-grid overlays
// (chart canvas, camera link, sparkline preview) we approximate the
// bounds from the snapshot's column-width / row-height data:
//
//   - Default column width: matches Univer's `DEFAULT_COL_WIDTH` constant
//     (73 px ≈ 8.43 chars in Calibri 11 — Excel-compatible default).
//   - Default row height: matches Univer's `DEFAULT_ROW_HEIGHT` (19 px ≈
//     15 pt). Affected by `defaultRowHeight` on the sheet when present.
//   - Per-column override: `columnData[c].w` (Excel char width × 7.5 px in
//     Calibri 11 — Univer stores this as already-converted px).
//   - Per-row override: `rowData[r].h` (px).
//   - Hidden rows / columns (`hd === 1`) contribute 0 px so they don't
//     occupy space.
//
// Header offsets (row header strip on the left, column header strip on
// top) are caller-supplied as `headerOffsetLeft` / `headerOffsetTop` so
// the helper stays Univer-version-agnostic. Default 46 / 20 mirrors
// Univer 0.24's stock theme.
//
// Pure / framework-free so the chart overlay can call it on a parsed
// snapshot without touching Univer.

const DEFAULT_COL_WIDTH_PX = 73;
const DEFAULT_ROW_HEIGHT_PX = 19;
const DEFAULT_HEADER_LEFT = 46;
const DEFAULT_HEADER_TOP = 20;

export interface PixelBounds {
  /** Distance from sheet origin (sheet top-left, includes header offsets). */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CellPixelOptions {
  /** Sheet-level default row height override (defaults to 19 px). */
  defaultRowHeight?: number;
  /** Sheet-level default column width override (defaults to 73 px). */
  defaultColWidth?: number;
  /** Row-header strip width in px. Defaults to Univer 0.24's 46. */
  headerOffsetLeft?: number;
  /** Column-header strip height in px. Defaults to Univer 0.24's 20. */
  headerOffsetTop?: number;
}

type RowMeta = { h?: number; hd?: 0 | 1 } | undefined;
type ColMeta = { w?: number; hd?: 0 | 1 } | undefined;

export interface SheetPixelLayout {
  rowData?: Record<string, RowMeta>;
  columnData?: Record<string, ColMeta>;
  defaultRowHeight?: number;
  defaultColumnWidth?: number;
}

function rowHeight(layout: SheetPixelLayout, row: number, defaultRow: number): number {
  const r = layout.rowData?.[String(row)];
  if (r?.hd === 1) return 0;
  if (typeof r?.h === "number" && Number.isFinite(r.h) && r.h >= 0) return r.h;
  return defaultRow;
}

function colWidth(layout: SheetPixelLayout, col: number, defaultCol: number): number {
  const c = layout.columnData?.[String(col)];
  if (c?.hd === 1) return 0;
  if (typeof c?.w === "number" && Number.isFinite(c.w) && c.w >= 0) return c.w;
  return defaultCol;
}

/**
 * Pixel bounds for a single cell. Walks rows 0..row-1 and cols 0..col-1
 * accumulating the offset, then adds the cell's own width / height.
 *
 * O(row + col). For ranges spanning hundreds of cells this is fast enough
 * — chart anchors are typically in the first 100 rows.
 */
export function cellBoundsPx(
  layout: SheetPixelLayout,
  row: number,
  col: number,
  opts: CellPixelOptions = {},
): PixelBounds {
  const defaultRow =
    opts.defaultRowHeight ?? layout.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_PX;
  const defaultCol =
    opts.defaultColWidth ?? layout.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX;
  const headerLeft = opts.headerOffsetLeft ?? DEFAULT_HEADER_LEFT;
  const headerTop = opts.headerOffsetTop ?? DEFAULT_HEADER_TOP;

  let left = headerLeft;
  for (let c = 0; c < col; c++) {
    left += colWidth(layout, c, defaultCol);
  }
  let top = headerTop;
  for (let r = 0; r < row; r++) {
    top += rowHeight(layout, r, defaultRow);
  }
  return {
    left,
    top,
    width: colWidth(layout, col, defaultCol),
    height: rowHeight(layout, row, defaultRow),
  };
}

/**
 * Pixel bounds for an inclusive range (r1,c1)..(r2,c2). Equivalent to
 * `cellBoundsPx` for the single-cell case; for multi-cell the bounds
 * span every covered cell.
 *
 * Returns a 0-size bound when the range is degenerate (r2 < r1 etc.) so
 * callers can treat it like "no chart to anchor".
 */
export function rangeBoundsPx(
  layout: SheetPixelLayout,
  range: { r1: number; c1: number; r2: number; c2: number },
  opts: CellPixelOptions = {},
): PixelBounds {
  const r1 = Math.min(range.r1, range.r2);
  const r2 = Math.max(range.r1, range.r2);
  const c1 = Math.min(range.c1, range.c2);
  const c2 = Math.max(range.c1, range.c2);
  if (r1 < 0 || c1 < 0) return { left: 0, top: 0, width: 0, height: 0 };

  const start = cellBoundsPx(layout, r1, c1, opts);
  // Width: sum widths c1..c2; height: sum heights r1..r2.
  const defaultRow =
    opts.defaultRowHeight ?? layout.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_PX;
  const defaultCol =
    opts.defaultColWidth ?? layout.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX;
  let width = 0;
  for (let c = c1; c <= c2; c++) width += colWidth(layout, c, defaultCol);
  let height = 0;
  for (let r = r1; r <= r2; r++) height += rowHeight(layout, r, defaultRow);
  return {
    left: start.left,
    top: start.top,
    width,
    height,
  };
}

/**
 * Inverse of `cellBoundsPx`: given an (x, y) pixel coordinate (relative to the
 * sheet origin, i.e. including header offsets), returns the 0-based (row, col)
 * of the cell that contains that point.
 *
 * Clamps to (0, 0) when the point is inside the header strip. Returns the last
 * visible cell when the point exceeds the sheet extent (maxRow / maxCol).
 */
export function pixelToCell(
  layout: SheetPixelLayout,
  x: number,
  y: number,
  opts: CellPixelOptions = {},
  maxRow = 200,
  maxCol = 100,
): { row: number; col: number } {
  const defaultRow =
    opts.defaultRowHeight ?? layout.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_PX;
  const defaultCol =
    opts.defaultColWidth ?? layout.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX;
  const headerLeft = opts.headerOffsetLeft ?? DEFAULT_HEADER_LEFT;
  const headerTop = opts.headerOffsetTop ?? DEFAULT_HEADER_TOP;

  // Walk columns until accumulated width exceeds x.
  let accX = headerLeft;
  let col = 0;
  for (let c = 0; c < maxCol; c++) {
    const w = colWidth(layout, c, defaultCol);
    if (accX + w > x) {
      col = c;
      break;
    }
    accX += w;
    col = c + 1;
  }

  // Walk rows until accumulated height exceeds y.
  let accY = headerTop;
  let row = 0;
  for (let r = 0; r < maxRow; r++) {
    const h = rowHeight(layout, r, defaultRow);
    if (accY + h > y) {
      row = r;
      break;
    }
    accY += h;
    row = r + 1;
  }

  return {
    row: Math.max(0, Math.min(row, maxRow - 1)),
    col: Math.max(0, Math.min(col, maxCol - 1)),
  };
}

/**
 * "Where should a chart anchored to this source range be placed by default?"
 *
 * Excel and Google Sheets both anchor a new chart in the empty space to the
 * RIGHT of the source range (or below, when the range hugs the right edge
 * of the visible columns). We do the simpler "right-of" placement for the
 * MVP — the user can drag the chart afterward.
 *
 * Returns the pixel position immediately to the right of the source range
 * (one default-column-width gap), with chart dimensions defaulting to
 * (480 × 300) — same as Excel's default new-chart size.
 */
export function defaultChartAnchorPx(
  layout: SheetPixelLayout,
  sourceRange: { r1: number; c1: number; r2: number; c2: number },
  opts: CellPixelOptions = {},
): PixelBounds {
  const src = rangeBoundsPx(layout, sourceRange, opts);
  const gap =
    opts.defaultColWidth ?? layout.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX;
  return {
    left: src.left + src.width + gap,
    top: src.top,
    width: 480,
    height: 300,
  };
}

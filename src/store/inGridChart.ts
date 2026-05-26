// #236 Step 2 — in-grid chart anchor + box resolution.
//
// Step 1 (PR #263, cellPixelBounds) gives pure cell → pixel conversion.
// Step 2 connects that to ChartEntry: when an entry carries position
// metadata (anchorRow / anchorCol / widthPx / heightPx), the overlay
// component knows where to draw the canvas. Entries WITHOUT position
// metadata fall through to the existing sidebar-only rendering — no
// breaking change.
//
// Pure / framework-free. The downstream canvas overlay component (Step 3+)
// calls `resolveChartBox` to determine where to position its <canvas> and
// `defaultChartAnchorPx` (from cellPixelBounds) when an entry was authored
// before in-grid placement existed (auto-place right of source range).

import {
  cellBoundsPx,
  defaultChartAnchorPx,
  pixelToCell,
  type CellPixelOptions,
  type PixelBounds,
  type SheetPixelLayout,
} from "./cellPixelBounds";
import { parseRange } from "../components/chartPreviewData";

// ---------------------------------------------------------------------------
// Minimum chart dimensions (pixels). Used by resize logic and drag preview.
// ---------------------------------------------------------------------------
export const CHART_MIN_WIDTH_PX = 60;
export const CHART_MIN_HEIGHT_PX = 40;

/** Optional in-grid placement metadata attached to a ChartEntry. */
export interface InGridChartAnchor {
  /** 0-based row of the top-left cell the chart anchors to. */
  anchorRow?: number;
  /** 0-based col of the top-left cell the chart anchors to. */
  anchorCol?: number;
  /** Width in CSS pixels. */
  widthPx?: number;
  /** Height in CSS pixels. */
  heightPx?: number;
}

/**
 * Subset of ChartEntry fields needed to resolve the on-canvas box. We don't
 * import ChartEntry directly so callers from new code paths (e.g. paste-
 * chart, recommendedCharts) can plug in without conforming to the full
 * legacy shape.
 */
export interface BoxableEntry extends InGridChartAnchor {
  /** Excel-style A1 range used as the chart's source data (and the fallback
   *  anchor location when explicit anchor* fields are absent). */
  range?: string;
}

/**
 * Returns the pixel bounds of where the chart should render in-grid, OR null
 * when no in-grid placement is possible (no anchor + no source range).
 *
 * Resolution order:
 *   1. When all 4 anchor* fields are present, use them directly. The pixel
 *      origin is computed from the anchorRow/anchorCol cell's top-left
 *      (via cellBoundsPx) plus the widthPx/heightPx dimensions.
 *   2. Otherwise, fall back to `defaultChartAnchorPx` against the source
 *      range — places the chart to the right of the source data with a
 *      one-column-width gap, 480 × 300 default size (matches Excel).
 *   3. When neither anchor nor range is parseable, returns null.
 *
 * Pure / framework-free.
 */
export function resolveChartBox(
  entry: BoxableEntry,
  layout: SheetPixelLayout,
  opts: CellPixelOptions = {},
): PixelBounds | null {
  const hasFullAnchor =
    typeof entry.anchorRow === "number" &&
    typeof entry.anchorCol === "number" &&
    typeof entry.widthPx === "number" &&
    typeof entry.heightPx === "number" &&
    entry.anchorRow >= 0 &&
    entry.anchorCol >= 0 &&
    entry.widthPx > 0 &&
    entry.heightPx > 0;

  if (hasFullAnchor) {
    const anchorCell = cellBoundsPx(
      layout,
      entry.anchorRow!,
      entry.anchorCol!,
      opts,
    );
    return {
      left: anchorCell.left,
      top: anchorCell.top,
      width: entry.widthPx!,
      height: entry.heightPx!,
    };
  }

  if (typeof entry.range === "string" && entry.range.trim()) {
    const parsed = parseRange(entry.range);
    if (parsed) {
      return defaultChartAnchorPx(
        layout,
        { r1: parsed.r0, c1: parsed.c0, r2: parsed.r1, c2: parsed.c1 },
        opts,
      );
    }
  }

  return null;
}

/**
 * "Bake" the default anchor into the entry — useful when the user just
 * clicked "Insert Chart" and we want to persist the auto-placement so
 * subsequent edits remember it. Returns a new entry; never mutates.
 */
export function bakeDefaultAnchor<T extends BoxableEntry>(
  entry: T,
  layout: SheetPixelLayout,
  opts: CellPixelOptions = {},
): T {
  if (
    typeof entry.anchorRow === "number" &&
    typeof entry.anchorCol === "number"
  ) {
    return entry;
  }
  if (typeof entry.range !== "string" || !entry.range.trim()) return entry;
  const parsed = parseRange(entry.range);
  if (!parsed) return entry;
  const box = defaultChartAnchorPx(
    layout,
    { r1: parsed.r0, c1: parsed.c0, r2: parsed.r1, c2: parsed.c1 },
    opts,
  );
  // The default-anchor box is in pixel space; for persistence we want a
  // cell-relative anchor (anchorRow/anchorCol) + pixel dimensions, so the
  // chart stays put even if column widths change later. Find the nearest
  // anchor cell by walking from the source range's top-right one col right.
  const anchorRow = parsed.r0;
  const anchorCol = parsed.c1 + 1;
  return {
    ...entry,
    anchorRow,
    anchorCol,
    widthPx: box.width,
    heightPx: box.height,
  };
}

/**
 * Move an existing chart entry by a delta (dropped on the user's mouseup).
 * `deltaCol` / `deltaRow` are 0-based cell offsets — useful for snap-to-
 * cell drag interactions. Pixel-precision dragging should adjust the
 * widthPx / heightPx fields instead and call `resolveChartBox` to redraw.
 */
export function moveChartAnchor<T extends BoxableEntry>(
  entry: T,
  deltaRow: number,
  deltaCol: number,
): T {
  const row = (entry.anchorRow ?? 0) + deltaRow;
  const col = (entry.anchorCol ?? 0) + deltaCol;
  return {
    ...entry,
    anchorRow: Math.max(0, row),
    anchorCol: Math.max(0, col),
  };
}

/**
 * Resize an existing chart entry by a pixel delta. Clamps to a minimum
 * Minimum size is CHART_MIN_WIDTH_PX × CHART_MIN_HEIGHT_PX so the chart
 * can't be shrunk to invisibility.
 */
export function resizeChartAnchor<T extends BoxableEntry>(
  entry: T,
  newWidth: number,
  newHeight: number,
): T {
  return {
    ...entry,
    widthPx: Math.max(CHART_MIN_WIDTH_PX, Math.floor(newWidth)),
    heightPx: Math.max(CHART_MIN_HEIGHT_PX, Math.floor(newHeight)),
  };
}

/**
 * Snap the chart's anchor cell from pixel coordinates (the drag-drop position).
 * `pixelX` / `pixelY` are relative to the sheet canvas origin (includes header
 * offsets). The resulting anchorRow/anchorCol become the cell whose top-left
 * is closest to the drop point.
 *
 * Preserves widthPx / heightPx so the chart retains its dimensions.
 */
export function snapAnchorToPixel<T extends BoxableEntry>(
  entry: T,
  pixelX: number,
  pixelY: number,
  layout: SheetPixelLayout,
  opts: CellPixelOptions = {},
): T {
  const { row, col } = pixelToCell(layout, pixelX, pixelY, opts);
  return {
    ...entry,
    anchorRow: row,
    anchorCol: col,
  };
}

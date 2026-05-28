// #312 — in-grid image anchor + box resolution.
//
// Mirrors the inGridChart.ts pattern: pure / framework-free helpers that the
// InGridImageLayer overlay component calls to resolve pixel positions for each
// ImageEntry stored under sheets[id]._images in the workbook snapshot.
//
// Data flow:
//   InsertImageDialog → appends ImageEntry to sheets[id]._images
//   InGridImageLayout  → reads _images, resolves pixel boxes
//   InGridImageLayer   → renders <img> elements at those pixel positions
//
// `_preservedParts` (legacy xlsx round-trip) and `_images` are EXCLUSIVE per
// sheet: InsertImageDialog writes to exactly one of them depending on whether
// the image comes from the new in-grid flow (#312) or the old xlsx-import
// flow. Never write to both for the same sheet.

import {
  cellBoundsPx,
  pixelToCell,
  type CellPixelOptions,
  type PixelBounds,
  type SheetPixelLayout,
} from "./cellPixelBounds";

// ---------------------------------------------------------------------------
// Minimum image dimensions (pixels). Prevents shrinking to invisibility.
// ---------------------------------------------------------------------------
export const IMAGE_MIN_WIDTH_PX = 40;
export const IMAGE_MIN_HEIGHT_PX = 30;

// ---------------------------------------------------------------------------
// ImageEntry — stored as elements of sheets[id]._images in the snapshot.
// ---------------------------------------------------------------------------
export interface ImageEntry {
  /** RFC 4648 base64 of the raw file bytes. */
  base64: string;
  /** Lowercased file extension without the leading dot. */
  ext: "png" | "jpg" | "jpeg" | "gif" | "bmp";
  /** 0-based row of the top-left anchor cell. */
  anchorRow: number;
  /** 0-based column of the top-left anchor cell. */
  anchorCol: number;
  /** Width in CSS pixels. */
  widthPx: number;
  /** Height in CSS pixels. */
  heightPx: number;
  /** Optional display name (basename of the original file). */
  name?: string;
  /** Original xl/media path — diagnostic only; not required for rendering. */
  mediaPath?: string;
  /**
   * Z-order stacking index. Higher values appear in front of lower values.
   * Omitted or 0 means default stacking order.
   */
  zIndex?: number;
  /**
   * Clockwise rotation in degrees. Typically 0 / 90 / 180 / 270 but any
   * value is accepted. Omitted or 0 means no rotation.
   */
  rotationDeg?: number;
}

// ---------------------------------------------------------------------------
// resolveImageBox
// ---------------------------------------------------------------------------

/**
 * Returns the pixel bounds for where an ImageEntry should render in-grid,
 * or null when all required anchor fields are missing or invalid.
 *
 * Unlike charts, images always require all 4 anchor fields — there is no
 * "source range" fallback because images have no associated data range.
 */
export function resolveImageBox(
  entry: ImageEntry,
  layout: SheetPixelLayout,
  opts: CellPixelOptions = {},
): PixelBounds | null {
  if (
    typeof entry.anchorRow !== "number" ||
    !Number.isFinite(entry.anchorRow) ||
    entry.anchorRow < 0 ||
    typeof entry.anchorCol !== "number" ||
    !Number.isFinite(entry.anchorCol) ||
    entry.anchorCol < 0 ||
    typeof entry.widthPx !== "number" ||
    !Number.isFinite(entry.widthPx) ||
    entry.widthPx <= 0 ||
    typeof entry.heightPx !== "number" ||
    !Number.isFinite(entry.heightPx) ||
    entry.heightPx <= 0
  ) {
    return null;
  }

  const anchorCell = cellBoundsPx(layout, entry.anchorRow, entry.anchorCol, opts);
  return {
    left: anchorCell.left,
    top: anchorCell.top,
    width: entry.widthPx,
    height: entry.heightPx,
  };
}

// ---------------------------------------------------------------------------
// moveImageAnchor
// ---------------------------------------------------------------------------

/**
 * Move an image entry by a cell delta. Clamps to (0, 0).
 * Returns a new entry; never mutates.
 */
export function moveImageAnchor(
  entry: ImageEntry,
  deltaRow: number,
  deltaCol: number,
): ImageEntry {
  return {
    ...entry,
    anchorRow: Math.max(0, entry.anchorRow + deltaRow),
    anchorCol: Math.max(0, entry.anchorCol + deltaCol),
  };
}

// ---------------------------------------------------------------------------
// resizeImageAnchor
// ---------------------------------------------------------------------------

/**
 * Resize an image entry, clamping to IMAGE_MIN_WIDTH_PX × IMAGE_MIN_HEIGHT_PX.
 * Returns a new entry; never mutates.
 */
export function resizeImageAnchor(
  entry: ImageEntry,
  newWidth: number,
  newHeight: number,
): ImageEntry {
  return {
    ...entry,
    widthPx: Math.max(IMAGE_MIN_WIDTH_PX, Math.floor(newWidth)),
    heightPx: Math.max(IMAGE_MIN_HEIGHT_PX, Math.floor(newHeight)),
  };
}

// ---------------------------------------------------------------------------
// snapAnchorToPixel
// ---------------------------------------------------------------------------

/**
 * Snap the image's anchor cell from pixel coordinates (the drag-drop position).
 * `pixelX` / `pixelY` are relative to the sheet canvas origin (includes header
 * offsets). Preserves widthPx / heightPx.
 */
export function snapAnchorToPixel(
  entry: ImageEntry,
  pixelX: number,
  pixelY: number,
  layout: SheetPixelLayout,
  opts: CellPixelOptions = {},
): ImageEntry {
  const { row, col } = pixelToCell(layout, pixelX, pixelY, opts);
  return {
    ...entry,
    anchorRow: row,
    anchorCol: col,
  };
}

// ---------------------------------------------------------------------------
// imageDataUrl
// ---------------------------------------------------------------------------

/**
 * Build a `data:<mime>;base64,...` URL from an ImageEntry's base64 + ext.
 * Used by InGridImageLayer to set the <img> src attribute.
 */
export function imageDataUrl(entry: ImageEntry): string {
  const mime = extToMime(entry.ext);
  return `data:${mime};base64,${entry.base64}`;
}

function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

// The single DOM-touching routine for the camera feature (#184): paint a
// `RangeLayout` onto a `<canvas>` and return a PNG data URL.
//
// Kept apart from cameraRender.ts so the layout/style maths can be unit
// -tested without a DOM. happy-dom's canvas is a no-op stub, so the only
// thing tested here is graceful failure when the 2D context is unavailable.

import {
  buildRangeLayout,
  CAMERA_DEFAULT_FONT_SIZE,
  type CellRect,
  type RangeLayout,
} from "./cameraRender";

const GRID_LINE = "#d0d0d0";
const DEFAULT_BG = "#ffffff";
const DEFAULT_FG = "#000000";
const CELL_PAD = 4;

/**
 * Paint a pre-built layout onto a canvas and return a `data:image/png`
 * URL. Returns null when a 2D context can't be acquired (happy-dom, or a
 * browser that refuses the context) or when `toDataURL` throws.
 */
export function paintLayoutToDataUrl(layout: RangeLayout): string | null {
  if (layout.width <= 0 || layout.height <= 0) return null;
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement("canvas");
  } catch {
    return null;
  }
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Backdrop.
  ctx.fillStyle = DEFAULT_BG;
  ctx.fillRect(0, 0, layout.width, layout.height);

  let y = 0;
  for (let r = 0; r < layout.rows; r++) {
    const h = layout.rowHeights[r];
    let x = 0;
    for (let c = 0; c < layout.cols; c++) {
      const w = layout.colWidths[c];
      const cell = layout.cells[r][c];

      // Fill.
      if (cell.bg) {
        ctx.fillStyle = cell.bg;
        ctx.fillRect(x, y, w, h);
      }

      // Text.
      if (cell.text) {
        const size = cell.fontSize ?? CAMERA_DEFAULT_FONT_SIZE;
        const weight = cell.bold ? "bold" : "normal";
        const style = cell.italic ? "italic" : "normal";
        ctx.font = `${style} ${weight} ${size}px sans-serif`;
        ctx.fillStyle = cell.color ?? DEFAULT_FG;
        ctx.textBaseline = "middle";
        let tx = x + CELL_PAD;
        if (cell.align === "center") {
          ctx.textAlign = "center";
          tx = x + w / 2;
        } else if (cell.align === "right") {
          ctx.textAlign = "right";
          tx = x + w - CELL_PAD;
        } else {
          ctx.textAlign = "left";
        }
        // Clip so long text doesn't bleed into neighbouring cells.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.fillText(cell.text, tx, y + h / 2);
        ctx.restore();
      }

      x += w;
    }
    y += h;
  }

  // Grid lines on top.
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = 1;
  let gx = 0;
  for (let c = 0; c <= layout.cols; c++) {
    ctx.beginPath();
    ctx.moveTo(gx + 0.5, 0);
    ctx.lineTo(gx + 0.5, layout.height);
    ctx.stroke();
    if (c < layout.cols) gx += layout.colWidths[c];
  }
  let gy = 0;
  for (let r = 0; r <= layout.rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(layout.width, gy + 0.5);
    ctx.stroke();
    if (r < layout.rows) gy += layout.rowHeights[r];
  }

  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * End-to-end: read a range out of the snapshot, lay it out, and paint it to
 * a PNG data URL. Returns null when the layout can't be built (bad snapshot,
 * missing sheet, oversized range) or the canvas paint fails.
 */
export function renderRangeToDataUrl(
  snapshotJson: string | null | undefined,
  sheetId: string,
  rect: CellRect,
): string | null {
  const layout = buildRangeLayout(snapshotJson, sheetId, rect);
  if (!layout) return null;
  return paintLayoutToDataUrl(layout);
}

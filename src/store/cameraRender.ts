// Pure layout + cell-reading helpers for the "camera" feature (#184): a
// snapshot of a cell range baked into a data-URL image that re-renders when
// the source cells change.
//
// Univer 0.5.x's facade exposes no pixel coordinates for cells and the
// renderer can't be invoked headlessly, so we draw the snapshot ourselves on
// a `<canvas>`: read each cell's value + resolved style out of the workbook
// snapshot, lay them out on a fixed grid, and paint per-cell.
//
// This module is split so the *layout maths* and *style reading* stay pure
// (no DOM, fully unit-testable). The single DOM-touching routine
// (`renderRangeToDataUrl`) lives in cameraCanvas.ts.
//
// Snapshot shape (Univer 0.5.x + Coco):
//   {
//     styles?: { [id]: IStyleData },
//     sheets: {
//       [sheetId]: {
//         name?: string,
//         cellData?: { [row]: { [col]: { v?, s?: object|string, _fmt? } } },
//       }
//     }
//   }

/** Inclusive 0-based cell rectangle. */
export interface CellRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** A single cell resolved out of the snapshot, ready to paint. */
export interface ResolvedCell {
  /** Display text (already stringified; "" when blank). */
  text: string;
  /** Background fill `#rrggbb`, or null for transparent. */
  bg: string | null;
  /** Font color `#rrggbb` (defaults to black at paint time when null). */
  color: string | null;
  bold: boolean;
  italic: boolean;
  /** Font size in pt (null => caller default). */
  fontSize: number | null;
  /** Horizontal alignment. */
  align: "left" | "center" | "right";
}

/** A laid-out snapshot ready for the canvas painter. */
export interface RangeLayout {
  /** Total canvas width in px. */
  width: number;
  /** Total canvas height in px. */
  height: number;
  /** Number of grid columns / rows. */
  cols: number;
  rows: number;
  /** Per-column widths / per-row heights, in px. */
  colWidths: number[];
  rowHeights: number[];
  /** Resolved cells, row-major: cells[r][c]. */
  cells: ResolvedCell[][];
}

/** Layout constants — fixed cell metrics keep the snapshot deterministic. */
export const CAMERA_DEFAULT_COL_WIDTH = 96;
export const CAMERA_DEFAULT_ROW_HEIGHT = 24;
export const CAMERA_DEFAULT_FONT_SIZE = 11;
/** Hard cap so a giant selection can't produce a multi-megapixel canvas. */
export const CAMERA_MAX_CELLS = 4_000;

interface CameraSnapshot {
  styles?: Record<string, Record<string, unknown> | undefined>;
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<
          string,
          Record<string, Record<string, unknown> | undefined> | undefined
        >;
      }
    | undefined
  >;
}

/**
 * Normalize a rect so r1<=r2, c1<=c2 and all >= 0. Returns null when the
 * input is degenerate (negative after clamping is impossible, but a NaN
 * input would slip through — we reject those).
 */
export function normalizeRect(rect: CellRect): CellRect | null {
  const r1 = Math.min(rect.r1, rect.r2);
  const r2 = Math.max(rect.r1, rect.r2);
  const c1 = Math.min(rect.c1, rect.c2);
  const c2 = Math.max(rect.c1, rect.c2);
  if (![r1, r2, c1, c2].every((n) => Number.isInteger(n) && n >= 0)) {
    return null;
  }
  return { r1, c1, r2, c2 };
}

/** Cell count of a rect (inclusive). */
export function rectCellCount(rect: CellRect): number {
  const n = normalizeRect(rect);
  if (!n) return 0;
  return (n.r2 - n.r1 + 1) * (n.c2 - n.c1 + 1);
}

/**
 * Convert a 0-based (col,row) to A1. Local copy so cameraRender stays
 * dependency-free; mirrors `colRowToA1` in imagePreviews.ts.
 */
export function rectToA1(rect: CellRect): string {
  const n = normalizeRect(rect);
  if (!n) return "";
  const col = (c: number): string => {
    let x = c;
    let s = "";
    while (true) {
      s = String.fromCharCode(65 + (x % 26)) + s;
      x = Math.floor(x / 26) - 1;
      if (x < 0) break;
    }
    return s;
  };
  const tl = `${col(n.c1)}${n.r1 + 1}`;
  if (n.r1 === n.r2 && n.c1 === n.c2) return tl;
  return `${tl}:${col(n.c2)}${n.r2 + 1}`;
}

/**
 * Coerce a hex/rgb-ish color value into `#rrggbb`. Univer stores colors as
 * `{ rgb: "#RRGGBB" }` (or sometimes a bare string). Returns null when the
 * value isn't a recognizable color so the painter can skip it.
 */
export function normalizeColor(v: unknown): string | null {
  let raw: string | null = null;
  if (typeof v === "string") raw = v;
  else if (v && typeof v === "object" && typeof (v as { rgb?: unknown }).rgb === "string") {
    raw = (v as { rgb: string }).rgb;
  }
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] !== "#") s = `#${s}`;
  // #rgb -> #rrggbb
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(s)) return s.slice(0, 7).toLowerCase();
  return null;
}

/** Map Univer's `ht` horizontal-align code to our string union. */
function alignFromCode(ht: unknown): "left" | "center" | "right" {
  // Univer HorizontalAlign: 0 normal/unset, 1 left, 2 center, 3 right.
  if (ht === 2) return "center";
  if (ht === 3) return "right";
  return "left";
}

/**
 * Stringify a cell value for display. Mirrors the conventions used elsewhere
 * (slicers.ts valueToKey) but keeps numbers/booleans readable.
 */
export function cellValueToText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    // Rich-text / formula cell objects sometimes nest the display value.
    const obj = v as { v?: unknown };
    if (obj.v !== undefined && obj.v !== null && typeof obj.v !== "object") {
      return cellValueToText(obj.v);
    }
    return "";
  }
  return "";
}

/**
 * Resolve a single cell (value + style) out of the snapshot into a
 * ResolvedCell. `s` may be an inline object or a string id interned in
 * `snapshot.styles` — both are handled.
 */
export function resolveCell(
  snapshot: CameraSnapshot,
  sheetId: string,
  row: number,
  col: number,
): ResolvedCell {
  const blank: ResolvedCell = {
    text: "",
    bg: null,
    color: null,
    bold: false,
    italic: false,
    fontSize: null,
    align: "left",
  };
  const cell = snapshot.sheets?.[sheetId]?.cellData?.[String(row)]?.[String(col)];
  if (!cell || typeof cell !== "object") return blank;

  let style: Record<string, unknown> | null = null;
  const s = cell.s;
  if (typeof s === "string") {
    const looked = snapshot.styles?.[s];
    if (looked && typeof looked === "object") style = looked;
  } else if (s && typeof s === "object") {
    style = s as Record<string, unknown>;
  }

  const text = cellValueToText(cell.v);
  if (!style) return { ...blank, text };

  const fs = style.fs;
  return {
    text,
    bg: normalizeColor(style.bg),
    color: normalizeColor(style.cl),
    bold: style.bl === 1 || style.bl === true,
    italic: style.it === 1 || style.it === true,
    fontSize: typeof fs === "number" && fs > 0 ? fs : null,
    align: alignFromCode(style.ht),
  };
}

/**
 * Build a fixed-grid layout for the given range. Pure: no DOM, no canvas.
 *
 * Returns null when the snapshot is malformed, the sheet is missing, the
 * rect is degenerate, or the range exceeds `CAMERA_MAX_CELLS`.
 */
export function buildRangeLayout(
  snapshotJson: string | null | undefined,
  sheetId: string,
  rect: CellRect,
): RangeLayout | null {
  if (!snapshotJson) return null;
  let snapshot: CameraSnapshot;
  try {
    snapshot = JSON.parse(snapshotJson) as CameraSnapshot;
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== "object") return null;
  if (!snapshot.sheets?.[sheetId]) return null;
  const n = normalizeRect(rect);
  if (!n) return null;
  const rows = n.r2 - n.r1 + 1;
  const cols = n.c2 - n.c1 + 1;
  if (rows * cols > CAMERA_MAX_CELLS) return null;

  const colWidths: number[] = new Array(cols).fill(CAMERA_DEFAULT_COL_WIDTH);
  const rowHeights: number[] = new Array(rows).fill(CAMERA_DEFAULT_ROW_HEIGHT);
  const cells: ResolvedCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowCells: ResolvedCell[] = [];
    for (let c = 0; c < cols; c++) {
      rowCells.push(resolveCell(snapshot, sheetId, n.r1 + r, n.c1 + c));
    }
    cells.push(rowCells);
  }
  return {
    width: cols * CAMERA_DEFAULT_COL_WIDTH,
    height: rows * CAMERA_DEFAULT_ROW_HEIGHT,
    cols,
    rows,
    colWidths,
    rowHeights,
    cells,
  };
}

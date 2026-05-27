// #312 — resolve per-sheet image placements for the in-grid overlay.
//
// Mirrors inGridChartLayout.ts. Reads sheets[id]._images (array of
// ImageEntry), resolves pixel boxes via resolveImageBox, and returns a flat
// list of placements that InGridImageLayer renders as <img> elements.
//
// Only entries with all 4 anchor fields populated are included (same guard as
// the chart layout module). Dangling / incomplete entries are silently skipped.

import { resolveImageBox } from "./inGridImage";
import type { ImageEntry } from "./inGridImage";
import type { CellPixelOptions, PixelBounds } from "./cellPixelBounds";

export interface InGridImagePlacement {
  key: string;
  index: number;
  entry: ImageEntry;
  box: PixelBounds;
}

interface SnapshotSheetShape {
  name?: string;
  rowData?: Record<string, { h?: number; hd?: 0 | 1 } | undefined>;
  columnData?: Record<string, { w?: number; hd?: 0 | 1 } | undefined>;
  defaultRowHeight?: number;
  defaultColumnWidth?: number;
  _images?: unknown[];
}

interface SnapshotShape {
  sheetOrder?: string[];
  sheets?: Record<string, SnapshotSheetShape | undefined>;
}

function hasFullAnchor(entry: ImageEntry): boolean {
  return (
    typeof entry.anchorRow === "number" &&
    Number.isFinite(entry.anchorRow) &&
    entry.anchorRow >= 0 &&
    typeof entry.anchorCol === "number" &&
    Number.isFinite(entry.anchorCol) &&
    entry.anchorCol >= 0 &&
    typeof entry.widthPx === "number" &&
    Number.isFinite(entry.widthPx) &&
    entry.widthPx > 0 &&
    typeof entry.heightPx === "number" &&
    Number.isFinite(entry.heightPx) &&
    entry.heightPx > 0
  );
}

export function resolveInGridImagesForSheet(
  snapshotJson: string | null | undefined,
  sheetId: string | null,
  opts: CellPixelOptions = {},
): InGridImagePlacement[] {
  if (!snapshotJson || !sheetId) return [];

  let snap: SnapshotShape;
  try {
    snap = JSON.parse(snapshotJson) as SnapshotShape;
  } catch {
    return [];
  }

  if (!snap || typeof snap !== "object") return [];
  const sheets = snap.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  const sheet = sheets[sheetId];
  if (!sheet || typeof sheet !== "object") return [];

  const images = sheet._images;
  if (!Array.isArray(images) || images.length === 0) return [];

  const layout = {
    rowData: sheet.rowData,
    columnData: sheet.columnData,
    defaultRowHeight: sheet.defaultRowHeight,
    defaultColumnWidth: sheet.defaultColumnWidth,
  };

  const out: InGridImagePlacement[] = [];

  images.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as ImageEntry;
    if (!hasFullAnchor(entry)) return;

    const box = resolveImageBox(entry, layout, opts);
    if (!box) return;

    out.push({
      key: `${sheetId}-${index}`,
      index,
      entry,
      box,
    });
  });

  return out;
}

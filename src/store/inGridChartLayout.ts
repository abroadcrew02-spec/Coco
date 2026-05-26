// #236 Step 3 — resolve per-sheet chart placements for the in-grid overlay.
//
// Pure / framework-free. Only entries with all 4 anchor fields populated are
// included; range-only entries remain handled by ChartCanvasPanel (sidebar).

import { resolveChartBox } from "./inGridChart";
import type { CellPixelOptions, PixelBounds } from "./cellPixelBounds";
import type { ChartEntry } from "./chartRender";

export interface InGridChartPlacement {
  key: string;
  index: number;
  entry: ChartEntry;
  box: PixelBounds;
}

interface SnapshotSheetShape {
  name?: string;
  rowData?: Record<string, { h?: number; hd?: 0 | 1 } | undefined>;
  columnData?: Record<string, { w?: number; hd?: 0 | 1 } | undefined>;
  defaultRowHeight?: number;
  defaultColumnWidth?: number;
  _charts?: unknown[];
}

interface SnapshotShape {
  sheetOrder?: string[];
  sheets?: Record<string, SnapshotSheetShape | undefined>;
}

function hasFullAnchor(entry: ChartEntry): boolean {
  return (
    typeof entry.anchorRow === "number" &&
    Number.isFinite(entry.anchorRow) &&
    typeof entry.anchorCol === "number" &&
    Number.isFinite(entry.anchorCol) &&
    typeof entry.widthPx === "number" &&
    Number.isFinite(entry.widthPx) &&
    entry.widthPx > 0 &&
    typeof entry.heightPx === "number" &&
    Number.isFinite(entry.heightPx) &&
    entry.heightPx > 0
  );
}

export function resolveInGridChartsForSheet(
  snapshotJson: string | null | undefined,
  sheetId: string | null,
  opts: CellPixelOptions = {},
): InGridChartPlacement[] {
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

  const charts = sheet._charts;
  if (!Array.isArray(charts) || charts.length === 0) return [];

  const layout = {
    rowData: sheet.rowData,
    columnData: sheet.columnData,
    defaultRowHeight: sheet.defaultRowHeight,
    defaultColumnWidth: sheet.defaultColumnWidth,
  };

  const out: InGridChartPlacement[] = [];

  charts.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as ChartEntry;
    if (!hasFullAnchor(entry)) return;

    const box = resolveChartBox(entry, layout, opts);
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

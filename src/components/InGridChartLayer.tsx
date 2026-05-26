// #236 Step 4 — drag-to-move + resize handles for in-grid charts.
//
// Builds on Step 3's overlay layer. Each chart frame now:
//   - Shows 8 resize handles on hover (corners + edge-midpoints).
//   - Supports pointer-based drag-to-move (body drag) and drag-to-resize
//     (handle drag). Both use pointer capture so the drag continues outside
//     the element boundary.
//   - On pointerup, snaps the anchor to the nearest cell boundary via
//     `snapAnchorToPixel` (reverse of cellPixelBounds). The caller
//     receives the updated `_charts` array via `onChartChange`.
//
// The overlay <div> has `pointer-events: none` for all non-interactive
// descendants so grid interactions aren't swallowed.

import { useMemo, useRef, useCallback } from "react";
import { resolveInGridChartsForSheet } from "../store/inGridChartLayout";
import { extractChartData, renderChart } from "../store/chartRender";
import {
  snapAnchorToPixel,
  resizeChartAnchor,
  type BoxableEntry,
} from "../store/inGridChart";
import type { CellPixelOptions, SheetPixelLayout } from "../store/cellPixelBounds";
import type { ChartEntry } from "../store/chartRender";
import "./InGridChartLayer.css";

// ---------------------------------------------------------------------------
// Resize handle positions: 8 cardinal / diagonal directions.
// ---------------------------------------------------------------------------
type HandleDir =
  | "n" | "s" | "e" | "w"
  | "nw" | "ne" | "sw" | "se";

interface HandleSpec {
  dir: HandleDir;
  /** CSS cursor value */
  cursor: string;
  /** Percentage positions for top/left */
  top: string;
  left: string;
}

const HANDLES: HandleSpec[] = [
  { dir: "nw", cursor: "nw-resize", top: "0%",   left: "0%" },
  { dir: "n",  cursor: "n-resize",  top: "0%",   left: "50%" },
  { dir: "ne", cursor: "ne-resize", top: "0%",   left: "100%" },
  { dir: "e",  cursor: "e-resize",  top: "50%",  left: "100%" },
  { dir: "se", cursor: "se-resize", top: "100%", left: "100%" },
  { dir: "s",  cursor: "s-resize",  top: "100%", left: "50%" },
  { dir: "sw", cursor: "sw-resize", top: "100%", left: "0%" },
  { dir: "w",  cursor: "w-resize",  top: "50%",  left: "0%" },
];

// ---------------------------------------------------------------------------
// Drag state (local ref, avoids React state for every pointer-move).
// ---------------------------------------------------------------------------
type DragMode = "move" | "resize";

interface DragState {
  mode: DragMode;
  dir?: HandleDir;
  /** Chart index in _charts array */
  index: number;
  /** Pointer position at drag start */
  startX: number;
  startY: number;
  /** Chart box at drag start */
  origLeft: number;
  origTop: number;
  origWidth: number;
  origHeight: number;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  workbookSnapshotJson: string | null;
  activeSheetId: string | null;
  pixelOpts?: CellPixelOptions;
  /**
   * Called when a drag operation commits. `chartIndex` is the 0-based index
   * in the sheet's `_charts` array; `updated` is the new chart entry.
   * The parent is responsible for persisting to the workbook snapshot.
   */
  onChartChange?: (
    sheetId: string,
    chartIndex: number,
    updated: ChartEntry,
  ) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function InGridChartLayer({
  workbookSnapshotJson,
  activeSheetId,
  pixelOpts,
  onChartChange,
}: Props) {
  const drag = useRef<DragState | null>(null);
  // Tracks live (uncommitted) box positions during a drag so we can preview
  // without waiting for React to re-render from the store.
  const liveBoxes = useRef<Map<number, { left: number; top: number; width: number; height: number }>>(new Map());
  // Ref to the container so we can read it for offset correction.
  const containerRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    if (!workbookSnapshotJson || !activeSheetId) return [];
    const placements = resolveInGridChartsForSheet(
      workbookSnapshotJson,
      activeSheetId,
      pixelOpts,
    );
    return placements.map((p) => {
      const data = extractChartData(workbookSnapshotJson, {
        entry: p.entry,
        sheetId: activeSheetId,
      });
      const svg = renderChart(data, p.entry, p.box.width, p.box.height);
      return { placement: p, svg };
    });
  }, [workbookSnapshotJson, activeSheetId, pixelOpts]);

  // Reset live boxes when items change (new snapshot committed).
  liveBoxes.current.clear();

  // ---------------------------------------------------------------------------
  // Helpers to parse the layout from the snapshot (for snap-to-cell).
  // ---------------------------------------------------------------------------
  const getLayout = useCallback((): SheetPixelLayout => {
    if (!workbookSnapshotJson || !activeSheetId) return {};
    try {
      const snap = JSON.parse(workbookSnapshotJson) as {
        sheets?: Record<string, {
          rowData?: SheetPixelLayout["rowData"];
          columnData?: SheetPixelLayout["columnData"];
          defaultRowHeight?: number;
          defaultColumnWidth?: number;
        }>;
      };
      const sheet = snap?.sheets?.[activeSheetId];
      if (!sheet) return {};
      return {
        rowData: sheet.rowData,
        columnData: sheet.columnData,
        defaultRowHeight: sheet.defaultRowHeight,
        defaultColumnWidth: sheet.defaultColumnWidth,
      };
    } catch {
      return {};
    }
  }, [workbookSnapshotJson, activeSheetId]);

  // ---------------------------------------------------------------------------
  // Pointer handlers
  // ---------------------------------------------------------------------------
  const onBodyPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, index: number, box: { left: number; top: number; width: number; height: number }) => {
      // Only primary button.
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      drag.current = {
        mode: "move",
        index,
        startX: e.clientX,
        startY: e.clientY,
        origLeft: box.left,
        origTop: box.top,
        origWidth: box.width,
        origHeight: box.height,
      };
    },
    [],
  );

  const onHandlePointerDown = useCallback(
    (
      e: React.PointerEvent<HTMLDivElement>,
      dir: HandleDir,
      index: number,
      box: { left: number; top: number; width: number; height: number },
    ) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      drag.current = {
        mode: "resize",
        dir,
        index,
        startX: e.clientX,
        startY: e.clientY,
        origLeft: box.left,
        origTop: box.top,
        origWidth: box.width,
        origHeight: box.height,
      };
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, index: number) => {
      const d = drag.current;
      if (!d || d.index !== index) return;

      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const MIN_W = 60;
      const MIN_H = 40;

      let { left: newLeft, top: newTop, width: newWidth, height: newHeight } =
        { left: d.origLeft, top: d.origTop, width: d.origWidth, height: d.origHeight };

      if (d.mode === "move") {
        newLeft = d.origLeft + dx;
        newTop = d.origTop + dy;
      } else if (d.mode === "resize" && d.dir) {
        const dir = d.dir;
        if (dir.includes("e")) {
          newWidth = Math.max(MIN_W, d.origWidth + dx);
        }
        if (dir.includes("w")) {
          const clamped = Math.max(MIN_W, d.origWidth - dx);
          newLeft = d.origLeft + (d.origWidth - clamped);
          newWidth = clamped;
        }
        if (dir.includes("s")) {
          newHeight = Math.max(MIN_H, d.origHeight + dy);
        }
        if (dir.includes("n")) {
          const clamped = Math.max(MIN_H, d.origHeight - dy);
          newTop = d.origTop + (d.origHeight - clamped);
          newHeight = clamped;
        }
      }

      // Live preview: update the DOM directly without going through React state.
      const container = containerRef.current;
      if (container) {
        const frameEl = container.querySelector<HTMLElement>(
          `[data-chart-index="${index}"]`,
        );
        if (frameEl) {
          frameEl.style.left = `${newLeft}px`;
          frameEl.style.top = `${newTop}px`;
          frameEl.style.width = `${newWidth}px`;
          frameEl.style.height = `${newHeight}px`;
        }
      }

      liveBoxes.current.set(index, { left: newLeft, top: newTop, width: newWidth, height: newHeight });
    },
    [],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, index: number, entry: ChartEntry) => {
      const d = drag.current;
      if (!d || d.index !== index) return;
      drag.current = null;

      const live = liveBoxes.current.get(index);
      if (!live) return;
      liveBoxes.current.delete(index);

      if (!onChartChange || !activeSheetId) return;

      const layout = getLayout();
      let updated: ChartEntry;

      if (d.mode === "move") {
        // Snap top-left corner to nearest cell.
        updated = snapAnchorToPixel(entry as BoxableEntry & ChartEntry, live.left, live.top, layout, pixelOpts) as ChartEntry;
        // Preserve size.
        updated = { ...updated, widthPx: entry.widthPx, heightPx: entry.heightPx };
      } else {
        // Resize: snap anchor for top-left (in case we dragged nw/n/w handle).
        const snapped = snapAnchorToPixel(entry as BoxableEntry & ChartEntry, live.left, live.top, layout, pixelOpts);
        updated = resizeChartAnchor(
          { ...entry, anchorRow: snapped.anchorRow, anchorCol: snapped.anchorCol } as BoxableEntry & ChartEntry,
          live.width,
          live.height,
        ) as ChartEntry;
      }

      onChartChange(activeSheetId, index, updated);
    },
    [onChartChange, activeSheetId, getLayout, pixelOpts],
  );

  if (items.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="ingrid-chart-layer"
      role="presentation"
      aria-hidden="true"
    >
      {items.map(({ placement, svg }) => {
        const { index, box, entry } = placement;
        return (
          <div
            key={placement.key}
            data-chart-index={index}
            className="ingrid-chart-frame"
            style={
              {
                "--cf-left": `${box.left}px`,
                "--cf-top": `${box.top}px`,
                "--cf-width": `${box.width}px`,
                "--cf-height": `${box.height}px`,
              } as React.CSSProperties
            }
          >
            {/* Chart body — drag moves the chart; cursor set via CSS */}
            <div
              className="ingrid-chart-body"
              onPointerDown={(e) => onBodyPointerDown(e, index, box)}
              onPointerMove={(e) => onPointerMove(e, index)}
              onPointerUp={(e) => onPointerUp(e, index, entry)}
              dangerouslySetInnerHTML={{ __html: svg }}
            />

            {/* 8 resize handles — shown via CSS on hover; cursor + position via CSS */}
            {HANDLES.map((h) => (
              <div
                key={h.dir}
                className="ingrid-chart-handle"
                data-dir={h.dir}
                style={
                  {
                    "--h-top": h.top,
                    "--h-left": h.left,
                  } as React.CSSProperties
                }
                onPointerDown={(e) => onHandlePointerDown(e, h.dir, index, box)}
                onPointerMove={(e) => onPointerMove(e, index)}
                onPointerUp={(e) => onPointerUp(e, index, entry)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

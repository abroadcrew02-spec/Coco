// #312 — drag-to-move + resize handles for in-grid images.
//
// Mirrors InGridChartLayer.tsx. Each image frame:
//   - Renders an <img> element at the resolved pixel position.
//   - Shows 8 resize handles on hover (corners + edge-midpoints).
//   - Supports pointer-based drag-to-move (body drag) and drag-to-resize
//     (handle drag). Both use pointer capture so the drag continues outside
//     the element boundary.
//   - On pointerup, snaps the anchor to the nearest cell boundary via
//     `snapAnchorToPixel`. The caller receives the updated `_images` array
//     via `onImageChange`.
//
// The overlay <div> has `pointer-events: none` for non-interactive descendants
// so grid interactions aren't swallowed.

import { useMemo, useRef, useCallback } from "react";
import { resolveInGridImagesForSheet } from "../store/inGridImageLayout";
import {
  snapAnchorToPixel,
  resizeImageAnchor,
  imageDataUrl,
  IMAGE_MIN_WIDTH_PX,
  IMAGE_MIN_HEIGHT_PX,
  type ImageEntry,
} from "../store/inGridImage";
import type { CellPixelOptions, SheetPixelLayout } from "../store/cellPixelBounds";
import "./InGridImageLayer.css";

// ---------------------------------------------------------------------------
// Resize handle positions: 8 cardinal / diagonal directions.
// ---------------------------------------------------------------------------
type HandleDir =
  | "n" | "s" | "e" | "w"
  | "nw" | "ne" | "sw" | "se";

interface HandleSpec {
  dir: HandleDir;
  cursor: string;
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
// Drag state (local ref — avoids React re-render on every pointer-move).
// ---------------------------------------------------------------------------
type DragMode = "move" | "resize";

interface DragState {
  mode: DragMode;
  dir?: HandleDir;
  /** Image index in _images array */
  index: number;
  startX: number;
  startY: number;
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
   * Called when a drag operation commits. `imageIndex` is the 0-based index
   * in the sheet's `_images` array; `updated` is the new image entry.
   * The parent is responsible for persisting to the workbook snapshot.
   */
  onImageChange?: (
    sheetId: string,
    imageIndex: number,
    updated: ImageEntry,
  ) => void;
  /**
   * Called when the user double-clicks an image frame.
   * Reserved for a future image-properties dialog.
   */
  onImageEdit?: (
    sheetId: string,
    imageIndex: number,
    entry: ImageEntry,
  ) => void;
  /**
   * Called when the user presses Delete or Backspace on a focused image frame.
   */
  onImageDelete?: (sheetId: string, imageIndex: number) => void;
  /**
   * Called when the user clicks "Bring to Front". The handler should set
   * zIndex to max(all images' zIndex) + 1 for the given image.
   */
  onImageBringToFront?: (sheetId: string, imageIndex: number) => void;
  /**
   * Called when the user clicks "Send to Back". The handler should set
   * zIndex to min(all images' zIndex) - 1 for the given image.
   */
  onImageSendToBack?: (sheetId: string, imageIndex: number) => void;
  /**
   * Called when the user clicks "Rotate 90°". The handler should increment
   * rotationDeg by 90, wrapping at 360.
   */
  onImageRotate?: (sheetId: string, imageIndex: number) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function InGridImageLayer({
  workbookSnapshotJson,
  activeSheetId,
  pixelOpts,
  onImageChange,
  onImageEdit,
  onImageDelete,
  onImageBringToFront,
  onImageSendToBack,
  onImageRotate,
}: Props) {
  const drag = useRef<DragState | null>(null);
  // Tracks live (uncommitted) box positions during drag so we can preview
  // without waiting for React to re-render from the store.
  const liveBoxes = useRef<Map<number, { left: number; top: number; width: number; height: number }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    if (!workbookSnapshotJson || !activeSheetId) return [];
    return resolveInGridImagesForSheet(
      workbookSnapshotJson,
      activeSheetId,
      pixelOpts,
    );
  }, [workbookSnapshotJson, activeSheetId, pixelOpts]);

  // Reset live boxes when items change (new snapshot committed).
  liveBoxes.current.clear();

  // ---------------------------------------------------------------------------
  // Parse layout for snap-to-cell on drag commit.
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

      let { left: newLeft, top: newTop, width: newWidth, height: newHeight } =
        { left: d.origLeft, top: d.origTop, width: d.origWidth, height: d.origHeight };

      if (d.mode === "move") {
        newLeft = d.origLeft + dx;
        newTop = d.origTop + dy;
      } else if (d.mode === "resize" && d.dir) {
        const dir = d.dir;
        if (dir.includes("e")) {
          newWidth = Math.max(IMAGE_MIN_WIDTH_PX, d.origWidth + dx);
        }
        if (dir.includes("w")) {
          const clamped = Math.max(IMAGE_MIN_WIDTH_PX, d.origWidth - dx);
          newLeft = d.origLeft + (d.origWidth - clamped);
          newWidth = clamped;
        }
        if (dir.includes("s")) {
          newHeight = Math.max(IMAGE_MIN_HEIGHT_PX, d.origHeight + dy);
        }
        if (dir.includes("n")) {
          const clamped = Math.max(IMAGE_MIN_HEIGHT_PX, d.origHeight - dy);
          newTop = d.origTop + (d.origHeight - clamped);
          newHeight = clamped;
        }
      }

      // Live preview: update DOM directly without going through React state.
      const container = containerRef.current;
      if (container) {
        const frameEl = container.querySelector<HTMLElement>(
          `[data-image-index="${index}"]`,
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

  // Delete / Backspace on a focused image frame removes the image.
  const onFrameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (drag.current !== null) return;
      e.preventDefault();
      e.stopPropagation();
      if (onImageDelete && activeSheetId) {
        onImageDelete(activeSheetId, index);
      }
    },
    [onImageDelete, activeSheetId],
  );

  const onPointerUp = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>, index: number, entry: ImageEntry) => {
      const d = drag.current;
      if (!d || d.index !== index) return;
      drag.current = null;

      const live = liveBoxes.current.get(index);
      if (!live) return;
      liveBoxes.current.delete(index);

      if (!onImageChange || !activeSheetId) return;

      const layout = getLayout();
      let updated: ImageEntry;

      if (d.mode === "move") {
        updated = snapAnchorToPixel(entry, live.left, live.top, layout, pixelOpts);
        updated = { ...updated, widthPx: entry.widthPx, heightPx: entry.heightPx };
      } else {
        const snapped = snapAnchorToPixel(entry, live.left, live.top, layout, pixelOpts);
        updated = resizeImageAnchor(
          { ...entry, anchorRow: snapped.anchorRow, anchorCol: snapped.anchorCol },
          live.width,
          live.height,
        );
      }

      onImageChange(activeSheetId, index, updated);
    },
    [onImageChange, activeSheetId, getLayout, pixelOpts],
  );

  if (items.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="ingrid-image-layer"
      role="presentation"
      aria-hidden="true"
    >
      {items.map((placement) => {
        const { index, box, entry } = placement;
        const src = imageDataUrl(entry);
        const zIdx = entry.zIndex ?? 0;
        const rotDeg = entry.rotationDeg ?? 0;
        return (
          <div
            key={placement.key}
            data-image-index={index}
            className="ingrid-image-frame"
            tabIndex={0}
            onKeyDown={(e) => onFrameKeyDown(e, index)}
            style={
              {
                "--if-left": `${box.left}px`,
                "--if-top": `${box.top}px`,
                "--if-width": `${box.width}px`,
                "--if-height": `${box.height}px`,
                zIndex: zIdx,
              } as React.CSSProperties
            }
          >
            {/* Controls toolbar: z-order + rotate */}
            <div className="ingrid-image-controls">
              <button
                type="button"
                className="ingrid-image-ctrl-btn"
                title="Bring to Front"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onImageBringToFront && activeSheetId) {
                    onImageBringToFront(activeSheetId, index);
                  }
                }}
              >
                &#9650;Front
              </button>
              <button
                type="button"
                className="ingrid-image-ctrl-btn"
                title="Send to Back"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onImageSendToBack && activeSheetId) {
                    onImageSendToBack(activeSheetId, index);
                  }
                }}
              >
                &#9660;Back
              </button>
              <button
                type="button"
                className="ingrid-image-ctrl-btn"
                title="Rotate 90°"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onImageRotate && activeSheetId) {
                    onImageRotate(activeSheetId, index);
                  }
                }}
              >
                &#8635;90°
              </button>
            </div>

            {/* Image body — drag moves the image */}
            <div
              className="ingrid-image-body"
              onPointerDown={(e) => onBodyPointerDown(e, index, box)}
              onPointerMove={(e) => onPointerMove(e, index)}
              onPointerUp={(e) => onPointerUp(e, index, entry)}
              onDoubleClick={() => {
                if (drag.current !== null) return;
                if (onImageEdit && activeSheetId) {
                  onImageEdit(activeSheetId, index, entry);
                }
              }}
            >
              <img
                className="ingrid-image-img"
                src={src}
                alt={entry.name ?? ""}
                draggable={false}
                style={rotDeg !== 0 ? { transform: `rotate(${rotDeg}deg)` } : undefined}
              />
            </div>

            {/* 8 resize handles */}
            {HANDLES.map((h) => (
              <div
                key={h.dir}
                className="ingrid-image-handle"
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

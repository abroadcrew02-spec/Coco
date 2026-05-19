// Snapshot patch that applies every slicer's row predicate, marking
// non-matching table rows with `hd: 1` so Univer hides them in the grid.
//
// Pure / idempotent — input is structurally cloned via `applySlicerFilters`,
// so re-running the patch on an already-patched snapshot yields the same
// output. Designed to slot into the `patchFooRenders` pipeline alongside
// outline, tables, sparklines, and CF (see EditorScreen.tsx initialData).
//
// Pipeline placement: this patch MUST run AFTER outline (so we don't lose
// the outline level metadata when we touch a row's cells) and BEFORE
// conditional formatting (so hidden rows are skipped by the CF evaluator —
// avoids burning cycles styling rows the user can't see, and prevents a
// "visible CF style on a hidden row" artefact if Univer ever paints hidden
// rows for rotated copy/paste).

import {
  applySlicerFilters,
  type WorkbookSlicerSnapshot,
} from "../store/slicers";

/**
 * Apply every slicer's `hd:1` mutation to the snapshot. Returns a NEW
 * snapshot — the input is structurally cloned by `applySlicerFilters` so the
 * caller never sees in-place changes.
 */
export function patchSlicerFilters<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  return applySlicerFilters(snapshot as unknown as WorkbookSlicerSnapshot) as unknown as T;
}

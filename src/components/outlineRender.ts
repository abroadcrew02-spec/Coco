// Outline-group hide-on-collapse snapshot patch.
//
// The xlsx round-trip stores per-sheet outline groups at
// `sheets.<sid>._outlineRows` / `_outlineCols`. Each group's `collapsed`
// flag is authoritative — but Univer itself has no notion of "outline
// collapse"; it only honours `rowData[i].hd = 1` (or `columnData[j].hd`)
// to hide rows/columns. This module bridges the two by walking every
// sheet's outline arrays and setting `hd: 1` on the relevant indices
// before the snapshot is handed to `univer.createUnit`, mirroring the
// contract of `patchCfRenders` / `patchHyperlinkRenders` (pure clone,
// no mutation of the input).
//
// The collapse decision lives in `applyOutlineToSheet` (see
// store/outlineGroups.ts) so the dialog and the renderer share one
// rule and stay unit-testable without Univer.

import { applyOutlineToSheet } from "../store/outlineGroups";

type SnapshotShape = {
  sheets?: Record<
    string,
    Record<string, unknown> | undefined
  >;
};

/**
 * Return a new snapshot with outline-collapsed rows/columns marked
 * `hd: 1` in `rowData` / `columnData`. Pure — the input is not mutated.
 * On any structural anomaly (non-object snapshot, missing sheets, JSON
 * serialization failure) we hand back the input unchanged, matching the
 * defensive posture of the other render patches.
 */
export function patchOutlineRenders<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  let cloned: SnapshotShape;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
  } catch {
    return snapshot;
  }
  const sheets = cloned.sheets;
  if (!sheets) return cloned as unknown as T;
  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    // applyOutlineToSheet mutates the (already-cloned) sheet in place.
    applyOutlineToSheet(sheet as Parameters<typeof applyOutlineToSheet>[0]);
  }
  return cloned as unknown as T;
}

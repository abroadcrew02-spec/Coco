// Pure helpers for hiding / unhiding sheets in a Univer workbook snapshot.
// Excel models per-sheet visibility via the workbook-level `<sheet state="...">`
// attribute (visible / hidden / veryHidden). Coco's xlsx round-trip already
// honors this via the `_sheetState` field on each sheet object — see
// `src-tauri/src/commands/xlsx_io.rs::parse_xlsx_sheet_visibility` (load) and
// the corresponding writer block ("Apply sheet visibility from `_sheetState`")
// at the bottom of the same file. We treat `_sheetState` as the canonical
// store for hidden state so this work surfaces in saved xlsx files without
// any backend changes.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheetOrder?: string[];                       // ordered sheet ids
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         _sheetState?: "hidden" | "veryHidden";  // absent === visible
//         ...
//       }
//     }
//   }
//
// `hideSheet` only writes "hidden" (not "veryHidden") because the dialog flow
// can't surface very-hidden sheets to the user — they're typically reserved
// for VBA-only access, which Coco doesn't expose. `unhideSheet` accepts both:
// it deletes the `_sheetState` key regardless of which value it carried.
//
// Kept side-effect free so it can be unit-tested without Univer.

export type SheetStateValue = "hidden" | "veryHidden";

export interface SheetEntry {
  name?: string;
  _sheetState?: SheetStateValue;
  [k: string]: unknown;
}

export interface VisibilitySnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, SheetEntry | undefined>;
}

export type SnapshotJsonString = string;

export interface SheetSummary {
  sheetId: string;
  name: string;
}

/**
 * True when the sheet object marks itself as hidden or veryHidden. Accepts
 * either a parsed sheet entry or undefined (returns false). Tolerant of
 * unknown `_sheetState` strings — only the documented enum values count.
 */
export function isSheetHidden(sheet: SheetEntry | undefined | null): boolean {
  if (!sheet || typeof sheet !== "object") return false;
  const state = (sheet as SheetEntry)._sheetState;
  return state === "hidden" || state === "veryHidden";
}

// Parse the snapshot JSON, returning null on malformed input so callers can
// fail open. Mirrors the defensive pattern in dataValidation.ts.
function parseSnapshot(snapshotJson: string | null | undefined): VisibilitySnapshot | null {
  if (!snapshotJson) return null;
  try {
    const parsed = JSON.parse(snapshotJson) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as VisibilitySnapshot;
  } catch {
    return null;
  }
}

// Compute the canonical iteration order of sheets: prefer `sheetOrder` when
// present (it controls tab order in Univer + xlsx), otherwise fall back to
// Object.keys insertion order so we still produce a stable list.
function getOrderedSheetIds(snapshot: VisibilitySnapshot): string[] {
  if (Array.isArray(snapshot.sheetOrder) && snapshot.sheetOrder.length > 0) {
    return snapshot.sheetOrder.filter((id) => typeof id === "string");
  }
  if (snapshot.sheets && typeof snapshot.sheets === "object") {
    return Object.keys(snapshot.sheets);
  }
  return [];
}

function summarize(snapshot: VisibilitySnapshot, sheetId: string): SheetSummary {
  const sheet = snapshot.sheets?.[sheetId];
  const rawName = sheet && typeof sheet.name === "string" ? sheet.name.trim() : "";
  return { sheetId, name: rawName.length > 0 ? rawName : sheetId };
}

/**
 * Sets `_sheetState = "hidden"` on the given sheet and returns the new
 * snapshot JSON. Returns the input untouched if the snapshot is malformed,
 * the sheet id is missing, or hiding the sheet would leave zero visible
 * sheets (Excel forbids hiding the last visible sheet — the dialog enforces
 * this too, but the helper double-checks defensively).
 */
export function hideSheet(
  snapshotJson: SnapshotJsonString,
  sheetId: string,
): SnapshotJsonString {
  const snapshot = parseSnapshot(snapshotJson);
  if (!snapshot) return snapshotJson;
  if (!snapshot.sheets || !snapshot.sheets[sheetId]) return snapshotJson;
  const sheet = snapshot.sheets[sheetId]!;
  // Already hidden — no-op, return as-is to avoid producing churn on the
  // snapshot stream (applyMutatedSnapshot can fan out to undo/redo).
  if (isSheetHidden(sheet)) return snapshotJson;
  // Last-visible guard: hiding this sheet must leave at least one visible.
  const visibleCount = listVisibleSheets(snapshotJson).length;
  if (visibleCount <= 1) return snapshotJson;
  sheet._sheetState = "hidden";
  return JSON.stringify(snapshot);
}

/**
 * Clears the `_sheetState` field so the sheet is visible again. Removes both
 * "hidden" and "veryHidden" states. No-op (returns input) when the snapshot
 * is malformed or the sheet id is missing.
 */
export function unhideSheet(
  snapshotJson: SnapshotJsonString,
  sheetId: string,
): SnapshotJsonString {
  const snapshot = parseSnapshot(snapshotJson);
  if (!snapshot) return snapshotJson;
  if (!snapshot.sheets || !snapshot.sheets[sheetId]) return snapshotJson;
  const sheet = snapshot.sheets[sheetId]!;
  if (!isSheetHidden(sheet)) return snapshotJson;
  delete sheet._sheetState;
  return JSON.stringify(snapshot);
}

/**
 * Returns the (sheetId, displayName) of every hidden or veryHidden sheet,
 * preserving sheetOrder. The display name falls back to the sheet id when
 * `name` is missing or blank.
 */
export function listHiddenSheets(snapshotJson: SnapshotJsonString | null | undefined): SheetSummary[] {
  const snapshot = parseSnapshot(snapshotJson);
  if (!snapshot) return [];
  const out: SheetSummary[] = [];
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (isSheetHidden(sheet)) out.push(summarize(snapshot, sheetId));
  }
  return out;
}

/**
 * Returns the (sheetId, displayName) of every visible sheet. Used by the
 * editor's safety check ("don't hide the last visible sheet") and could feed
 * any future workbook-level UI that wants to enumerate active tabs.
 */
export function listVisibleSheets(snapshotJson: SnapshotJsonString | null | undefined): SheetSummary[] {
  const snapshot = parseSnapshot(snapshotJson);
  if (!snapshot) return [];
  const out: SheetSummary[] = [];
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!isSheetHidden(sheet)) out.push(summarize(snapshot, sheetId));
  }
  return out;
}

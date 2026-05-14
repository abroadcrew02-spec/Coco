// Pure helpers for reading sheet-protection state out of a Univer workbook
// snapshot JSON string. Used by both the editor's "is the active sheet
// protected?" toolbar hint and the live command-blocking guard. Kept side
// -effect free so it can be unit-tested without standing up Univer.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   { sheets: { sheetId: { _protected?: { protected?: boolean } } } }

export interface ProtectedSnapshot {
  sheets?: Record<string, { _protected?: { protected?: boolean } } | undefined>;
}

/**
 * Returns true when the given sheet id is marked as protected in the snapshot.
 * Tolerates malformed JSON, missing sheets, and missing keys (returns false in
 * any of those cases) so callers never throw on edge cases.
 */
export function isSheetProtectedInSnapshot(
  snapshotJson: string | null | undefined,
  sheetId: string | null | undefined,
): boolean {
  if (!snapshotJson || !sheetId) return false;
  let parsed: ProtectedSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as ProtectedSnapshot;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const sheet = parsed.sheets?.[sheetId];
  return sheet?._protected?.protected === true;
}

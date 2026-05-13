// Pure helpers that derive display-friendly stats from a Univer workbook
// snapshot JSON string. Kept separate from EditorScreen so the logic is
// testable without standing up Univer.

export interface SnapshotStats {
  sheetCount: number;
  cellCount: number;
}

/**
 * Counts the number of non-empty cells across all sheets in a Univer snapshot.
 * Tolerates malformed input (returns zeros rather than throwing) so the status
 * bar never crashes the editor.
 *
 * Snapshot shape (Univer 0.5.x):
 *   { sheetOrder: [...], sheets: { sheetId: { cellData: { row: { col: {...} } } } } }
 */
export function computeSnapshotStats(snapshotJson: string | null | undefined): SnapshotStats {
  if (!snapshotJson) return { sheetCount: 0, cellCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    return { sheetCount: 0, cellCount: 0 };
  }
  if (!parsed || typeof parsed !== "object") return { sheetCount: 0, cellCount: 0 };
  const root = parsed as { sheets?: unknown; sheetOrder?: unknown };
  const sheets = root.sheets;
  if (!sheets || typeof sheets !== "object") return { sheetCount: 0, cellCount: 0 };

  const sheetEntries = Object.values(sheets);
  let cellCount = 0;
  for (const sheet of sheetEntries) {
    if (!sheet || typeof sheet !== "object") continue;
    const cellData = (sheet as { cellData?: unknown }).cellData;
    if (!cellData || typeof cellData !== "object") continue;
    for (const row of Object.values(cellData)) {
      if (!row || typeof row !== "object") continue;
      cellCount += Object.keys(row).length;
    }
  }

  return { sheetCount: sheetEntries.length, cellCount };
}

/**
 * Formats stats as a single Japanese string for the status bar.
 * Empty workbook → null (caller skips rendering).
 */
export function formatSnapshotStats(stats: SnapshotStats): string | null {
  if (stats.sheetCount === 0 && stats.cellCount === 0) return null;
  const cellLabel = stats.cellCount.toLocaleString("ja-JP");
  return `${stats.sheetCount} シート · ${cellLabel} セル`;
}

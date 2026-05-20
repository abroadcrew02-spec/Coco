// Pure helpers for extracting cell-comment indicator data out of a Univer
// workbook snapshot JSON string. Used by the in-grid comment indicators
// panel (EditorScreen) so users can see at a glance which cells carry a
// comment without opening the InsertComment dialog. Kept side-effect free
// so it can be unit-tested without standing up Univer.
//
// Snapshot shape (Univer 0.5.x + Coco extension; mirrors xlsx_io.rs):
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         _comments?: Array<{ cell: string, author?: string, text: string }>
//       }
//     }
//   }
//
// Note on visual representation: Univer 0.5.x's facade does not expose a
// cell decoration / pixel-position API, so we cannot render a true in-cell
// triangle overlay aligned to the canvas without diving into the unstable
// render-controller services. The MVP instead surfaces commented cells via
// a fixed side panel in EditorScreen (CommentIndicatorsPanel) — same goal
// (at-a-glance visibility) without pixel coordinate fragility.

export interface CommentIndicator {
  sheetId: string;
  sheetName: string;
  cell: string;
  text: string;
  author?: string;
}

interface CommentSnapshot {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        _comments?: Array<{
          cell?: unknown;
          cellRef?: unknown;
          author?: unknown;
          text?: unknown;
          body?: unknown;
        }>;
      }
    | undefined
  >;
}

/**
 * Returns a flat list of comment indicators across all sheets in the
 * snapshot, preserving the snapshot's `sheetOrder` so the UI lists sheets
 * in tab order. Within each sheet, comments retain their array order
 * (matches the order they were authored / parsed from xlsx).
 *
 * Tolerates malformed JSON, missing sheets, missing `_comments`, and
 * malformed entries (silently skips bad rows). A null / empty input
 * returns [] so callers can render unconditionally.
 *
 * `sheetName` falls back to the sheet id when the sheet object lacks an
 * explicit `name` field — this matches how the dialog flow already labels
 * orphan sheets.
 */
export function computeCommentIndicators(
  snapshotJson: string | null | undefined,
): CommentIndicator[] {
  if (!snapshotJson) return [];
  let parsed: CommentSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as CommentSnapshot;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const sheets = parsed.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  // Iterate sheets in declared order when sheetOrder is available; fall
  // back to Object.keys order so we still emit something for snapshots
  // that omit sheetOrder.
  const order =
    Array.isArray(parsed.sheetOrder) && parsed.sheetOrder.length > 0
      ? parsed.sheetOrder.filter((id) => typeof id === "string")
      : Object.keys(sheets);

  const out: CommentIndicator[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const arr = sheet._comments;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sheetName = typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const cell =
        typeof entry.cell === "string"
          ? entry.cell
          : typeof entry.cellRef === "string"
            ? entry.cellRef
            : null;
      const text =
        typeof entry.text === "string"
          ? entry.text
          : typeof entry.body === "string"
            ? entry.body
            : null;
      if (!cell || text === null) continue;
      const indicator: CommentIndicator = { sheetId, sheetName, cell, text };
      if (typeof entry.author === "string" && entry.author) {
        indicator.author = entry.author;
      }
      out.push(indicator);
    }
  }
  return out;
}

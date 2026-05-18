// Pure helpers for the Cell Linker dialog. The dialog gives the user a
// no-typing path to author a cross-sheet reference formula (`=Sheet2!A1`)
// or a one-shot value copy. Kept side-effect free so the same helpers can
// drive both the preview pane in the dialog and the actual apply step in
// EditorScreen, and so they're testable without Univer.
//
// Snapshot shape we care about (Univer 0.5.x + Coco extension):
//   {
//     sheetOrder?: string[];               // canonical sheet ordering
//     sheets: {
//       <sheetId>: {
//         name?: string;                   // human-visible sheet name
//         cellData?: {
//           [row: number]: {
//             [col: number]: {
//               v?: unknown;               // user-facing value
//               f?: string;                // formula (no `=` prefix in Univer)
//             }
//           }
//         }
//       }
//     }
//   }

export interface CellLinkParams {
  /** Sheet id of the target (where the formula or copied value is written). */
  targetSheetId: string;
  /** A1 reference for the destination cell on the target sheet. */
  targetCellRef: string;
  /** Human-visible source sheet name (will be quoted if it contains spaces). */
  sourceSheetName: string;
  /** A1 reference for the source cell. */
  sourceCellRef: string;
  /** When true write `=Sheet!A1`; when false write the resolved value (copy). */
  liveLink: boolean;
}

// Sheet names in Excel must be wrapped in single quotes when they contain
// whitespace, punctuation (other than _), or start with a digit. We err on
// the side of quoting whenever the name doesn't match a strict bare-name
// regex; embedded single quotes are escaped by doubling (Excel convention).
const BARE_SHEET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteSheetNameIfNeeded(name: string): string {
  if (BARE_SHEET_NAME.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Build the cross-sheet reference formula string, including the leading `=`.
 * Returns `=Sheet1!A1` for bare names, `='My Sheet'!A1` for names that need
 * quoting. Whitespace in `sourceCellRef` is trimmed; the caller is expected
 * to have validated the A1 shape upstream.
 */
export function buildLinkFormula(
  sourceSheetName: string,
  sourceCellRef: string,
): string {
  const quoted = quoteSheetNameIfNeeded(sourceSheetName);
  return `=${quoted}!${sourceCellRef.trim()}`;
}

// A1 → 0-based (row, col). Returns null on malformed input. Absolute markers
// ($) are tolerated and ignored — they don't affect which cell we read.
function parseA1Cell(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    if (c < 65 || c > 90) return null;
    col = col * 26 + (c - 64);
  }
  const row = parseInt(m[2], 10);
  if (!Number.isFinite(row) || row < 1) return null;
  return { row: row - 1, col: col - 1 };
}

// Resolve a sheet name to its sheet id by scanning the snapshot. Case-sensitive
// match first (matches Univer/Excel behavior), then a case-insensitive fallback
// for friendlier UX in the dialog. Returns null if unresolved.
function findSheetIdByName(
  snapshot: unknown,
  sheetName: string,
): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const sheets = (snapshot as { sheets?: Record<string, unknown> }).sheets;
  if (!sheets || typeof sheets !== "object") return null;
  const target = sheetName.trim();
  let lcMatch: string | null = null;
  for (const [sid, sh] of Object.entries(sheets)) {
    if (!sh || typeof sh !== "object") continue;
    const name = (sh as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    if (name === target) return sid;
    if (name.toLowerCase() === target.toLowerCase()) lcMatch = sid;
  }
  return lcMatch;
}

/**
 * Read the current value of a source cell from a snapshot. Used by the copy
 * mode (liveLink === false) so we can write a static snapshot of the value
 * instead of a formula. Returns `null` when the cell is empty / unresolvable —
 * callers should treat that as "clear the destination" or skip.
 *
 * Prefers `v` (computed value) over `f` (formula); we never want to copy a
 * formula in copy mode because it would be re-evaluated in the target sheet's
 * context and likely break.
 */
export function resolveSourceValue(
  snapshot: unknown,
  sourceSheetName: string,
  sourceCellRef: string,
): unknown {
  const sheetId = findSheetIdByName(snapshot, sourceSheetName);
  if (!sheetId) return null;
  const cell = parseA1Cell(sourceCellRef);
  if (!cell) return null;
  const sheets = (snapshot as { sheets?: Record<string, unknown> }).sheets ?? {};
  const sheet = sheets[sheetId] as { cellData?: unknown } | undefined;
  const cellData = sheet?.cellData;
  if (!cellData || typeof cellData !== "object") return null;
  const rowObj = (cellData as Record<string, unknown>)[String(cell.row)];
  if (!rowObj || typeof rowObj !== "object") return null;
  const cellObj = (rowObj as Record<string, unknown>)[String(cell.col)];
  if (!cellObj || typeof cellObj !== "object") return null;
  const v = (cellObj as { v?: unknown }).v;
  return v ?? null;
}

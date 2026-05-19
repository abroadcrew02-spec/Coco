// "Show All Comments" view patch (Excel View → Show All Comments toggle).
//
// When the toggle is on, every cell that carries a comment should display a
// visible hint inline — Excel renders the full note tethered to the cell,
// but Univer 0.5.x has no public cell-decoration / pixel-position API so we
// approximate by appending a small "💬 …first-20-chars" suffix to each
// commented cell's display value (`v`). The CommentsAllOverlay companion
// component renders the full text for cells the suffix has to truncate.
//
// Snapshot shape (Univer 0.5.x + Coco extension; mirrors xlsx_io.rs):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: { [row]: { [col]: { v?, f?, s?, ... } } },
//         _comments?: Array<{ cell: "A1", author?: string, text: string }>
//       }
//     }
//   }
//
// Mirrors the `patchShowFormulasView` contract:
//   - Pure: input is structurally cloned, never mutated.
//   - Idempotent: re-applying yields the same output (we detect the glyph
//     prefix and skip re-prefixing).
//   - Fail-soft: returns the input untouched on serialization errors.
//
// When `enabled` is false the patch is a true no-op — we return the snapshot
// reference unchanged so the integrator can skip a clone in the common
// "feature off" path.

const GLYPH = "\u{1F4AC}"; // 💬
const GLYPH_PREFIX = `${GLYPH} `;
const TEXT_PREVIEW_LEN = 20;

type CellLike = { v?: unknown; f?: unknown; s?: unknown } | undefined;

type SnapshotShape = {
  sheets?: Record<
    string,
    {
      cellData?: Record<string, Record<string, CellLike>>;
      _comments?: Array<{ cell?: unknown; author?: unknown; text?: unknown }>;
    } | undefined
  >;
};

/** Decode an A1 column-letter run into a 0-based column index, or -1 on bad input. */
function colLettersToIndex(letters: string): number {
  const up = letters.toUpperCase();
  let n = 0;
  for (const ch of up) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Parse a single A1 cell ref ("B12", "$AA$3") into {row, col}, 0-based. */
function parseA1(cell: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(cell.trim());
  if (!m) return null;
  const col = colLettersToIndex(m[1]);
  const row = Number.parseInt(m[2], 10);
  if (col < 0 || !Number.isFinite(row) || row < 1) return null;
  return { row: row - 1, col };
}

/** Trim a comment body to TEXT_PREVIEW_LEN chars, collapsing whitespace and
 *  appending an ellipsis when truncated. Returns "" for empty / non-string input. */
function previewText(text: unknown): string {
  if (typeof text !== "string") return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= TEXT_PREVIEW_LEN) return collapsed;
  return `${collapsed.slice(0, TEXT_PREVIEW_LEN)}…`;
}

/**
 * Return a snapshot with every commented cell's display value prefixed by a
 * "💬 ... — <preview>" hint when `enabled` is true. When `enabled` is false
 * the original snapshot reference is returned unchanged.
 *
 * Behavior per commented cell:
 *   - cell's existing `v` is preserved; we prepend the glyph and append
 *     "— <first 20 chars of comment text>" so the cell reads as
 *     `💬 <original> — <preview>` (or `💬  — <preview>` for empty cells).
 *   - When the cell already starts with the glyph prefix we leave it
 *     untouched, guaranteeing idempotence across repeat applications.
 *   - Cells named in `_comments` but missing from `cellData` get a stub
 *     `{ v: "💬  — <preview>" }` written so the hint is still visible.
 */
export function patchShowAllCommentsView<T>(snapshot: T, enabled: boolean): T {
  if (!enabled) return snapshot;
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
    const comments = sheet._comments;
    if (!Array.isArray(comments) || comments.length === 0) continue;

    const cellData =
      (sheet.cellData ?? (sheet.cellData = {})) as Record<
        string,
        Record<string, CellLike>
      >;

    for (const entry of comments) {
      if (!entry || typeof entry !== "object") continue;
      const cellRef = typeof entry.cell === "string" ? entry.cell : null;
      if (!cellRef) continue;
      const coord = parseA1(cellRef);
      if (!coord) continue;
      const preview = previewText(entry.text);

      const rowKey = String(coord.row);
      const colKey = String(coord.col);
      const rowMap = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<
        string,
        CellLike
      >;
      const existing = (rowMap[colKey] ?? {}) as Exclude<CellLike, undefined>;

      const curRaw = existing.v;
      const cur = curRaw === undefined || curRaw === null ? "" : String(curRaw);
      // Idempotence: a previously-patched cell already starts with the glyph.
      if (cur.startsWith(GLYPH_PREFIX)) continue;

      const suffix = preview ? ` — ${preview}` : "";
      const next = `${GLYPH_PREFIX}${cur}${suffix}`;
      rowMap[colKey] = { ...existing, v: next };
    }
  }

  return cloned as unknown as T;
}

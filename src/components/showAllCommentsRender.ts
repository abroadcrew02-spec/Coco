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

import {
  ICONSET_GLYPHS,
  ICONSET_MULTI_PREFIXES,
  SPARKLINE_GLYPHS_ALL,
} from "./renderGlyphs";

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

/** Does `value` begin with a sparkline glyph (any sparkline type)? Used to
 *  detect a cell that the sparkline patch wrote into earlier in the pipeline. */
function curStartsWithSparkline(value: string): boolean {
  if (value.length === 0) return false;
  const cp = value.codePointAt(0);
  if (cp === undefined) return false;
  return SPARKLINE_GLYPHS_ALL.has(String.fromCodePoint(cp));
}

/** Does `value` begin with a CF iconSet glyph followed by a space (single
 *  codepoint glyphs like ↑ / 🔴) or with a multi-char 5-rating prefix? */
function curStartsWithIconSet(value: string): boolean {
  if (value.length === 0) return false;
  for (const p of ICONSET_MULTI_PREFIXES) {
    if (value.startsWith(p)) return true;
  }
  const cp = value.codePointAt(0);
  if (cp === undefined) return false;
  const glyph = String.fromCodePoint(cp);
  if (!ICONSET_GLYPHS.has(glyph)) return false;
  return value.slice(glyph.length).startsWith(" ");
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
 *     `💬 <original> — <preview>` (or stays unchanged when there is no
 *     pre-existing cell — see "stub cells" note below).
 *   - When the cell already starts with the glyph prefix we leave it
 *     untouched, guaranteeing idempotence across repeat applications.
 *   - Cells named in `_comments` but missing from `cellData` are LEFT
 *     UNCREATED. (Audit Bug #2: the previous version wrote stub
 *     `{ v: "💬  — <preview>" }` entries that then leaked into the snapshot
 *     pipeline — they polluted CF top10/duplicate/iconSet range stats,
 *     re-decorated each other through CF iconSet, and counted in
 *     workbookStats. The CommentsAllOverlay companion reads from
 *     `_comments` directly via `computeCommentIndicators`, so it does NOT
 *     need a cellData stub to display the hint.)
 *   - When a sibling render patch (sparkline / CF iconSet / error marker)
 *     decorated the cell first, we strip its prefix off the bare text
 *     before prepending the comment glyph so we don't stack glyphs.
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

    // Bug #2 fix: don't materialize an empty cellData when we're not going to
    // write into it. If the sheet has no cellData at all, every comment maps
    // to a missing cell and we should leave the sheet alone.
    const cellData = sheet.cellData as
      | Record<string, Record<string, CellLike>>
      | undefined;
    if (!cellData) continue;

    for (const entry of comments) {
      if (!entry || typeof entry !== "object") continue;
      const cellRef = typeof entry.cell === "string" ? entry.cell : null;
      if (!cellRef) continue;
      const coord = parseA1(cellRef);
      if (!coord) continue;
      const preview = previewText(entry.text);

      const rowKey = String(coord.row);
      const colKey = String(coord.col);
      const rowObj = cellData[rowKey];
      if (!rowObj) continue; // No row → no cell → don't stub. (Audit Bug #2)
      const existing = rowObj[colKey];
      if (!existing) continue; // No cell → don't stub. CommentsAllOverlay reads
      // from `_comments` directly so the in-grid hint is purely cosmetic and
      // safe to omit when there's no underlying cell to decorate.

      const curRaw = existing.v;
      const cur = curRaw === undefined || curRaw === null ? "" : String(curRaw);
      // Idempotence: a previously-patched cell already starts with the glyph.
      if (cur.startsWith(GLYPH_PREFIX)) continue;

      // If the cell is already decorated by sparkline or CF iconSet, prefer
      // that sibling decoration over a stacked comment hint — the audit
      // explicitly calls out that result cells should be "sensible (no stacked
      // '↑ 💬  ▁▃▆▇█')". CommentsAllOverlay still surfaces the full comment
      // in the side panel, so the in-cell hint is purely cosmetic and safe to
      // omit.
      //
      // Error prefix ("⚠ ") and show-formulas replacements ("=...") are
      // intentionally allowed to stack with the comment hint: those are small
      // / non-data decorations the codebase has historically combined with
      // comments (see `extractKnownPrefixes` in showFormulasRender.ts).
      if (curStartsWithSparkline(cur) || curStartsWithIconSet(cur)) continue;
      const suffix = preview ? ` — ${preview}` : "";
      const next = `${GLYPH_PREFIX}${cur}${suffix}`;
      rowObj[colKey] = { ...existing, v: next };
    }
  }

  return cloned as unknown as T;
}

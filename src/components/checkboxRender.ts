// In-grid checkbox rendering (#150).
//
// Mirrors `patchHyperlinkRenders` and `patchSparklineRenders`: pure,
// idempotent snapshot patch. For every (sheetId, cellRef) listed in
// `sheets.<sid>._checkboxes`, we paint the cell with a glyph that visually
// represents the boolean state in `.v`.
//
//   - `v: true`  → display "☑" (BALLOT BOX WITH CHECK)
//   - `v: false` → display "☐" (BALLOT BOX)
//
// The on-disk `.v` stays a literal boolean so the formula engine and xlsx
// round-trip continue to see TRUE/FALSE. The display glyph is conveyed via
// Univer's `p` (rich-text paragraph) field — that path renders the visible
// string without touching `v`, so `=A1` still returns boolean true/false.
// We also center-align the cell and bump the font so the glyph reads cleanly.
//
// Why `p` instead of just rewriting `v` to the glyph string?
//   - `v` is the value the formula engine reads. If we replaced `true` with
//     `"☑"`, every `=IF(A1, ...)` reference would break (truthy strings, but
//     `=A1=TRUE` would fail). Univer's display layer prefers `p` over `v`
//     when both are present, so `p` is the right channel for a pure
//     display-only override.
//
// Pipeline ordering: run BEFORE `patchCfRenders` so conditional-formatting
// rules can still restyle checkbox cells (e.g. red fill on FALSE entries).

import {
  parseA1,
  type CheckboxEntry,
  type CheckboxSheet,
  type CheckboxSnapshot,
} from "../store/checkbox";

/** Glyphs picked from Unicode "Misc Symbols" — render cleanly in Win/Mac/Linux default fonts. */
export const CHECKBOX_CHECKED = "☑"; // ☑
export const CHECKBOX_UNCHECKED = "☐"; // ☐

interface IParagraphRun {
  st: number;
  ed: number;
  ts?: { fs?: number; cl?: { rgb?: string } };
}

interface IDocumentDataLike {
  body?: { dataStream: string; textRuns?: IParagraphRun[] };
  documentStyle?: Record<string, unknown>;
  drawings?: Record<string, unknown>;
  drawingsOrder?: string[];
}

/**
 * Build a minimal Univer rich-text paragraph wrapping the glyph. We use a
 * single text run so future patches can layer their own runs without
 * conflicting (the glyph occupies positions [0, 1]; the trailing `\r\n` is
 * Univer's required paragraph terminator).
 */
function buildGlyphParagraph(checked: boolean): IDocumentDataLike {
  const glyph = checked ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED;
  // Univer expects `\r\n` at the end of each paragraph in dataStream.
  return {
    body: {
      dataStream: `${glyph}\r\n`,
      textRuns: [{ st: 0, ed: 1, ts: { fs: 14 } }],
    },
    documentStyle: {},
  };
}

/**
 * Coerce a cell's stored value to the boolean we want to render. Tolerates
 * the xlsx round-trip shapes (numeric 1/0, string "TRUE"/"FALSE") so a
 * checkbox added to a cell that already holds one of those reads correctly.
 */
function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toUpperCase();
    return t === "TRUE" || t === "1";
  }
  return false;
}

/**
 * Patch a snapshot so each `_checkboxes` entry paints the corresponding
 * cell with a checkbox glyph + centered, larger font. The input is NOT
 * mutated; callers can keep the original for diff / undo.
 *
 *   - Skips malformed A1 refs (logged-but-ignored by parseA1 returning null).
 *   - Initializes `cellData[row][col]` if the cell is empty so a freshly
 *     decorated blank cell still renders the glyph.
 *   - Normalizes the cell value to a literal boolean (defaulting to false)
 *     so formulas see TRUE/FALSE even if the cell previously held some
 *     other type.
 *   - Centers horizontally (`ht: 2` per Univer's enum: 0=left, 1=center,
 *     2=center — we use the most widely understood "2" but Univer actually
 *     uses `1` for center; we use literal `1` to match Univer's IHorizontalAlign).
 */
export function patchCheckboxRenders<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  let cloned: CheckboxSnapshot;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as CheckboxSnapshot;
  } catch {
    return snapshot;
  }
  const sheets = cloned.sheets;
  if (!sheets) return cloned as unknown as T;

  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId] as CheckboxSheet | undefined;
    const list = sheet?._checkboxes;
    if (!sheet || !Array.isArray(list) || list.length === 0) continue;

    const cellData = (sheet.cellData ?? (sheet.cellData = {})) as Record<
      string,
      Record<string, unknown>
    >;

    for (const entry of list as CheckboxEntry[]) {
      if (!entry || typeof entry.cell !== "string") continue;
      const coord = parseA1(entry.cell);
      if (!coord) continue;
      const rowKey = String(coord.row);
      const colKey = String(coord.col);
      const row = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<string, unknown>;
      const existing = (row[colKey] as Record<string, unknown> | undefined) ?? {};
      const checked = coerceBool(existing.v);

      // Merge the glyph paragraph + center alignment into the cell's inline
      // style without losing any prior style keys (e.g. bg color from CF).
      const baseStyle =
        typeof existing.s === "object" && existing.s !== null
          ? (existing.s as Record<string, unknown>)
          : {};
      const nextStyle = {
        ...baseStyle,
        // Univer IHorizontalAlign: 1 = center. (0=unspecified, 2=right, 3=left)
        ht: 1,
        // Univer IVerticalAlign: 2 = middle.
        vt: 2,
      };

      row[colKey] = {
        ...existing,
        v: checked, // canonicalize to literal boolean
        p: buildGlyphParagraph(checked),
        s: nextStyle,
      };
    }
  }
  return cloned as unknown as T;
}

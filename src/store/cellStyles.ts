// Pure helpers for the Excel-style "Cell Styles" gallery (Good / Bad / Neutral,
// Headings, Title, Total, Calculation, Accents, Comma / Currency / Percent,
// ...). Kept side-effect free + framework-free so tests don't need Univer.
//
// Approach mirrors formatPainter.ts and quickNumberFormat.ts: we operate on
// the Univer 0.5.x workbook snapshot directly because FRange has no public
// `setStyle(IStyleData)` in this build. The preset's resolved style is
// merged into each cell's inline `s` field, and number-format presets
// (Comma / Currency / Percent) additionally write to the per-cell `_fmt`
// key — same path applyNumberFormat / applyQuickNumberFormat use, so the
// round-trip through xlsx_io.rs stays clean.
//
// Snapshot shape (Univer 0.5.x):
//   {
//     sheets: {
//       [sheetId]: {
//         cellData: {
//           [row]: {
//             [col]: { s?: object | string, v?: ..., _fmt?: string }
//           }
//         }
//       }
//     }
//   }
//
// The "Normal" preset (resetAll: true) deletes the cell's `s` *and* `_fmt`
// entirely — matches Excel's "Clear all styling back to defaults".
//
// We don't intern style payloads into workbook.styles — inline `s` round-trips
// fine through Univer, and dedup is the xlsx export's responsibility.

/** A partial Univer IStyleData. We avoid coupling to Univer's type at the
 *  helper boundary so the file stays framework-free. Keys mirror the shape
 *  used in conditionalFormatRender.styleForRule:
 *    bg: { rgb }            -- fill color
 *    cl: { rgb }            -- font color
 *    bl: 0|1                -- bold
 *    it: 0|1                -- italic
 *    un: { s }              -- underline
 *    ff: string             -- font family
 *    fs: number             -- font size (pt)
 *    bd: { t/b/l/r: { s, cl: { rgb } } }  -- borders
 */
export type UniverStylePartial = Record<string, unknown>;

export interface CellStylePreset {
  id: string;
  label: string;
  category:
    | "good-bad-neutral"
    | "data-model"
    | "title-heading"
    | "accent"
    | "number";
  /** Style payload merged onto each cell's `s`. Empty for number-only presets. */
  style: UniverStylePartial;
  /** Optional Excel number-format code (Comma / Currency / Percent). */
  numFmt?: string;
  /** When true, the preset clears all cell styling (Normal). */
  resetAll?: boolean;
}

// Border line-style codes follow Univer's BorderStyleTypes enum ordering:
//   1 = THIN, 2 = HAIR, 3 = DOTTED, 4 = DASHED, 5 = DASH_DOT, 6 = DASH_DOT_DOT,
//   7 = DOUBLE, 8 = MEDIUM, 9 = MEDIUM_DASHED, 10 = MEDIUM_DASH_DOT,
//   11 = MEDIUM_DASH_DOT_DOT, 12 = SLANT_DASH_DOT, 13 = THICK.
// We only use THIN (1), MEDIUM (8), DOUBLE (7), THICK (13) here.
const BORDER_THIN = 1;
const BORDER_DOUBLE = 7;
const BORDER_MEDIUM = 8;
const BORDER_THICK = 13;

const HEADING_BLUE = "#4472C4";
const BLACK = "#000000";
const WHITE = "#FFFFFF";

/** Build a border-set object covering only the requested sides. */
function border(
  sides: ReadonlyArray<"t" | "b" | "l" | "r">,
  style: number,
  rgb: string,
): UniverStylePartial {
  const bd: Record<string, { s: number; cl: { rgb: string } }> = {};
  for (const s of sides) bd[s] = { s: style, cl: { rgb } };
  return { bd };
}

function merge(...parts: UniverStylePartial[]): UniverStylePartial {
  const out: UniverStylePartial = {};
  for (const part of parts) {
    for (const k of Object.keys(part)) out[k] = part[k];
  }
  return out;
}

// Helpers for the Accent1..Accent6 family. Excel ships 6 themed accent fills
// (blue/orange/gray/yellow/blue2/green); we approximate the standard Office
// 2007+ palette here. The 20%/40%/60% tints lighten the base for use as a
// banded fill behind dark text.
interface AccentSpec {
  id: number;
  base: string;
  text20: string;
  fill20: string;
  fill40: string;
  fill60: string;
}

const ACCENTS: ReadonlyArray<AccentSpec> = [
  { id: 1, base: "#4472C4", text20: "#000000", fill20: "#D9E1F2", fill40: "#B4C7E7", fill60: "#8FAADC" },
  { id: 2, base: "#ED7D31", text20: "#000000", fill20: "#FCE4D6", fill40: "#F8CBAD", fill60: "#F4B084" },
  { id: 3, base: "#A5A5A5", text20: "#000000", fill20: "#EDEDED", fill40: "#DBDBDB", fill60: "#C9C9C9" },
  { id: 4, base: "#FFC000", text20: "#000000", fill20: "#FFF2CC", fill40: "#FFE699", fill60: "#FFD966" },
  { id: 5, base: "#5B9BD5", text20: "#000000", fill20: "#DDEBF7", fill40: "#BDD7EE", fill60: "#9DC3E6" },
  { id: 6, base: "#70AD47", text20: "#000000", fill20: "#E2EFDA", fill40: "#C6E0B4", fill60: "#A9D08E" },
];

function accentBase(spec: AccentSpec): CellStylePreset {
  return {
    id: `accent${spec.id}`,
    label: `Accent${spec.id}`,
    category: "accent",
    style: { bg: { rgb: spec.base }, cl: { rgb: WHITE }, bl: 1 },
  };
}

function accentTint(spec: AccentSpec, pct: 20 | 40 | 60): CellStylePreset {
  const fill =
    pct === 20 ? spec.fill20 : pct === 40 ? spec.fill40 : spec.fill60;
  return {
    id: `accent${spec.id}-${pct}`,
    label: `${pct}% - Accent${spec.id}`,
    category: "accent",
    style: { bg: { rgb: fill }, cl: { rgb: spec.text20 } },
  };
}

/**
 * Full Excel preset catalog. Order roughly follows Excel's gallery so users
 * see the same grouping (good/bad/neutral, then data/model, then titles,
 * then accents stacked by row, then number formats).
 */
export const CELL_STYLE_PRESETS: ReadonlyArray<CellStylePreset> = [
  // Normal — clears all styling (resetAll branch in applyPresetToRange).
  { id: "normal", label: "Normal", category: "good-bad-neutral", style: {}, resetAll: true },

  // Good / Bad / Neutral
  { id: "good", label: "Good", category: "good-bad-neutral", style: { bg: { rgb: "#C6EFCE" }, cl: { rgb: "#006100" } } },
  { id: "bad", label: "Bad", category: "good-bad-neutral", style: { bg: { rgb: "#FFC7CE" }, cl: { rgb: "#9C0006" } } },
  { id: "neutral", label: "Neutral", category: "good-bad-neutral", style: { bg: { rgb: "#FFEB9C" }, cl: { rgb: "#9C6500" } } },

  // Data / Model
  { id: "calculation", label: "Calculation", category: "data-model", style: { bg: { rgb: "#F2F2F2" }, cl: { rgb: "#FA7D00" }, bl: 1, it: 1 } },
  {
    id: "check-cell",
    label: "Check Cell",
    category: "data-model",
    style: merge(
      { bg: { rgb: "#A5A5A5" }, cl: { rgb: WHITE }, bl: 1 },
      border(["t", "b", "l", "r"], BORDER_DOUBLE, BLACK),
    ),
  },
  {
    id: "linked-cell",
    label: "Linked Cell",
    category: "data-model",
    style: merge(
      { cl: { rgb: "#FA7D00" }, it: 1 },
      border(["b"], BORDER_DOUBLE, "#FA7D00"),
    ),
  },
  {
    id: "note",
    label: "Note",
    category: "data-model",
    style: merge(
      { bg: { rgb: "#FFFFCC" } },
      border(["t", "b", "l", "r"], BORDER_THIN, "#B2B2B2"),
    ),
  },
  { id: "warning-text", label: "Warning Text", category: "data-model", style: { cl: { rgb: "#FF0000" }, it: 1 } },

  // Titles & Headings
  {
    id: "heading-1",
    label: "Heading 1",
    category: "title-heading",
    style: merge({ bl: 1, fs: 15 }, border(["b"], BORDER_THICK, HEADING_BLUE)),
  },
  {
    id: "heading-2",
    label: "Heading 2",
    category: "title-heading",
    style: merge({ bl: 1, fs: 13 }, border(["b"], BORDER_MEDIUM, HEADING_BLUE)),
  },
  {
    id: "heading-3",
    label: "Heading 3",
    category: "title-heading",
    style: merge({ bl: 1, fs: 11 }, border(["b"], BORDER_THIN, HEADING_BLUE)),
  },
  { id: "heading-4", label: "Heading 4", category: "title-heading", style: { bl: 1, it: 1 } },
  { id: "title", label: "Title", category: "title-heading", style: { bl: 1, fs: 18 } },
  {
    id: "total",
    label: "Total",
    category: "title-heading",
    // border() returns a fresh `bd` per call, so we can't chain merges for
    // top-thin + bottom-double — compose the bd map by hand.
    style: {
      bl: 1,
      bd: {
        t: { s: BORDER_THIN, cl: { rgb: BLACK } },
        b: { s: BORDER_DOUBLE, cl: { rgb: BLACK } },
      },
    },
  },

  // Accents (Accent1..Accent6 + 20%/40%/60% tints).
  ...ACCENTS.map(accentBase),
  ...ACCENTS.map((a) => accentTint(a, 60)),
  ...ACCENTS.map((a) => accentTint(a, 40)),
  ...ACCENTS.map((a) => accentTint(a, 20)),

  // Number formats — these tweak `_fmt` only; `style` left empty so the
  // cell's existing fill/font is preserved.
  { id: "comma", label: "Comma", category: "number", style: {}, numFmt: "#,##0" },
  { id: "currency", label: "Currency", category: "number", style: {}, numFmt: "¥#,##0" },
  { id: "percent", label: "Percent", category: "number", style: {}, numFmt: "0%" },
];

/** Look up a preset by id; null when unknown. */
export function getPreset(presetId: string): CellStylePreset | null {
  return CELL_STYLE_PRESETS.find((p) => p.id === presetId) ?? null;
}

interface CellStylesSnapshot {
  sheets?: Record<
    string,
    {
      cellData?: Record<
        string,
        Record<string, Record<string, unknown> | undefined> | undefined
      >;
    } | undefined
  >;
}

/** #98-style cap: refuse to materialise more than 100k empty cells for whole-
 *  column / whole-row selections. Past the cap we restrict writes to cells
 *  that already exist in cellData — same "format only used cells" behaviour
 *  applyQuickNumberFormat uses. */
const CELL_STYLE_MAX_NEW_CELLS = 100_000;

/**
 * Apply a preset to every cell in the inclusive rectangle. Returns a new
 * snapshot JSON string. No-ops (returns input) when the snapshot is malformed,
 * the sheet is missing, the preset is unknown, or the range is degenerate.
 *
 * Behaviour per cell:
 *   - When the preset is `resetAll`, drop the cell's `s` and `_fmt` keys.
 *   - Otherwise, shallow-merge the preset's `style` onto the cell's existing
 *     `s` (preserves whatever the cell already had — partial override).
 *   - When the preset has a `numFmt`, write it to `_fmt`.
 *
 * Cells outside cellData are created so formatting sticks to blank cells too
 * (Excel does the same). Past the cell cap we only paint existing cells.
 */
export function applyPresetToRange(
  snapshotJson: string,
  sheetId: string,
  range: { r1: number; c1: number; r2: number; c2: number },
  presetId: string,
): string {
  const preset = getPreset(presetId);
  if (!preset) return snapshotJson;
  const r1 = Math.min(range.r1, range.r2);
  const r2 = Math.max(range.r1, range.r2);
  const c1 = Math.min(range.c1, range.c2);
  const c2 = Math.max(range.c1, range.c2);
  if (r1 < 0 || c1 < 0) return snapshotJson;
  let parsed: CellStylesSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as CellStylesSnapshot;
  } catch {
    return snapshotJson;
  }
  if (!parsed || typeof parsed !== "object") return snapshotJson;
  const sheet = parsed.sheets?.[sheetId];
  if (!sheet) return snapshotJson;
  if (!sheet.cellData) sheet.cellData = {};
  const cellData = sheet.cellData;

  const rangeCellCount = (r2 - r1 + 1) * (c2 - c1 + 1);
  const usedRangeOnly = rangeCellCount > CELL_STYLE_MAX_NEW_CELLS;

  const styleHasKeys =
    !preset.resetAll && Object.keys(preset.style).length > 0;
  const code = preset.numFmt;

  for (let r = r1; r <= r2; r++) {
    const rowKey = String(r);
    const rowExists = cellData[rowKey] !== undefined;
    if (usedRangeOnly && !rowExists) continue;
    if (!cellData[rowKey]) cellData[rowKey] = {};
    const row = cellData[rowKey]!;
    for (let c = c1; c <= c2; c++) {
      const colKey = String(c);
      const existing = row[colKey];
      if (usedRangeOnly && existing === undefined) continue;

      if (preset.resetAll) {
        if (!existing) continue;
        const cell = existing as Record<string, unknown>;
        delete cell.s;
        delete cell._fmt;
        continue;
      }

      const cell = (existing ?? {}) as Record<string, unknown>;

      if (styleHasKeys) {
        // Merge: pull the cell's current inline style (if any) and overlay
        // the preset's keys on top. String-id `s` is replaced wholesale —
        // we can't safely mutate the interned styles table.
        let base: Record<string, unknown> = {};
        const curS = cell.s;
        if (curS && typeof curS === "object") {
          base = { ...(curS as Record<string, unknown>) };
        }
        cell.s = { ...base, ...preset.style };
      }

      if (code !== undefined) {
        if (code === "") {
          delete cell._fmt;
        } else {
          cell._fmt = code;
        }
      }

      row[colKey] = cell;
    }
  }

  return JSON.stringify(parsed);
}

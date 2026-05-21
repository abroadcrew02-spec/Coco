// In-grid form-control rendering (#183).
//
// Mirrors `patchCheckboxRenders`: a pure, idempotent snapshot patch. For every
// (sheetId, cellRef) listed in `sheets.<sid>._formControls`, we paint the host
// cell with a glyph that visually represents the control and its current
// value, conveyed through Univer's `p` (rich-text paragraph) field — the same
// display-only channel the checkbox MVP uses so the underlying `.v` and the
// formula engine stay untouched.
//
// Univer 0.5.x has no native form-control primitive and the project's pixel
// API is limited to cell `p` / `s` overrides, so — exactly like the checkbox
// MVP — we render controls as in-cell glyphs rather than free-floating
// drawing objects. The interactive behaviour (click / keyboard) is wired in
// EditorScreen via the `onCellClick` facade event + a keydown handler.
//
//   radio  → "◉ Label" when selected, "◯ Label" otherwise
//   spin   → "▲▼ <value>"  (host cell shows current linked value)
//   scroll → "◀▮▶ <value>" (host cell shows current linked value)
//
// Pipeline ordering: run alongside `patchCheckboxRenders`, BEFORE
// `patchCfRenders`, so conditional-formatting rules can still restyle the
// host cells.

import {
  parseA1,
  linkedCellOf,
  coerceNumber,
  SPIN_DEFAULTS,
  SCROLL_DEFAULTS,
  type FormControlEntry,
  type FormControlSheet,
  type FormControlSnapshot,
} from "../store/formControls";

/** Glyphs picked from Unicode "Misc Symbols" / "Geometric Shapes". */
export const RADIO_SELECTED = "◉"; // ◉ FISHEYE
export const RADIO_UNSELECTED = "○"; // ◯ LARGE CIRCLE
export const SPIN_GLYPH = "▲▼"; // ▲▼
export const SCROLL_GLYPH = "◀▮▶"; // ◀▮▶

interface IParagraphRun {
  st: number;
  ed: number;
  ts?: { fs?: number; cl?: { rgb?: string }; bl?: number };
}

interface IDocumentDataLike {
  body?: { dataStream: string; textRuns?: IParagraphRun[] };
  documentStyle?: Record<string, unknown>;
}

/**
 * Build a Univer rich-text paragraph wrapping the control's display string.
 * The glyph prefix gets a slightly larger font; the trailing `\r\n` is
 * Univer's required paragraph terminator.
 */
function buildControlParagraph(glyph: string, label: string): IDocumentDataLike {
  const text = label ? `${glyph} ${label}` : glyph;
  return {
    body: {
      dataStream: `${text}\r\n`,
      // One run for the glyph (bigger), one for the trailing label.
      textRuns: [{ st: 0, ed: glyph.length, ts: { fs: 13 } }],
    },
    documentStyle: {},
  };
}

/** Read a linked cell's `.v` from the snapshot. undefined when empty. */
function readLinked(
  sheet: FormControlSheet,
  ref: string,
): unknown {
  const coord = parseA1(ref);
  if (!coord) return undefined;
  const cell = sheet.cellData?.[String(coord.row)]?.[String(coord.col)];
  if (!cell || typeof cell !== "object") return undefined;
  return (cell as { v?: unknown }).v;
}

/** Compose the display string for one control given its linked value. */
function displayFor(entry: FormControlEntry, sheet: FormControlSheet): string {
  if (entry.kind === "radio") {
    const linkedVal = readLinked(sheet, linkedCellOf(entry));
    const optionVal = entry.optionValue ?? entry.label ?? entry.cell;
    const selected = String(linkedVal) === String(optionVal);
    const glyph = selected ? RADIO_SELECTED : RADIO_UNSELECTED;
    return entry.label ? `${glyph} ${entry.label}` : glyph;
  }
  if (entry.kind === "spin") {
    const min = entry.min ?? SPIN_DEFAULTS.min;
    const v = coerceNumber(readLinked(sheet, linkedCellOf(entry))) ?? min;
    return `${SPIN_GLYPH} ${v}`;
  }
  // scroll
  const min = entry.min ?? SCROLL_DEFAULTS.min;
  const v = coerceNumber(readLinked(sheet, linkedCellOf(entry))) ?? min;
  return `${SCROLL_GLYPH} ${v}`;
}

/** Pick the glyph length so the first text run sizes the icon, not the label. */
function glyphLengthFor(kind: FormControlEntry["kind"]): number {
  if (kind === "radio") return RADIO_SELECTED.length;
  if (kind === "spin") return SPIN_GLYPH.length;
  return SCROLL_GLYPH.length;
}

/**
 * Patch a snapshot so each `_formControls` entry paints its host cell with a
 * control glyph + value. The input is NOT mutated; callers keep the original
 * for diff / undo.
 *
 *   - Skips malformed A1 refs.
 *   - Initializes `cellData[row][col]` if the host cell is empty.
 *   - Leaves the host cell's `.v` untouched — the *display* lives in `p`, so
 *     a control hosted on a populated cell never loses its real value.
 *   - Left-aligns + vertically centers the cell so the glyph reads cleanly.
 */
export function patchFormControlRenders<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  let cloned: FormControlSnapshot;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as FormControlSnapshot;
  } catch {
    return snapshot;
  }
  const sheets = cloned.sheets;
  if (!sheets) return cloned as unknown as T;

  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId] as FormControlSheet | undefined;
    const list = sheet?._formControls;
    if (!sheet || !Array.isArray(list) || list.length === 0) continue;

    const cellData = (sheet.cellData ?? (sheet.cellData = {})) as Record<
      string,
      Record<string, unknown>
    >;

    for (const entry of list as FormControlEntry[]) {
      if (!entry || typeof entry.cell !== "string") continue;
      if (
        entry.kind !== "radio" &&
        entry.kind !== "spin" &&
        entry.kind !== "scroll"
      ) {
        continue;
      }
      const coord = parseA1(entry.cell);
      if (!coord) continue;
      const rowKey = String(coord.row);
      const colKey = String(coord.col);
      const row = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<
        string,
        unknown
      >;
      const existing = (row[colKey] as Record<string, unknown> | undefined) ?? {};

      const text = displayFor(entry, sheet);
      const glyphLen = glyphLengthFor(entry.kind);

      const baseStyle =
        typeof existing.s === "object" && existing.s !== null
          ? (existing.s as Record<string, unknown>)
          : {};
      const nextStyle = {
        ...baseStyle,
        // Univer IHorizontalAlign: 3 = left. (1 = center, 2 = right)
        ht: 3,
        // Univer IVerticalAlign: 2 = middle.
        vt: 2,
      };

      row[colKey] = {
        ...existing,
        p: {
          body: {
            dataStream: `${text}\r\n`,
            textRuns: [{ st: 0, ed: glyphLen, ts: { fs: 13 } }],
          },
          documentStyle: {},
        },
        s: nextStyle,
      };
    }
  }
  return cloned as unknown as T;
}

// Exported for unit tests / potential reuse.
export { buildControlParagraph };

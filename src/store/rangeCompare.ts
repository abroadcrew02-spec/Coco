// Pure helpers for the "Range Compare" feature — walks two cell rectangles
// (possibly on different sheets in the same workbook) and reports per-cell
// diffs, including value mismatches, formula-only mismatches (where the
// computed value is the same but the formula text drifts), and size-mismatch
// "only in A" / "only in B" rows. Excel ships this under Inquire's "Compare
// Workbooks" only for whole files; Coco's twist is range-local so users can
// audit a copied block against its source without leaving the workbook.
//
// Snapshot shape (Univer 0.5.x + Coco extension) the helpers walk — same
// shape consumed by snapshotDiff.ts / formulaAudit.ts so the cell-traversal
// pattern matches:
//   {
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;       // computed / display value
//               f?: string;        // formula text (without leading "=")
//               s?: ...            // style ref or inline IStyleData
//               p?: ...            // rich-text paragraph
//             }
//           }
//         }
//       }
//     },
//     sheetOrder?: string[]
//   }
//
// All exports here are pure (no DOM, no Univer, no Tauri dependency) so the
// dialog can call them on parsed JSON without any render-time state.

export interface RangeRef {
  sheetId: string;
  range: { r1: number; c1: number; r2: number; c2: number };
}

export interface RangeCompareCell {
  sheetId: string;
  /** A1 cell ref, e.g. "B12". Always uppercase column letters. */
  cellRef: string;
  value: unknown;
  formula?: string;
}

export interface RangeCompareDiff {
  kind:
    | "value-differ"
    | "formula-differ-value-same"
    | "only-in-a"
    | "only-in-b";
  /** Human-readable position label, e.g. "(1, 1)" — row,col offset within the
   *  range rectangle (1-based) so users can locate the mismatch within their
   *  selection regardless of where A and B live on their respective sheets. */
  positionLabel: string;
  aCell?: RangeCompareCell;
  bCell?: RangeCompareCell;
}

type CellLike = { v?: unknown; f?: unknown } | undefined;

type SheetShape = {
  name?: string;
  cellData?: Record<string, Record<string, CellLike> | undefined>;
};

type Snapshot = {
  sheets?: Record<string, SheetShape | undefined>;
  sheetOrder?: string[];
};

/** 0-based column index → A1 column letters ("A", "AA", "AAA", ...). */
function colIndexToLetters(col: number): string {
  if (!Number.isFinite(col) || col < 0) return "A";
  let n = Math.floor(col) + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Compose an A1 ref from 0-based (row, col). */
export function cellRefToA1(row: number, col: number): string {
  const r = Math.max(0, Math.floor(row)) + 1;
  return `${colIndexToLetters(col)}${r}`;
}

function parseSnapshot(input: string | object): Snapshot {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === "object" ? (parsed as Snapshot) : {};
    } catch {
      return {};
    }
  }
  if (input && typeof input === "object") return input as Snapshot;
  return {};
}

function getCell(snap: Snapshot, sheetId: string, row: number, col: number): CellLike {
  const sheet = snap.sheets?.[sheetId];
  const rowObj = sheet?.cellData?.[String(row)];
  if (!rowObj || typeof rowObj !== "object") return undefined;
  return rowObj[String(col)];
}

function extractValue(cell: CellLike): { hasContent: boolean; value: unknown; formula?: string } {
  if (cell === undefined || cell === null) return { hasContent: false, value: undefined };
  if (typeof cell !== "object") return { hasContent: true, value: cell };
  const f = (cell as { f?: unknown }).f;
  const v = (cell as { v?: unknown }).v;
  const formula = typeof f === "string" && f.length > 0 ? f : undefined;
  const valueIsBlank = v === undefined || v === null || v === "";
  if (formula === undefined && valueIsBlank) return { hasContent: false, value: undefined };
  return { hasContent: true, value: valueIsBlank ? undefined : v, formula };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Loose numeric/string equality so "42" vs 42 doesn't trip the diff —
  // matches the tolerance snapshotDiff uses for cached values.
  if (typeof a === "number" && typeof b === "string") return String(a) === b.trim();
  if (typeof a === "string" && typeof b === "number") return a.trim() === String(b);
  if (a && b && typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function normRange(r: { r1: number; c1: number; r2: number; c2: number }) {
  const r1 = Math.max(0, Math.floor(Math.min(r.r1, r.r2)));
  const r2 = Math.max(0, Math.floor(Math.max(r.r1, r.r2)));
  const c1 = Math.max(0, Math.floor(Math.min(r.c1, r.c2)));
  const c2 = Math.max(0, Math.floor(Math.max(r.c1, r.c2)));
  return { r1, c1, r2, c2 };
}

/**
 * Compare two cell rectangles. Rectangles are aligned by their top-left
 * corner: cell (r1+dr, c1+dc) in A is paired with cell (r1+dr, c1+dc) in B.
 * When the rectangles differ in size the union is walked: cells that only
 * exist on one side become `only-in-a` / `only-in-b` rows so the user can
 * see the gap.
 *
 * Tolerates malformed input — returns [] when snapshot can't be parsed.
 */
export function compareRanges(
  snapshot: string | object,
  rangeA: RangeRef,
  rangeB: RangeRef,
): RangeCompareDiff[] {
  const snap = parseSnapshot(snapshot);
  if (!snap.sheets) return [];
  if (!rangeA?.sheetId || !rangeB?.sheetId) return [];

  const a = normRange(rangeA.range);
  const b = normRange(rangeB.range);
  const aHeight = a.r2 - a.r1 + 1;
  const aWidth = a.c2 - a.c1 + 1;
  const bHeight = b.r2 - b.r1 + 1;
  const bWidth = b.c2 - b.c1 + 1;
  const height = Math.max(aHeight, bHeight);
  const width = Math.max(aWidth, bWidth);

  const out: RangeCompareDiff[] = [];

  for (let dr = 0; dr < height; dr++) {
    for (let dc = 0; dc < width; dc++) {
      const inA = dr < aHeight && dc < aWidth;
      const inB = dr < bHeight && dc < bWidth;
      const positionLabel = `(${dr + 1}, ${dc + 1})`;

      const aRow = a.r1 + dr;
      const aCol = a.c1 + dc;
      const bRow = b.r1 + dr;
      const bCol = b.c1 + dc;

      const aRaw = inA ? getCell(snap, rangeA.sheetId, aRow, aCol) : undefined;
      const bRaw = inB ? getCell(snap, rangeB.sheetId, bRow, bCol) : undefined;
      const aExt = inA ? extractValue(aRaw) : { hasContent: false, value: undefined };
      const bExt = inB ? extractValue(bRaw) : { hasContent: false, value: undefined };

      const buildA = (): RangeCompareCell => ({
        sheetId: rangeA.sheetId,
        cellRef: cellRefToA1(aRow, aCol),
        value: aExt.value,
        ...(aExt.formula !== undefined ? { formula: aExt.formula } : {}),
      });
      const buildB = (): RangeCompareCell => ({
        sheetId: rangeB.sheetId,
        cellRef: cellRefToA1(bRow, bCol),
        value: bExt.value,
        ...(bExt.formula !== undefined ? { formula: bExt.formula } : {}),
      });

      // Size mismatch: cell exists only on one side of the rectangle.
      if (inA && !inB) {
        if (aExt.hasContent) {
          out.push({ kind: "only-in-a", positionLabel, aCell: buildA() });
        }
        continue;
      }
      if (!inA && inB) {
        if (bExt.hasContent) {
          out.push({ kind: "only-in-b", positionLabel, bCell: buildB() });
        }
        continue;
      }

      // Same overlap region. Skip if both blank — nothing to report.
      if (!aExt.hasContent && !bExt.hasContent) continue;

      // Presence mismatch within the overlap region is still surfaced as
      // an only-in-X row so the user sees a cleared-vs-populated drift.
      if (aExt.hasContent && !bExt.hasContent) {
        out.push({ kind: "only-in-a", positionLabel, aCell: buildA() });
        continue;
      }
      if (!aExt.hasContent && bExt.hasContent) {
        out.push({ kind: "only-in-b", positionLabel, bCell: buildB() });
        continue;
      }

      // Both populated — compare values, then formulas-with-same-value.
      const sameValue = valuesEqual(aExt.value, bExt.value);
      if (!sameValue) {
        out.push({
          kind: "value-differ",
          positionLabel,
          aCell: buildA(),
          bCell: buildB(),
        });
        continue;
      }
      // Same computed value, but the formula text drifts. Empty/undefined
      // on either side means "literal" — flag only when both have formulas
      // and they're not character-equal.
      const aF = aExt.formula;
      const bF = bExt.formula;
      if (aF !== undefined && bF !== undefined && aF !== bF) {
        out.push({
          kind: "formula-differ-value-same",
          positionLabel,
          aCell: buildA(),
          bCell: buildB(),
        });
      }
      // Otherwise: identical — no diff row.
    }
  }

  return out;
}

/** Roll up a diff list into headline counts for the dialog's summary band. */
export function summarizeRangeCompare(diffs: RangeCompareDiff[]): {
  total: number;
  valueDiffer: number;
  formulaOnly: number;
  onlyA: number;
  onlyB: number;
} {
  let valueDiffer = 0;
  let formulaOnly = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (const d of diffs) {
    switch (d.kind) {
      case "value-differ":
        valueDiffer++;
        break;
      case "formula-differ-value-same":
        formulaOnly++;
        break;
      case "only-in-a":
        onlyA++;
        break;
      case "only-in-b":
        onlyB++;
        break;
    }
  }
  return { total: diffs.length, valueDiffer, formulaOnly, onlyA, onlyB };
}

// --- Sheet-qualified A1 parsing -------------------------------------------
// The dialog accepts inputs like "Sheet1!A1:C10" (preferred) or bare
// "A1:C10" (resolved against the default sheet). These helpers live here
// alongside compareRanges so the dialog stays presentation-only.

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Parse a possibly sheet-qualified A1 range expression. Returns null on
 *  malformed input. `sheetName` is undefined when the input is bare. */
export function parseQualifiedA1Range(
  expr: string,
): { sheetName?: string; r1: number; c1: number; r2: number; c2: number } | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  // Optional sheet-name prefix. Excel allows single-quoted names with
  // embedded spaces / punctuation; bare names are unquoted identifiers.
  const sep = trimmed.lastIndexOf("!");
  let sheetName: string | undefined;
  let body = trimmed;
  if (sep >= 0) {
    let raw = trimmed.slice(0, sep);
    body = trimmed.slice(sep + 1);
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      raw = raw.slice(1, -1).replace(/''/g, "'");
    }
    sheetName = raw;
  }
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(body);
  if (!m) return null;
  const c1 = colLetterToIndex(m[1].toUpperCase());
  const r1 = Number.parseInt(m[2], 10) - 1;
  if (c1 < 0 || r1 < 0) return null;
  if (m[3] === undefined) {
    return { sheetName, r1, c1, r2: r1, c2: c1 };
  }
  const c2 = colLetterToIndex(m[3].toUpperCase());
  const r2 = Number.parseInt(m[4], 10) - 1;
  if (c2 < 0 || r2 < 0) return null;
  return {
    sheetName,
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

/** Look up a sheetId by case-sensitive name from a snapshot. Returns null
 *  when the snapshot is malformed or no sheet matches. */
export function resolveSheetIdByName(
  snapshot: string | object,
  name: string,
): string | null {
  const snap = parseSnapshot(snapshot);
  if (!snap.sheets) return null;
  for (const id of Object.keys(snap.sheets)) {
    if (snap.sheets[id]?.name === name) return id;
  }
  return null;
}

/** List (sheetId, name) pairs in sheetOrder when available, otherwise in
 *  insertion order. Names default to sheetId for unnamed sheets. */
export function listSheets(
  snapshot: string | object,
): Array<{ sheetId: string; name: string }> {
  const snap = parseSnapshot(snapshot);
  if (!snap.sheets) return [];
  const order = Array.isArray(snap.sheetOrder)
    ? snap.sheetOrder.filter((id): id is string => typeof id === "string")
    : [];
  const seen = new Set<string>();
  const out: Array<{ sheetId: string; name: string }> = [];
  for (const id of order) {
    if (snap.sheets[id] && !seen.has(id)) {
      seen.add(id);
      out.push({ sheetId: id, name: snap.sheets[id]?.name ?? id });
    }
  }
  for (const id of Object.keys(snap.sheets)) {
    if (!seen.has(id) && snap.sheets[id]) {
      seen.add(id);
      out.push({ sheetId: id, name: snap.sheets[id]?.name ?? id });
    }
  }
  return out;
}

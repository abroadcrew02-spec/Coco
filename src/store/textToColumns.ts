// Pure helpers for Excel-style "Text to Columns" (Data → Text to Columns).
// The user selects a single column (or a single-column slice) of delimited /
// fixed-width text and the dialog splits each row into adjacent columns,
// overwriting whatever sat to the right of the source column.
//
// Kept side-effect free so it can be exercised without a live Univer instance:
// `splitText` works on bare strings, and `applyToSheet` takes a plain
// snapshot-shaped object and returns a new one with the writes applied.
//
// Snapshot shape (Univer 0.5.x):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: {
//           [row: number]: {
//             [col: number]: { v?: unknown; f?: unknown; s?: unknown; ... }
//           }
//         }
//       }
//     }
//   }
//
// "Source range" is a rectangle but the feature is column-oriented: we read
// the value at (r, sourceRange.c1) for every row in the range and write the
// split pieces to (r, sourceRange.c1 + i). Multi-column source ranges are
// tolerated (only the first column is split) to match Excel's behaviour.

export type TextToColumnsMode = "delimited" | "fixedWidth";

export interface TextToColumnsRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface TextToColumnsDelimiters {
  tab?: boolean;
  semicolon?: boolean;
  comma?: boolean;
  space?: boolean;
  /** Free-form delimiter character (single char is typical, but multi-char
   *  is accepted — Excel only allows one but we let the caller decide). */
  other?: string;
}

export type QuoteChar = "none" | "double" | "single";

export interface TextToColumnsParams {
  sourceRange: TextToColumnsRange;
  mode: TextToColumnsMode;
  delimiters?: TextToColumnsDelimiters;
  /** When true, runs of identical delimiters collapse into a single boundary
   *  ("a,,b" with comma + this flag → ["a","b"]). Defaults to false. */
  treatConsecutiveAsOne?: boolean;
  /** Quoted-field handling. When set to `double` or `single`, the matching
   *  quote opens a literal region where delimiters are ignored, and a doubled
   *  quote inside (e.g. "" inside a "..." block) collapses to a single quote. */
  quoteChar?: QuoteChar;
  /** Fixed-width column break positions (0-based character offsets). Each
   *  number marks where the *next* column starts. Order is normalised
   *  internally so callers can hand in unsorted lists. */
  fixedWidths?: number[];
  /** Strip leading/trailing whitespace from each piece after splitting. */
  trim?: boolean;
}

/** A minimal snapshot shape we know how to read & write. */
export interface CellData {
  v?: unknown;
  f?: unknown;
  s?: unknown;
  [k: string]: unknown;
}

export interface SheetData {
  cellData?: Record<number, Record<number, CellData | null | undefined>>;
  [k: string]: unknown;
}

export interface SnapshotShape {
  sheets?: Record<string, SheetData | undefined>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

function quoteCharFor(mode: QuoteChar | undefined): string | null {
  if (mode === "double") return '"';
  if (mode === "single") return "'";
  return null;
}

function buildDelimiterSet(d: TextToColumnsDelimiters | undefined): Set<string> {
  const out = new Set<string>();
  if (!d) return out;
  if (d.tab) out.add("\t");
  if (d.semicolon) out.add(";");
  if (d.comma) out.add(",");
  if (d.space) out.add(" ");
  if (d.other) {
    for (const ch of d.other) out.add(ch);
  }
  return out;
}

function splitDelimited(
  text: string,
  delims: Set<string>,
  collapseRuns: boolean,
  quote: string | null,
): string[] {
  // Empty delimiter set means "no split" — Excel returns the whole row as
  // one piece. This also keeps fixed-width mode safe if it ever reuses us.
  if (delims.size === 0) return [text];

  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let lastWasDelim = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote && ch === quote) {
      // Doubled quote inside a quoted region → literal quote, stay inside.
      if (inQuotes && text[i + 1] === quote) {
        current += quote;
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      lastWasDelim = false;
      continue;
    }

    if (!inQuotes && delims.has(ch)) {
      // Collapse a run of delimiters into a single boundary when requested
      // — emits no extra empty piece between consecutive separators.
      if (collapseRuns && lastWasDelim) continue;
      out.push(current);
      current = "";
      lastWasDelim = true;
      continue;
    }

    current += ch;
    lastWasDelim = false;
  }
  out.push(current);
  return out;
}

function splitFixedWidth(text: string, widths: number[]): string[] {
  // Sort + dedupe + drop non-positive (those would produce a leading empty
  // column the user never asked for).
  const breaks = Array.from(new Set(widths.filter((n) => Number.isFinite(n) && n > 0)))
    .map((n) => Math.floor(n))
    .sort((a, b) => a - b);
  if (breaks.length === 0) return [text];
  const out: string[] = [];
  let prev = 0;
  for (const b of breaks) {
    if (b <= prev) continue;
    out.push(text.slice(prev, b));
    prev = b;
  }
  out.push(text.slice(prev));
  return out;
}

/**
 * Split a single source string into the pieces Excel would produce for the
 * given params. Pure — no Univer / snapshot access.
 */
export function splitText(text: string, params: TextToColumnsParams): string[] {
  const raw = text ?? "";
  let pieces: string[];
  if (params.mode === "fixedWidth") {
    pieces = splitFixedWidth(raw, params.fixedWidths ?? []);
  } else {
    pieces = splitDelimited(
      raw,
      buildDelimiterSet(params.delimiters),
      params.treatConsecutiveAsOne === true,
      quoteCharFor(params.quoteChar),
    );
  }
  if (params.trim) pieces = pieces.map((p) => p.trim());
  return pieces;
}

// ---------------------------------------------------------------------------
// Snapshot mutation
// ---------------------------------------------------------------------------

function readSourceValue(cell: CellData | null | undefined): string {
  if (!cell || typeof cell !== "object") return "";
  const v = cell.v;
  if (v === null || v === undefined) return "";
  // Numbers/booleans get coerced via String() — Excel does the same when
  // "Text to Columns" runs against a numeric cell.
  return String(v);
}

/**
 * Returns a new snapshot with each source row split into adjacent columns.
 * The original `sheet` is not mutated. `overwrittenCells` counts every cell
 * write that landed on a *previously non-empty* cell to the right of the
 * source column — useful for showing a "will overwrite N cells" confirmation
 * in the UI.
 */
export function applyToSheet(
  sheet: SheetData | null | undefined,
  params: TextToColumnsParams,
): { sheetMutated: SheetData; overwrittenCells: number } {
  const next: SheetData = sheet ? { ...sheet } : {};
  const oldCellData = (sheet && sheet.cellData) || {};
  // Shallow-copy each affected row so callers comparing references can detect
  // the change without us mutating the input.
  const newCellData: Record<number, Record<number, CellData | null | undefined>> = {};
  for (const [rk, rv] of Object.entries(oldCellData)) {
    newCellData[Number(rk)] = { ...(rv ?? {}) };
  }

  const { r1, r2, c1 } = params.sourceRange;
  const rowStart = Math.min(r1, r2);
  const rowEnd = Math.max(r1, r2);
  let overwritten = 0;
  let maxPieces = 1;

  for (let r = rowStart; r <= rowEnd; r++) {
    const sourceCell = oldCellData[r]?.[c1];
    const text = readSourceValue(sourceCell);
    const pieces = splitText(text, params);
    if (pieces.length > maxPieces) maxPieces = pieces.length;

    const rowMap = newCellData[r] ?? {};
    for (let i = 0; i < pieces.length; i++) {
      const targetCol = c1 + i;
      const existing = oldCellData[r]?.[targetCol];
      // Only count cells that were previously holding a non-blank value as
      // "overwritten" — empty/blank targets are not a destructive write.
      if (
        i > 0 &&
        existing &&
        typeof existing === "object" &&
        existing.v !== undefined &&
        existing.v !== null &&
        String(existing.v) !== ""
      ) {
        overwritten++;
      }
      // Preserve any style metadata that was on the *source* cell for the
      // first piece (since we're effectively rewriting the source). For new
      // adjacent cells, drop styles — Excel writes plain text into the
      // expansion columns.
      if (i === 0 && existing && typeof existing === "object" && existing.s !== undefined) {
        rowMap[targetCol] = { v: pieces[i], s: existing.s };
      } else {
        rowMap[targetCol] = { v: pieces[i] };
      }
    }
    newCellData[r] = rowMap;
  }

  next.cellData = newCellData;
  return { sheetMutated: next, overwrittenCells: overwritten };
}

// ---------------------------------------------------------------------------
// A1 helpers (exported for the dialog so it can convert the prefilled range)
// ---------------------------------------------------------------------------

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Parse an A1 range ("A1", "A1:A10", "Sheet1!A1:A10") into a rectangle.
 *  Returns null if the input is malformed. The sheet prefix, if present, is
 *  discarded — the caller already knows which sheet they're on. */
export function parseA1RangeForTextToColumns(input: string): TextToColumnsRange | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const body = trimmed.includes("!") ? trimmed.slice(trimmed.indexOf("!") + 1) : trimmed;
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(body);
  if (!m) return null;
  const c1 = colLetterToIndex(m[1].toUpperCase());
  const r1 = parseInt(m[2], 10) - 1;
  if (c1 < 0 || r1 < 0 || !Number.isFinite(r1)) return null;
  if (m[3] === undefined) return { r1, c1, r2: r1, c2: c1 };
  const c2 = colLetterToIndex(m[3].toUpperCase());
  const r2 = parseInt(m[4], 10) - 1;
  if (c2 < 0 || r2 < 0 || !Number.isFinite(r2)) return null;
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

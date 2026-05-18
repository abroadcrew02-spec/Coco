// Pure helpers for the "Trace Precedents / Trace Dependents" formula audit
// feature. Excel draws arrows in the grid; we surface the same information
// as a sidebar panel (FormulaTracePanel) — the grid-arrow renderer in
// Univer 0.5.x is too involved to bolt on for MVP.
//
// Snapshot shape (Univer 0.5.x + Coco extension) the helpers walk — same
// layout `formulaAudit.ts` documents:
//   {
//     sheetOrder?: string[];
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;       // computed / display value
//               f?: string;        // formula text (with or without leading "=")
//             }
//           }
//         }
//       }
//     }
//   }
//
// Every export here is side-effect free (no DOM, no Univer dependency) so
// the React panel and any future engine-side integration can call them
// without dragging in render-time state.
//
// Performance: `findDependents` walks every cell in every sheet. We early
// exit per cell when `.f` is missing or empty so a workbook with only a
// handful of formulas only inspects those cells beyond the row/col scan.

/** A1-style address used by the trace panel. `sheetId` is optional — when
 *  omitted the address refers to the current sheet (matches Excel's bare
 *  `A1` vs sheet-qualified `Sheet1!A1` distinction). */
export interface CellAddress {
  sheetId?: string;
  row: number;
  col: number;
}

/** Single parsed reference extracted from a formula. Range refs populate
 *  both (r1,c1) and (r2,c2); single cells set r2/c2 equal to r1/c1.
 *  `kind === "namedRange"` carries no coordinates — `name` is the bare
 *  identifier (callers resolve via defined-names if they care). */
export interface ParsedRef {
  kind: "cell" | "range" | "namedRange";
  /** The raw substring matched in the formula, useful for snippet display. */
  raw: string;
  /** Sheet token if the ref was qualified (`Sheet1!A1` → "Sheet1"). */
  sheet?: string;
  r1?: number;
  c1?: number;
  r2?: number;
  c2?: number;
  /** Bare identifier for named-range refs. */
  name?: string;
}

type Snapshot = {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<string, Record<string, { v?: unknown; f?: unknown } | undefined>>;
      }
    | undefined
  >;
};

// ---------- A1 conversion helpers (kept private — formulaAudit.toA1Ref
// covers the same need but we avoid the cross-module import to keep this
// file standalone testable). ----------

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

/** A1 column letters → 0-based column index. Returns -1 on bad input so
 *  caller can skip the token rather than throw. */
function colLettersToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    // Accept both upper- and lower-case letters; Excel formulas are
    // case-insensitive for column refs.
    let v: number;
    if (c >= 65 && c <= 90) v = c - 64;
    else if (c >= 97 && c <= 122) v = c - 96;
    else return -1;
    n = n * 26 + v;
  }
  return n - 1;
}

/** Compose an A1 ref from 0-based (row, col). Exposed so the panel and
 *  jump-handler can format addresses without re-implementing this twice. */
export function cellRefToA1(row: number, col: number): string {
  const r = Math.max(0, Math.floor(row)) + 1;
  return `${colIndexToLetters(col)}${r}`;
}

// ---------- Formula tokenisation ----------

// Matches sheet-qualified or bare A1 cell / range references. Designed to
// be paired with a pre-pass that strips quoted string literals so we never
// match an A1-looking substring inside `"=SUM(""A1"")"`.
//
// Captures (when present):
//   1. quoted sheet name body (without surrounding quotes)        — 'Sheet 1'
//   2. unquoted sheet name                                        — Sheet1
//   3. first column letters
//   4. first row digits
//   5. second column letters (range half)
//   6. second row digits     (range half)
//
// Sheet names: Excel allows almost anything inside single quotes (and
// escapes embedded quotes by doubling them); unquoted names are alphanumeric
// plus underscore. We accept the unquoted subset that's safe to detect
// without a real parser.
const REF_RE =
  /(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))?!?(?:\$?([A-Za-z]{1,3})\$?(\d{1,7}))(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?/g;

// A "bare" sheet-qualified ref requires the `!` between sheet and address —
// REF_RE makes the sheet part optional and `!` optional independently, so
// after a match we re-check the position to confirm the `!` was actually
// there before treating the leading group as a sheet name.

/** Strip everything inside quoted string literals so REF_RE only scans
 *  identifier / reference text. We replace literal content with spaces so
 *  source offsets remain stable (helpful for snippet extraction later). */
function stripStringLiterals(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"') {
      out += " ";
      i++;
      while (i < n) {
        if (src[i] === '"' && src[i + 1] === '"') {
          // Escaped double quote inside string — consume both.
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          out += " ";
          i++;
          break;
        }
        out += " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract every cell / range / named-range reference from a formula's text.
 * Strips a leading "=" if present. Tolerates malformed input (returns []).
 *
 * Named-range detection is intentionally conservative: any bare identifier
 * that survives string-stripping, isn't followed by "(" (so it's not a
 * function call), and isn't already swallowed by an A1 match. This catches
 * `=mytotal + A1` cases without misclassifying `SUM(`.
 */
export function extractCellRefs(formula: string): ParsedRef[] {
  if (typeof formula !== "string" || formula.length === 0) return [];
  const body = formula.startsWith("=") ? formula.slice(1) : formula;
  const cleaned = stripStringLiterals(body);

  const refs: ParsedRef[] = [];
  // Track [start, end) byte ranges consumed by A1 matches so the named-
  // range pass below doesn't double-count tokens that already landed.
  const consumed: Array<[number, number]> = [];

  REF_RE.lastIndex = 0;
  for (let m = REF_RE.exec(cleaned); m !== null; m = REF_RE.exec(cleaned)) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    const quotedSheet = m[1];
    const unquotedSheet = m[2];
    const col1 = m[3];
    const row1 = m[4];
    const col2 = m[5];
    const row2 = m[6];

    // Reject the match if neither half parses — REF_RE always captures the
    // first address group on a successful match, so col1 + row1 are required.
    if (!col1 || !row1) continue;

    // If the regex captured a sheet name, the original match text must
    // contain "!"; otherwise the leading identifier was a coincidence and
    // belongs to a different token (e.g. `SUM(A1)` → "SUM" looks like a
    // sheet name but isn't because there's no "!"). Re-check the matched
    // substring directly.
    let sheet: string | undefined;
    if (quotedSheet !== undefined || unquotedSheet !== undefined) {
      if (m[0].includes("!")) {
        // Unescape Excel's doubled-quote convention inside quoted names.
        sheet = quotedSheet !== undefined ? quotedSheet.replace(/''/g, "'") : unquotedSheet;
      } else {
        // The sheet portion was a false-positive; recover by re-running the
        // match against just the address tail. Easier: skip and let a later
        // pass pick up the address — but that's brittle. Instead, treat it
        // as a sheet-less ref by ignoring the sheet captures.
        sheet = undefined;
      }
    }

    const c1 = colLettersToIndex(col1);
    const r1 = parseInt(row1, 10) - 1;
    if (c1 < 0 || !Number.isFinite(r1) || r1 < 0) continue;

    if (col2 && row2) {
      const c2 = colLettersToIndex(col2);
      const r2 = parseInt(row2, 10) - 1;
      if (c2 < 0 || !Number.isFinite(r2) || r2 < 0) continue;
      refs.push({
        kind: "range",
        raw: m[0],
        sheet,
        r1: Math.min(r1, r2),
        c1: Math.min(c1, c2),
        r2: Math.max(r1, r2),
        c2: Math.max(c1, c2),
      });
    } else {
      refs.push({
        kind: "cell",
        raw: m[0],
        sheet,
        r1,
        c1,
        r2: r1,
        c2: c1,
      });
    }

    consumed.push([matchStart, matchEnd]);
  }

  // Named-range pass: scan for bare identifiers not followed by "(" and
  // not overlapping an A1 match.
  const NAME_RE = /\b([A-Za-z_][A-Za-z0-9_.]*)\b/g;
  // A1 addresses (e.g. "A1") would otherwise look like identifiers; the
  // overlap check below skips them.
  NAME_RE.lastIndex = 0;
  for (let m = NAME_RE.exec(cleaned); m !== null; m = NAME_RE.exec(cleaned)) {
    const start = m.index;
    const end = start + m[0].length;
    if (consumed.some(([s, e]) => start < e && end > s)) continue;
    // Skip if immediately followed by "(" — that's a function call.
    let i = end;
    while (i < cleaned.length && (cleaned[i] === " " || cleaned[i] === "\t")) i++;
    if (cleaned[i] === "(") continue;
    // Skip Excel boolean / error literals and obvious noise.
    const name = m[1];
    if (
      name === "TRUE" ||
      name === "FALSE" ||
      name === "true" ||
      name === "false" ||
      name === "NULL" ||
      name === "null"
    ) {
      continue;
    }
    refs.push({ kind: "namedRange", raw: name, name });
  }

  return refs;
}

// ---------- Snapshot helpers ----------

/**
 * Walk the snapshot for the cell at (sheetId, row, col), read its `.f`
 * formula, and return every reference it contains. Sheet-qualified refs
 * resolve their sheet name to a sheetId via the snapshot's `sheets[*].name`
 * lookup; refs whose sheet name doesn't resolve are still returned (the
 * caller will fall back to displaying the raw `cellRef`).
 *
 * Tolerates malformed / partial snapshots (returns [] in the failure
 * cases) so callers don't need to pre-validate.
 */
export function findPrecedents(
  snapshot: unknown,
  sheetId: string,
  row: number,
  col: number,
): Array<{ sheetId: string; cellRef: string }> {
  if (!snapshot || typeof snapshot !== "object") return [];
  const snap = snapshot as Snapshot;
  const sheets = snap.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  const sheet = sheets[sheetId];
  if (!sheet || typeof sheet !== "object") return [];
  const cell = sheet.cellData?.[String(row)]?.[String(col)];
  if (!cell || typeof cell !== "object") return [];
  const formula = typeof cell.f === "string" ? cell.f : "";
  if (!formula) return [];

  // Build a name → sheetId map once so sheet-qualified refs resolve in
  // O(1) per reference rather than O(sheets) per reference.
  const nameToId = new Map<string, string>();
  for (const id of Object.keys(sheets)) {
    const s = sheets[id];
    if (!s || typeof s !== "object") continue;
    const name = typeof s.name === "string" && s.name.length > 0 ? s.name : id;
    nameToId.set(name, id);
  }

  const refs = extractCellRefs(formula);
  const out: Array<{ sheetId: string; cellRef: string }> = [];
  for (const ref of refs) {
    if (ref.kind === "namedRange") continue; // named ranges have no coords
    if (ref.r1 === undefined || ref.c1 === undefined) continue;
    const targetSheetId = ref.sheet ? nameToId.get(ref.sheet) ?? sheetId : sheetId;
    const cellRef =
      ref.kind === "range" && ref.r2 !== undefined && ref.c2 !== undefined
        ? `${cellRefToA1(ref.r1, ref.c1)}:${cellRefToA1(ref.r2, ref.c2)}`
        : cellRefToA1(ref.r1, ref.c1);
    out.push({ sheetId: targetSheetId, cellRef });
  }
  return out;
}

/**
 * Walk every cell in every sheet and return the ones whose `.f` references
 * (targetSheetId, targetRow, targetCol). Per cell we early-exit when `.f`
 * is empty so the dependent scan only spends real work on formula cells.
 *
 * A reference matches when:
 *  - The ref's resolved sheetId equals targetSheetId (bare refs default to
 *    the same sheet as the formula cell), AND
 *  - The target (row, col) falls within the ref's r1..r2 / c1..c2 rectangle.
 */
export function findDependents(
  snapshot: unknown,
  targetSheetId: string,
  targetRow: number,
  targetCol: number,
): Array<{ sheetId: string; cellRef: string; formula: string }> {
  if (!snapshot || typeof snapshot !== "object") return [];
  const snap = snapshot as Snapshot;
  const sheets = snap.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  // Same name → id map as findPrecedents — built once for the whole walk.
  const nameToId = new Map<string, string>();
  for (const id of Object.keys(sheets)) {
    const s = sheets[id];
    if (!s || typeof s !== "object") continue;
    const name = typeof s.name === "string" && s.name.length > 0 ? s.name : id;
    nameToId.set(name, id);
  }

  const orderedIds = Array.isArray(snap.sheetOrder) && snap.sheetOrder.length > 0
    ? snap.sheetOrder.filter((id) => typeof id === "string" && id in sheets)
    : Object.keys(sheets);

  const out: Array<{ sheetId: string; cellRef: string; formula: string }> = [];
  for (const sheetId of orderedIds) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const cellData = sheet.cellData;
    if (!cellData || typeof cellData !== "object") continue;

    for (const rowKey of Object.keys(cellData)) {
      const row = Number.parseInt(rowKey, 10);
      if (!Number.isFinite(row) || row < 0) continue;
      const rowObj = cellData[rowKey];
      if (!rowObj || typeof rowObj !== "object") continue;
      for (const colKey of Object.keys(rowObj)) {
        const col = Number.parseInt(colKey, 10);
        if (!Number.isFinite(col) || col < 0) continue;
        const cell = rowObj[colKey];
        if (!cell || typeof cell !== "object") continue;
        // Skip self — a cell trivially references its own coordinates only
        // through circular formulas, which Excel rejects; surfacing self
        // here would clutter the panel.
        if (sheetId === targetSheetId && row === targetRow && col === targetCol) continue;
        const formula = typeof cell.f === "string" ? cell.f : "";
        // Early exit: non-formula cells can't be dependents.
        if (!formula) continue;

        const refs = extractCellRefs(formula);
        for (const ref of refs) {
          if (ref.kind === "namedRange") continue;
          if (ref.r1 === undefined || ref.c1 === undefined) continue;
          const r2 = ref.r2 ?? ref.r1;
          const c2 = ref.c2 ?? ref.c1;
          const refSheetId = ref.sheet ? nameToId.get(ref.sheet) ?? sheetId : sheetId;
          if (refSheetId !== targetSheetId) continue;
          if (targetRow < ref.r1 || targetRow > r2) continue;
          if (targetCol < ref.c1 || targetCol > c2) continue;
          out.push({
            sheetId,
            cellRef: cellRefToA1(row, col),
            formula,
          });
          break; // one match per cell is enough for the panel
        }
      }
    }
  }
  return out;
}

/** Look up a sheet's display name from the snapshot, falling back to the
 *  raw id when the sheet object or name is missing. Useful for the panel's
 *  per-entry sheet label. */
export function getSheetName(snapshot: unknown, sheetId: string): string {
  if (!snapshot || typeof snapshot !== "object") return sheetId;
  const snap = snapshot as Snapshot;
  const sheet = snap.sheets?.[sheetId];
  if (!sheet || typeof sheet !== "object") return sheetId;
  return typeof sheet.name === "string" && sheet.name.length > 0 ? sheet.name : sheetId;
}

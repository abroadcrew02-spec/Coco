// Pure helpers backing the Name Box (NavigationBox) — Excel's small text
// input to the left of the formula bar that shows the active cell address
// and lets users jump to a cell / range / named range by typing.
//
// Kept side-effect free (no Univer dependency) so the component and any
// future engine integration can call them without dragging in render-time
// state. The integrator wires the parsed result back into Univer via the
// existing `jumpToA1OnSheet` helper.
//
// Snapshot shape (Univer 0.5.x + Coco extension) the helpers walk — same
// layout used by formulaTrace.ts and dataValidation.ts:
//   {
//     sheetOrder?: string[];
//     sheets: {
//       <sheetId>: {
//         name?: string;   // human-readable sheet name (e.g. "Sheet1")
//         ...
//       }
//     },
//     // Named ranges — Univer stores them under `resources` after a save;
//     // we accept either an array passed in directly (the typical
//     // EditorScreen path that calls workbook.getDefinedNames()) or a
//     // pre-extracted { name, target } pair where `target` is the formula /
//     // ref string like "=Sheet1!$A$1" or "Sheet1!$A$1:$B$2".
//   }
//
// All exports tolerate malformed input — they return either null or a
// sentinel ("invalid") rather than throwing so the input box stays usable
// even when the user is mid-typing.

/** Discriminated parse result for whatever the user typed into the box.
 *  `invalid` is preserved (not narrowed away) so the component can choose
 *  between disabling Enter and showing inline hint text. */
export type NavigationParse =
  | { kind: "cell"; a1: string }
  | { kind: "range"; a1: string }
  | { kind: "sheetCell"; sheetName: string; a1: string }
  | { kind: "sheetRange"; sheetName: string; a1: string }
  | { kind: "named"; name: string }
  | { kind: "invalid" };

// Bare A1 single-cell ref: letters + digits, optional $ anchors. We deliberately
// cap the digits at 7 to avoid pathologically large rows that Excel itself
// rejects (1,048,576 = 7 digits is the upper bound).
const CELL_RE = /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}$/;

// Bare A1 range ref: two cell refs joined by `:`. Single-cell ranges (A1:A1)
// are accepted as `range` (the resolver/component can collapse if it cares).
const RANGE_RE =
  /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}:\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}$/;

// Excel-style defined-name shape — same conservative subset NamedRangesDialog
// uses: starts with letter/underscore, ASCII alphanumeric + underscore. Any
// stricter validation (length cap, dot-form like _xlnm.Print_Area) is left to
// the consumer.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strip a surrounding pair of single quotes from a sheet name token and
 * unescape Excel's doubled-quote convention (`'O''Reilly'` → `O'Reilly`).
 * Bare names are returned as-is.
 */
function unquoteSheetName(token: string): string {
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  return token;
}

/**
 * Parse what the user typed into the name box. Whitespace at the edges is
 * trimmed; everything else (including embedded spaces in a quoted sheet
 * name) is preserved. Returns `{ kind: "invalid" }` when nothing matches —
 * callers should treat that as "disable Enter".
 */
export function parseNavigationInput(text: string): NavigationParse {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "invalid" };

  // Sheet-qualified ref — split on the first `!` that isn't inside a quoted
  // name. We hand-roll the split rather than regex so quoted sheet names
  // with embedded `!` (Excel allows them) survive intact.
  const bangIndex = findSheetSeparator(trimmed);
  if (bangIndex > 0 && bangIndex < trimmed.length - 1) {
    const sheetToken = trimmed.slice(0, bangIndex);
    const addrToken = trimmed.slice(bangIndex + 1);
    const sheetName = unquoteSheetName(sheetToken);
    if (sheetName.length === 0) return { kind: "invalid" };
    if (RANGE_RE.test(addrToken)) {
      return { kind: "sheetRange", sheetName, a1: addrToken.toUpperCase() };
    }
    if (CELL_RE.test(addrToken)) {
      return { kind: "sheetCell", sheetName, a1: addrToken.toUpperCase() };
    }
    return { kind: "invalid" };
  }

  // Bare range / cell — check range first since "A1:B2" also matches CELL_RE's
  // prefix half.
  if (RANGE_RE.test(trimmed)) {
    return { kind: "range", a1: trimmed.toUpperCase() };
  }
  if (CELL_RE.test(trimmed)) {
    return { kind: "cell", a1: trimmed.toUpperCase() };
  }

  // Named range — anything else that matches the conservative identifier
  // shape. Numbers / mixed-case tokens that already failed CELL_RE land here.
  if (NAME_RE.test(trimmed)) {
    return { kind: "named", name: trimmed };
  }

  return { kind: "invalid" };
}

/**
 * Locate the `!` that separates a sheet name from its address. Quoted sheet
 * names (`'Sheet 1'!A1`) may contain `!` inside the quotes, so we skip past
 * a balanced quoted prefix before scanning. Returns -1 when no separator is
 * present.
 */
function findSheetSeparator(text: string): number {
  if (text.startsWith("'")) {
    // Walk to the closing quote, treating `''` as an escaped literal quote.
    let i = 1;
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          i += 2;
          continue;
        }
        // Closing quote — the next char should be `!` to qualify as a sheet ref.
        if (text[i + 1] === "!") return i + 1;
        return -1;
      }
      i++;
    }
    return -1;
  }
  // Unquoted prefix: first `!` wins.
  return text.indexOf("!");
}

/** Minimal snapshot shape `resolveNamedRange` reads — kept loose so callers
 *  can pass the same JSON.parse output the trace panels already consume. */
type Snapshot = {
  sheets?: Record<string, { name?: string } | undefined>;
  // Named ranges may be stashed under any of a few keys depending on which
  // Univer plugin authored them; we don't normalize that here. Callers are
  // expected to pre-extract a list and pass it to the component as a prop.
};

/**
 * Resolve a defined-name reference (`MyRange` → `Sheet1!$A$1:$B$2`) into a
 * concrete `{ sheetId, a1 }` jump target. Returns null when the name is
 * unknown or when its formula isn't a plain sheet-qualified range we can
 * parse without a formula engine.
 *
 * Inputs:
 *   - `snapshot` is JSON.parse'd snapshot (used to map sheet *name* → *id*).
 *   - `name` is the bare defined-name identifier the user typed.
 *   - `namedRanges` is a list of `{ name, target }` where `target` is the
 *     value from `FDefinedName.getFormulaOrRefString()`. Accepts either a
 *     leading `=` or a bare reference.
 *
 * Tolerates `formula = "=SUM(A:A)"` style entries by returning null — those
 * aren't jump targets.
 */
export function resolveNamedRange(
  snapshot: unknown,
  name: string,
  namedRanges: ReadonlyArray<{ name: string; target: string }>,
): { sheetId: string; a1: string } | null {
  if (!name) return null;
  // Defined names are case-insensitive in Excel; match the same way.
  const lower = name.toLowerCase();
  const entry = namedRanges.find((r) => r.name.toLowerCase() === lower);
  if (!entry) return null;

  let target = entry.target.trim();
  if (target.startsWith("=")) target = target.slice(1).trim();
  if (!target) return null;

  // Sheet-qualified single-cell or range reference. `$` anchors are stripped
  // since `jumpToA1OnSheet` doesn't care about absolute / relative.
  const bangIndex = findSheetSeparator(target);
  if (bangIndex <= 0 || bangIndex >= target.length - 1) return null;
  const sheetToken = target.slice(0, bangIndex);
  const addr = target.slice(bangIndex + 1).replace(/\$/g, "");
  const sheetName = unquoteSheetName(sheetToken);

  if (!CELL_RE.test(addr) && !RANGE_RE.test(addr)) return null;

  if (!snapshot || typeof snapshot !== "object") return null;
  const snap = snapshot as Snapshot;
  const sheets = snap.sheets;
  if (!sheets) return null;
  for (const id of Object.keys(sheets)) {
    const s = sheets[id];
    if (!s || typeof s !== "object") continue;
    const n = typeof s.name === "string" && s.name.length > 0 ? s.name : id;
    if (n === sheetName) {
      return { sheetId: id, a1: addr.toUpperCase() };
    }
  }
  return null;
}

/**
 * Format a "{sheet}!{cell}" label for the box's read-only display state.
 * Sheet names containing spaces / non-identifier chars are wrapped in single
 * quotes per Excel's convention.
 */
export function currentCellLabel(sheetName: string, cellRef: string): string {
  const needsQuotes = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheetName);
  const sheetPart = needsQuotes
    ? "'" + sheetName.replace(/'/g, "''") + "'"
    : sheetName;
  return `${sheetPart}!${cellRef}`;
}

/**
 * Display helper — if the supplied A1-ish text is qualified by the active
 * sheet, strip the prefix so the box shows the compact "A1" form Excel
 * uses by default. Other-sheet refs are returned untouched. Bare cell refs
 * pass through unchanged.
 */
export function formatA1Compact(a1: string): string {
  if (!a1) return "";
  const bang = findSheetSeparator(a1);
  if (bang < 0) return a1;
  // We can't know the active sheet from here — the component owns that bit.
  // This helper is intentionally a no-op for non-qualified refs; the
  // component applies it after deciding whether stripping is appropriate.
  return a1.slice(bang + 1);
}

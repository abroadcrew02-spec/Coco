// Pure helpers for the "Find & Replace All Sheets" feature.
//
// Univer's bundled find-replace plugin only searches the active sheet — this
// module provides a workbook-wide alternative that walks every sheet's
// `cellData` directly off the snapshot. All exports are side-effect free so
// the dialog can call them deterministically (no Univer dependency) and so
// `replaceAll` can be wrapped by the Coco checkpoint machinery for undo.
//
// Snapshot shape (Univer 0.5.x + Coco extension) the helpers walk:
//   {
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;       // computed / display value
//               f?: string;        // formula text — preserved as-is, search
//                                  //   targets `v` only (Excel's default)
//               p?: ...            // rich-text — left untouched, value-only
//                                  //   replace
//             }
//           }
//         }
//       }
//     },
//     sheetOrder?: string[];
//   }

export type FindReplaceScope = "sheet" | "workbook";

export interface FindReplaceParams {
  find: string;
  replace?: string;
  isRegex: boolean;
  matchCase: boolean;
  matchEntireCell: boolean;
  scope: FindReplaceScope;
  /** Required when scope === "sheet" — narrows the walk to one sheet. */
  activeSheetId?: string | null;
  /** Visual-order traversal of the result list. Defaults to "rows". */
  searchBy?: "rows" | "columns";
}

export interface FindMatch {
  sheetId: string;
  sheetName: string;
  /** 0-based. */
  row: number;
  /** 0-based. */
  col: number;
  cellRef: string;
  /** The cell value coerced to string at the time of the find walk. */
  value: string;
  /** UTF-16 character offset within `value`. -1 when matchEntireCell hit. */
  matchStart: number;
  /** UTF-16 length of the match. value.length when matchEntireCell hit. */
  matchLength: number;
}

type CellLike = { v?: unknown; f?: unknown; p?: unknown } | undefined | null;
type RowMap = Record<string, CellLike>;
type CellDataMap = Record<string, RowMap | undefined>;
type SheetLike = { name?: string; cellData?: CellDataMap } | undefined | null;

interface Snapshot {
  sheets?: Record<string, SheetLike>;
  sheetOrder?: string[];
}

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

function toA1Ref(row: number, col: number): string {
  const r = Math.max(0, Math.floor(row)) + 1;
  return `${colIndexToLetters(col)}${r}`;
}

// Escape characters with regex meaning so the literal find string can run
// through the same RegExp machinery as the explicit-regex code path.
function escapeRegex(src: string): string {
  return src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a searcher function that maps `text` → match positions. Returns []
 * when the find string is empty (we never report 0-length matches — those
 * would explode into infinite results in regex mode and aren't user-useful
 * in literal mode either). Returns null when the find string was supposed
 * to be a regex but failed to compile so the dialog can surface a hint.
 */
export function compileSearcher(
  params: FindReplaceParams,
): ((text: string) => Array<{ start: number; length: number }>) | null {
  const { find, isRegex, matchCase, matchEntireCell } = params;
  if (!find) return () => [];

  // Whole-cell mode is a string compare; faster + bypasses regex entirely.
  if (matchEntireCell) {
    if (isRegex) {
      // Anchor the user's pattern so "abc" matches "abc" but not "abcdef".
      let re: RegExp;
      try {
        re = new RegExp(`^(?:${find})$`, matchCase ? "" : "i");
      } catch {
        return null;
      }
      return (text: string) => {
        if (text.length === 0 && find.length === 0) return [];
        return re.test(text) ? [{ start: -1, length: text.length }] : [];
      };
    }
    return (text: string) => {
      const a = matchCase ? text : text.toLowerCase();
      const b = matchCase ? find : find.toLowerCase();
      return a === b ? [{ start: -1, length: text.length }] : [];
    };
  }

  // Substring / regex mode. Always /g so the loop terminates.
  let re: RegExp;
  try {
    re = new RegExp(
      isRegex ? find : escapeRegex(find),
      matchCase ? "g" : "gi",
    );
  } catch {
    return null;
  }
  return (text: string) => {
    if (!text) return [];
    const out: Array<{ start: number; length: number }> = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Zero-width matches (e.g. /^/) would otherwise loop forever — bail.
      if (m[0].length === 0) {
        re.lastIndex++;
        if (re.lastIndex > text.length) break;
        continue;
      }
      out.push({ start: m.index, length: m[0].length });
    }
    return out;
  };
}

function coerceCellValue(cell: CellLike): string {
  if (!cell || typeof cell !== "object") return "";
  const v = cell.v;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function pickSheetIds(snapshot: Snapshot, params: FindReplaceParams): string[] {
  const sheets = snapshot.sheets;
  if (!sheets) return [];
  if (params.scope === "sheet") {
    const id = params.activeSheetId;
    if (id && id in sheets) return [id];
    return [];
  }
  // Workbook scope — honour declared sheet order so result rows mirror the
  // tab strip the user sees.
  const ordered =
    Array.isArray(snapshot.sheetOrder) && snapshot.sheetOrder.length > 0
      ? snapshot.sheetOrder.filter((id) => typeof id === "string" && id in sheets)
      : Object.keys(sheets);
  return ordered;
}

function sheetDisplayName(sheet: SheetLike, sheetId: string): string {
  if (sheet && typeof sheet.name === "string" && sheet.name.length > 0) {
    return sheet.name;
  }
  return sheetId;
}

/**
 * Walk every selected sheet's cellData and return one FindMatch per hit.
 * Order: by sheet (snapshot `sheetOrder` when present), then row-major or
 * column-major within the sheet depending on `searchBy`. Tolerates malformed
 * / partial snapshots — returns [] in failure cases rather than throwing.
 */
export function findAll(snapshot: unknown, params: FindReplaceParams): FindMatch[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const snap = snapshot as Snapshot;
  const searcher = compileSearcher(params);
  if (!searcher) return [];
  const sheetIds = pickSheetIds(snap, params);
  const byColumn = params.searchBy === "columns";

  const out: FindMatch[] = [];
  for (const sheetId of sheetIds) {
    const sheet = snap.sheets?.[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const cellData = sheet.cellData;
    if (!cellData || typeof cellData !== "object") continue;
    const sheetName = sheetDisplayName(sheet, sheetId);

    // Materialise (row, col, cell) tuples so we can sort independently of
    // object key order — Object.keys is insertion-ordered for integer-like
    // keys in practice, but we sort explicitly to be safe.
    const cells: Array<{ row: number; col: number; cell: CellLike }> = [];
    for (const rowKey of Object.keys(cellData)) {
      const row = Number.parseInt(rowKey, 10);
      if (!Number.isFinite(row) || row < 0) continue;
      const rowObj = cellData[rowKey];
      if (!rowObj || typeof rowObj !== "object") continue;
      for (const colKey of Object.keys(rowObj)) {
        const col = Number.parseInt(colKey, 10);
        if (!Number.isFinite(col) || col < 0) continue;
        cells.push({ row, col, cell: rowObj[colKey] });
      }
    }
    cells.sort((a, b) =>
      byColumn ? a.col - b.col || a.row - b.row : a.row - b.row || a.col - b.col,
    );

    for (const { row, col, cell } of cells) {
      const value = coerceCellValue(cell);
      const hits = searcher(value);
      for (const hit of hits) {
        out.push({
          sheetId,
          sheetName,
          row,
          col,
          cellRef: toA1Ref(row, col),
          value,
          matchStart: hit.start,
          matchLength: hit.length,
        });
      }
    }
  }
  return out;
}

// Apply the user's replace expression to one occurrence inside `value` and
// return the new string. The match metadata (`matchStart` / `matchLength`)
// from findAll pinpoints exactly which occurrence to swap so multiple hits
// in the same cell don't collide with each other when "Replace" steps
// through them one-by-one.
function applyReplaceToValue(
  value: string,
  match: { matchStart: number; matchLength: number },
  replacement: string,
): string {
  if (match.matchStart < 0) {
    // matchEntireCell — swap the whole value.
    return replacement;
  }
  const start = Math.max(0, Math.min(match.matchStart, value.length));
  const end = Math.max(start, Math.min(start + match.matchLength, value.length));
  return value.slice(0, start) + replacement + value.slice(end);
}

// Deep-clone the snapshot object (JSON round-trip is safe — snapshots are
// already JSON-serialised throughout Coco). Returning a fresh tree lets the
// caller hand the result to `updateSnapshot` without aliasing live state.
function cloneSnapshot(snapshot: unknown): Snapshot {
  if (!snapshot || typeof snapshot !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  } catch {
    return {};
  }
}

// Make sure cellData[row][col] exists as a writable object before we poke `v`
// onto it. Returns the cell record so the caller can mutate in place.
function ensureCellRecord(
  snap: Snapshot,
  sheetId: string,
  row: number,
  col: number,
): { v?: unknown } | null {
  const sheet = snap.sheets?.[sheetId];
  if (!sheet || typeof sheet !== "object") return null;
  if (!sheet.cellData || typeof sheet.cellData !== "object") {
    sheet.cellData = {};
  }
  const rowKey = String(row);
  if (!sheet.cellData[rowKey] || typeof sheet.cellData[rowKey] !== "object") {
    sheet.cellData[rowKey] = {};
  }
  const rowObj = sheet.cellData[rowKey] as RowMap;
  const colKey = String(col);
  const existing = rowObj[colKey];
  if (!existing || typeof existing !== "object") {
    rowObj[colKey] = { v: "" };
  }
  return rowObj[colKey] as { v?: unknown };
}

/**
 * Replace a single occurrence in a fresh snapshot clone. The caller passes
 * the original snapshot object; the returned object is safe to JSON.stringify
 * and hand to `updateSnapshot`. The original is left untouched.
 */
export function replaceOne(
  snapshot: unknown,
  match: FindMatch,
  replacement: string,
): object {
  const clone = cloneSnapshot(snapshot);
  const cell = ensureCellRecord(clone, match.sheetId, match.row, match.col);
  if (!cell) return clone;
  const currentValue = typeof cell.v === "string" ? cell.v : coerceCellValue(cell);
  cell.v = applyReplaceToValue(currentValue, match, replacement);
  return clone;
}

/**
 * Replace every match across the configured scope in one pass. Re-scans the
 * value within each cell so multiple hits in the same string are all swapped
 * (without the position drift you'd get if we naively re-used findAll's
 * offsets). Returns the clone + the number of substitutions actually made
 * so the dialog can show "M replacements".
 */
export function replaceAll(
  snapshot: unknown,
  params: FindReplaceParams,
): { snapshotMutated: object; replacedCount: number } {
  const clone = cloneSnapshot(snapshot);
  const searcher = compileSearcher(params);
  if (!searcher) return { snapshotMutated: clone, replacedCount: 0 };
  const replacement = params.replace ?? "";
  const sheetIds = pickSheetIds(clone, params);
  let replacedCount = 0;

  for (const sheetId of sheetIds) {
    const sheet = clone.sheets?.[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const cellData = sheet.cellData;
    if (!cellData || typeof cellData !== "object") continue;
    for (const rowKey of Object.keys(cellData)) {
      const rowObj = cellData[rowKey];
      if (!rowObj || typeof rowObj !== "object") continue;
      for (const colKey of Object.keys(rowObj)) {
        const cell = rowObj[colKey];
        if (!cell || typeof cell !== "object") continue;
        const original = coerceCellValue(cell);
        const hits = searcher(original);
        if (hits.length === 0) continue;
        if (hits[0].start < 0) {
          // matchEntireCell — single swap, count as 1.
          (cell as { v?: unknown }).v = replacement;
          replacedCount += 1;
          continue;
        }
        // Multiple substring hits — rebuild the string left-to-right so the
        // offsets stay valid even when replacement length differs from match.
        let out = "";
        let cursor = 0;
        for (const hit of hits) {
          out += original.slice(cursor, hit.start) + replacement;
          cursor = hit.start + hit.length;
          replacedCount += 1;
        }
        out += original.slice(cursor);
        (cell as { v?: unknown }).v = out;
      }
    }
  }
  return { snapshotMutated: clone, replacedCount };
}

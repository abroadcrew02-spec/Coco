// Pure helpers for Excel-style "Bulk Data Cleaning". Given a rectangle and an
// ordered list of cleaning operations, walks every string-valued cell in the
// range and rewrites `v` in place. Formula cells (`.f` set) are skipped — Excel
// applies these as values, not as TRIM()/CLEAN()/UPPER() wrappers.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: {
//           [row: string]: {
//             [col: string]: { v?: unknown; f?: unknown; p?: unknown; s?: unknown }
//           }
//         }
//       }
//     }
//   }
//
// All transformations are kept side-effect free + framework-free so the helper
// can be unit-tested with plain object literals (no Univer instance needed).
// `applyOps` is the single per-string entry point — callers compose by passing
// operations in the order they want them executed.

export type BulkCleanOp =
  | "trim"
  | "clean"
  | "upper"
  | "lower"
  | "proper"
  | "halfToFull"
  | "fullToHalf"
  | "hiraToKana"
  | "kanaToHira"
  | "stripApostrophe"
  | "normalizeNewlines";

export interface BulkCleanParams {
  /** Rectangle (0-based, inclusive) covering the cells to clean. */
  range: { r1: number; c1: number; r2: number; c2: number };
  /** Operations applied in this order. */
  ops: BulkCleanOp[];
}

export interface BulkCleanResult {
  /** Whole-snapshot JSON string with the chosen sheet rewritten. */
  snapshotMutated: string;
  /** Count of cells whose value was actually changed by the run. */
  cellsTouched: number;
}

/** Hard ceiling on the range we'll iterate — whole-column / whole-row picks
 *  would otherwise scan a million rows × 16k cols. Past this size we silently
 *  restrict writes to cells that already exist in cellData (Excel does the
 *  same — "format/clean only used cells"). */
const BULK_CLEAN_MAX_NEW_CELLS = 100_000;

// --- Per-operation transformations ---------------------------------------

// Collapse any run of unicode whitespace down to single spaces and strip
// leading/trailing whitespace. Matches Excel TRIM() semantics for inner runs
// (Excel's TRIM only handles ASCII space, but Coco follows the documented
// "collapse whitespace runs" intent — covers 　 too).
function opTrim(s: string): string {
  return s.replace(/[\s　]+/g, " ").replace(/^ +| +$/g, "");
}

// Strip the C0 control range (\x00-\x1F) — same set Excel's CLEAN() removes.
// Newlines (\x0A) and tab (\x09) are in that range and get removed too, which
// mirrors Excel.
function opClean(s: string): string {
  return s.replace(/[\x00-\x1F]/g, "");
}

function opUpper(s: string): string {
  return s.toUpperCase();
}

function opLower(s: string): string {
  return s.toLowerCase();
}

// Title-case each whitespace-delimited word: first character uppercased, the
// rest lowercased. Matches Excel PROPER() for ASCII; Unicode-aware via
// toLocaleUpperCase/Lower for accented letters.
function opProper(s: string): string {
  return s.replace(/\S+/g, (word) => {
    const first = word.charAt(0).toLocaleUpperCase();
    const rest = word.slice(1).toLocaleLowerCase();
    return first + rest;
  });
}

// ASCII printable (0x21-0x7E) → full-width (0xFF01-0xFF5E). ASCII space →
// ideographic space U+3000. Matches Excel JIS() behaviour for the printable
// subset.
function opHalfToFull(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 0x20) out += "　";
    else if (code >= 0x21 && code <= 0x7e) out += String.fromCharCode(code + 0xfee0);
    else out += ch;
  }
  return out;
}

// Reverse of halfToFull: full-width printable → ASCII, U+3000 → space.
function opFullToHalf(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out;
}

// Hiragana U+3041-U+3096 → Katakana U+30A1-U+30F6 (offset +0x60).
function opHiraToKana(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x3041 && code <= 0x3096) out += String.fromCharCode(code + 0x60);
    else out += ch;
  }
  return out;
}

// Reverse: Katakana → Hiragana (U+30A1-U+30F6 only — leave half-width katakana
// alone since they have no hiragana counterpart).
function opKanaToHira(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCharCode(code - 0x60);
    else out += ch;
  }
  return out;
}

// Strip a single leading apostrophe — Excel uses this as the "text anchor"
// prefix to force a numeric-looking string to stay text. When the cell is
// imported the apostrophe sometimes survives the round-trip; this removes it.
function opStripApostrophe(s: string): string {
  return s.startsWith("'") ? s.slice(1) : s;
}

// Normalize \r\n and bare \r to \n. Useful before pasting into systems that
// only accept LF (web inputs, JSON payloads, etc).
function opNormalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const OP_TABLE: Record<BulkCleanOp, (s: string) => string> = {
  trim: opTrim,
  clean: opClean,
  upper: opUpper,
  lower: opLower,
  proper: opProper,
  halfToFull: opHalfToFull,
  fullToHalf: opFullToHalf,
  hiraToKana: opHiraToKana,
  kanaToHira: opKanaToHira,
  stripApostrophe: opStripApostrophe,
  normalizeNewlines: opNormalizeNewlines,
};

/** Apply `ops` in argument order to `text`. Returns the original string
 *  unchanged when `ops` is empty or contains only unknown identifiers. */
export function applyOps(text: string, ops: BulkCleanOp[]): string {
  let out = text;
  for (const op of ops) {
    const fn = OP_TABLE[op];
    if (fn) out = fn(out);
  }
  return out;
}

/** Human-readable labels for the operation picker. Kept in this module (not
 *  i18n/locale.ts) so the helper stays self-contained for unit tests; the
 *  dialog can pull either side per the current locale. */
export const OP_LABELS: Record<BulkCleanOp, { ja: string; en: string }> = {
  trim: { ja: "余分な空白を除去 (TRIM)", en: "Trim whitespace (TRIM)" },
  clean: { ja: "制御文字を除去 (CLEAN)", en: "Remove control chars (CLEAN)" },
  upper: { ja: "大文字に変換 (UPPER)", en: "UPPERCASE" },
  lower: { ja: "小文字に変換 (LOWER)", en: "lowercase" },
  proper: { ja: "先頭大文字に変換 (PROPER)", en: "Title Case (PROPER)" },
  halfToFull: { ja: "半角→全角", en: "Half-width → Full-width" },
  fullToHalf: { ja: "全角→半角", en: "Full-width → Half-width" },
  hiraToKana: { ja: "ひらがな→カタカナ", en: "Hiragana → Katakana" },
  kanaToHira: { ja: "カタカナ→ひらがな", en: "Katakana → Hiragana" },
  stripApostrophe: {
    ja: "先頭のアポストロフィを除去",
    en: "Remove leading apostrophe",
  },
  normalizeNewlines: {
    ja: "改行を LF に統一",
    en: "Normalize line endings (CRLF → LF)",
  },
};

interface BulkCleanSnapshot {
  sheets?: Record<
    string,
    {
      cellData?: Record<
        string,
        Record<string, Record<string, unknown> | undefined> | undefined
      > | undefined;
    } | undefined
  >;
}

/**
 * Apply the given clean operations to every string-valued cell in the range
 * on `sheetId`. Returns a NEW snapshot JSON string. No-ops (returns input)
 * when the snapshot is malformed, the sheet is missing, the range is
 * degenerate, or `ops` is empty.
 *
 * Cells whose `.f` (formula) is set are skipped — those are computed and we
 * don't want to clobber the formula source. Cells with a non-string `.v`
 * (numbers, booleans) are skipped too. When the range is bigger than
 * BULK_CLEAN_MAX_NEW_CELLS we only visit cells that already exist in cellData.
 */
export function applyBulkClean(
  snapshotJson: string,
  sheetId: string,
  params: BulkCleanParams,
): BulkCleanResult {
  const { range, ops } = params;
  if (range.r1 > range.r2 || range.c1 > range.c2 || ops.length === 0) {
    return { snapshotMutated: snapshotJson, cellsTouched: 0 };
  }

  let parsed: BulkCleanSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as BulkCleanSnapshot;
  } catch {
    return { snapshotMutated: snapshotJson, cellsTouched: 0 };
  }
  if (!parsed || typeof parsed !== "object") {
    return { snapshotMutated: snapshotJson, cellsTouched: 0 };
  }
  const sheet = parsed.sheets?.[sheetId];
  if (!sheet) return { snapshotMutated: snapshotJson, cellsTouched: 0 };
  if (!sheet.cellData) sheet.cellData = {};
  const cellData = sheet.cellData;

  const rangeCellCount =
    (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
  const usedRangeOnly = rangeCellCount > BULK_CLEAN_MAX_NEW_CELLS;

  let cellsTouched = 0;
  for (let r = range.r1; r <= range.r2; r++) {
    const rowKey = String(r);
    const row = cellData[rowKey];
    if (!row) continue;
    if (usedRangeOnly && row === undefined) continue;
    for (let c = range.c1; c <= range.c2; c++) {
      const colKey = String(c);
      const cell = row[colKey];
      if (!cell || typeof cell !== "object") continue;
      const cellRec = cell as { v?: unknown; f?: unknown };
      // Skip formula cells — applying TRIM/UPPER to a formula source would
      // break the computation. Excel applies these operations to values, and
      // recomputed formulas would just overwrite anything we wrote anyway.
      if (cellRec.f !== undefined && cellRec.f !== null && cellRec.f !== "") {
        continue;
      }
      if (typeof cellRec.v !== "string") continue;
      const next = applyOps(cellRec.v, ops);
      if (next !== cellRec.v) {
        cellRec.v = next;
        cellsTouched++;
      }
    }
  }

  return { snapshotMutated: JSON.stringify(parsed), cellsTouched };
}

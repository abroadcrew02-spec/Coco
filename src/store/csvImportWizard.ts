// CSV Import Wizard — pure helpers for the multi-step preview dialog.
//
// This module is deliberately self-contained: no React, no Zustand store,
// no Tauri commands. The dialog (CsvImportWizardDialog.tsx) imports these
// helpers to render the per-step previews; the parent wires the final
// `CsvWizardConfig` to the existing `importCsv(path)` action.
//
// Snapshot shape: the wizard does NOT itself mutate a workbook snapshot.
// It produces a `CsvWizardConfig` describing the user's intent. Backend
// extensions (delimiter / skipRows / hasHeader / columnTypes) are a
// follow-up — for the MVP the existing `workbook_import_csv(path, encoding)`
// is invoked with auto-detect parameters; the wizard's role is purely the
// preview-and-confirm UI.

export type CsvEncoding = "auto" | "utf8" | "utf8bom" | "sjis" | "eucjp";

export type CsvDelimiter = "auto" | "," | ";" | "\t" | "|" | string;

export type CsvColumnType = "text" | "number" | "date" | "skip";

export interface CsvWizardConfig {
  /** "auto" defers to the backend's UTF-8 BOM → UTF-8 → SJIS fallback. */
  encoding: CsvEncoding;
  /** "auto" lets the parser pick from candidates by occurrence count. */
  delimiter: CsvDelimiter;
  /** Number of leading rows to drop before parsing the data body. */
  skipRows: number;
  /** When true, the first remaining row is treated as a header row. */
  hasHeader: boolean;
  /** Per-column type override. Length matches the inferred column count;
   *  "skip" omits the column from the imported sheet. */
  columnTypes: CsvColumnType[];
}

/** Lightweight heuristic encoding detection from a byte sample (typically
 *  the first 5KB of the file). Returns a concrete encoding — callers map
 *  "auto" to one of these via this helper. The detection is purely a hint
 *  for the dialog's "Detected: X" line; the backend re-runs detection on
 *  the full file when the user chooses "auto". */
export function detectEncoding(
  bytes: Uint8Array
): "utf8" | "utf8bom" | "sjis" | "eucjp" {
  // UTF-8 BOM is the only zero-ambiguity signal.
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return "utf8bom";
  }
  // Strict UTF-8 validation walk — abort on the first invalid sequence.
  if (isValidUtf8(bytes)) return "utf8";
  // Distinguish Shift_JIS from EUC-JP by counting bytes in each encoding's
  // lead-byte band. SJIS lead bytes: 0x81-0x9F, 0xE0-0xFC. EUC-JP lead bytes:
  // 0xA1-0xFE (with 0x8E for half-width kana). Whichever has more plausible
  // pair-aligned occurrences wins.
  let sjisScore = 0;
  let eucScore = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    const b = bytes[i];
    const nxt = bytes[i + 1];
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      if ((nxt >= 0x40 && nxt <= 0x7e) || (nxt >= 0x80 && nxt <= 0xfc)) {
        sjisScore++;
      }
    }
    if (b >= 0xa1 && b <= 0xfe && nxt >= 0xa1 && nxt <= 0xfe) {
      eucScore++;
    }
  }
  if (eucScore > sjisScore) return "eucjp";
  return "sjis";
}

/** Step through `bytes` and confirm every multi-byte sequence follows the
 *  UTF-8 grammar (RFC 3629). Short on the final code point counts as
 *  invalid so a truncated buffer doesn't get mislabeled. */
function isValidUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    if ((b & 0xe0) === 0xc0) need = 1;
    else if ((b & 0xf0) === 0xe0) need = 2;
    else if ((b & 0xf8) === 0xf0) need = 3;
    else return false;
    if (i + need >= bytes.length) return false;
    for (let k = 1; k <= need; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  return true;
}

/** Pick the most likely field separator by counting unquoted occurrences
 *  across the first five lines. Mirrors the backend's `infer_delimiter`
 *  spirit but stays in the browser so the preview reflects the same
 *  decision the user is about to confirm. */
export function detectDelimiter(text: string): string {
  const candidates = [",", ";", "\t", "|"];
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.length > 0).slice(0, 5);
  const counts: Record<string, number> = {
    ",": 0,
    ";": 0,
    "\t": 0,
    "|": 0,
  };
  for (const line of lines) {
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          i++; // escaped quote
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (inQuotes) continue;
      if (ch in counts) counts[ch]++;
    }
  }
  let winner = ",";
  let max = -1;
  for (const c of candidates) {
    if (counts[c] > max) {
      max = counts[c];
      winner = c;
    }
  }
  return winner;
}

/** Basic RFC4180-style parser with double-quote escaping. Sufficient for
 *  the wizard's preview (first ~10 rows); the actual import still goes
 *  through the Rust `csv` crate which handles edge cases more rigorously. */
export function parseCsvPreview(
  text: string,
  delimiter: string,
  skipRows: number
): string[][] {
  // Strip a UTF-8 BOM if it slipped through into the decoded string.
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < src.length && src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // CRLF → newline; lone CR also treated as line break (classic Mac).
      if (i + 1 < src.length && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing record (no terminating newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const skip = Math.max(0, Math.floor(skipRows));
  return rows.slice(skip);
}

/** Infer the most permissive type that accepts every non-empty value in
 *  the column. "date" requires every value to parse as a YYYY-MM-DD or
 *  YYYY/MM/DD calendar date; "number" accepts ints, floats, and signed
 *  values; falls back to "text" otherwise. Empty columns default to "text". */
export function inferColumnType(values: string[]): "text" | "number" | "date" {
  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (nonEmpty.length === 0) return "text";

  const allDates = nonEmpty.every(looksLikeDate);
  if (allDates) return "date";

  const allNumbers = nonEmpty.every(looksLikeNumber);
  if (allNumbers) return "number";

  return "text";
}

function looksLikeDate(s: string): boolean {
  const trimmed = s.trim();
  // YYYY-MM-DD or YYYY/MM/DD, optionally with HH:MM:SS appended.
  const dateRe = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/;
  if (!dateRe.test(trimmed)) return false;
  const [y, m, d] = trimmed
    .split(/[T ]/)[0]
    .split(/[-/]/)
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return true;
}

function looksLikeNumber(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  // Accept plain numerics + RFC4180 thousand-separator form ("1,234.56").
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return true;
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(trimmed)) return true;
  // Scientific notation: "1e10", "-2.5E-3".
  if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(trimmed)) return true;
  return false;
}

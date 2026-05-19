// Pure helpers for "Smart Date Recognition" — the Data → 日付に変換 batch
// tool, plus reusable date-string parsers that other features (CSV import
// wizard, paste handlers, future flash-fill suggestions) can call without
// pulling in Univer.
//
// The tool walks an inclusive rectangle of cells, attempts to parse each
// string `v` as a date using a small set of regional patterns (US MM/DD,
// EU DD/MM, Japan YYYY年M月D日, plus ISO variants), and when it matches it:
//   - rewrites the cell's `v` to an Excel date serial (1899-12-30 epoch),
//   - sets `_fmt` to the user-chosen display pattern (default "yyyy/m/d").
// Cells whose value is not a string, is blank, or fails every pattern are
// left untouched — partial conversions are expected and surfaced via the
// returned `convertedCount`.
//
// Snapshot shape (Univer 0.5.x + Coco):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: {
//           [row: number]: {
//             [col: number]: { v?: unknown; f?: unknown; s?: unknown;
//                              _fmt?: string; ... }
//           }
//         }
//       }
//     }
//   }
//
// Excel epoch matches dataValidation.ts#coerceDate: 1899-12-30 UTC, days since.

const EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export type SmartDateLocale = "us" | "eu" | "ja";

export interface SmartDateRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface ConvertToDateParams {
  range: SmartDateRange;
  locale: SmartDateLocale;
  /** Number format code written to the cell's `_fmt` slot. Defaults to
   *  "yyyy/m/d" when the caller passes an empty string. */
  outputFormat: string;
}

interface DatePattern {
  regex: RegExp;
  /** When `locale` is provided the pattern is only attempted in that locale —
   *  used to disambiguate MM/DD vs DD/MM forms which share a regex shape. */
  locale?: SmartDateLocale;
  parser: (m: RegExpMatchArray) => Date | null;
}

// Build a Date in UTC so the epoch-difference math below isn't perturbed by
// the host's timezone. Returns null when the resulting calendar values would
// roll over (e.g. month=13 or day=32).
function buildUtcDate(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): Date | null {
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  // Reject impossible calendar dates that Date.UTC silently rolls over
  // (e.g. Feb 30 → Mar 2).
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return back;
}

// Patterns are tried in order; the first match wins. Locale-specific ones
// are gated by SmartDateLocale so the same "01/02/2026" string can mean Jan 2
// in US mode and Feb 1 in EU mode.
export const DATE_PATTERNS: ReadonlyArray<DatePattern> = [
  // ISO datetime with seconds: 2026-05-18T13:45:00 / 2026-05-18 13:45:00
  {
    regex: /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/,
    parser: (m) =>
      buildUtcDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]),
  },
  // ISO datetime without seconds: 2026-05-18T13:45 / 2026-05-18 13:45
  {
    regex: /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?:Z|[+-]\d{2}:?\d{2})?$/,
    parser: (m) => buildUtcDate(+m[1], +m[2], +m[3], +m[4], +m[5], 0),
  },
  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  {
    regex: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/,
    parser: (m) => buildUtcDate(+m[1], +m[2], +m[3]),
  },
  // YYYY年M月D日 — fixed positions, no locale gate needed.
  {
    regex: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
    parser: (m) => buildUtcDate(+m[1], +m[2], +m[3]),
  },
  // M月D日 — current year. JA-only because MM/DD bareform is covered below.
  {
    regex: /^(\d{1,2})月(\d{1,2})日$/,
    locale: "ja",
    parser: (m) => buildUtcDate(new Date().getUTCFullYear(), +m[1], +m[2]),
  },
  // MM/DD/YYYY or M/D/YYYY — US convention only.
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    locale: "us",
    parser: (m) => buildUtcDate(+m[3], +m[1], +m[2]),
  },
  // Same shape, EU convention (DD/MM/YYYY).
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    locale: "eu",
    parser: (m) => buildUtcDate(+m[3], +m[2], +m[1]),
  },
  // MM-DD-YYYY (US) — Excel also accepts dashes here.
  {
    regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    locale: "us",
    parser: (m) => buildUtcDate(+m[3], +m[1], +m[2]),
  },
  // DD-MM-YYYY (EU)
  {
    regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    locale: "eu",
    parser: (m) => buildUtcDate(+m[3], +m[2], +m[1]),
  },
];

/**
 * Try every pattern in DATE_PATTERNS (filtered by locale) against `text` and
 * return the first match's Date, or null if nothing parses. Trims surrounding
 * whitespace; blank strings always return null.
 */
export function tryParseDate(text: string, locale: SmartDateLocale): Date | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const pat of DATE_PATTERNS) {
    if (pat.locale && pat.locale !== locale) continue;
    const m = pat.regex.exec(trimmed);
    if (!m) continue;
    const d = pat.parser(m);
    if (d) return d;
  }
  return null;
}

/** Convert a JS Date to an Excel date serial (days since 1899-12-30 UTC).
 *  Matches dataValidation.ts#coerceDate and rust_xlsxwriter's epoch so the
 *  serial round-trips through xlsx_io.rs untouched. */
export function dateToExcelSerial(d: Date): number {
  return (d.getTime() - EPOCH_MS) / MS_PER_DAY;
}

/** Inverse of dateToExcelSerial. Treats the serial as a UTC offset; callers
 *  that need the local representation should reformat via the returned Date. */
export function excelSerialToDate(serial: number): Date {
  return new Date(EPOCH_MS + serial * MS_PER_DAY);
}

/** Default display format when the caller doesn't override outputFormat. */
export const DEFAULT_SMART_DATE_FORMAT = "yyyy/m/d";

interface SmartDateSnapshot {
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
 * Walk the inclusive rectangle in `params.range` on the named sheet and
 * convert any cell whose string value parses as a date in the active locale
 * into an Excel date serial plus a number-format code (`_fmt`). Cells that
 * already hold a non-string value, or that fail to parse, are left as-is.
 *
 * Returns a new snapshot object (not mutated in place) and the number of
 * cells that were rewritten. No-ops (returns the input + 0) when the
 * snapshot is malformed, the sheet is missing, or the range is degenerate.
 */
export function applyConvertToDate(
  snapshot: unknown,
  sheetId: string,
  params: ConvertToDateParams,
): { snapshotMutated: object; convertedCount: number } {
  const { range, locale, outputFormat } = params;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    range.r1 > range.r2 ||
    range.c1 > range.c2
  ) {
    return { snapshotMutated: (snapshot as object) ?? {}, convertedCount: 0 };
  }
  // Deep-clone via JSON so the caller's input stays untouched — same pattern
  // applyQuickNumberFormat uses. Safe here because Univer cell payloads are
  // JSON-clean (no Dates, Maps, functions).
  const cloned = JSON.parse(JSON.stringify(snapshot)) as SmartDateSnapshot;
  const sheet = cloned.sheets?.[sheetId];
  if (!sheet) return { snapshotMutated: cloned, convertedCount: 0 };
  if (!sheet.cellData) sheet.cellData = {};
  const cellData = sheet.cellData;
  const fmtCode = (outputFormat && outputFormat.trim()) || DEFAULT_SMART_DATE_FORMAT;

  let converted = 0;
  for (let r = range.r1; r <= range.r2; r++) {
    const rowKey = String(r);
    const row = cellData[rowKey];
    if (!row) continue;
    for (let c = range.c1; c <= range.c2; c++) {
      const colKey = String(c);
      const cell = row[colKey];
      if (!cell) continue;
      // Skip formula cells — overwriting `v` while `f` still drives the value
      // would just be undone on the next recalc, and converting formula text
      // isn't what the user asked for.
      const f = (cell as { f?: unknown }).f;
      if (f !== undefined && f !== null && f !== "") continue;
      const v = (cell as { v?: unknown }).v;
      if (typeof v !== "string") continue;
      const parsed = tryParseDate(v, locale);
      if (!parsed) continue;
      const serial = dateToExcelSerial(parsed);
      const next = { ...(cell as Record<string, unknown>) };
      next.v = serial;
      next._fmt = fmtCode;
      row[colKey] = next;
      converted++;
    }
  }
  return { snapshotMutated: cloned, convertedCount: converted };
}

/**
 * Build a small preview list of "before → after" strings for the dialog. Walks
 * the same rectangle as applyConvertToDate but stops once `limit` matches
 * have been collected; unmatched cells inside the rectangle are skipped so
 * the preview always shows attempted conversions rather than empties.
 */
export function buildSmartDatePreview(
  snapshot: unknown,
  sheetId: string,
  range: SmartDateRange,
  locale: SmartDateLocale,
  outputFormat: string,
  limit = 5,
): Array<{ original: string; converted: string | "(変換不可)" }> {
  const result: Array<{ original: string; converted: string | "(変換不可)" }> = [];
  if (!snapshot || typeof snapshot !== "object") return result;
  const snap = snapshot as SmartDateSnapshot;
  const cellData = snap.sheets?.[sheetId]?.cellData;
  if (!cellData) return result;
  const fmtCode = (outputFormat && outputFormat.trim()) || DEFAULT_SMART_DATE_FORMAT;
  for (let r = range.r1; r <= range.r2 && result.length < limit; r++) {
    const row = cellData[String(r)];
    if (!row) continue;
    for (let c = range.c1; c <= range.c2 && result.length < limit; c++) {
      const cell = row[String(c)];
      if (!cell) continue;
      const f = (cell as { f?: unknown }).f;
      if (f !== undefined && f !== null && f !== "") continue;
      const v = (cell as { v?: unknown }).v;
      if (typeof v !== "string" || !v.trim()) continue;
      const parsed = tryParseDate(v, locale);
      if (!parsed) {
        result.push({ original: v, converted: "(変換不可)" });
        continue;
      }
      result.push({ original: v, converted: formatPreviewDate(parsed, fmtCode) });
    }
  }
  return result;
}

// Render a JS Date through the small handful of pattern tokens the dialog
// offers. We avoid pulling in the workbook's full numfmt engine here — this
// is a preview helper, not the authoritative formatter (Univer reformats on
// render using `_fmt`). Falls back to ISO when the code is unrecognised.
function formatPreviewDate(d: Date, code: string): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const out = code
    .replace(/yyyy/g, String(y))
    .replace(/yy/g, String(y).slice(-2))
    .replace(/mm/g, pad(m))
    .replace(/m/g, String(m))
    .replace(/dd/g, pad(day))
    .replace(/d/g, String(day));
  return out;
}

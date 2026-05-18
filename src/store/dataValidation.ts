// Pure helpers for live data-validation enforcement. B2 round-trips
// `_dataValidations[]` through xlsx and F2 added an authoring dialog, but
// without this guard a user can still type any value into a cell with a DV
// rule. The EditorScreen beforeCommandExecute hook calls `validateMutation`
// for every mutation that writes a cell value; if a rule rejects the value
// the hook throws CustomCommandExecutionError to politely cancel.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheets: {
//       <sheetId>: {
//         _dataValidations?: Array<{
//           sqref: string;           // "A1:A10" or "A1 B2:C5"
//           type?: string;           // list | decimal | whole | textLength | date | time
//           operator?: string;       // between | notBetween | equal | ...
//           formula1?: string;
//           formula2?: string;
//           allowBlank?: boolean;
//           errorMessage?: string;
//           ...
//         }>
//       }
//     }
//   }
//
// Kept side-effect free so it can be unit-tested without Univer.

export interface DataValidationRule {
  sqref?: string;
  type?: string;
  operator?: string;
  formula1?: string;
  formula2?: string;
  allowBlank?: boolean;
  errorTitle?: string;
  errorMessage?: string;
  [k: string]: unknown;
}

export interface DataValidationSnapshot {
  sheets?: Record<string, { _dataValidations?: DataValidationRule[] } | undefined>;
}

export interface ValidationError {
  code: string;
  message: string;
}

// Convert a single A1 column reference ("A", "AB") to a 0-based column index.
function colLetterToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// Parse a single A1 cell or range token like "A1" or "A1:B10" into a
// rectangle. Returns null on malformed input.
function parseA1Range(token: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(token.trim());
  if (!m) return null;
  const c1 = colLetterToIndex(m[1].toUpperCase());
  const r1 = parseInt(m[2], 10) - 1;
  if (c1 < 0 || r1 < 0 || !Number.isFinite(r1)) return null;
  if (m[3] === undefined) {
    return { r1, c1, r2: r1, c2: c1 };
  }
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

/**
 * True when (row, col) is covered by the sqref expression (space-separated
 * A1 tokens). Tolerates malformed tokens by skipping them.
 */
export function sqrefCovers(sqref: string | undefined, row: number, col: number): boolean {
  if (!sqref) return false;
  for (const token of sqref.split(/\s+/)) {
    if (!token) continue;
    const r = parseA1Range(token);
    if (!r) continue;
    if (row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2) return true;
  }
  return false;
}

// Split a list-source formula1 like `"Yes,No,Maybe"` or `Yes,No` into tokens.
// Excel/xlsx historically wraps the literal list in quotes; we strip a
// matching outer pair if present and then split on commas. Whitespace around
// each token is trimmed. Cell-reference sources (starting with `=` or `$` or
// containing `!`) are returned as a single opaque token so the caller can
// pass-through (we can't resolve formulas without the engine).
function parseListSource(formula1: string): { tokens: string[]; opaque: boolean } {
  const raw = formula1.trim();
  if (!raw) return { tokens: [], opaque: false };
  // Anything starting with `=` is a formula/range reference — opaque.
  if (raw.startsWith("=")) return { tokens: [], opaque: true };
  // Strip a single pair of matching outer quotes ("..." or '...').
  let body = raw;
  if (
    (body.startsWith('"') && body.endsWith('"') && body.length >= 2) ||
    (body.startsWith("'") && body.endsWith("'") && body.length >= 2)
  ) {
    body = body.slice(1, -1);
  }
  // Bare sheet/cell reference like Sheet1!A1 — opaque.
  if (body.includes("!") || body.startsWith("$")) return { tokens: [], opaque: true };
  return { tokens: body.split(",").map((s) => s.trim()).filter((s) => s.length > 0), opaque: false };
}

// Parse a numeric formula (literal). Excel allows `=10` or just `10`; we
// strip a leading `=` if present.
function parseNumberFormula(f: string | undefined): number | null {
  if (f === undefined || f === null) return null;
  let s = String(f).trim();
  if (!s) return null;
  if (s.startsWith("=")) s = s.slice(1).trim();
  // Allow quoted numeric literals like "10".
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** #100: Excel-style numeric normalisation. Accepts:
 *  - full-width digits (０-９) → half-width
 *  - thousand separators ("1,234" → "1234")
 *  - accounting negatives ("(50)" → "-50")
 *  - leading + sign
 *  Returns the normalized number as a JS Number, or null if still invalid.
 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    let t = value.trim();
    if (!t) return null;
    // Full-width digits + signs → ASCII.
    t = t.replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30),
    );
    t = t.replace(/[＋]/g, "+").replace(/[－−]/g, "-").replace(/[．]/g, ".");
    // Accounting parens around digits → negative.
    if (/^\([\d.,+\-]+\)$/.test(t)) {
      t = "-" + t.slice(1, -1);
    }
    // Strip thousand separators (only when surrounded by digits to avoid
    // wrecking actual decimals — JS Number uses "." not ",").
    t = t.replace(/(\d),(?=\d)/g, "$1");
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

/** #99: convert a value into an Excel date serial (days since 1899-12-30,
 *  the same epoch rust_xlsxwriter uses). Accepts:
 *   - numbers: assumed to already be Excel serials (xlsx round-trip path)
 *   - JS Date / ISO strings / YYYY-MM-DD / YYYY/MM/DD: converted from
 *     epoch ms to Excel serial
 *  Returns null on parse failure.
 *
 *  Excel/OOXML date validation rules carry their bounds in serial units
 *  (`<formula1>45000</formula1>` ≒ 2023-03-15), so the cell value MUST
 *  also be in serial units for comparison to work.
 */
function coerceDate(value: unknown): number | null {
  // Excel epoch is 1899-12-30 (accounting for the 1900-leap-year bug).
  const EPOCH_MS = Date.UTC(1899, 11, 30);
  const MS_PER_DAY = 86_400_000;
  const toSerial = (ms: number): number => (ms - EPOCH_MS) / MS_PER_DAY;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? toSerial(value.getTime()) : null;
  }
  if (typeof value === "number") {
    // Already a serial (xlsx import path stores cell `v` as serial).
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    // If the string parses as a pure number, treat it as a serial directly.
    const asNumber = Number(t);
    if (Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(t)) {
      return asNumber;
    }
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? toSerial(ms) : null;
  }
  return null;
}

function compareWithOperator(
  value: number,
  operator: string | undefined,
  f1: number | null,
  f2: number | null,
): boolean {
  // Default to `between` when operator is missing (matches the dialog default).
  const op = operator ?? "between";
  switch (op) {
    case "between":
      if (f1 === null || f2 === null) return false;
      return value >= Math.min(f1, f2) && value <= Math.max(f1, f2);
    case "notBetween":
      if (f1 === null || f2 === null) return false;
      return value < Math.min(f1, f2) || value > Math.max(f1, f2);
    case "equal":
      return f1 !== null && value === f1;
    case "notEqual":
      return f1 !== null && value !== f1;
    case "greaterThan":
      return f1 !== null && value > f1;
    case "greaterThanOrEqual":
      return f1 !== null && value >= f1;
    case "lessThan":
      return f1 !== null && value < f1;
    case "lessThanOrEqual":
      return f1 !== null && value <= f1;
    default:
      // Unknown operator — fail open so we don't block legitimate edits on
      // a rule the round-trip preserved but we don't recognise.
      return true;
  }
}

function defaultMessage(rule: DataValidationRule): string {
  if (rule.errorMessage && rule.errorMessage.trim()) return rule.errorMessage;
  switch (rule.type) {
    case "list":
      return "リストに含まれる値を入力してください。";
    case "whole":
      return "整数を入力してください。";
    case "decimal":
      return "数値を入力してください。";
    case "textLength":
      return "入力可能な文字数の範囲外です。";
    case "date":
      return "有効な日付を入力してください。";
    case "time":
      return "有効な時刻を入力してください。";
    default:
      return "入力規則に違反しています。";
  }
}

/**
 * Validate a candidate cell write against the data-validation rules on the
 * given sheet. Returns null when the value is acceptable (or when no rule
 * covers the cell, or when the rule type is unsupported / opaque), otherwise
 * an error object suitable for surfacing to the user.
 *
 * Tolerates a malformed snapshot, missing sheets, and missing rule arrays —
 * returns null in any of those cases so callers never throw on edge cases.
 */
export function validateMutation(
  snapshotJson: string | null | undefined,
  sheetId: string | null | undefined,
  row: number,
  col: number,
  newValue: unknown,
): ValidationError | null {
  if (!snapshotJson || !sheetId) return null;
  let parsed: DataValidationSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as DataValidationSnapshot;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const sheet = parsed.sheets?.[sheetId];
  const rules = sheet?._dataValidations;
  if (!Array.isArray(rules) || rules.length === 0) return null;

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    if (!sqrefCovers(rule.sqref, row, col)) continue;

    // Blank value: respect allowBlank, otherwise treat it as "no change" and
    // skip — clearing a cell shouldn't trip a DV rule by default in Excel.
    const isBlank =
      newValue === null ||
      newValue === undefined ||
      (typeof newValue === "string" && newValue.trim() === "");
    if (isBlank) {
      if (rule.allowBlank === false) {
        return { code: "blank-not-allowed", message: defaultMessage(rule) };
      }
      continue;
    }

    switch (rule.type) {
      case "list": {
        const parsedList = parseListSource(rule.formula1 ?? "");
        // Opaque source (cell reference / formula) — we can't resolve it
        // without the formula engine, so fail open.
        if (parsedList.opaque) continue;
        if (parsedList.tokens.length === 0) continue;
        const asStr = String(newValue);
        if (!parsedList.tokens.includes(asStr)) {
          return { code: "list-not-allowed", message: defaultMessage(rule) };
        }
        break;
      }
      case "whole":
      case "decimal": {
        const n = coerceNumber(newValue);
        if (n === null) {
          return { code: `${rule.type}-not-number`, message: defaultMessage(rule) };
        }
        if (rule.type === "whole" && !Number.isInteger(n)) {
          return { code: "whole-not-integer", message: defaultMessage(rule) };
        }
        const f1 = parseNumberFormula(rule.formula1);
        const f2 = parseNumberFormula(rule.formula2);
        if (!compareWithOperator(n, rule.operator, f1, f2)) {
          return { code: `${rule.type}-out-of-range`, message: defaultMessage(rule) };
        }
        break;
      }
      case "textLength": {
        const len = String(newValue).length;
        const f1 = parseNumberFormula(rule.formula1);
        const f2 = parseNumberFormula(rule.formula2);
        if (!compareWithOperator(len, rule.operator, f1, f2)) {
          return { code: "textLength-out-of-range", message: defaultMessage(rule) };
        }
        break;
      }
      case "date":
      case "time": {
        const v = coerceDate(newValue);
        if (v === null) {
          return { code: `${rule.type}-not-${rule.type}`, message: defaultMessage(rule) };
        }
        const f1raw = rule.formula1;
        const f2raw = rule.formula2;
        // Try date first, fall back to a numeric serial (Excel-style) — but
        // if neither parses, fail open (preserve user edits over a bad rule).
        const f1 = f1raw ? coerceDate(f1raw) ?? parseNumberFormula(f1raw) : null;
        const f2 = f2raw ? coerceDate(f2raw) ?? parseNumberFormula(f2raw) : null;
        if (f1 === null && (rule.operator ?? "between") !== "between") continue;
        if (!compareWithOperator(v, rule.operator, f1, f2)) {
          return { code: `${rule.type}-out-of-range`, message: defaultMessage(rule) };
        }
        break;
      }
      default:
        // Unknown / unsupported type — fail open so we don't block edits.
        continue;
    }
  }
  return null;
}

/**
 * Extract every (sheetId, row, col, value) tuple from a SetRangeValuesMutation
 * params object. Univer's `cellValue` is `{ [row]: { [col]: ICellData } }`
 * where the user-facing value lives at `.v` (formulas live at `.f` and don't
 * need DV — they're computed). Returns an empty array when params don't
 * match the expected shape so callers can fail-safe.
 */
export interface CellWrite {
  row: number;
  col: number;
  value: unknown;
}

export function extractCellWrites(params: unknown): { subUnitId: string | null; writes: CellWrite[] } {
  if (!params || typeof params !== "object") return { subUnitId: null, writes: [] };
  const p = params as { subUnitId?: unknown; cellValue?: unknown };
  const subUnitId = typeof p.subUnitId === "string" ? p.subUnitId : null;
  const cellValue = p.cellValue;
  if (!cellValue || typeof cellValue !== "object") return { subUnitId, writes: [] };
  const writes: CellWrite[] = [];
  for (const rowKey of Object.keys(cellValue)) {
    const row = Number(rowKey);
    if (!Number.isFinite(row)) continue;
    const rowObj = (cellValue as Record<string, unknown>)[rowKey];
    if (!rowObj || typeof rowObj !== "object") continue;
    for (const colKey of Object.keys(rowObj as object)) {
      const col = Number(colKey);
      if (!Number.isFinite(col)) continue;
      const cell = (rowObj as Record<string, unknown>)[colKey];
      // null/undefined → cell cleared; we surface that as value === null.
      if (cell === null || cell === undefined) {
        writes.push({ row, col, value: null });
        continue;
      }
      if (typeof cell !== "object") continue;
      const c = cell as { v?: unknown; f?: unknown };
      // Skip pure-formula writes — DV doesn't gate formula entry in Excel.
      if (c.f !== undefined && c.f !== null && c.f !== "") continue;
      // `v` may be explicitly null (clearing); preserve that for allowBlank.
      writes.push({ row, col, value: c.v ?? null });
    }
  }
  return { subUnitId, writes };
}

// In-grid conditional formatting rendering (Phase 2).
//
// The xlsx round-trip stores per-sheet rules at `sheets.<sid>._conditionalFormatting`
// (entries: { sqref, type, operator?, formula1?, formula2?, text?, rank?,
// percent?, bottom?, priority, stopIfTrue?, style? }). This module turns
// those rules into a visible highlight on every matching cell before the
// snapshot is handed to Univer, mirroring the `hyperlinkRender.ts` shape.
//
// Scope of the PoC:
//   - Operates against the snapshot's `cellData` only — same as L1's hyperlink
//     patch — so it runs once at `createUnit` time. Cells the user edits
//     in-session aren't re-evaluated until the next snapshot patch.
//   - Evaluates literal/numeric comparisons; cell- or formula-references
//     in `formula1` / `formula2` are treated as literals (Excel allows
//     `=A1` and `=SUM(...)`, but live formula evaluation is out of scope
//     for the PoC and would require a runtime formula engine).
//   - When a rule carries an authoring-time style (`style.bold`,
//     `style.fontColor`, `style.bgColor`), we use that; otherwise we fall
//     back to a default highlight (yellow fill + bold) so any matching
//     rule is at least visible.
//   - Rules are applied in ascending priority order (lower number = higher
//     priority in Excel), so the highest-priority style wins per cell.

export interface CfRuleEntry {
  sqref: string;
  type?: string;
  operator?: string;
  formula1?: string;
  formula2?: string;
  text?: string;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  priority?: number;
  stopIfTrue?: boolean;
  style?: { bold?: boolean; fontColor?: string; bgColor?: string };
}

export interface CellCoord {
  row: number;
  col: number;
}

/** Default highlight applied when a rule has no explicit `style`. */
export const DEFAULT_CF_STYLE = {
  bg: { rgb: "#fff2a8" },
  bl: 1 as const,
};

type SnapshotShape = {
  sheets?: Record<
    string,
    {
      cellData?: Record<string, Record<string, unknown>>;
      _conditionalFormatting?: CfRuleEntry[];
    }
  >;
};

/**
 * Decode an A1 column-letter run into a 0-based column index. Returns -1
 * on malformed input so callers can skip the cell silently.
 */
function colLettersToIndex(letters: string): number {
  const up = letters.toUpperCase();
  let n = 0;
  for (const ch of up) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * Parse an A1 single-cell ref (e.g. "B12", "$AA$3"). The `$` absolute
 * anchors don't affect rendering, so they're stripped.
 */
function parseA1(cell: string): CellCoord | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(cell.trim());
  if (!m) return null;
  const col = colLettersToIndex(m[1]);
  const rowNum = Number.parseInt(m[2], 10);
  if (col < 0 || !Number.isFinite(rowNum) || rowNum < 1) return null;
  return { row: rowNum - 1, col };
}

/**
 * Parse an Excel sqref into a flat list of cell coordinates. Accepts:
 *   - single cells: "A1"
 *   - ranges: "A1:C3"
 *   - space-separated mixes: "A1 B2 D4:D10"
 * Returns an empty array on any malformed piece.
 */
export function parseSqrefToCells(sqref: string): CellCoord[] {
  const out: CellCoord[] = [];
  if (typeof sqref !== "string") return out;
  const pieces = sqref.trim().split(/\s+/);
  for (const piece of pieces) {
    if (!piece) continue;
    const colon = piece.indexOf(":");
    if (colon < 0) {
      const c = parseA1(piece);
      if (c) out.push(c);
      continue;
    }
    const a = parseA1(piece.slice(0, colon));
    const b = parseA1(piece.slice(colon + 1));
    if (!a || !b) continue;
    const r0 = Math.min(a.row, b.row);
    const r1 = Math.max(a.row, b.row);
    const c0 = Math.min(a.col, b.col);
    const c1 = Math.max(a.col, b.col);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) out.push({ row: r, col: c });
    }
  }
  return out;
}

/**
 * Pull a numeric or string value out of a Univer cellData entry. Cells may
 * carry `{ v: number | string }` or rich-text via `p`; we read `v` only,
 * which matches what cfRule formulas typically compare against.
 */
function readCellValue(cellData: Record<string, Record<string, unknown>> | undefined, row: number, col: number): unknown {
  if (!cellData) return undefined;
  const r = cellData[String(row)];
  if (!r) return undefined;
  const cell = r[String(col)] as Record<string, unknown> | undefined;
  if (!cell) return undefined;
  return cell.v;
}

/**
 * Coerce a cfRule formula token into a number. Excel formulas can be:
 *   - bare numbers ("100", "3.14")
 *   - quoted strings (for text comparison)
 *   - cell refs / functions ("=A1", "=SUM(B:B)") — unsupported, returns NaN
 * Leading `=` is stripped; quoted-string forms are also handled.
 */
function parseFormulaNumber(f: string | undefined): number {
  if (f === undefined || f === null) return Number.NaN;
  let s = String(f).trim();
  if (s.startsWith("=")) s = s.slice(1).trim();
  // Quoted strings can't be numeric.
  if (s.startsWith("\"") || s.startsWith("'")) return Number.NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Strip leading `=` and surrounding quotes from a formula token, returning the literal text. */
function parseFormulaString(f: string | undefined): string {
  if (f === undefined || f === null) return "";
  let s = String(f).trim();
  if (s.startsWith("=")) s = s.slice(1).trim();
  if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
    s = s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

/** Coerce a cell value to a number, returning NaN if non-numeric. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

/**
 * Evaluate a cellIs rule against a single value. Returns false (no
 * highlight) when the value is non-numeric or the comparison can't be
 * resolved (e.g. greaterThan with a non-numeric formula1).
 */
export function evaluateCellIs(
  value: unknown,
  operator: string | undefined,
  formula1: string | undefined,
  formula2: string | undefined,
): boolean {
  const n = toNumber(value);
  // notEqual is allowed to test strings too — handle that path first.
  if (operator === "equal" || operator === "notEqual") {
    const a = String(value ?? "");
    const b = parseFormulaString(formula1);
    const eq = a === b || (toNumber(value) === parseFormulaNumber(formula1) && !Number.isNaN(toNumber(value)));
    return operator === "equal" ? eq : !eq;
  }
  if (Number.isNaN(n)) return false;
  const f1 = parseFormulaNumber(formula1);
  switch (operator) {
    case "greaterThan":
      return Number.isFinite(f1) && n > f1;
    case "greaterThanOrEqual":
      return Number.isFinite(f1) && n >= f1;
    case "lessThan":
      return Number.isFinite(f1) && n < f1;
    case "lessThanOrEqual":
      return Number.isFinite(f1) && n <= f1;
    case "between":
    case "notBetween": {
      const f2 = parseFormulaNumber(formula2);
      if (!Number.isFinite(f1) || !Number.isFinite(f2)) return false;
      const lo = Math.min(f1, f2);
      const hi = Math.max(f1, f2);
      const inside = n >= lo && n <= hi;
      return operator === "between" ? inside : !inside;
    }
    default:
      return false;
  }
}

/** Evaluate a containsText rule (substring, case-insensitive per Excel). */
export function evaluateContainsText(value: unknown, text: string | undefined): boolean {
  if (!text) return false;
  if (value === undefined || value === null) return false;
  return String(value).toLowerCase().includes(text.toLowerCase());
}

/**
 * Compute the set of values that qualify for a top-10 rule, given the
 * full value list over the sqref. `rank` is the N (default 10). `percent`
 * switches the count to a percentage of populated cells. `bottom`
 * switches sort order. Returns the selected numeric set; non-numeric
 * cells are excluded from the ranking (matching Excel behavior).
 */
export function evaluateTop10(
  values: unknown[],
  rank: number | undefined,
  percent: boolean | undefined,
  bottom: boolean | undefined,
): Set<number> {
  const nums = values.map(toNumber).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return new Set();
  const n = Math.max(1, rank ?? 10);
  let take: number;
  if (percent) {
    // Excel rounds *up* for percentages: 50% of 3 values = 2, not 1.
    take = Math.max(1, Math.ceil((nums.length * n) / 100));
  } else {
    take = Math.min(nums.length, n);
  }
  const sorted = [...nums].sort((a, b) => (bottom ? a - b : b - a));
  return new Set(sorted.slice(0, take));
}

/** Evaluate a duplicate-values rule: true when `target` appears 2+ times in `values`. */
export function evaluateDuplicate(values: unknown[], target: unknown): boolean {
  if (target === undefined || target === null || target === "") return false;
  let count = 0;
  const key = String(target);
  for (const v of values) {
    if (v === undefined || v === null || v === "") continue;
    if (String(v) === key) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

/** Evaluate a unique-values rule: true when `target` appears exactly once. */
export function evaluateUnique(values: unknown[], target: unknown): boolean {
  if (target === undefined || target === null || target === "") return false;
  let count = 0;
  const key = String(target);
  for (const v of values) {
    if (v === undefined || v === null || v === "") continue;
    if (String(v) === key) {
      count++;
      if (count >= 2) return false;
    }
  }
  return count === 1;
}

/**
 * Translate a CfRuleEntry's `style` field (authoring-time) plus a default
 * fallback into the Univer IStyleData partial we merge into a cell's `s`.
 */
function styleForRule(rule: CfRuleEntry): Record<string, unknown> {
  const s = rule.style;
  const hasAny = s && (s.bold || s.fontColor || s.bgColor);
  if (!hasAny) {
    return { bg: { rgb: DEFAULT_CF_STYLE.bg.rgb }, bl: DEFAULT_CF_STYLE.bl };
  }
  const out: Record<string, unknown> = {};
  if (s?.bold) out.bl = 1;
  if (s?.fontColor) out.cl = { rgb: s.fontColor };
  if (s?.bgColor) out.bg = { rgb: s.bgColor };
  return out;
}

/**
 * Decide whether a rule matches a particular cell value. For range-aware
 * rules (top10, duplicate, unique), the caller passes the full value set.
 */
function ruleMatches(rule: CfRuleEntry, value: unknown, rangeValues: unknown[]): boolean {
  const type = rule.type ?? "";
  switch (type) {
    case "cellIs":
      return evaluateCellIs(value, rule.operator, rule.formula1, rule.formula2);
    case "containsText":
      return evaluateContainsText(value, rule.text);
    case "top10": {
      const winners = evaluateTop10(rangeValues, rule.rank, rule.percent, rule.bottom);
      const n = toNumber(value);
      return !Number.isNaN(n) && winners.has(n);
    }
    case "duplicateValues":
      return evaluateDuplicate(rangeValues, value);
    case "uniqueValues":
      return evaluateUnique(rangeValues, value);
    default:
      return false;
  }
}

/**
 * Return a new snapshot with CF-matching cells styled in place. Pure —
 * does not mutate the input. Mirrors `patchHyperlinkRenders`'s contract.
 *
 * Order of operations per sheet:
 *   1. Sort rules ascending by priority (lower = higher priority).
 *   2. Reverse-iterate so the highest-priority style is applied last and
 *      wins on collision. (We use the existing-style merge: matching
 *      keys overwrite.)
 *   3. For range-aware rules, gather the rangeValues once; for cellIs /
 *      containsText, we only need the per-cell value.
 */
export function patchCfRenders<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  let cloned: SnapshotShape;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
  } catch {
    return snapshot;
  }

  const sheets = cloned.sheets;
  if (!sheets) return cloned as unknown as T;

  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId];
    const rules = sheet?._conditionalFormatting;
    if (!Array.isArray(rules) || rules.length === 0) continue;

    const cellData = (sheet.cellData ?? (sheet.cellData = {})) as Record<
      string,
      Record<string, unknown>
    >;

    // Ascending priority = highest-priority first (Excel convention).
    // We iterate low-to-high and let later (lower-priority) writes only
    // fill keys not already set, so the first rule wins per style key.
    const sorted = [...rules]
      .filter((r) => r && typeof r === "object" && typeof r.sqref === "string")
      .sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));

    for (const rule of sorted) {
      const coords = parseSqrefToCells(rule.sqref);
      if (coords.length === 0) continue;
      // Pre-collect values when the rule is range-aware.
      let rangeValues: unknown[] = [];
      const t = rule.type ?? "";
      if (t === "top10" || t === "duplicateValues" || t === "uniqueValues") {
        rangeValues = coords.map((c) => readCellValue(cellData, c.row, c.col));
      }
      const styleDelta = styleForRule(rule);
      for (const { row, col } of coords) {
        const value = readCellValue(cellData, row, col);
        if (!ruleMatches(rule, value, rangeValues)) continue;
        const rowKey = String(row);
        const colKey = String(col);
        const rowMap = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<string, unknown>;
        const existing = (rowMap[colKey] as Record<string, unknown> | undefined) ?? {};
        const baseStyle =
          typeof existing.s === "object" && existing.s !== null
            ? (existing.s as Record<string, unknown>)
            : {};
        // Higher-priority rule already wrote these keys — keep them.
        const mergedStyle: Record<string, unknown> = { ...baseStyle };
        for (const k of Object.keys(styleDelta)) {
          if (!(k in mergedStyle)) mergedStyle[k] = styleDelta[k];
        }
        rowMap[colKey] = {
          ...existing,
          s: mergedStyle,
        };
      }
    }
  }

  return cloned as unknown as T;
}

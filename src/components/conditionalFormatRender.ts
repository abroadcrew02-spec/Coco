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
  // new in this round: advanced CF rule fields
  color?: string;
  colorScaleType?: "2color" | "3color";
  minColor?: string;
  midColor?: string;
  maxColor?: string;
  iconStyle?: "3arrows" | "3traffic" | "5rating";
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

/** Parse a column-only ref like "A", "$AA" — returns the 0-based column,
 *  or null if it's not pure letters. #101 helper. */
function parseColRef(s: string): number | null {
  const trimmed = s.replace(/^\$/, "");
  if (!/^[A-Za-z]+$/.test(trimmed)) return null;
  const col = colLettersToIndex(trimmed);
  return col >= 0 ? col : null;
}

/** Parse a row-only ref like "1", "$5" — returns the 0-based row, or null. */
function parseRowRef(s: string): number | null {
  const trimmed = s.replace(/^\$/, "");
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n - 1;
}

/**
 * Parse an Excel sqref into a flat list of cell coordinates. Accepts:
 *   - single cells: "A1"
 *   - ranges: "A1:C3"
 *   - whole-column refs: "A:A", "B:D" (#101)
 *   - whole-row refs: "1:1", "5:10" (#101)
 *   - space-separated mixes: "A1 B2 D4:D10"
 *
 * #101: whole-column / whole-row refs are bounded by `usedRange` (passed in
 * by the caller) so we never generate 1M-coordinate arrays for the full
 * worksheet. If usedRange is omitted, whole-column / whole-row pieces
 * conservatively fall back to row 0 / col 0 only.
 */
export function parseSqrefToCells(
  sqref: string,
  usedRange?: { maxRow: number; maxCol: number },
): CellCoord[] {
  const out: CellCoord[] = [];
  if (typeof sqref !== "string") return out;
  const maxRow = usedRange?.maxRow ?? 0;
  const maxCol = usedRange?.maxCol ?? 0;
  const pieces = sqref.trim().split(/\s+/);
  for (const piece of pieces) {
    if (!piece) continue;
    const colon = piece.indexOf(":");
    if (colon < 0) {
      const c = parseA1(piece);
      if (c) out.push(c);
      continue;
    }
    const leftStr = piece.slice(0, colon);
    const rightStr = piece.slice(colon + 1);
    // Whole-column ("A:A", "B:D")
    const lc = parseColRef(leftStr);
    const rc = parseColRef(rightStr);
    if (lc !== null && rc !== null) {
      const c0 = Math.min(lc, rc);
      const c1 = Math.max(lc, rc);
      for (let r = 0; r <= maxRow; r++) {
        for (let c = c0; c <= c1; c++) out.push({ row: r, col: c });
      }
      continue;
    }
    // Whole-row ("1:1", "5:10")
    const lr = parseRowRef(leftStr);
    const rr = parseRowRef(rightStr);
    if (lr !== null && rr !== null) {
      const r0 = Math.min(lr, rr);
      const r1 = Math.max(lr, rr);
      for (let r = r0; r <= r1; r++) {
        for (let c = 0; c <= maxCol; c++) out.push({ row: r, col: c });
      }
      continue;
    }
    // Explicit cell range.
    const a = parseA1(leftStr);
    const b = parseA1(rightStr);
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

// new in this round: -----------------------------------------------------
// Advanced CF rule types: dataBar, colorScale, iconSet, expression.

/** Convert a hex color ("#RRGGBB") to [r,g,b] (0..255). Returns null on bad input. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Convert RGB (0..255) to HSL where h:0..360, s:0..100, l:0..100. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

/** Convert HSL (h:0..360, s:0..100, l:0..100) to RGB (0..255). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100, ln = l / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hk = h / 360;
  return [
    Math.round(hue2rgb(p, q, hk + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hk) * 255),
    Math.round(hue2rgb(p, q, hk - 1 / 3) * 255),
  ];
}

/** Given a base color and a fillRatio (0..1), return a lightness-adjusted hex.
 *  lightness = 100 - fillRatio * 60: 100% fill → darker bar, 0% → nearly white. */
export function evaluateDataBar(base: string, fillRatio: number): string {
  const rgb = hexToRgb(base) ?? [99, 142, 198];
  const [h, s] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const ratio = Math.max(0, Math.min(1, fillRatio));
  const l = 100 - ratio * 60;
  const [nr, ng, nb] = hslToRgb(h, s, l);
  return rgbToHex(nr, ng, nb);
}

/** Compute the fill ratio of `value` in [min,max]. Returns 0 if min==max or non-numeric. */
function fillRatioFor(value: unknown, min: number, max: number): number {
  const n = toNumber(value);
  if (Number.isNaN(n)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  const r = (n - min) / (max - min);
  return Math.max(0, Math.min(1, r));
}

/** Linear interpolation between two RGB colors in RGB space. t in [0,1]. */
function lerpHex(aHex: string, bHex: string, t: number): string {
  const a = hexToRgb(aHex) ?? [0, 0, 0];
  const b = hexToRgb(bHex) ?? [255, 255, 255];
  const tt = Math.max(0, Math.min(1, t));
  return rgbToHex(
    a[0] + (b[0] - a[0]) * tt,
    a[1] + (b[1] - a[1]) * tt,
    a[2] + (b[2] - a[2]) * tt,
  );
}

/**
 * Evaluate a colorScale rule against a single value. For 3-color scales we
 * interpolate min→mid in [min,median] and mid→max in [median,max]. Returns
 * the hex color, or null when the value is non-numeric (no fill).
 */
export function evaluateColorScale(
  value: unknown,
  scaleType: "2color" | "3color",
  min: number,
  max: number,
  median: number,
  minColor: string,
  midColor: string,
  maxColor: string,
): string | null {
  const n = toNumber(value);
  if (Number.isNaN(n)) return null;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max === min) return minColor;
  if (scaleType === "2color") {
    return lerpHex(minColor, maxColor, (n - min) / (max - min));
  }
  if (n <= median) {
    const span = median - min;
    return lerpHex(minColor, midColor, span === 0 ? 0 : (n - min) / span);
  } else {
    const span = max - median;
    return lerpHex(midColor, maxColor, span === 0 ? 1 : (n - median) / span);
  }
}

const ICON_GLYPHS: Record<string, string[]> = {
  "3arrows": ["↓", "→", "↑"],
  "3traffic": ["🔴", "🟡", "🟢"],
  "5rating": ["★☆☆☆☆", "★★☆☆☆", "★★★☆☆", "★★★★☆", "★★★★★"],
};

/** Pick an icon glyph for `value` based on its band in [min,max] using the
 *  given iconStyle's bucket count. Returns "" when value is non-numeric. */
export function evaluateIconSet(
  value: unknown,
  iconStyle: string,
  min: number,
  max: number,
): string {
  const set = ICON_GLYPHS[iconStyle] ?? ICON_GLYPHS["3arrows"];
  const n = toNumber(value);
  if (Number.isNaN(n) || !Number.isFinite(min) || !Number.isFinite(max)) return "";
  const buckets = set.length;
  if (max === min) return set[buckets - 1];
  const ratio = (n - min) / (max - min);
  let idx = Math.floor(ratio * buckets);
  if (idx >= buckets) idx = buckets - 1;
  if (idx < 0) idx = 0;
  return set[idx];
}

/**
 * Tiny tokenizer for the expression evaluator. Yields numbers, strings,
 * idents (function names + cell refs), and operator tokens. Whitespace skipped.
 */
type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "ident"; v: string }
  | { k: "op"; v: string }
  | { k: "lp" }
  | { k: "rp" }
  | { k: "comma" };

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  const s = src;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "(") {
      out.push({ k: "lp" });
      i++;
      continue;
    }
    if (ch === ")") {
      out.push({ k: "rp" });
      i++;
      continue;
    }
    if (ch === ",") {
      out.push({ k: "comma" });
      i++;
      continue;
    }
    if (ch === ">" || ch === "<" || ch === "=") {
      // multi-char: >=, <=, <>
      if (ch === "<" && s[i + 1] === ">") {
        out.push({ k: "op", v: "<>" });
        i += 2;
        continue;
      }
      if ((ch === ">" || ch === "<") && s[i + 1] === "=") {
        out.push({ k: "op", v: ch + "=" });
        i += 2;
        continue;
      }
      out.push({ k: "op", v: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = "";
      while (j < s.length && s[j] !== '"') {
        buf += s[j];
        j++;
      }
      if (j >= s.length) return null;
      out.push({ k: "str", v: buf });
      i = j + 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < s.length && (/[0-9.]/.test(s[j]))) j++;
      const n = Number(s.slice(i, j));
      if (!Number.isFinite(n)) return null;
      out.push({ k: "num", v: n });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z_$0-9]/.test(s[j])) j++;
      out.push({ k: "ident", v: s.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown char — bail.
    return null;
  }
  return out;
}

/** Parsed atom value used during expression evaluation. */
type EvalValue = number | string | boolean | null;

interface EvalCtx {
  cellData: Record<string, Record<string, unknown>> | undefined;
  anchorRow: number;
  anchorCol: number;
  curRow: number;
  curCol: number;
}

/** Resolve an A1 ident relative to the rule's anchor cell. E.g. rule sqref=A1
 *  with formula1="=B2" and current cell at (3,3) reads from (3+ (2-1), 3+ (B-A))
 *  =(4,4). Returns the raw cell value (number/string/null). */
function readRelative(name: string, ctx: EvalCtx): EvalValue {
  const c = parseA1(name);
  if (!c) return null;
  const dr = c.row - ctx.anchorRow;
  const dc = c.col - ctx.anchorCol;
  const r = ctx.curRow + dr;
  const cc = ctx.curCol + dc;
  if (r < 0 || cc < 0) return null;
  const v = readCellValue(ctx.cellData, r, cc);
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  return String(v);
}

/** Tiny recursive-descent parser for the expression grammar:
 *    expr   := cmp
 *    cmp    := add ( OP add )?       OP in > < >= <= = <>
 *    add    := mul ( ('+'|'-') mul )*    -- not in spec but harmless
 *    mul    := atom
 *    atom   := number | string | ident '(' args? ')' | ident | '(' expr ')'
 *  Returns evaluated value or throws. */
class ExprParser {
  i = 0;
  toks: Token[];
  ctx: EvalCtx;
  constructor(toks: Token[], ctx: EvalCtx) {
    this.toks = toks;
    this.ctx = ctx;
  }
  peek(): Token | undefined {
    return this.toks[this.i];
  }
  eat(): Token | undefined {
    return this.toks[this.i++];
  }
  parse(): EvalValue {
    const v = this.parseCmp();
    if (this.i !== this.toks.length) throw new Error("trailing tokens");
    return v;
  }
  parseCmp(): EvalValue {
    const l = this.parseAtom();
    const t = this.peek();
    if (t && t.k === "op") {
      this.eat();
      const r = this.parseAtom();
      return cmp(l, r, t.v);
    }
    return l;
  }
  parseAtom(): EvalValue {
    const t = this.eat();
    if (!t) throw new Error("unexpected end");
    if (t.k === "num") return t.v;
    if (t.k === "str") return t.v;
    if (t.k === "lp") {
      const v = this.parseCmp();
      const r = this.eat();
      if (!r || r.k !== "rp") throw new Error("missing )");
      return v;
    }
    if (t.k === "ident") {
      // function call?
      if (this.peek()?.k === "lp") {
        this.eat(); // consume lp
        const args: EvalValue[] = [];
        if (this.peek()?.k !== "rp") {
          args.push(this.parseCmp());
          while (this.peek()?.k === "comma") {
            this.eat();
            args.push(this.parseCmp());
          }
        }
        const close = this.eat();
        if (!close || close.k !== "rp") throw new Error("missing )");
        return callFn(t.v.toUpperCase(), args, this.ctx);
      }
      // bare ident: cell ref or unknown name
      return readRelative(t.v, this.ctx);
    }
    throw new Error("bad atom");
  }
}

function isBlankVal(v: EvalValue): boolean {
  return v === null || v === undefined || v === "";
}

function cmp(l: EvalValue, r: EvalValue, op: string): boolean {
  // Coerce both sides to number when possible; fall back to string compare for = / <>.
  const ln = typeof l === "number" ? l : Number(l);
  const rn = typeof r === "number" ? r : Number(r);
  const bothNum = !Number.isNaN(ln) && !Number.isNaN(rn) && l !== null && r !== null;
  switch (op) {
    case ">":
      return bothNum && ln > rn;
    case "<":
      return bothNum && ln < rn;
    case ">=":
      return bothNum && ln >= rn;
    case "<=":
      return bothNum && ln <= rn;
    case "=":
      if (bothNum) return ln === rn;
      return String(l ?? "") === String(r ?? "");
    case "<>":
      if (bothNum) return ln !== rn;
      return String(l ?? "") !== String(r ?? "");
  }
  return false;
}

function callFn(name: string, args: EvalValue[], ctx: EvalCtx): EvalValue {
  switch (name) {
    case "ISBLANK":
      return args.length === 1 && isBlankVal(args[0]);
    case "ISNUMBER":
      return args.length === 1 && typeof args[0] === "number" && Number.isFinite(args[0]);
    case "ISTEXT":
      return args.length === 1 && typeof args[0] === "string" && args[0] !== "";
    case "MOD": {
      if (args.length !== 2) return null;
      const a = typeof args[0] === "number" ? args[0] : Number(args[0]);
      const b = typeof args[1] === "number" ? args[1] : Number(args[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
      return a - Math.floor(a / b) * b;
    }
    case "ROW":
      // ROW() with no args returns the current row (1-based).
      return args.length === 0 ? ctx.curRow + 1 : null;
    case "COLUMN":
      return args.length === 0 ? ctx.curCol + 1 : null;
  }
  return null;
}

/** Evaluate a formula-based CF expression against the current cell. Returns
 *  true / false (fail-closed: any parse or evaluation error → false). The
 *  formula's leading `=` is stripped before tokenization. */
export function evaluateExpression(
  formula: string | undefined,
  ctx: EvalCtx,
): boolean {
  if (!formula) return false;
  let src = String(formula).trim();
  if (src.startsWith("=")) src = src.slice(1).trim();
  if (!src) return false;
  try {
    const toks = tokenize(src);
    if (!toks) return false;
    const p = new ExprParser(toks, ctx);
    const v = p.parse();
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v !== "";
    return false;
  } catch {
    return false;
  }
}

/** Extract the anchor (top-left) of the first piece of an sqref string.
 *  Used by the expression evaluator to derive the relative-reference offset. */
function anchorOfSqref(sqref: string): CellCoord {
  const pieces = sqref.trim().split(/\s+/);
  for (const piece of pieces) {
    if (!piece) continue;
    const colon = piece.indexOf(":");
    const leftStr = colon < 0 ? piece : piece.slice(0, colon);
    const a = parseA1(leftStr);
    if (a) return a;
    // Whole-column "A:A" or whole-row "1:1" — best-effort anchor at (0, col) / (row, 0).
    const lc = parseColRef(leftStr);
    if (lc !== null) return { row: 0, col: lc };
    const lr = parseRowRef(leftStr);
    if (lr !== null) return { row: lr, col: 0 };
  }
  return { row: 0, col: 0 };
}
// end new in this round ---------------------------------------------------

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
    // new in this round: dataBar / colorScale / iconSet always "match" when
    // the cell has a numeric value (they always paint a style for in-range
    // numeric cells). The actual color/glyph is decided inside patchCfRenders.
    case "dataBar":
    case "colorScale":
    case "iconSet":
      return !Number.isNaN(toNumber(value));
    // new in this round: expression rules — evaluated by the caller because
    // they need (row,col) context. ruleMatches returns false here so the
    // default switch doesn't accidentally style them.
    case "expression":
      return false;
    default:
      return false;
  }
}

// new in this round: compute the per-numeric-cell range stats used by
// dataBar / colorScale / iconSet. Non-numeric cells are excluded. Returns
// null when the range has no numeric data.
function rangeStats(values: unknown[]): { min: number; max: number; median: number } | null {
  const nums: number[] = [];
  for (const v of values) {
    const n = toNumber(v);
    if (!Number.isNaN(n)) nums.push(n);
  }
  if (nums.length === 0) return null;
  let min = nums[0];
  let max = nums[0];
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[(sorted.length - 1) / 2];
  return { min, max, median: mid };
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

    // #101: compute the used range so whole-column / whole-row sqrefs
    // ("A:A", "1:1") can be bounded. Walk the existing cellData once —
    // the keys are stringified ints so a max-reduce is cheap.
    let usedMaxRow = 0;
    let usedMaxCol = 0;
    for (const rowKey of Object.keys(cellData)) {
      const r = Number.parseInt(rowKey, 10);
      if (Number.isFinite(r) && r > usedMaxRow) usedMaxRow = r;
      const row = cellData[rowKey];
      if (row && typeof row === "object") {
        for (const colKey of Object.keys(row)) {
          const c = Number.parseInt(colKey, 10);
          if (Number.isFinite(c) && c > usedMaxCol) usedMaxCol = c;
        }
      }
    }
    const usedRange = { maxRow: usedMaxRow, maxCol: usedMaxCol };

    // Ascending priority = highest-priority first (Excel convention).
    // We iterate low-to-high and let later (lower-priority) writes only
    // fill keys not already set, so the first rule wins per style key.
    const sorted = [...rules]
      .filter((r) => r && typeof r === "object" && typeof r.sqref === "string")
      .sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));

    for (const rule of sorted) {
      const coords = parseSqrefToCells(rule.sqref, usedRange);
      if (coords.length === 0) continue;
      // Pre-collect values when the rule is range-aware.
      let rangeValues: unknown[] = [];
      const t = rule.type ?? "";
      if (
        t === "top10" ||
        t === "duplicateValues" ||
        t === "uniqueValues" ||
        // new in this round: dataBar / colorScale / iconSet also need the
        // full range to compute min/max/median.
        t === "dataBar" ||
        t === "colorScale" ||
        t === "iconSet"
      ) {
        rangeValues = coords.map((c) => readCellValue(cellData, c.row, c.col));
      }
      // new in this round: dataBar/colorScale/iconSet are styled per-cell
      // based on the cell's value relative to range stats — branch out so we
      // can compute the delta inside the loop and skip styleForRule.
      const isAdvancedScale =
        t === "dataBar" || t === "colorScale" || t === "iconSet";
      const isExpression = t === "expression";
      const stats = isAdvancedScale ? rangeStats(rangeValues) : null;
      const anchor = isExpression ? anchorOfSqref(rule.sqref) : { row: 0, col: 0 };
      const exprStyleDelta = isExpression ? styleForRule(rule) : null;
      const styleDelta = isAdvancedScale || isExpression ? {} : styleForRule(rule);

      for (const { row, col } of coords) {
        const value = readCellValue(cellData, row, col);

        // new in this round: expression branch — evaluate per cell.
        if (isExpression) {
          const ok = evaluateExpression(rule.formula1, {
            cellData,
            anchorRow: anchor.row,
            anchorCol: anchor.col,
            curRow: row,
            curCol: col,
          });
          if (!ok) continue;
          const rowKey = String(row);
          const colKey = String(col);
          const rowMap = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<string, unknown>;
          const existing = (rowMap[colKey] as Record<string, unknown> | undefined) ?? {};
          const baseStyle =
            typeof existing.s === "object" && existing.s !== null
              ? (existing.s as Record<string, unknown>)
              : {};
          const mergedStyle: Record<string, unknown> = { ...baseStyle };
          for (const k of Object.keys(exprStyleDelta ?? {})) {
            if (!(k in mergedStyle)) mergedStyle[k] = (exprStyleDelta as Record<string, unknown>)[k];
          }
          rowMap[colKey] = { ...existing, s: mergedStyle };
          continue;
        }

        // new in this round: dataBar / colorScale / iconSet — per-cell paint
        // based on range stats.
        if (isAdvancedScale) {
          if (!stats) continue;
          const n = toNumber(value);
          if (Number.isNaN(n)) continue;
          const rowKey = String(row);
          const colKey = String(col);
          const rowMap = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<string, unknown>;
          const existing = (rowMap[colKey] as Record<string, unknown> | undefined) ?? {};
          const baseStyle =
            typeof existing.s === "object" && existing.s !== null
              ? (existing.s as Record<string, unknown>)
              : {};
          if (t === "dataBar") {
            const base = rule.color ?? "#638EC6";
            const ratio = fillRatioFor(value, stats.min, stats.max);
            const bg = evaluateDataBar(base, ratio);
            if (!("bg" in baseStyle)) {
              rowMap[colKey] = {
                ...existing,
                s: { ...baseStyle, bg: { rgb: bg } },
              };
            }
            continue;
          }
          if (t === "colorScale") {
            const scaleType = rule.colorScaleType ?? "2color";
            const minCol = rule.minColor ?? "#F8696B";
            const midCol = rule.midColor ?? "#FFEB84";
            const maxCol = rule.maxColor ?? "#63BE7B";
            const hex = evaluateColorScale(
              value,
              scaleType,
              stats.min,
              stats.max,
              stats.median,
              minCol,
              midCol,
              maxCol,
            );
            if (hex && !("bg" in baseStyle)) {
              rowMap[colKey] = {
                ...existing,
                s: { ...baseStyle, bg: { rgb: hex } },
              };
            }
            continue;
          }
          if (t === "iconSet") {
            const glyph = evaluateIconSet(value, rule.iconStyle ?? "3arrows", stats.min, stats.max);
            if (!glyph) continue;
            // Prefix the glyph onto the cell's display value `v`. We work on
            // the deep-cloned snapshot so the source isn't mutated.
            const cur = existing.v;
            const text = cur === undefined || cur === null ? "" : String(cur);
            // Avoid double-prefixing if the same glyph is already there
            // (e.g. a re-render of the same snapshot — patch idempotence).
            const prefix = `${glyph} `;
            const next = text.startsWith(prefix) ? text : prefix + text;
            rowMap[colKey] = {
              ...existing,
              v: next,
            };
            continue;
          }
          continue;
        }

        // Existing path for cellIs / containsText / top10 / duplicate / unique.
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

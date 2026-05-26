// #239 Power Pivot / Data Model — DAX engine foundation.
//
// MVP scope (Step 1): pure types + recursive-descent parser + evaluator
// for the simple subset of DAX. RELATED / FILTER / CALCULATE / SUMX /
// AVERAGEX touch relationships and are deferred to Step 2.
//
// Implemented this PR:
//   - literals: numbers, strings, booleans
//   - identifier refs: table[column]
//   - function calls: SUM / AVERAGE / MIN / MAX / COUNT / DISTINCTCOUNT /
//     COUNTROWS / IF / ALL
//   - binary ops: + - * / & (string concat) = <> < > <= >=
//   - parenthesised expressions
//
// Deferred:
//   - RELATED(table[col]): cross-table lookup via relationships
//   - FILTER / CALCULATE / SUMX / AVERAGEX: filter-context propagation
//   - Time Intelligence (TOTALYTD, SAMEPERIODLASTYEAR, ...)
//   - Variables (VAR ... RETURN)

export interface ModelColumn {
  name: string;
  type: "number" | "string" | "boolean" | "date";
}

export interface ModelTable {
  name: string;
  columns: ModelColumn[];
  /** In-memory rows. Each row maps column name → cell value. */
  rows: Array<Record<string, unknown>>;
}

export interface ModelRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface DataModel {
  tables: ModelTable[];
  relationships: ModelRelationship[];
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type DaxAst =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "columnRef"; table: string; column: string }
  | { kind: "tableRef"; table: string }
  | { kind: "binaryOp"; op: BinaryOp; left: DaxAst; right: DaxAst }
  | { kind: "funcCall"; name: string; args: DaxAst[] };

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "&"
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">=";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "punct"; value: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    // String literal — single OR double quotes; doubled-quote = escape.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let acc = "";
      while (i < n) {
        if (src[i] === quote) {
          if (src[i + 1] === quote) {
            acc += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        acc += src[i];
        i++;
      }
      out.push({ kind: "str", value: acc });
      continue;
    }
    // Number literal.
    if ((ch >= "0" && ch <= "9") || (ch === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i;
      while (j < n && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      const numStr = src.slice(i, j);
      out.push({ kind: "num", value: Number.parseFloat(numStr) });
      i = j;
      continue;
    }
    // Identifier (table or function name).
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_") {
      let j = i;
      while (
        j < n &&
        ((src[j] >= "A" && src[j] <= "Z") ||
          (src[j] >= "a" && src[j] <= "z") ||
          (src[j] >= "0" && src[j] <= "9") ||
          src[j] === "_" ||
          src[j] === ".")
      ) j++;
      out.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Multi-char punctuation.
    if (src.startsWith("<>", i) || src.startsWith("<=", i) || src.startsWith(">=", i)) {
      out.push({ kind: "punct", value: src.slice(i, i + 2) });
      i += 2;
      continue;
    }
    // Single-char punctuation.
    if (
      ch === "(" || ch === ")" || ch === "[" || ch === "]" ||
      ch === "," || ch === "+" || ch === "-" || ch === "*" ||
      ch === "/" || ch === "&" || ch === "=" || ch === "<" || ch === ">"
    ) {
      out.push({ kind: "punct", value: ch });
      i++;
      continue;
    }
    // Unknown char — skip silently (parser will likely error downstream).
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ParseError extends Error {}

interface ParseState {
  tokens: Token[];
  pos: number;
}

function peek(s: ParseState): Token | null {
  return s.pos < s.tokens.length ? s.tokens[s.pos] : null;
}
function consume(s: ParseState): Token | null {
  return s.pos < s.tokens.length ? s.tokens[s.pos++] : null;
}
function expectPunct(s: ParseState, p: string): void {
  const t = consume(s);
  if (!t || t.kind !== "punct" || t.value !== p) {
    throw new ParseError(`expected '${p}'`);
  }
}

const PRECEDENCE: Record<BinaryOp, number> = {
  "&": 1,
  "=": 2,
  "<>": 2,
  "<": 2,
  ">": 2,
  "<=": 2,
  ">=": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
};

function isBinaryOp(value: string): value is BinaryOp {
  return value in PRECEDENCE;
}

function parsePrimary(s: ParseState): DaxAst {
  const t = consume(s);
  if (!t) throw new ParseError("unexpected end of input");
  if (t.kind === "num") return { kind: "number", value: t.value };
  if (t.kind === "str") return { kind: "string", value: t.value };
  if (t.kind === "punct" && t.value === "(") {
    const inner = parseExpression(s, 0);
    expectPunct(s, ")");
    return inner;
  }
  if (t.kind === "punct" && t.value === "-") {
    const right = parsePrimary(s);
    return { kind: "binaryOp", op: "-", left: { kind: "number", value: 0 }, right };
  }
  if (t.kind === "ident") {
    // Boolean literals first.
    const lower = t.value.toLowerCase();
    if (lower === "true") return { kind: "boolean", value: true };
    if (lower === "false") return { kind: "boolean", value: false };
    // Identifier followed by '(' = function call.
    const next = peek(s);
    if (next?.kind === "punct" && next.value === "(") {
      consume(s);
      const args: DaxAst[] = [];
      const after = peek(s);
      if (!after || after.kind !== "punct" || after.value !== ")") {
        args.push(parseExpression(s, 0));
        while (peek(s)?.kind === "punct" && peek(s)?.value === ",") {
          consume(s);
          args.push(parseExpression(s, 0));
        }
      }
      expectPunct(s, ")");
      return { kind: "funcCall", name: t.value.toUpperCase(), args };
    }
    // Identifier followed by '[col]' = columnRef.
    if (next?.kind === "punct" && next.value === "[") {
      consume(s);
      const colTok = consume(s);
      if (!colTok || colTok.kind !== "ident") {
        throw new ParseError("expected column name in []");
      }
      expectPunct(s, "]");
      return { kind: "columnRef", table: t.value, column: colTok.value };
    }
    // Bare identifier = tableRef.
    return { kind: "tableRef", table: t.value };
  }
  throw new ParseError(`unexpected token: ${JSON.stringify(t)}`);
}

function parseExpression(s: ParseState, minPrec: number): DaxAst {
  let left = parsePrimary(s);
  while (true) {
    const t = peek(s);
    if (!t || t.kind !== "punct" || !isBinaryOp(t.value)) break;
    const op = t.value as BinaryOp;
    const prec = PRECEDENCE[op];
    if (prec < minPrec) break;
    consume(s);
    const right = parseExpression(s, prec + 1);
    left = { kind: "binaryOp", op, left, right };
  }
  return left;
}

/** Parse a DAX expression. Strips a leading '=' if present. */
export function parseDax(src: string): DaxAst {
  const trimmed = src.trim().startsWith("=") ? src.trim().slice(1) : src;
  const tokens = tokenize(trimmed);
  const state: ParseState = { tokens, pos: 0 };
  const ast = parseExpression(state, 0);
  if (state.pos < state.tokens.length) {
    throw new ParseError(`trailing tokens after expression: ${JSON.stringify(state.tokens[state.pos])}`);
  }
  return ast;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export interface EvalContext {
  model: DataModel;
  /** Optional "current row" for column refs without a row context wrapper. */
  currentRow?: { table: string; row: Record<string, unknown> };
}

function toNumberOrNaN(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function findTable(model: DataModel, name: string): ModelTable | null {
  return model.tables.find((t) => t.name === name) ?? null;
}

function columnValues(model: DataModel, table: string, column: string): unknown[] {
  const t = findTable(model, table);
  if (!t) return [];
  if (!t.columns.some((c) => c.name === column)) return [];
  return t.rows.map((r) => r[column]);
}

/**
 * Evaluate a parsed DAX expression. Throws on unrecognized function calls
 * (callers should pre-validate `funcCall.name` against IMPLEMENTED_FUNCTIONS).
 */
export function evaluate(ast: DaxAst, ctx: EvalContext): unknown {
  switch (ast.kind) {
    case "number":
      return ast.value;
    case "string":
      return ast.value;
    case "boolean":
      return ast.value;
    case "columnRef": {
      // When we're inside a row context (SUMX / IF row-by-row), return the
      // single cell value. Otherwise return the full column array — caller
      // (e.g. SUM, AVERAGE) will reduce it.
      if (ctx.currentRow && ctx.currentRow.table === ast.table) {
        return ctx.currentRow.row[ast.column];
      }
      return columnValues(ctx.model, ast.table, ast.column);
    }
    case "tableRef":
      return findTable(ctx.model, ast.table)?.rows ?? [];
    case "binaryOp": {
      const lv = evaluate(ast.left, ctx);
      const rv = evaluate(ast.right, ctx);
      return applyBinaryOp(ast.op, lv, rv);
    }
    case "funcCall":
      return evalFuncCall(ast.name, ast.args, ctx);
  }
}

function applyBinaryOp(op: BinaryOp, lv: unknown, rv: unknown): unknown {
  if (op === "&") {
    return String(lv ?? "") + String(rv ?? "");
  }
  if (op === "=" || op === "<>") {
    const lNum = toNumberOrNaN(lv);
    const rNum = toNumberOrNaN(rv);
    if (Number.isFinite(lNum) && Number.isFinite(rNum)) {
      return op === "=" ? lNum === rNum : lNum !== rNum;
    }
    const ls = String(lv ?? "");
    const rs = String(rv ?? "");
    return op === "=" ? ls === rs : ls !== rs;
  }
  const lNum = toNumberOrNaN(lv);
  const rNum = toNumberOrNaN(rv);
  if (!Number.isFinite(lNum) || !Number.isFinite(rNum)) return NaN;
  switch (op) {
    case "+":
      return lNum + rNum;
    case "-":
      return lNum - rNum;
    case "*":
      return lNum * rNum;
    case "/":
      return rNum === 0 ? NaN : lNum / rNum;
    case "<":
      return lNum < rNum;
    case ">":
      return lNum > rNum;
    case "<=":
      return lNum <= rNum;
    case ">=":
      return lNum >= rNum;
  }
}

export const IMPLEMENTED_FUNCTIONS = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTROWS",
  "DISTINCTCOUNT",
  "IF",
  "ALL",
]);

function evalFuncCall(name: string, args: DaxAst[], ctx: EvalContext): unknown {
  const fn = name.toUpperCase();
  switch (fn) {
    case "SUM":
    case "AVERAGE":
    case "MIN":
    case "MAX":
    case "COUNT":
    case "DISTINCTCOUNT": {
      if (args.length !== 1) throw new ParseError(`${fn} expects 1 argument`);
      const arr = toArray(evaluate(args[0], ctx));
      return reduceColumn(fn, arr);
    }
    case "COUNTROWS": {
      if (args.length !== 1) throw new ParseError("COUNTROWS expects 1 argument");
      const v = evaluate(args[0], ctx);
      if (Array.isArray(v)) return v.length;
      return 0;
    }
    case "ALL": {
      // MVP: ALL(table) returns every row; ALL(table[col]) returns every
      // distinct value in that column. Used to bypass filter context — but
      // since CALCULATE isn't implemented, this is currently equivalent to
      // the bare table / column reference.
      if (args.length !== 1) throw new ParseError("ALL expects 1 argument");
      return evaluate(args[0], ctx);
    }
    case "IF": {
      if (args.length < 2 || args.length > 3) {
        throw new ParseError("IF expects 2 or 3 arguments");
      }
      const cond = evaluate(args[0], ctx);
      const truthy = cond === true || (typeof cond === "number" && cond !== 0);
      if (truthy) return evaluate(args[1], ctx);
      return args[2] !== undefined ? evaluate(args[2], ctx) : null;
    }
    default:
      throw new ParseError(`unsupported function: ${fn}`);
  }
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return [v];
}

function reduceColumn(
  fn: "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT" | "DISTINCTCOUNT",
  values: unknown[],
): number | null {
  switch (fn) {
    case "SUM": {
      let s = 0;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n)) s += n;
      }
      return s;
    }
    case "AVERAGE": {
      let s = 0;
      let c = 0;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n)) {
          s += n;
          c++;
        }
      }
      return c > 0 ? s / c : null;
    }
    case "MIN": {
      let m = Infinity;
      let touched = false;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n)) {
          if (n < m) m = n;
          touched = true;
        }
      }
      return touched ? m : null;
    }
    case "MAX": {
      let m = -Infinity;
      let touched = false;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n)) {
          if (n > m) m = n;
          touched = true;
        }
      }
      return touched ? m : null;
    }
    case "COUNT": {
      let c = 0;
      for (const v of values) {
        if (Number.isFinite(toNumberOrNaN(v))) c++;
      }
      return c;
    }
    case "DISTINCTCOUNT": {
      const seen = new Set<string>();
      for (const v of values) {
        if (v === undefined || v === null) continue;
        seen.add(typeof v === "string" ? v : JSON.stringify(v));
      }
      return seen.size;
    }
  }
}

/**
 * Convenience entry point: parse + evaluate in one call. Returns NaN-like
 * `null` when parsing fails so the UI can show "#ERROR" instead of throwing.
 */
export function evaluateDax(src: string, ctx: EvalContext): unknown {
  try {
    const ast = parseDax(src);
    return evaluate(ast, ctx);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

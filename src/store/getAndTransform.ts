// #238 Power Query 風 Get & Transform — pure pipeline engine.
//
// Excel の Power Query は M 言語 + 大量のソース/transform をサポートするが、
// Coco の MVP では下記スコープに絞る:
//   - データソース: csv / json / jsonl / sqlite (本ファイルは pipeline 専用なので
//     ソース読み込みは別レイヤー — call site で受け取った rows[] から開始)
//   - 変換ステップ 13 種: selectColumns / dropColumns / filterRows / sort /
//     rename / groupBy / changeType / fillMissing / conditionalColumn /
//     replaceValue / splitColumn / mergeColumns / addIndexColumn
//   - 結果は Array<Record<string, unknown>> + 列名配列 + warnings[]
//
// 設計: docs/designs/238-power-query.md の "Step 1 (foundation)" 部分。
// 本ファイルは framework-free / I/O-free のため UI/Tauri 抜きでテスト可能。

export interface PipelineRow {
  [columnName: string]: unknown;
}

// 変換ステップの discriminated union。順番に runPipeline で適用される。

export type TransformStep =
  | SelectColumnsStep
  | DropColumnsStep
  | FilterRowsStep
  | SortStep
  | RenameStep
  | GroupByStep
  | ChangeTypeStep
  | FillMissingStep
  | ConditionalColumnStep
  | ReplaceValueStep
  | SplitColumnStep
  | MergeColumnsStep
  | AddIndexColumnStep;

export interface SelectColumnsStep {
  kind: "selectColumns";
  /** Keep ONLY these columns; drop others. Missing names are ignored. */
  columns: string[];
}

export interface DropColumnsStep {
  kind: "dropColumns";
  /** Drop these columns. Missing names are silently skipped. */
  columns: string[];
}

export type FilterOp =
  | ">"
  | "<"
  | ">="
  | "<="
  | "=="
  | "!="
  | "contains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "isEmpty"
  | "isNotEmpty";

export interface FilterRowsStep {
  kind: "filterRows";
  column: string;
  op: FilterOp;
  /** Required for all ops except isEmpty / isNotEmpty. */
  value?: string;
}

export interface SortStep {
  kind: "sort";
  column: string;
  descending: boolean;
}

export interface RenameStep {
  kind: "rename";
  from: string;
  to: string;
}

export interface GroupByStep {
  kind: "groupBy";
  /** Key column to group on. */
  key: string;
  /** Per-output-column aggregation rules. */
  agg: Array<{
    /** Source column to aggregate. */
    column: string;
    fn: "sum" | "avg" | "min" | "max" | "count" | "first";
    /** Optional output column name; defaults to `${fn}_${column}`. */
    as?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Step 3 — additional transform step types
// ---------------------------------------------------------------------------

/** How to handle conversion failures in changeType. */
export type ChangeTypeErrorHandling = "error" | "null" | "keep";

export interface ChangeTypeStep {
  kind: "changeType";
  column: string;
  targetType: "string" | "number" | "boolean" | "date";
  /**
   * What to do when conversion fails:
   * - "error": emit a warning and leave value as-is (same as "keep")
   * - "null":  replace with null
   * - "keep":  leave the original value (default)
   */
  onError?: ChangeTypeErrorHandling;
}

export type FillDirection = "forward" | "backward" | "fixed";

export interface FillMissingStep {
  kind: "fillMissing";
  column: string;
  direction: FillDirection;
  /** Required when direction === "fixed". */
  fixedValue?: string;
}

export type ConditionalOp = ">" | "<" | ">=" | "<=" | "==" | "!=" | "contains" | "isEmpty" | "isNotEmpty";

export interface ConditionalColumnStep {
  kind: "conditionalColumn";
  /** Name of the new column to add. */
  newColumn: string;
  /** Source column to test. */
  column: string;
  op: ConditionalOp;
  /** Comparison value (not needed for isEmpty / isNotEmpty). */
  value?: string;
  /** Output when condition is true. */
  thenValue: string;
  /** Output when condition is false. */
  elseValue: string;
}

export interface ReplaceValueStep {
  kind: "replaceValue";
  column: string;
  /** Value / pattern to find. */
  find: string;
  /** Replacement string. */
  replace: string;
  /** When true, `find` is treated as a regular expression. Default false. */
  useRegex?: boolean;
}

export type SplitColumnExpand = "columns" | "rows";

export interface SplitColumnStep {
  kind: "splitColumn";
  column: string;
  delimiter: string;
  /**
   * - "columns": spread parts into new columns (col_1, col_2, …)
   * - "rows":    each part becomes a separate row
   * Default: "columns".
   */
  expand?: SplitColumnExpand;
  /** Maximum number of parts (for "columns" expand only). Default: unlimited. */
  maxParts?: number;
}

export interface MergeColumnsStep {
  kind: "mergeColumns";
  /** Columns to combine, in order. */
  columns: string[];
  /** Delimiter placed between values. Default: " ". */
  delimiter?: string;
  /** Name of the merged output column. */
  newColumn: string;
  /** When true, drop the source columns after merging. Default true. */
  dropSources?: boolean;
}

export interface AddIndexColumnStep {
  kind: "addIndexColumn";
  /** Name of the new index column. Default: "Index". */
  columnName?: string;
  /** Starting value. Default: 0. */
  startAt?: number;
  /** Increment per row. Default: 1. */
  increment?: number;
}

export interface PipelineResult {
  /** Column names in the order they should appear in the output. */
  columns: string[];
  rows: PipelineRow[];
  /**
   * Non-fatal warnings raised during the run (e.g. dropped non-numeric
   * value in a SUM agg). The pipeline still returns a best-effort result.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function asString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function inferColumns(rows: ReadonlyArray<PipelineRow>, hint?: string[]): string[] {
  if (hint && hint.length > 0) return hint.slice();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

function applySelectColumns(
  state: PipelineResult,
  step: SelectColumnsStep,
): PipelineResult {
  const wanted = new Set(step.columns);
  const cols = state.columns.filter((c) => wanted.has(c));
  if (cols.length === 0) {
    return {
      columns: [],
      rows: state.rows.map(() => ({})),
      warnings: [
        ...state.warnings,
        "selectColumns: 指定された列は全て対象に存在しません",
      ],
    };
  }
  const rows = state.rows.map((row) => {
    const out: PipelineRow = {};
    for (const c of cols) {
      if (c in row) out[c] = row[c];
    }
    return out;
  });
  return { columns: cols, rows, warnings: state.warnings };
}

function applyDropColumns(
  state: PipelineResult,
  step: DropColumnsStep,
): PipelineResult {
  const drop = new Set(step.columns);
  const cols = state.columns.filter((c) => !drop.has(c));
  const rows = state.rows.map((row) => {
    const out: PipelineRow = {};
    for (const c of cols) {
      if (c in row) out[c] = row[c];
    }
    return out;
  });
  return { columns: cols, rows, warnings: state.warnings };
}

function evalFilter(cellValue: unknown, step: FilterRowsStep): boolean {
  if (step.op === "isEmpty") return isBlank(cellValue);
  if (step.op === "isNotEmpty") return !isBlank(cellValue);
  const expected = step.value ?? "";
  if (step.op === "contains") return asString(cellValue).includes(expected);
  if (step.op === "startsWith") return asString(cellValue).startsWith(expected);
  if (step.op === "endsWith") return asString(cellValue).endsWith(expected);
  if (step.op === "regex") {
    try {
      const re = new RegExp(expected);
      return re.test(asString(cellValue));
    } catch {
      return false;
    }
  }
  // Comparison ops: numeric when both sides parse to finite numbers, else
  // string comparison.
  const lvNum = toNumberOrNaN(cellValue);
  const rvNum = toNumberOrNaN(expected);
  const numericCompare = Number.isFinite(lvNum) && Number.isFinite(rvNum);
  const ls = asString(cellValue);
  const rs = expected;
  switch (step.op) {
    case "==":
      return numericCompare ? lvNum === rvNum : ls === rs;
    case "!=":
      return numericCompare ? lvNum !== rvNum : ls !== rs;
    case ">":
      return numericCompare ? lvNum > rvNum : ls > rs;
    case "<":
      return numericCompare ? lvNum < rvNum : ls < rs;
    case ">=":
      return numericCompare ? lvNum >= rvNum : ls >= rs;
    case "<=":
      return numericCompare ? lvNum <= rvNum : ls <= rs;
  }
}

function applyFilterRows(
  state: PipelineResult,
  step: FilterRowsStep,
): PipelineResult {
  if (!state.columns.includes(step.column)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `filterRows: 列 '${step.column}' は存在しないため step を無視しました`,
      ],
    };
  }
  return {
    ...state,
    rows: state.rows.filter((row) => evalFilter(row[step.column], step)),
  };
}

function applySort(state: PipelineResult, step: SortStep): PipelineResult {
  if (!state.columns.includes(step.column)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `sort: 列 '${step.column}' は存在しないため step を無視しました`,
      ],
    };
  }
  const sorted = state.rows.slice().sort((a, b) => {
    const av = a[step.column];
    const bv = b[step.column];
    const an = toNumberOrNaN(av);
    const bn = toNumberOrNaN(bv);
    let cmp: number;
    if (Number.isFinite(an) && Number.isFinite(bn)) cmp = an - bn;
    else cmp = asString(av).localeCompare(asString(bv));
    return step.descending ? -cmp : cmp;
  });
  return { ...state, rows: sorted };
}

function applyRename(state: PipelineResult, step: RenameStep): PipelineResult {
  if (!state.columns.includes(step.from)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `rename: 列 '${step.from}' は存在しないため step を無視しました`,
      ],
    };
  }
  if (step.from === step.to) return state;
  if (state.columns.includes(step.to)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `rename: 列 '${step.to}' は既に存在するため step を無視しました`,
      ],
    };
  }
  const cols = state.columns.map((c) => (c === step.from ? step.to : c));
  const rows = state.rows.map((row) => {
    const out: PipelineRow = {};
    for (const c of state.columns) {
      const key = c === step.from ? step.to : c;
      out[key] = row[c];
    }
    return out;
  });
  return { ...state, columns: cols, rows };
}

function aggValues(values: unknown[], fn: GroupByStep["agg"][number]["fn"]): unknown {
  switch (fn) {
    case "count":
      return values.length;
    case "first":
      return values.length > 0 ? values[0] : null;
    case "sum": {
      let s = 0;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n)) s += n;
      }
      return s;
    }
    case "avg": {
      let s = 0;
      let count = 0;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n)) {
          s += n;
          count++;
        }
      }
      return count > 0 ? s / count : null;
    }
    case "min": {
      let m = Infinity;
      let touched = false;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n) && n < m) {
          m = n;
          touched = true;
        }
      }
      return touched ? m : null;
    }
    case "max": {
      let m = -Infinity;
      let touched = false;
      for (const v of values) {
        const n = toNumberOrNaN(v);
        if (Number.isFinite(n) && n > m) {
          m = n;
          touched = true;
        }
      }
      return touched ? m : null;
    }
  }
}

function applyGroupBy(state: PipelineResult, step: GroupByStep): PipelineResult {
  if (!state.columns.includes(step.key)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `groupBy: キー列 '${step.key}' は存在しないため step を無視しました`,
      ],
    };
  }
  const groups = new Map<string, PipelineRow[]>();
  const keyOrder: string[] = [];
  for (const row of state.rows) {
    const keyStr = asString(row[step.key]);
    let bucket = groups.get(keyStr);
    if (!bucket) {
      bucket = [];
      groups.set(keyStr, bucket);
      keyOrder.push(keyStr);
    }
    bucket.push(row);
  }
  const outCols = [step.key, ...step.agg.map((a) => a.as ?? `${a.fn}_${a.column}`)];
  const warnings = [...state.warnings];
  // Validate every agg column exists.
  for (const a of step.agg) {
    if (!state.columns.includes(a.column)) {
      warnings.push(
        `groupBy: 集計列 '${a.column}' は存在しません — 該当列は null になります`,
      );
    }
  }
  const outRows: PipelineRow[] = [];
  for (const keyStr of keyOrder) {
    const bucket = groups.get(keyStr)!;
    const row: PipelineRow = { [step.key]: bucket[0][step.key] };
    for (const a of step.agg) {
      const colName = a.as ?? `${a.fn}_${a.column}`;
      const values = state.columns.includes(a.column)
        ? bucket.map((r) => r[a.column])
        : [];
      row[colName] = aggValues(values, a.fn);
    }
    outRows.push(row);
  }
  return { columns: outCols, rows: outRows, warnings };
}

// ---------------------------------------------------------------------------
// Step 3 — implementations
// ---------------------------------------------------------------------------

function convertValue(
  v: unknown,
  targetType: ChangeTypeStep["targetType"],
): { value: unknown; ok: boolean } {
  switch (targetType) {
    case "string":
      return { value: asString(v), ok: true };
    case "number": {
      const n = toNumberOrNaN(v);
      return Number.isFinite(n) ? { value: n, ok: true } : { value: v, ok: false };
    }
    case "boolean": {
      if (typeof v === "boolean") return { value: v, ok: true };
      const s = asString(v).toLowerCase().trim();
      if (s === "true" || s === "1" || s === "yes") return { value: true, ok: true };
      if (s === "false" || s === "0" || s === "no") return { value: false, ok: true };
      return { value: v, ok: false };
    }
    case "date": {
      if (v instanceof Date) return { value: v, ok: true };
      const s = asString(v);
      const d = new Date(s);
      return !isNaN(d.getTime()) ? { value: d.toISOString(), ok: true } : { value: v, ok: false };
    }
  }
}

function applyChangeType(
  state: PipelineResult,
  step: ChangeTypeStep,
): PipelineResult {
  if (!state.columns.includes(step.column)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `changeType: 列 '${step.column}' は存在しないため step を無視しました`,
      ],
    };
  }
  const onError = step.onError ?? "keep";
  const warnings = [...state.warnings];
  let errCount = 0;
  const rows = state.rows.map((row) => {
    const { value, ok } = convertValue(row[step.column], step.targetType);
    if (!ok) {
      errCount++;
      if (onError === "null") return { ...row, [step.column]: null };
      // "keep" or "error" — keep original value
      return row;
    }
    return { ...row, [step.column]: value };
  });
  if (errCount > 0) {
    warnings.push(
      `changeType: 列 '${step.column}' の ${errCount} 行が ${step.targetType} に変換できませんでした (onError="${onError}")`,
    );
  }
  return { ...state, rows, warnings };
}

function applyFillMissing(
  state: PipelineResult,
  step: FillMissingStep,
): PipelineResult {
  if (!state.columns.includes(step.column)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `fillMissing: 列 '${step.column}' は存在しないため step を無視しました`,
      ],
    };
  }
  const rows = state.rows.slice();
  if (step.direction === "fixed") {
    const fill = step.fixedValue ?? "";
    return {
      ...state,
      rows: rows.map((row) =>
        isBlank(row[step.column]) ? { ...row, [step.column]: fill } : row,
      ),
    };
  }
  if (step.direction === "forward") {
    let last: unknown = null;
    return {
      ...state,
      rows: rows.map((row) => {
        if (isBlank(row[step.column])) {
          return last !== null ? { ...row, [step.column]: last } : row;
        }
        last = row[step.column];
        return row;
      }),
    };
  }
  // backward
  let last: unknown = null;
  const filled = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isBlank(rows[i][step.column])) {
      filled[i] = last !== null ? { ...rows[i], [step.column]: last } : rows[i];
    } else {
      last = rows[i][step.column];
      filled[i] = rows[i];
    }
  }
  return { ...state, rows: filled };
}

function evalConditional(cellValue: unknown, step: ConditionalColumnStep): boolean {
  if (step.op === "isEmpty") return isBlank(cellValue);
  if (step.op === "isNotEmpty") return !isBlank(cellValue);
  const expected = step.value ?? "";
  if (step.op === "contains") return asString(cellValue).includes(expected);
  const lvNum = toNumberOrNaN(cellValue);
  const rvNum = toNumberOrNaN(expected);
  const numericCompare = Number.isFinite(lvNum) && Number.isFinite(rvNum);
  const ls = asString(cellValue);
  const rs = expected;
  switch (step.op) {
    case "==": return numericCompare ? lvNum === rvNum : ls === rs;
    case "!=": return numericCompare ? lvNum !== rvNum : ls !== rs;
    case ">":  return numericCompare ? lvNum > rvNum : ls > rs;
    case "<":  return numericCompare ? lvNum < rvNum : ls < rs;
    case ">=": return numericCompare ? lvNum >= rvNum : ls >= rs;
    case "<=": return numericCompare ? lvNum <= rvNum : ls <= rs;
  }
}

function applyConditionalColumn(
  state: PipelineResult,
  step: ConditionalColumnStep,
): PipelineResult {
  if (!state.columns.includes(step.column)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `conditionalColumn: 列 '${step.column}' は存在しないため step を無視しました`,
      ],
    };
  }
  if (state.columns.includes(step.newColumn)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `conditionalColumn: 新列 '${step.newColumn}' は既に存在するため step を無視しました`,
      ],
    };
  }
  const newCols = [...state.columns, step.newColumn];
  const rows = state.rows.map((row) => {
    const result = evalConditional(row[step.column], step);
    return { ...row, [step.newColumn]: result ? step.thenValue : step.elseValue };
  });
  return { ...state, columns: newCols, rows };
}

function applyReplaceValue(
  state: PipelineResult,
  step: ReplaceValueStep,
): PipelineResult {
  if (!state.columns.includes(step.column)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `replaceValue: 列 '${step.column}' は存在しないため step を無視しました`,
      ],
    };
  }
  const warnings = [...state.warnings];
  let re: RegExp | null = null;
  if (step.useRegex) {
    try {
      re = new RegExp(step.find, "g");
    } catch {
      warnings.push(
        `replaceValue: 正規表現 '${step.find}' が無効なため step を無視しました`,
      );
      return { ...state, warnings };
    }
  }
  const rows = state.rows.map((row) => {
    const s = asString(row[step.column]);
    const replaced = re
      ? s.replace(re, step.replace)
      : s.split(step.find).join(step.replace);
    return { ...row, [step.column]: replaced };
  });
  return { ...state, rows, warnings };
}

function applySplitColumn(
  state: PipelineResult,
  step: SplitColumnStep,
): PipelineResult {
  if (!state.columns.includes(step.column)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `splitColumn: 列 '${step.column}' は存在しないため step を無視しました`,
      ],
    };
  }
  const expand = step.expand ?? "columns";
  const maxParts = step.maxParts && step.maxParts > 0 ? step.maxParts : undefined;

  if (expand === "rows") {
    // Each part → a new row; original column is replaced with the part value.
    const newRows: PipelineRow[] = [];
    for (const row of state.rows) {
      const s = asString(row[step.column]);
      const parts = s.split(step.delimiter);
      const limited = maxParts ? parts.slice(0, maxParts) : parts;
      for (const part of limited) {
        newRows.push({ ...row, [step.column]: part });
      }
    }
    return { ...state, rows: newRows };
  }

  // "columns": find the max number of parts across all rows first
  const allParts: string[][] = state.rows.map((row) => {
    const s = asString(row[step.column]);
    const parts = s.split(step.delimiter);
    return maxParts ? parts.slice(0, maxParts) : parts;
  });
  const maxCount = allParts.reduce((m, p) => Math.max(m, p.length), 0);
  // New column names: {column}_1, {column}_2, …
  const newColNames = Array.from({ length: maxCount }, (_, i) => `${step.column}_${i + 1}`);
  // Drop original column; insert new columns in its place
  const colIdx = state.columns.indexOf(step.column);
  const newCols = [
    ...state.columns.slice(0, colIdx),
    ...newColNames,
    ...state.columns.slice(colIdx + 1),
  ];
  const rows = state.rows.map((row, ri) => {
    const parts = allParts[ri];
    const out: PipelineRow = {};
    for (const c of state.columns) {
      if (c === step.column) continue;
      out[c] = row[c];
    }
    for (let i = 0; i < maxCount; i++) {
      out[newColNames[i]] = i < parts.length ? parts[i] : null;
    }
    return out;
  });
  // Re-order to respect newCols ordering
  const orderedRows = rows.map((row) => {
    const out: PipelineRow = {};
    for (const c of newCols) out[c] = row[c];
    return out;
  });
  return { ...state, columns: newCols, rows: orderedRows };
}

function applyMergeColumns(
  state: PipelineResult,
  step: MergeColumnsStep,
): PipelineResult {
  const missing = step.columns.filter((c) => !state.columns.includes(c));
  if (missing.length > 0) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `mergeColumns: 列 ${missing.map((c) => `'${c}'`).join(", ")} は存在しないため step を無視しました`,
      ],
    };
  }
  if (state.columns.includes(step.newColumn)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `mergeColumns: 新列 '${step.newColumn}' は既に存在するため step を無視しました`,
      ],
    };
  }
  const delim = step.delimiter ?? " ";
  const dropSources = step.dropSources !== false; // default true
  const srcSet = new Set(step.columns);
  // New column order: insert newColumn where the first source column was.
  // When dropSources=true: remove all source columns.
  // When dropSources=false: keep all source columns and also add newColumn.
  const firstIdx = state.columns.findIndex((c) => srcSet.has(c));
  const newCols: string[] = [];
  for (let i = 0; i < state.columns.length; i++) {
    const col = state.columns[i];
    if (i === firstIdx) {
      // Insert newColumn at this position
      newCols.push(step.newColumn);
      if (!dropSources) {
        // Keep original source column too
        newCols.push(col);
      }
      // If dropSources, skip the source column (don't push it)
    } else if (dropSources && srcSet.has(col)) {
      // Drop this source column
    } else {
      newCols.push(col);
    }
  }
  const rows = state.rows.map((row) => {
    const merged = step.columns.map((c) => asString(row[c])).join(delim);
    const out: PipelineRow = {};
    for (const c of newCols) {
      if (c === step.newColumn) out[c] = merged;
      else out[c] = row[c];
    }
    return out;
  });
  return { ...state, columns: newCols, rows };
}

function applyAddIndexColumn(
  state: PipelineResult,
  step: AddIndexColumnStep,
): PipelineResult {
  const colName = step.columnName ?? "Index";
  if (state.columns.includes(colName)) {
    return {
      ...state,
      warnings: [
        ...state.warnings,
        `addIndexColumn: 列 '${colName}' は既に存在するため step を無視しました`,
      ],
    };
  }
  const startAt = step.startAt ?? 0;
  const increment = step.increment ?? 1;
  const newCols = [...state.columns, colName];
  const rows = state.rows.map((row, i) => ({
    ...row,
    [colName]: startAt + i * increment,
  }));
  return { ...state, columns: newCols, rows };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run a sequence of transform steps against `rows`. Steps are applied in
 * order; each step receives the output of the previous one. Pure / no I/O.
 *
 * `columnsHint` is optional — when provided, it sets the initial column
 * order (typically the headers from the source). When omitted, columns are
 * the union of `Object.keys(row)` across all rows in first-seen order.
 *
 * Tolerates malformed steps by emitting a warning and skipping; the
 * pipeline always returns a (possibly degenerate) result so the UI can
 * render warnings without special-casing.
 */
export function runPipeline(
  rows: ReadonlyArray<PipelineRow>,
  steps: ReadonlyArray<TransformStep>,
  columnsHint?: ReadonlyArray<string>,
): PipelineResult {
  const initial: PipelineResult = {
    columns: inferColumns(rows, columnsHint ? columnsHint.slice() : undefined),
    rows: rows.slice(),
    warnings: [],
  };
  let state = initial;
  for (const step of steps) {
    switch (step.kind) {
      case "selectColumns":
        state = applySelectColumns(state, step);
        break;
      case "dropColumns":
        state = applyDropColumns(state, step);
        break;
      case "filterRows":
        state = applyFilterRows(state, step);
        break;
      case "sort":
        state = applySort(state, step);
        break;
      case "rename":
        state = applyRename(state, step);
        break;
      case "groupBy":
        state = applyGroupBy(state, step);
        break;
      case "changeType":
        state = applyChangeType(state, step);
        break;
      case "fillMissing":
        state = applyFillMissing(state, step);
        break;
      case "conditionalColumn":
        state = applyConditionalColumn(state, step);
        break;
      case "replaceValue":
        state = applyReplaceValue(state, step);
        break;
      case "splitColumn":
        state = applySplitColumn(state, step);
        break;
      case "mergeColumns":
        state = applyMergeColumns(state, step);
        break;
      case "addIndexColumn":
        state = applyAddIndexColumn(state, step);
        break;
    }
  }
  return state;
}

/**
 * Produce a human-readable label for a step (used by the dialog's step list).
 */
export function describeStep(step: TransformStep): string {
  switch (step.kind) {
    case "selectColumns":
      return `列を選択: ${step.columns.join(", ")}`;
    case "dropColumns":
      return `列を削除: ${step.columns.join(", ")}`;
    case "filterRows":
      if (step.op === "isEmpty") return `${step.column} が空`;
      if (step.op === "isNotEmpty") return `${step.column} が空でない`;
      return `${step.column} ${step.op} '${step.value ?? ""}'`;
    case "sort":
      return `${step.column} で${step.descending ? "降順" : "昇順"}並べ替え`;
    case "rename":
      return `${step.from} → ${step.to}`;
    case "groupBy": {
      const aggs = step.agg.map((a) => `${a.fn}(${a.column})`).join(", ");
      return `${step.key} でグループ化: ${aggs}`;
    }
    case "changeType":
      return `${step.column} を ${step.targetType} に変換`;
    case "fillMissing":
      if (step.direction === "fixed") return `${step.column} の空白を '${step.fixedValue ?? ""}' で補完`;
      return `${step.column} の空白を ${step.direction === "forward" ? "前方" : "後方"}補完`;
    case "conditionalColumn": {
      const opLabel = step.op === "isEmpty" ? "が空" : step.op === "isNotEmpty" ? "が空でない" : `${step.op} '${step.value ?? ""}'`;
      return `条件列 ${step.newColumn}: ${step.column} ${opLabel}`;
    }
    case "replaceValue":
      return `${step.column}: '${step.find}' → '${step.replace}'${step.useRegex ? " (regex)" : ""}`;
    case "splitColumn":
      return `${step.column} を '${step.delimiter}' で分割 (${step.expand ?? "columns"})`;
    case "mergeColumns":
      return `${step.columns.join(" + ")} → ${step.newColumn}`;
    case "addIndexColumn":
      return `インデックス列 '${step.columnName ?? "Index"}' を追加 (${step.startAt ?? 0}~)`;
  }
}

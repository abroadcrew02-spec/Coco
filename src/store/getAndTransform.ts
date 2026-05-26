// #238 Power Query 風 Get & Transform — pure pipeline engine.
//
// Excel の Power Query は M 言語 + 大量のソース/transform をサポートするが、
// Coco の MVP では下記スコープに絞る:
//   - データソース: csv / json / jsonl / sqlite (本ファイルは pipeline 専用なので
//     ソース読み込みは別レイヤー — call site で受け取った rows[] から開始)
//   - 変換ステップ 6 種: selectColumns / dropColumns / filterRows / sort /
//     rename / groupBy
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
  | GroupByStep;

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
  }
}

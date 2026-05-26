import { describe, it, expect } from "vitest";
import {
  runQuery,
  pipelineResultToCellData,
  applyQueryResultToSnapshot,
  QUERY_MAX_ROWS,
  type SourceFetcher,
  type QueryRunResult,
} from "./queryExecutor";
import type { SavedQuery } from "./cocoQueries";
import type { PipelineRow } from "./getAndTransform";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuery(overrides: Partial<SavedQuery> = {}): SavedQuery {
  const now = "2026-05-26T00:00:00.000Z";
  return {
    id: "q1",
    name: "Query1",
    source: {
      kind: "static",
      rows: [
        { name: "Alice", age: 30, dept: "Eng" },
        { name: "Bob", age: 25, dept: "Sales" },
        { name: "Carol", age: 35, dept: "Eng" },
      ],
      columns: ["name", "age", "dept"],
    },
    steps: [],
    outputSheet: "QueryResult",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStaticFetcher(
  rows: PipelineRow[],
  columns?: string[],
  warnings?: string[],
): SourceFetcher {
  return {
    fetch: async () => ({ rows, columns, warnings }),
  };
}

function makeSnapshot(sheets: Record<string, unknown> = {}, sheetOrder: string[] = []) {
  return {
    id: "wb1",
    name: "Test",
    sheetOrder,
    sheets,
  };
}

// ---------------------------------------------------------------------------
// 1. static + empty steps → rows pass through unchanged
// ---------------------------------------------------------------------------

describe("runQuery", () => {
  it("1. static + empty steps returns rows as-is", async () => {
    const query = makeQuery();
    const fetcher = makeStaticFetcher(
      query.source.kind === "static" ? (query.source.rows as PipelineRow[]) : [],
      ["name", "age", "dept"],
    );
    const result = await runQuery(query, { fetcher });
    expect(result.pipeline.rows).toHaveLength(3);
    expect(result.pipeline.rows[0]).toEqual({ name: "Alice", age: 30, dept: "Eng" });
    expect(result.sourceWarnings).toEqual([]);
  });

  // 2. static + selectColumns → column reduction
  it("2. static + selectColumns reduces columns", async () => {
    const query = makeQuery({
      steps: [{ kind: "selectColumns", columns: ["name", "dept"] }],
    });
    const fetcher = makeStaticFetcher(
      [
        { name: "Alice", age: 30, dept: "Eng" },
        { name: "Bob", age: 25, dept: "Sales" },
      ],
      ["name", "age", "dept"],
    );
    const result = await runQuery(query, { fetcher });
    expect(result.pipeline.columns).toEqual(["name", "dept"]);
    expect(result.pipeline.rows[0]).not.toHaveProperty("age");
    expect(result.pipeline.rows[0]).toEqual({ name: "Alice", dept: "Eng" });
  });

  // 3. static + filterRows + sort → applied in order
  it("3. static + filterRows + sort applies steps in order", async () => {
    const query = makeQuery({
      steps: [
        { kind: "filterRows", column: "dept", op: "==", value: "Eng" },
        { kind: "sort", column: "age", descending: true },
      ],
    });
    const fetcher = makeStaticFetcher(
      [
        { name: "Alice", age: 30, dept: "Eng" },
        { name: "Bob", age: 25, dept: "Sales" },
        { name: "Carol", age: 35, dept: "Eng" },
      ],
      ["name", "age", "dept"],
    );
    const result = await runQuery(query, { fetcher });
    expect(result.pipeline.rows).toHaveLength(2);
    expect(result.pipeline.rows[0].name).toBe("Carol");
    expect(result.pipeline.rows[1].name).toBe("Alice");
  });

  // 4. static + groupBy → aggregation result
  it("4. static + groupBy returns aggregated rows", async () => {
    const query = makeQuery({
      steps: [
        {
          kind: "groupBy",
          key: "dept",
          agg: [{ column: "age", fn: "avg", as: "avg_age" }],
        },
      ],
    });
    const fetcher = makeStaticFetcher(
      [
        { name: "Alice", age: 30, dept: "Eng" },
        { name: "Bob", age: 25, dept: "Sales" },
        { name: "Carol", age: 35, dept: "Eng" },
      ],
      ["name", "age", "dept"],
    );
    const result = await runQuery(query, { fetcher });
    const engRow = result.pipeline.rows.find((r) => r.dept === "Eng");
    const salesRow = result.pipeline.rows.find((r) => r.dept === "Sales");
    expect(engRow).toBeDefined();
    expect(engRow!.avg_age).toBe(32.5);
    expect(salesRow!.avg_age).toBe(25);
  });

  // 11. MAX_ROWS clamp
  it("11. clamps to QUERY_MAX_ROWS when source exceeds limit", async () => {
    const overRows: PipelineRow[] = Array.from({ length: QUERY_MAX_ROWS + 1 }, (_, i) => ({
      n: i,
    }));
    const query = makeQuery({
      source: { kind: "static", rows: overRows, columns: ["n"] },
    });
    const fetcher = makeStaticFetcher(overRows, ["n"]);
    const result = await runQuery(query, { fetcher });
    expect(result.pipeline.rows).toHaveLength(QUERY_MAX_ROWS);
    expect(result.sourceWarnings).toHaveLength(1);
    expect(result.sourceWarnings[0]).toContain("1,000,000");
  });

  // 12. sourceWarnings propagation
  it("12. fetcher warnings propagate to sourceWarnings", async () => {
    const query = makeQuery();
    const fetcher: SourceFetcher = {
      fetch: async () => ({
        rows: [{ x: 1 }],
        columns: ["x"],
        warnings: ["行 3 のパースに失敗"],
      }),
    };
    const result = await runQuery(query, { fetcher });
    expect(result.sourceWarnings).toContain("行 3 のパースに失敗");
  });
});

// ---------------------------------------------------------------------------
// pipelineResultToCellData tests
// ---------------------------------------------------------------------------

describe("pipelineResultToCellData", () => {
  // 5. row 0 = headers, data rows at 1+
  it("5. row 0 is header row; data starts at row 1", () => {
    const result: QueryRunResult = {
      pipeline: {
        columns: ["colA", "colB"],
        rows: [
          { colA: "x", colB: 1 },
          { colA: "y", colB: 2 },
        ],
        warnings: [],
      },
      sourceWarnings: [],
    };
    const { cellData, rowCount, columnCount } = pipelineResultToCellData(result.pipeline);

    expect(cellData["0"]["0"].v).toBe("colA");
    expect(cellData["0"]["1"].v).toBe("colB");
    expect(cellData["1"]["0"].v).toBe("x");
    expect(cellData["1"]["1"].v).toBe(1);
    expect(cellData["2"]["0"].v).toBe("y");
    expect(rowCount).toBe(3);
    expect(columnCount).toBe(2);
  });

  // 6. empty rows → only header row
  it("6. empty rows still emits header row", () => {
    const { cellData, rowCount, columnCount } = pipelineResultToCellData({
      columns: ["a", "b"],
      rows: [],
      warnings: [],
    });
    expect(cellData["0"]["0"].v).toBe("a");
    expect(cellData["0"]["1"].v).toBe("b");
    expect(cellData["1"]).toBeUndefined();
    expect(rowCount).toBe(1);
    expect(columnCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyQueryResultToSnapshot tests
// ---------------------------------------------------------------------------

function makeRunResult(rows: PipelineRow[] = [], columns: string[] = []): QueryRunResult {
  return {
    pipeline: { columns, rows, warnings: [] },
    sourceWarnings: [],
  };
}

describe("applyQueryResultToSnapshot", () => {
  // 7. new sheet added + sheetOrder grows
  it("7. adds new sheet when outputSheet does not exist", () => {
    const snap = makeSnapshot({}, []);
    const query = makeQuery({ outputSheet: "Fresh" });
    const result = makeRunResult([{ x: 1 }], ["x"]);
    const out = applyQueryResultToSnapshot(snap, query, result) as Record<string, unknown>;

    const sheetOrder = out.sheetOrder as string[];
    expect(sheetOrder).toHaveLength(1);
    const newId = sheetOrder[0];
    const sheets = out.sheets as Record<string, Record<string, unknown>>;
    expect(sheets[newId].name).toBe("Fresh");
    expect(sheets[newId].rowCount).toBe(2);
  });

  // 8. existing sheet overwritten + sheetOrder unchanged
  it("8. overwrites existing sheet; sheetOrder stays the same", () => {
    const existingSheet = {
      id: "sheet-1",
      name: "QueryResult",
      rowCount: 100,
      columnCount: 5,
      cellData: {},
    };
    const snap = makeSnapshot({ "sheet-1": existingSheet }, ["sheet-1"]);
    const query = makeQuery({ outputSheet: "QueryResult" });
    const result = makeRunResult([{ a: 42 }], ["a"]);
    const out = applyQueryResultToSnapshot(snap, query, result) as Record<string, unknown>;

    const sheetOrder = out.sheetOrder as string[];
    expect(sheetOrder).toEqual(["sheet-1"]);
    const sheets = out.sheets as Record<string, Record<string, unknown>>;
    expect(sheets["sheet-1"].rowCount).toBe(2);
    expect(sheets["sheet-1"].columnCount).toBe(1);
  });

  // 9. _cocoQueries upserted
  it("9. upserts query into _cocoQueries", () => {
    const snap = makeSnapshot({}, []);
    const query = makeQuery({ id: "q-abc", name: "MyQuery" });
    const result = makeRunResult([], ["x"]);
    const out = applyQueryResultToSnapshot(snap, query, result) as Record<string, unknown>;
    const queries = out._cocoQueries as Array<{ id: string; name: string }>;
    expect(Array.isArray(queries)).toBe(true);
    expect(queries.some((q) => q.id === "q-abc")).toBe(true);
  });

  // 10. immutability: frozen snapshot does not throw
  it("10. does not mutate input snapshot (frozen object)", () => {
    const sheet = Object.freeze({
      id: "sheet-1",
      name: "QueryResult",
      rowCount: 1,
      columnCount: 1,
      cellData: Object.freeze({}),
    });
    const snap = Object.freeze({
      id: "wb",
      name: "Test",
      sheetOrder: Object.freeze(["sheet-1"]) as unknown as string[],
      sheets: Object.freeze({ "sheet-1": sheet }) as unknown as Record<string, unknown>,
    });
    const query = makeQuery({ outputSheet: "QueryResult" });
    const result = makeRunResult([{ a: 1 }], ["a"]);
    expect(() => applyQueryResultToSnapshot(snap, query, result)).not.toThrow();
    // Original is untouched
    expect((snap as Record<string, unknown>).sheetOrder).toHaveLength(1);
  });
});

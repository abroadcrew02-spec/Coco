import { describe, it, expect } from "vitest";
import {
  evaluate,
  evaluateDax,
  evaluateCalculatedColumns,
  evaluateMeasure,
  evaluateAllMeasures,
  _evaluateMeasureInternal,
  IMPLEMENTED_FUNCTIONS,
  CALC_COLUMN_ERROR,
  MEASURE_ERROR,
  parseDax,
  DAX_FUNCTION_REFERENCE,
  type DataModel,
  type CalculatedColumnDef,
  type MeasureDef,
} from "./daxEngine";

// #239 Power Pivot / DAX engine foundation tests.

function model(): DataModel {
  return {
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "Region", type: "string" },
          { name: "Quarter", type: "string" },
          { name: "Amount", type: "number" },
        ],
        rows: [
          { Region: "East", Quarter: "Q1", Amount: 100 },
          { Region: "East", Quarter: "Q2", Amount: 150 },
          { Region: "West", Quarter: "Q1", Amount: 200 },
          { Region: "West", Quarter: "Q2", Amount: 250 },
        ],
      },
    ],
    relationships: [],
  };
}

describe("parseDax", () => {
  it("parses a number literal", () => {
    expect(parseDax("42")).toEqual({ kind: "number", value: 42 });
  });

  it("strips a leading '='", () => {
    expect(parseDax("=42")).toEqual({ kind: "number", value: 42 });
  });

  it("parses a string literal with doubled-quote escape", () => {
    expect(parseDax('"hello"')).toEqual({ kind: "string", value: "hello" });
    expect(parseDax('"a""b"')).toEqual({ kind: "string", value: 'a"b' });
  });

  it("parses boolean literals (case-insensitive)", () => {
    expect(parseDax("TRUE")).toEqual({ kind: "boolean", value: true });
    expect(parseDax("false")).toEqual({ kind: "boolean", value: false });
  });

  it("parses a column ref Table[column]", () => {
    expect(parseDax("Sales[Amount]")).toEqual({
      kind: "columnRef",
      table: "Sales",
      column: "Amount",
    });
  });

  it("parses a function call", () => {
    expect(parseDax("SUM(Sales[Amount])")).toMatchObject({
      kind: "funcCall",
      name: "SUM",
      args: [{ kind: "columnRef", table: "Sales", column: "Amount" }],
    });
  });

  it("parses a binary expression with correct precedence", () => {
    const ast = parseDax("1 + 2 * 3");
    // Should be 1 + (2 * 3), not (1 + 2) * 3
    expect(ast).toMatchObject({
      kind: "binaryOp",
      op: "+",
      left: { kind: "number", value: 1 },
      right: {
        kind: "binaryOp",
        op: "*",
        left: { kind: "number", value: 2 },
        right: { kind: "number", value: 3 },
      },
    });
  });

  it("parses parentheses overriding precedence", () => {
    const ast = parseDax("(1 + 2) * 3");
    expect(ast).toMatchObject({
      kind: "binaryOp",
      op: "*",
      left: {
        kind: "binaryOp",
        op: "+",
        left: { kind: "number", value: 1 },
        right: { kind: "number", value: 2 },
      },
      right: { kind: "number", value: 3 },
    });
  });

  it("parses comparison operators", () => {
    expect(parseDax("a >= 1").kind).toBe("binaryOp");
    expect(parseDax("a <> 1").kind).toBe("binaryOp");
    expect(parseDax("a <= 1").kind).toBe("binaryOp");
  });

  it("parses unary minus as (0 - x)", () => {
    const ast = parseDax("-5");
    expect(ast).toMatchObject({
      kind: "binaryOp",
      op: "-",
      left: { kind: "number", value: 0 },
      right: { kind: "number", value: 5 },
    });
  });
});

describe("evaluate — literals + binary ops", () => {
  const ctx = { model: model() };

  it("numbers", () => {
    expect(evaluate({ kind: "number", value: 42 }, ctx)).toBe(42);
  });

  it("strings", () => {
    expect(evaluate({ kind: "string", value: "hi" }, ctx)).toBe("hi");
  });

  it("addition / subtraction / multiplication / division", () => {
    expect(evaluateDax("1 + 2", ctx)).toBe(3);
    expect(evaluateDax("10 - 4", ctx)).toBe(6);
    expect(evaluateDax("3 * 4", ctx)).toBe(12);
    expect(evaluateDax("10 / 4", ctx)).toBe(2.5);
  });

  it("division by zero → NaN", () => {
    expect(Number.isNaN(evaluateDax("10 / 0", ctx) as number)).toBe(true);
  });

  it("string concat with &", () => {
    expect(evaluateDax('"a" & "b"', ctx)).toBe("ab");
    expect(evaluateDax('"v=" & 42', ctx)).toBe("v=42");
  });

  it("equality / inequality (numeric)", () => {
    expect(evaluateDax("1 = 1", ctx)).toBe(true);
    expect(evaluateDax("1 = 2", ctx)).toBe(false);
    expect(evaluateDax("1 <> 2", ctx)).toBe(true);
  });

  it("equality / inequality (string)", () => {
    expect(evaluateDax('"foo" = "foo"', ctx)).toBe(true);
    expect(evaluateDax('"foo" = "bar"', ctx)).toBe(false);
  });

  it("comparisons", () => {
    expect(evaluateDax("3 > 2", ctx)).toBe(true);
    expect(evaluateDax("3 < 2", ctx)).toBe(false);
    expect(evaluateDax("3 >= 3", ctx)).toBe(true);
    expect(evaluateDax("3 <= 2", ctx)).toBe(false);
  });
});

describe("evaluate — aggregations", () => {
  const ctx = { model: model() };

  it("SUM(table[col])", () => {
    expect(evaluateDax("SUM(Sales[Amount])", ctx)).toBe(700);
  });

  it("AVERAGE", () => {
    expect(evaluateDax("AVERAGE(Sales[Amount])", ctx)).toBe(175);
  });

  it("MIN / MAX", () => {
    expect(evaluateDax("MIN(Sales[Amount])", ctx)).toBe(100);
    expect(evaluateDax("MAX(Sales[Amount])", ctx)).toBe(250);
  });

  it("COUNT counts numeric only", () => {
    expect(evaluateDax("COUNT(Sales[Amount])", ctx)).toBe(4);
    // Region column is all strings → COUNT(numeric-only) = 0
    expect(evaluateDax("COUNT(Sales[Region])", ctx)).toBe(0);
  });

  it("COUNTROWS(table)", () => {
    expect(evaluateDax("COUNTROWS(Sales)", ctx)).toBe(4);
  });

  it("DISTINCTCOUNT", () => {
    expect(evaluateDax("DISTINCTCOUNT(Sales[Region])", ctx)).toBe(2);
    expect(evaluateDax("DISTINCTCOUNT(Sales[Quarter])", ctx)).toBe(2);
  });

  it("IF returns truth branch when condition is truthy", () => {
    expect(evaluateDax("IF(TRUE, 100, 200)", ctx)).toBe(100);
    expect(evaluateDax("IF(FALSE, 100, 200)", ctx)).toBe(200);
    expect(evaluateDax("IF(1 = 1, 100, 200)", ctx)).toBe(100);
  });

  it("IF returns null when condition false and no else branch", () => {
    expect(evaluateDax("IF(FALSE, 100)", ctx)).toBeNull();
  });

  it("aggregations compose with arithmetic", () => {
    expect(evaluateDax("SUM(Sales[Amount]) / COUNTROWS(Sales)", ctx)).toBe(175);
  });

  it("empty column aggregations: MIN/MAX/AVERAGE → null", () => {
    const emptyCtx = {
      model: {
        tables: [
          { name: "T", columns: [{ name: "X", type: "number" as const }], rows: [] },
        ],
        relationships: [],
      },
    };
    expect(evaluateDax("SUM(T[X])", emptyCtx)).toBe(0);
    expect(evaluateDax("MIN(T[X])", emptyCtx)).toBeNull();
    expect(evaluateDax("MAX(T[X])", emptyCtx)).toBeNull();
    expect(evaluateDax("AVERAGE(T[X])", emptyCtx)).toBeNull();
  });

  it("ALL is currently a passthrough (CALCULATE deferred)", () => {
    expect(evaluateDax("SUM(ALL(Sales[Amount]))", ctx)).toBe(700);
  });
});

describe("evaluateDax — error handling", () => {
  const ctx = { model: model() };

  it("returns an error object for malformed input", () => {
    const r = evaluateDax("1 +", ctx) as { error: string };
    expect(r.error).toBeTruthy();
  });

  it("returns an error for unknown function", () => {
    const r = evaluateDax("FOO(1, 2)", ctx) as { error: string };
    expect(r.error).toContain("FOO");
  });

  it("returns an error for unknown table", () => {
    // Unknown table → SUM gets an empty array → returns 0 (not an error).
    // This is the documented behaviour: undefined tables silently degrade.
    expect(evaluateDax("SUM(Ghost[X])", ctx)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step 2: RELATED + SUMX / AVERAGEX / MINX / MAXX / COUNTX
// ---------------------------------------------------------------------------

function modelWithRelationship(): DataModel {
  return {
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "ProductId", type: "string" },
          { name: "Qty", type: "number" },
        ],
        rows: [
          { ProductId: "P1", Qty: 3 },
          { ProductId: "P2", Qty: 5 },
          { ProductId: "P1", Qty: 2 },
        ],
      },
      {
        name: "Products",
        columns: [
          { name: "Id", type: "string" },
          { name: "Name", type: "string" },
          { name: "Price", type: "number" },
        ],
        rows: [
          { Id: "P1", Name: "Apple", Price: 100 },
          { Id: "P2", Name: "Banana", Price: 80 },
        ],
      },
    ],
    relationships: [
      // M:1 — Sales.ProductId → Products.Id
      { fromTable: "Sales", fromColumn: "ProductId", toTable: "Products", toColumn: "Id" },
    ],
  };
}

describe("RELATED — M:1 lookup", () => {
  it("returns null outside a row context", () => {
    const ctx = { model: modelWithRelationship() };
    expect(evaluateDax("RELATED(Products[Price])", ctx)).toBeNull();
  });

  it("inside SUMX, RELATED resolves the joined row's column", () => {
    const ctx = { model: modelWithRelationship() };
    // SUM(Sales.Qty * Products.Price):
    //   row 1 (P1, Qty=3): 3 * 100 = 300
    //   row 2 (P2, Qty=5): 5 *  80 = 400
    //   row 3 (P1, Qty=2): 2 * 100 = 200
    //   total = 900
    expect(
      evaluateDax("SUMX(Sales, Sales[Qty] * RELATED(Products[Price]))", ctx),
    ).toBe(900);
  });

  it("returns null when no relationship between tables (silent 0 in SUMX)", () => {
    const ctx = {
      model: {
        tables: [
          {
            name: "Sales",
            columns: [{ name: "Qty", type: "number" as const }],
            rows: [{ Qty: 1 }],
          },
          {
            name: "Other",
            columns: [{ name: "X", type: "string" as const }],
            rows: [{ X: "a" }],
          },
        ],
        relationships: [],
      },
    };
    expect(evaluateDax("SUMX(Sales, RELATED(Other[X]))", ctx)).toBe(0);
  });

  it("handles null key gracefully (row contributes 0 to SUM)", () => {
    const m = modelWithRelationship();
    m.tables[0].rows[0].ProductId = null;
    const ctx = { model: m };
    // Row 1's ProductId is null → RELATED returns null → Qty*null = NaN
    // → dropped from SUM. Rows 2 & 3 contribute Price (80, 100).
    expect(evaluateDax("SUMX(Sales, RELATED(Products[Price]))", ctx)).toBe(180);
  });

  it("rejects RELATED without a column reference argument", () => {
    const r = evaluateDax("SUMX(Sales, RELATED(42))", { model: modelWithRelationship() }) as { error: string };
    expect(r.error).toContain("RELATED");
  });
});

describe("SUMX / AVERAGEX / MINX / MAXX / COUNTX", () => {
  const ctx = { model: modelWithRelationship() };

  it("SUMX sums per-row expressions", () => {
    // Sales.Qty across 3 rows: 3 + 5 + 2 = 10
    expect(evaluateDax("SUMX(Sales, Sales[Qty])", ctx)).toBe(10);
  });

  it("AVERAGEX averages per-row expressions", () => {
    expect(evaluateDax("AVERAGEX(Sales, Sales[Qty])", ctx)).toBeCloseTo(10 / 3, 5);
  });

  it("MINX / MAXX find extremes", () => {
    expect(evaluateDax("MINX(Sales, Sales[Qty])", ctx)).toBe(2);
    expect(evaluateDax("MAXX(Sales, Sales[Qty])", ctx)).toBe(5);
  });

  it("COUNTX counts numeric per-row results", () => {
    expect(evaluateDax("COUNTX(Sales, Sales[Qty])", ctx)).toBe(3);
  });

  it("SUMX with arithmetic expression evaluates per row", () => {
    expect(evaluateDax("SUMX(Sales, Sales[Qty] * 10)", ctx)).toBe(100);
  });

  it("SUMX with IF iterates correctly", () => {
    // Qty > 3 contributes Qty, else 0 → only row 2 (Qty=5) qualifies → 5
    expect(
      evaluateDax("SUMX(Sales, IF(Sales[Qty] > 3, Sales[Qty], 0))", ctx),
    ).toBe(5);
  });

  it("SUMX(ALL(table), ...) — ALL passthrough still iterates", () => {
    expect(evaluateDax("SUMX(ALL(Sales), Sales[Qty])", ctx)).toBe(10);
  });

  it("rejects SUMX without a table argument", () => {
    const r = evaluateDax("SUMX(42, Sales[Qty])", ctx) as { error: string };
    expect(r.error).toContain("SUMX");
  });

  it("returns NULL/0 baselines for empty inputs", () => {
    const emptyCtx = {
      model: {
        tables: [{ name: "T", columns: [{ name: "X", type: "number" as const }], rows: [] }],
        relationships: [],
      },
    };
    expect(evaluateDax("SUMX(T, T[X])", emptyCtx)).toBe(0);
    expect(evaluateDax("MINX(T, T[X])", emptyCtx)).toBeNull();
    expect(evaluateDax("MAXX(T, T[X])", emptyCtx)).toBeNull();
    expect(evaluateDax("AVERAGEX(T, T[X])", emptyCtx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 3: FILTER + CALCULATE (filter context propagation)
// ---------------------------------------------------------------------------

describe("FILTER", () => {
  const ctx = { model: model() };

  it("returns rows passing the predicate", () => {
    // 4 sales rows; only ones with Amount > 150 (200, 250) pass.
    const r = evaluateDax("FILTER(Sales, Sales[Amount] > 150)", ctx) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(r)).toBe(true);
    expect(r).toHaveLength(2);
    expect(r.every((row) => (row.Amount as number) > 150)).toBe(true);
  });

  it("equality filter on string column works", () => {
    const r = evaluateDax(
      'FILTER(Sales, Sales[Region] = "East")',
      ctx,
    ) as Array<Record<string, unknown>>;
    expect(r).toHaveLength(2);
  });

  it("returns empty array when no row matches", () => {
    const r = evaluateDax(
      "FILTER(Sales, Sales[Amount] > 9999)",
      ctx,
    ) as Array<Record<string, unknown>>;
    expect(r).toEqual([]);
  });

  it("can be the input to SUMX/COUNTROWS for aggregation", () => {
    expect(
      evaluateDax(
        "SUMX(FILTER(Sales, Sales[Amount] > 150), Sales[Amount])",
        ctx,
      ),
    ).toBe(450); // 200 + 250
    expect(
      evaluateDax("COUNTROWS(FILTER(Sales, Sales[Amount] > 150))", ctx),
    ).toBe(2);
  });
});

describe("CALCULATE", () => {
  const ctx = { model: model() };

  it("evaluates expression with a single filter applied", () => {
    // SUM of Amount, only East rows: 100 + 150 = 250
    expect(
      evaluateDax(
        'CALCULATE(SUM(Sales[Amount]), FILTER(Sales, Sales[Region] = "East"))',
        ctx,
      ),
    ).toBe(250);
  });

  it("INTERSECTS multiple filters on the same table", () => {
    // East AND Q2 → only one row (Amount=150)
    const r = evaluateDax(
      `CALCULATE(
        SUM(Sales[Amount]),
        FILTER(Sales, Sales[Region] = "East"),
        FILTER(Sales, Sales[Quarter] = "Q2")
      )`,
      ctx,
    );
    expect(r).toBe(150);
  });

  it("ALL bypasses the filter context", () => {
    // CALCULATE with East filter → SUM(Sales[Amount]) = 250
    // but ALL(Sales) drops the filter → SUM = 700
    expect(
      evaluateDax(
        `CALCULATE(
          SUMX(ALL(Sales), Sales[Amount]),
          FILTER(Sales, Sales[Region] = "East")
        )`,
        ctx,
      ),
    ).toBe(700);
  });

  it("nested CALCULATE composes filters (intersection)", () => {
    expect(
      evaluateDax(
        `CALCULATE(
          CALCULATE(SUM(Sales[Amount]), FILTER(Sales, Sales[Quarter] = "Q2")),
          FILTER(Sales, Sales[Region] = "East")
        )`,
        ctx,
      ),
    ).toBe(150); // East ∩ Q2 = single row Amount=150
  });

  it("rejects non-FILTER filter args", () => {
    const r = evaluateDax(
      "CALCULATE(SUM(Sales[Amount]), 42)",
      ctx,
    ) as { error: string };
    expect(r.error).toContain("FILTER");
  });

  it("with no filter args degrades to plain expression", () => {
    expect(evaluateDax("CALCULATE(SUM(Sales[Amount]))", ctx)).toBe(700);
  });
});

describe("filter context propagation into nested aggregations", () => {
  const ctx = { model: model() };

  it("SUM inside CALCULATE sees only filtered rows", () => {
    expect(
      evaluateDax(
        'CALCULATE(COUNTROWS(Sales), FILTER(Sales, Sales[Region] = "East"))',
        ctx,
      ),
    ).toBe(2);
  });

  it("AVERAGEX inside CALCULATE iterates only filtered rows", () => {
    // East rows: Amount = [100, 150] → avg = 125
    expect(
      evaluateDax(
        `CALCULATE(
          AVERAGEX(Sales, Sales[Amount]),
          FILTER(Sales, Sales[Region] = "East")
        )`,
        ctx,
      ),
    ).toBe(125);
  });
});

describe("IMPLEMENTED_FUNCTIONS", () => {
  it("contains the documented MVP function set (Step 1 + Step 2)", () => {
    // Step 1
    expect(IMPLEMENTED_FUNCTIONS.has("SUM")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("AVERAGE")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("MIN")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("MAX")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("COUNT")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("COUNTROWS")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("DISTINCTCOUNT")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("IF")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("ALL")).toBe(true);
    // Step 2
    expect(IMPLEMENTED_FUNCTIONS.has("RELATED")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("SUMX")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("AVERAGEX")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("MINX")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("MAXX")).toBe(true);
    expect(IMPLEMENTED_FUNCTIONS.has("COUNTX")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 4: evaluateCalculatedColumns
// ---------------------------------------------------------------------------

function salesModel(): DataModel {
  return {
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "Region", type: "string" },
          { name: "Amount", type: "number" },
        ],
        rows: [
          { Region: "East", Amount: 100 },
          { Region: "West", Amount: 200 },
        ],
      },
    ],
    relationships: [],
  };
}

describe("evaluateCalculatedColumns — basics", () => {
  it("injects a simple arithmetic column into every row", () => {
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "AmountX2",
      expression: "Sales[Amount] * 2",
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    const rows = result.tables[0].rows;
    expect(rows[0].AmountX2).toBe(200);
    expect(rows[1].AmountX2).toBe(400);
  });

  it("appends the column to ModelTable.columns with inferred type", () => {
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "AmountX2",
      expression: "Sales[Amount] * 2",
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    const cols = result.tables[0].columns;
    expect(cols.some((c) => c.name === "AmountX2")).toBe(true);
  });

  it("does NOT mutate the input model", () => {
    const original = salesModel();
    const originalRow0 = { ...original.tables[0].rows[0] };
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "NewCol",
      expression: "Sales[Amount] + 1",
    };
    evaluateCalculatedColumns(original, [col]);
    expect(original.tables[0].rows[0]).toEqual(originalRow0);
    expect(original.tables[0].columns).toHaveLength(2);
  });

  it("string expression is evaluated per row", () => {
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "Label",
      expression: 'Sales[Region] & " - ok"',
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    const rows = result.tables[0].rows;
    expect(rows[0].Label).toBe("East - ok");
    expect(rows[1].Label).toBe("West - ok");
  });

  it("boolean expression is evaluated per row", () => {
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "IsLarge",
      expression: "Sales[Amount] > 150",
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    expect(result.tables[0].rows[0].IsLarge).toBe(false);
    expect(result.tables[0].rows[1].IsLarge).toBe(true);
  });

  it("IF expression works in row context", () => {
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "Tier",
      expression: 'IF(Sales[Amount] >= 200, "High", "Low")',
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    expect(result.tables[0].rows[0].Tier).toBe("Low");
    expect(result.tables[0].rows[1].Tier).toBe("High");
  });
});

describe("evaluateCalculatedColumns — error handling", () => {
  it("parse error marks every cell as CALC_COLUMN_ERROR", () => {
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "Bad",
      expression: "1 +",  // syntax error
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    const rows = result.tables[0].rows;
    expect(rows[0].Bad).toBe(CALC_COLUMN_ERROR);
    expect(rows[1].Bad).toBe(CALC_COLUMN_ERROR);
    // Column is still registered so callers can identify it.
    expect(result.tables[0].columns.some((c) => c.name === "Bad")).toBe(true);
  });

  it("runtime error on a single row marks that cell, others are fine", () => {
    // Divide by a column value that is 0 on one row.
    const m: DataModel = {
      tables: [
        {
          name: "T",
          columns: [{ name: "X", type: "number" }],
          rows: [{ X: 10 }, { X: 0 }, { X: 5 }],
        },
      ],
      relationships: [],
    };
    const col: CalculatedColumnDef = {
      tableId: "T",
      columnName: "Inv",
      expression: "10 / T[X]",
    };
    const result = evaluateCalculatedColumns(m, [col]);
    const rows = result.tables[0].rows;
    // 10/10 = 1, 10/0 = NaN (not an error object, so stored as NaN), 10/5 = 2
    expect(rows[0].Inv).toBe(1);
    expect(Number.isNaN(rows[1].Inv)).toBe(true);
    expect(rows[2].Inv).toBe(2);
  });

  it("unknown function in expression marks every cell as CALC_COLUMN_ERROR", () => {
    // evaluateDax returns { error: ... } for unknown function — should turn into CALC_COLUMN_ERROR
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "Bad2",
      expression: "NOPE(Sales[Amount])",
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    const rows = result.tables[0].rows;
    expect(rows[0].Bad2).toBe(CALC_COLUMN_ERROR);
    expect(rows[1].Bad2).toBe(CALC_COLUMN_ERROR);
  });

  it("unknown tableId is silently skipped — model is not corrupted", () => {
    const col: CalculatedColumnDef = {
      tableId: "Ghost",
      columnName: "X",
      expression: "1",
    };
    const result = evaluateCalculatedColumns(salesModel(), [col]);
    // Sales table is untouched.
    expect(result.tables[0].columns).toHaveLength(2);
    expect(result.tables[0].rows[0]).not.toHaveProperty("X");
  });

  it("empty table produces no rows but column metadata is registered", () => {
    const m: DataModel = {
      tables: [
        { name: "T", columns: [{ name: "X", type: "number" }], rows: [] },
      ],
      relationships: [],
    };
    const col: CalculatedColumnDef = {
      tableId: "T",
      columnName: "Y",
      expression: "T[X] * 2",
    };
    const result = evaluateCalculatedColumns(m, [col]);
    expect(result.tables[0].rows).toHaveLength(0);
    // Column registered even though there were no rows to infer type from.
    expect(result.tables[0].columns.some((c) => c.name === "Y")).toBe(true);
  });
});

describe("evaluateCalculatedColumns — RELATED in row context", () => {
  it("RELATED resolves M:1 lookup inside a calculated column", () => {
    const m: DataModel = {
      tables: [
        {
          name: "Sales",
          columns: [
            { name: "ProductId", type: "string" },
            { name: "Qty", type: "number" },
          ],
          rows: [
            { ProductId: "P1", Qty: 3 },
            { ProductId: "P2", Qty: 5 },
          ],
        },
        {
          name: "Products",
          columns: [
            { name: "Id", type: "string" },
            { name: "Price", type: "number" },
          ],
          rows: [
            { Id: "P1", Price: 100 },
            { Id: "P2", Price: 80 },
          ],
        },
      ],
      relationships: [
        { fromTable: "Sales", fromColumn: "ProductId", toTable: "Products", toColumn: "Id" },
      ],
    };
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "Revenue",
      expression: "Sales[Qty] * RELATED(Products[Price])",
    };
    const result = evaluateCalculatedColumns(m, [col]);
    const rows = result.tables[0].rows;
    expect(rows[0].Revenue).toBe(300);  // 3 * 100
    expect(rows[1].Revenue).toBe(400);  // 5 * 80
  });
});

describe("evaluateCalculatedColumns — column chaining", () => {
  it("second column can reference values set by first column", () => {
    const col1: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "AmountX2",
      expression: "Sales[Amount] * 2",
    };
    const col2: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "AmountX4",
      expression: "Sales[AmountX2] * 2",
    };
    const result = evaluateCalculatedColumns(salesModel(), [col1, col2]);
    const rows = result.tables[0].rows;
    // East: 100 → 200 → 400
    expect(rows[0].AmountX2).toBe(200);
    expect(rows[0].AmountX4).toBe(400);
    // West: 200 → 400 → 800
    expect(rows[1].AmountX2).toBe(400);
    expect(rows[1].AmountX4).toBe(800);
  });

  it("multiple columns targeting different tables work independently", () => {
    const m: DataModel = {
      tables: [
        {
          name: "A",
          columns: [{ name: "X", type: "number" }],
          rows: [{ X: 10 }],
        },
        {
          name: "B",
          columns: [{ name: "Y", type: "number" }],
          rows: [{ Y: 20 }],
        },
      ],
      relationships: [],
    };
    const result = evaluateCalculatedColumns(m, [
      { tableId: "A", columnName: "X2", expression: "A[X] * 2" },
      { tableId: "B", columnName: "Y2", expression: "B[Y] * 2" },
    ]);
    expect(result.tables[0].rows[0].X2).toBe(20);
    expect(result.tables[1].rows[0].Y2).toBe(40);
  });
});

describe("evaluateCalculatedColumns — idempotent column registration", () => {
  it("re-evaluating same columnName replaces values but doesn't duplicate column metadata", () => {
    const col: CalculatedColumnDef = {
      tableId: "Sales",
      columnName: "AmountX2",
      expression: "Sales[Amount] * 2",
    };
    // Apply twice — same column name.
    const result = evaluateCalculatedColumns(salesModel(), [col, col]);
    const cols = result.tables[0].columns;
    expect(cols.filter((c) => c.name === "AmountX2")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Step 6: evaluateMeasure / evaluateAllMeasures
// ---------------------------------------------------------------------------

function measureModel(): DataModel {
  return {
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "Region", type: "string" },
          { name: "Amount", type: "number" },
          { name: "Quantity", type: "number" },
        ],
        rows: [
          { Region: "East", Amount: 100, Quantity: 2 },
          { Region: "East", Amount: 150, Quantity: 3 },
          { Region: "West", Amount: 200, Quantity: 1 },
          { Region: "West", Amount: 250, Quantity: 4 },
        ],
      },
      {
        name: "Regions",
        columns: [
          { name: "Code", type: "string" },
          { name: "Label", type: "string" },
        ],
        rows: [
          { Code: "East", Label: "Eastern Region" },
          { Code: "West", Label: "Western Region" },
        ],
      },
    ],
    relationships: [],
  };
}

function defs(measures: Array<{ name: string; expression: string }>): MeasureDef[] {
  return measures;
}

describe("evaluateMeasure — basic aggregations", () => {
  it("SUM measure returns correct total", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([{ name: "Total Amount", expression: "SUM(Sales[Amount])" }]),
      "Total Amount",
    );
    expect(result).toBe(700);
  });

  it("AVERAGE measure returns correct mean", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([{ name: "Avg Amount", expression: "AVERAGE(Sales[Amount])" }]),
      "Avg Amount",
    );
    expect(result).toBe(175);
  });

  it("COUNT measure counts numeric rows", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([{ name: "Row Count", expression: "COUNTROWS(Sales)" }]),
      "Row Count",
    );
    expect(result).toBe(4);
  });

  it("MAX / MIN measures return correct extremes", () => {
    const m = measureModel();
    const ms = defs([
      { name: "Max Amt", expression: "MAX(Sales[Amount])" },
      { name: "Min Amt", expression: "MIN(Sales[Amount])" },
    ]);
    expect(evaluateMeasure(m, ms, "Max Amt")).toBe(250);
    expect(evaluateMeasure(m, ms, "Min Amt")).toBe(100);
  });

  it("arithmetic expression measure returns scalar", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([{ name: "Hard Coded", expression: "10 + 5 * 2" }]),
      "Hard Coded",
    );
    expect(result).toBe(20);
  });
});

describe("evaluateMeasure — filter context", () => {
  it("evaluates with external filter context (East only)", () => {
    const m = measureModel();
    const eastRows = m.tables[0].rows.filter((r) => r.Region === "East");
    const filterCtx = new Map<string, Array<Record<string, unknown>>>([
      ["Sales", eastRows],
    ]);
    const result = evaluateMeasure(
      m,
      defs([{ name: "East Total", expression: "SUM(Sales[Amount])" }]),
      "East Total",
      filterCtx,
    );
    expect(result).toBe(250); // 100 + 150
  });

  it("CALCULATE measure modifies its own filter context", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([
        {
          name: "West Total",
          expression: "CALCULATE(SUM(Sales[Amount]), FILTER(Sales, Sales[Region] = \"West\"))",
        },
      ]),
      "West Total",
    );
    expect(result).toBe(450); // 200 + 250
  });

  it("FILTER inside measure returns filtered table to COUNTROWS", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([
        {
          name: "East Count",
          expression: "COUNTROWS(FILTER(Sales, Sales[Region] = \"East\"))",
        },
      ]),
      "East Count",
    );
    expect(result).toBe(2);
  });

  it("ALL bypasses external filter context", () => {
    const m = measureModel();
    // Apply an East-only filter externally.
    const eastRows = m.tables[0].rows.filter((r) => r.Region === "East");
    const filterCtx = new Map<string, Array<Record<string, unknown>>>([
      ["Sales", eastRows],
    ]);
    // The measure uses ALL to ignore the filter and sum the full dataset.
    const result = evaluateMeasure(
      m,
      defs([{ name: "All Total", expression: "SUM(ALL(Sales[Amount]))" }]),
      "All Total",
      filterCtx,
    );
    expect(result).toBe(700); // all 4 rows
  });

  it("CALCULATE intersects with external filter context", () => {
    const m = measureModel();
    // External: East rows only.
    const eastRows = m.tables[0].rows.filter((r) => r.Region === "East");
    const filterCtx = new Map<string, Array<Record<string, unknown>>>([
      ["Sales", eastRows],
    ]);
    // CALCULATE pushes a FILTER for Amount > 120 on top.
    // Only East row with Amount=150 passes both filters.
    const result = evaluateMeasure(
      m,
      defs([
        {
          name: "East High",
          expression: "CALCULATE(SUM(Sales[Amount]), FILTER(Sales, Sales[Amount] > 120))",
        },
      ]),
      "East High",
      filterCtx,
    );
    // Intersection: East rows ∩ Amount>120 → only row {East,150}
    expect(result).toBe(150);
  });
});

describe("evaluateMeasure — error handling", () => {
  it("returns MEASURE_ERROR for unknown measure name", () => {
    expect(
      evaluateMeasure(measureModel(), defs([]), "No Such Measure"),
    ).toBe(MEASURE_ERROR);
  });

  it("returns MEASURE_ERROR for parse error in expression", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([{ name: "Bad Expr", expression: "SUM(Sales[Amount]" }]), // missing ')'
      "Bad Expr",
    );
    expect(result).toBe(MEASURE_ERROR);
  });

  it("returns MEASURE_ERROR for unsupported function in expression", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([{ name: "Bad Fn", expression: "NOSUCHFN(Sales[Amount])" }]),
      "Bad Fn",
    );
    expect(result).toBe(MEASURE_ERROR);
  });

  it("returns MEASURE_ERROR for circular reference (self-referential measure)", () => {
    // Directly invoke the internal function with "Self" already in the evaluating set
    // to simulate a re-entrant call — this is the exact scenario the guard protects against.
    const evaluating = new Set(["Self"]);
    const result = _evaluateMeasureInternal(
      measureModel(),
      defs([{ name: "Self", expression: "SUM(Sales[Amount])" }]),
      "Self",
      undefined,
      evaluating,
    );
    expect(result).toBe(MEASURE_ERROR);
  });

  it("MEASURE_ERROR sentinel matches CALC_COLUMN_ERROR sentinel value", () => {
    // Consistent error sentinel across calculated columns and measures.
    expect(MEASURE_ERROR).toBe(CALC_COLUMN_ERROR);
  });

  it("returns MEASURE_ERROR when expression produces an array (no aggregation)", () => {
    // A bare tableRef without COUNTROWS or SUM returns an array — invalid scalar.
    const result = evaluateMeasure(
      measureModel(),
      defs([{ name: "Table Ref", expression: "Sales" }]),
      "Table Ref",
    );
    expect(result).toBe(MEASURE_ERROR);
  });
});

describe("evaluateMeasure — no row context", () => {
  it("SUMX inside a measure iterates the table normally (measure has no currentRow)", () => {
    const result = evaluateMeasure(
      measureModel(),
      defs([
        {
          name: "SumX Measure",
          expression: "SUMX(Sales, Sales[Amount] * Sales[Quantity])",
        },
      ]),
      "SumX Measure",
    );
    // 100*2 + 150*3 + 200*1 + 250*4 = 200+450+200+1000 = 1850
    expect(result).toBe(1850);
  });
});

describe("evaluateAllMeasures", () => {
  it("returns a map with all measure names and their values", () => {
    const ms = defs([
      { name: "Total", expression: "SUM(Sales[Amount])" },
      { name: "Count", expression: "COUNTROWS(Sales)" },
    ]);
    const results = evaluateAllMeasures(measureModel(), ms);
    expect(results.size).toBe(2);
    expect(results.get("Total")).toBe(700);
    expect(results.get("Count")).toBe(4);
  });

  it("returns MEASURE_ERROR for individual failed measures, others succeed", () => {
    const ms = defs([
      { name: "Good", expression: "SUM(Sales[Amount])" },
      { name: "Bad", expression: "SUM(Sales[Amount]" }, // parse error
    ]);
    const results = evaluateAllMeasures(measureModel(), ms);
    expect(results.get("Good")).toBe(700);
    expect(results.get("Bad")).toBe(MEASURE_ERROR);
  });

  it("returns empty map for empty measure list", () => {
    const results = evaluateAllMeasures(measureModel(), []);
    expect(results.size).toBe(0);
  });

  it("respects filter context for all measures", () => {
    const m = measureModel();
    const eastRows = m.tables[0].rows.filter((r) => r.Region === "East");
    const filterCtx = new Map<string, Array<Record<string, unknown>>>([
      ["Sales", eastRows],
    ]);
    const ms = defs([
      { name: "Total", expression: "SUM(Sales[Amount])" },
      { name: "Count", expression: "COUNTROWS(Sales)" },
    ]);
    const results = evaluateAllMeasures(m, ms, filterCtx);
    expect(results.get("Total")).toBe(250);
    expect(results.get("Count")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DAX_FUNCTION_REFERENCE integrity
// ---------------------------------------------------------------------------

describe("DAX_FUNCTION_REFERENCE", () => {
  it("contains exactly 17 entries", () => {
    expect(DAX_FUNCTION_REFERENCE).toHaveLength(17);
  });

  it("every name is in IMPLEMENTED_FUNCTIONS", () => {
    for (const fn of DAX_FUNCTION_REFERENCE) {
      expect(IMPLEMENTED_FUNCTIONS.has(fn.name.toUpperCase())).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 7: Cross-measure references via [MeasureName] syntax (#311)
// ---------------------------------------------------------------------------

describe("parseDax — measureRef nodes", () => {
  it("parses [MeasureName] as a measureRef AST node", () => {
    const ast = parseDax("[TotalSales]");
    expect(ast).toEqual({ kind: "measureRef", name: "TotalSales" });
  });

  it("parses measure names containing spaces", () => {
    const ast = parseDax("[Total Sales]");
    expect(ast).toEqual({ kind: "measureRef", name: "Total Sales" });
  });

  it("parses [MeasureName] in a binary expression", () => {
    const ast = parseDax("[TotalSales] * 1.1");
    expect(ast).toMatchObject({
      kind: "binaryOp",
      op: "*",
      left: { kind: "measureRef", name: "TotalSales" },
      right: { kind: "number", value: 1.1 },
    });
  });

  it("does NOT confuse Sales[Amount] (columnRef) with [Amount] (measureRef)", () => {
    const colAst = parseDax("Sales[Amount]");
    expect(colAst).toEqual({ kind: "columnRef", table: "Sales", column: "Amount" });

    const refAst = parseDax("[Amount]");
    expect(refAst).toEqual({ kind: "measureRef", name: "Amount" });
  });
});

describe("evaluateMeasure — cross-measure references", () => {
  it("[MeasureName] evaluates the referenced measure", () => {
    const m = measureModel();
    const ms = defs([
      { name: "TotalSales", expression: "SUM(Sales[Amount])" },
      { name: "TaxedSales", expression: "[TotalSales] * 1.1" },
    ]);
    expect(evaluateMeasure(m, ms, "TotalSales")).toBe(700);
    expect(evaluateMeasure(m, ms, "TaxedSales")).toBeCloseTo(770, 5);
  });

  it("three-level chain A → B → C evaluates correctly", () => {
    const m = measureModel();
    const ms = defs([
      { name: "Base", expression: "SUM(Sales[Amount])" },
      { name: "Double", expression: "[Base] * 2" },
      { name: "Triple", expression: "[Double] + [Base]" },
    ]);
    // Base = 700, Double = 1400, Triple = 1400 + 700 = 2100
    expect(evaluateMeasure(m, ms, "Triple")).toBe(2100);
  });

  it("returns MEASURE_ERROR for a reference to a non-existent measure", () => {
    const m = measureModel();
    const ms = defs([
      { name: "Broken", expression: "[DoesNotExist] * 2" },
    ]);
    expect(evaluateMeasure(m, ms, "Broken")).toBe(MEASURE_ERROR);
  });

  it("returns MEASURE_ERROR for a direct circular reference (A = [A])", () => {
    const m = measureModel();
    const ms = defs([
      { name: "SelfRef", expression: "[SelfRef] + 1" },
    ]);
    expect(evaluateMeasure(m, ms, "SelfRef")).toBe(MEASURE_ERROR);
  });

  it("returns MEASURE_ERROR for a mutual circular reference (A = [B], B = [A])", () => {
    const m = measureModel();
    const ms = defs([
      { name: "A", expression: "[B]" },
      { name: "B", expression: "[A]" },
    ]);
    expect(evaluateMeasure(m, ms, "A")).toBe(MEASURE_ERROR);
    expect(evaluateMeasure(m, ms, "B")).toBe(MEASURE_ERROR);
  });

  it("[MeasureName] inherits the external filter context", () => {
    const m = measureModel();
    // East rows only: Amount = 100 + 150 = 250
    const eastRows = m.tables[0].rows.filter((r) => r.Region === "East");
    const filterCtx = new Map<string, Array<Record<string, unknown>>>([
      ["Sales", eastRows],
    ]);
    const ms = defs([
      { name: "TotalSales", expression: "SUM(Sales[Amount])" },
      { name: "TaxedSales", expression: "[TotalSales] * 1.1" },
    ]);
    // TotalSales under East filter = 250; TaxedSales = 250 * 1.1 = 275
    expect(evaluateMeasure(m, ms, "TotalSales", filterCtx)).toBe(250);
    expect(evaluateMeasure(m, ms, "TaxedSales", filterCtx)).toBeCloseTo(275, 5);
  });

  it("evaluateAllMeasures resolves cross-measure refs for all measures", () => {
    const m = measureModel();
    const ms = defs([
      { name: "Base", expression: "SUM(Sales[Amount])" },
      { name: "Ratio", expression: "[Base] / COUNTROWS(Sales)" },
    ]);
    const results = evaluateAllMeasures(m, ms);
    expect(results.get("Base")).toBe(700);
    expect(results.get("Ratio")).toBe(175); // 700 / 4
  });
});

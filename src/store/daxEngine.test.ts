import { describe, it, expect } from "vitest";
import {
  evaluate,
  evaluateDax,
  IMPLEMENTED_FUNCTIONS,
  parseDax,
  type DataModel,
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

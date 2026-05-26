import { describe, it, expect } from "vitest";
import {
  describeStep,
  runPipeline,
  type PipelineRow,
  type TransformStep,
} from "./getAndTransform";

// #238 Power Query foundation — pure pipeline engine tests.

const sales: PipelineRow[] = [
  { Region: "East", Quarter: "Q1", Sales: 100 },
  { Region: "East", Quarter: "Q2", Sales: 150 },
  { Region: "West", Quarter: "Q1", Sales: 200 },
  { Region: "West", Quarter: "Q2", Sales: 250 },
];

describe("runPipeline (empty pipeline)", () => {
  it("returns rows unchanged when no steps", () => {
    const r = runPipeline(sales, []);
    expect(r.rows).toEqual(sales);
    expect(r.warnings).toEqual([]);
  });

  it("infers columns from rows in first-seen order", () => {
    const r = runPipeline(sales, []);
    expect(r.columns).toEqual(["Region", "Quarter", "Sales"]);
  });

  it("respects an explicit columnsHint", () => {
    const r = runPipeline(sales, [], ["Sales", "Region"]);
    expect(r.columns).toEqual(["Sales", "Region"]);
  });
});

describe("selectColumns", () => {
  it("keeps only the listed columns", () => {
    const r = runPipeline(sales, [
      { kind: "selectColumns", columns: ["Region", "Sales"] },
    ]);
    expect(r.columns).toEqual(["Region", "Sales"]);
    expect(r.rows[0]).toEqual({ Region: "East", Sales: 100 });
  });

  it("warns when none of the listed columns exist", () => {
    const r = runPipeline(sales, [
      { kind: "selectColumns", columns: ["NonExistent"] },
    ]);
    expect(r.columns).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("dropColumns", () => {
  it("removes the named columns", () => {
    const r = runPipeline(sales, [{ kind: "dropColumns", columns: ["Quarter"] }]);
    expect(r.columns).toEqual(["Region", "Sales"]);
    expect(r.rows[0]).toEqual({ Region: "East", Sales: 100 });
  });

  it("silently skips columns that don't exist", () => {
    const r = runPipeline(sales, [{ kind: "dropColumns", columns: ["Ghost"] }]);
    expect(r.columns).toEqual(["Region", "Quarter", "Sales"]);
  });
});

describe("filterRows", () => {
  it("filters with numeric comparison", () => {
    const r = runPipeline(sales, [
      { kind: "filterRows", column: "Sales", op: ">", value: "150" },
    ]);
    expect(r.rows).toHaveLength(2); // 200, 250
  });

  it("filters with string equality (case-sensitive)", () => {
    const r = runPipeline(sales, [
      { kind: "filterRows", column: "Region", op: "==", value: "East" },
    ]);
    expect(r.rows).toHaveLength(2);
  });

  it("contains / startsWith / endsWith ops work", () => {
    const c = runPipeline(sales, [
      { kind: "filterRows", column: "Region", op: "contains", value: "as" },
    ]);
    expect(c.rows).toHaveLength(2); // East rows

    const sw = runPipeline(sales, [
      { kind: "filterRows", column: "Quarter", op: "startsWith", value: "Q" },
    ]);
    expect(sw.rows).toHaveLength(4);

    const ew = runPipeline(sales, [
      { kind: "filterRows", column: "Quarter", op: "endsWith", value: "1" },
    ]);
    expect(ew.rows).toHaveLength(2);
  });

  it("regex op supports valid patterns; invalid patterns drop the row", () => {
    const ok = runPipeline(sales, [
      { kind: "filterRows", column: "Region", op: "regex", value: "^E" },
    ]);
    expect(ok.rows).toHaveLength(2);

    const bad = runPipeline(sales, [
      { kind: "filterRows", column: "Region", op: "regex", value: "(" },
    ]);
    expect(bad.rows).toHaveLength(0);
  });

  it("isEmpty / isNotEmpty respect blank cells", () => {
    const data = [
      { x: 1 },
      { x: "" },
      { x: null },
      { x: "hello" },
    ] as PipelineRow[];
    const empty = runPipeline(data, [
      { kind: "filterRows", column: "x", op: "isEmpty" },
    ]);
    expect(empty.rows).toHaveLength(2);
    const notEmpty = runPipeline(data, [
      { kind: "filterRows", column: "x", op: "isNotEmpty" },
    ]);
    expect(notEmpty.rows).toHaveLength(2);
  });

  it("warns when column doesn't exist", () => {
    const r = runPipeline(sales, [
      { kind: "filterRows", column: "NoSuch", op: "==", value: "x" },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.rows).toEqual(sales);
  });
});

describe("sort", () => {
  it("sorts ascending numerically", () => {
    const r = runPipeline(sales, [
      { kind: "sort", column: "Sales", descending: false },
    ]);
    expect(r.rows.map((row) => row.Sales)).toEqual([100, 150, 200, 250]);
  });

  it("sorts descending", () => {
    const r = runPipeline(sales, [
      { kind: "sort", column: "Sales", descending: true },
    ]);
    expect(r.rows.map((row) => row.Sales)).toEqual([250, 200, 150, 100]);
  });

  it("sorts strings lexicographically when not numeric", () => {
    const r = runPipeline(sales, [
      { kind: "sort", column: "Region", descending: false },
    ]);
    expect(r.rows[0].Region).toBe("East");
    expect(r.rows[3].Region).toBe("West");
  });

  it("warns when column missing", () => {
    const r = runPipeline(sales, [
      { kind: "sort", column: "NoSuch", descending: false },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("rename", () => {
  it("renames a column and remaps row data", () => {
    const r = runPipeline(sales, [
      { kind: "rename", from: "Sales", to: "Revenue" },
    ]);
    expect(r.columns).toEqual(["Region", "Quarter", "Revenue"]);
    expect(r.rows[0]).toEqual({ Region: "East", Quarter: "Q1", Revenue: 100 });
  });

  it("is a no-op when from === to", () => {
    const r = runPipeline(sales, [
      { kind: "rename", from: "Sales", to: "Sales" },
    ]);
    expect(r.columns).toEqual(["Region", "Quarter", "Sales"]);
  });

  it("warns when source column doesn't exist", () => {
    const r = runPipeline(sales, [
      { kind: "rename", from: "Ghost", to: "X" },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warns when target column already exists (avoids collision)", () => {
    const r = runPipeline(sales, [
      { kind: "rename", from: "Sales", to: "Region" },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.columns).toEqual(["Region", "Quarter", "Sales"]); // unchanged
  });
});

describe("groupBy", () => {
  it("groups by key with SUM aggregation", () => {
    const r = runPipeline(sales, [
      {
        kind: "groupBy",
        key: "Region",
        agg: [{ column: "Sales", fn: "sum" }],
      },
    ]);
    expect(r.columns).toEqual(["Region", "sum_Sales"]);
    expect(r.rows).toHaveLength(2);
    const east = r.rows.find((row) => row.Region === "East");
    const west = r.rows.find((row) => row.Region === "West");
    expect(east?.sum_Sales).toBe(250);
    expect(west?.sum_Sales).toBe(450);
  });

  it("supports avg / min / max / count / first", () => {
    const r = runPipeline(sales, [
      {
        kind: "groupBy",
        key: "Region",
        agg: [
          { column: "Sales", fn: "avg" },
          { column: "Sales", fn: "min" },
          { column: "Sales", fn: "max" },
          { column: "Sales", fn: "count" },
          { column: "Quarter", fn: "first" },
        ],
      },
    ]);
    const east = r.rows.find((row) => row.Region === "East")!;
    expect(east.avg_Sales).toBe(125);
    expect(east.min_Sales).toBe(100);
    expect(east.max_Sales).toBe(150);
    expect(east.count_Sales).toBe(2);
    expect(east.first_Quarter).toBe("Q1");
  });

  it("honours custom output column name via `as`", () => {
    const r = runPipeline(sales, [
      {
        kind: "groupBy",
        key: "Region",
        agg: [{ column: "Sales", fn: "sum", as: "TotalSales" }],
      },
    ]);
    expect(r.columns).toEqual(["Region", "TotalSales"]);
    expect(r.rows[0].TotalSales).toBe(250);
  });

  it("warns when key column doesn't exist", () => {
    const r = runPipeline(sales, [
      {
        kind: "groupBy",
        key: "NoSuch",
        agg: [{ column: "Sales", fn: "sum" }],
      },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warns and emits null for missing agg column", () => {
    const r = runPipeline(sales, [
      {
        kind: "groupBy",
        key: "Region",
        agg: [{ column: "Ghost", fn: "sum" }],
      },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.rows[0].sum_Ghost).toBe(0); // sum of empty = 0
  });

  it("returns null for empty min/max/avg buckets (not NaN/Infinity)", () => {
    const data = [{ key: "A", v: "text" }];
    const r = runPipeline(data, [
      {
        kind: "groupBy",
        key: "key",
        agg: [
          { column: "v", fn: "min" },
          { column: "v", fn: "max" },
          { column: "v", fn: "avg" },
        ],
      },
    ]);
    expect(r.rows[0].min_v).toBeNull();
    expect(r.rows[0].max_v).toBeNull();
    expect(r.rows[0].avg_v).toBeNull();
  });
});

describe("pipeline composition (steps applied in order)", () => {
  it("filter → sort → select chain", () => {
    const r = runPipeline(sales, [
      { kind: "filterRows", column: "Sales", op: ">", value: "100" },
      { kind: "sort", column: "Sales", descending: true },
      { kind: "selectColumns", columns: ["Region", "Sales"] },
    ]);
    expect(r.columns).toEqual(["Region", "Sales"]);
    expect(r.rows.map((row) => row.Sales)).toEqual([250, 200, 150]);
  });

  it("rename → groupBy chain", () => {
    const r = runPipeline(sales, [
      { kind: "rename", from: "Sales", to: "Revenue" },
      {
        kind: "groupBy",
        key: "Region",
        agg: [{ column: "Revenue", fn: "sum" }],
      },
    ]);
    expect(r.columns).toEqual(["Region", "sum_Revenue"]);
    expect(r.rows.find((row) => row.Region === "East")?.sum_Revenue).toBe(250);
  });

  it("warnings accumulate across steps", () => {
    const r = runPipeline(sales, [
      { kind: "filterRows", column: "Ghost", op: "==", value: "x" },
      { kind: "rename", from: "Phantom", to: "X" },
    ]);
    expect(r.warnings).toHaveLength(2);
  });
});

describe("describeStep", () => {
  it("returns a JA label for each step kind", () => {
    expect(describeStep({ kind: "selectColumns", columns: ["a", "b"] })).toContain("a, b");
    expect(describeStep({ kind: "dropColumns", columns: ["x"] })).toContain("x");
    expect(describeStep({ kind: "filterRows", column: "Sales", op: ">", value: "100" })).toContain("Sales");
    expect(describeStep({ kind: "filterRows", column: "X", op: "isEmpty" })).toContain("空");
    expect(describeStep({ kind: "sort", column: "X", descending: false })).toContain("昇順");
    expect(describeStep({ kind: "sort", column: "X", descending: true })).toContain("降順");
    expect(describeStep({ kind: "rename", from: "A", to: "B" })).toContain("→");
    const g: TransformStep = {
      kind: "groupBy",
      key: "Region",
      agg: [{ column: "Sales", fn: "sum" }],
    };
    expect(describeStep(g)).toContain("sum(Sales)");
  });
});

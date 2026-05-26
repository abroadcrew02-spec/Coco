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

  it("describeStep: changeType", () => {
    expect(describeStep({ kind: "changeType", column: "A", targetType: "number" })).toContain("number");
  });

  it("describeStep: fillMissing forward", () => {
    expect(describeStep({ kind: "fillMissing", column: "A", direction: "forward" })).toContain("前方");
  });

  it("describeStep: fillMissing backward", () => {
    expect(describeStep({ kind: "fillMissing", column: "A", direction: "backward" })).toContain("後方");
  });

  it("describeStep: fillMissing fixed", () => {
    expect(describeStep({ kind: "fillMissing", column: "A", direction: "fixed", fixedValue: "0" })).toContain("0");
  });

  it("describeStep: conditionalColumn", () => {
    expect(describeStep({ kind: "conditionalColumn", newColumn: "Cat", column: "Score", op: ">", value: "80", thenValue: "High", elseValue: "Low" })).toContain("Cat");
  });

  it("describeStep: replaceValue (literal)", () => {
    expect(describeStep({ kind: "replaceValue", column: "A", find: "x", replace: "y" })).toContain("x");
  });

  it("describeStep: replaceValue (regex)", () => {
    expect(describeStep({ kind: "replaceValue", column: "A", find: "x", replace: "y", useRegex: true })).toContain("regex");
  });

  it("describeStep: splitColumn", () => {
    expect(describeStep({ kind: "splitColumn", column: "A", delimiter: "," })).toContain(",");
  });

  it("describeStep: mergeColumns", () => {
    expect(describeStep({ kind: "mergeColumns", columns: ["A", "B"], newColumn: "C" })).toContain("C");
  });

  it("describeStep: addIndexColumn", () => {
    expect(describeStep({ kind: "addIndexColumn" })).toContain("Index");
  });
});

// =============================================================================
// Step 3 — additional transform step tests
// =============================================================================

const typed: PipelineRow[] = [
  { id: 1, score: "85", active: "true", date: "2024-01-15" },
  { id: 2, score: "not-a-number", active: "false", date: "bad-date" },
  { id: 3, score: "42", active: "1", date: "2024-03-01" },
];

describe("changeType", () => {
  it("converts string column to number", () => {
    const r = runPipeline(
      [{ v: "123" }, { v: "456" }],
      [{ kind: "changeType", column: "v", targetType: "number" }],
    );
    expect(r.rows[0].v).toBe(123);
    expect(r.rows[1].v).toBe(456);
  });

  it("converts to boolean", () => {
    const r = runPipeline(
      [{ v: "true" }, { v: "false" }, { v: "1" }, { v: "0" }],
      [{ kind: "changeType", column: "v", targetType: "boolean" }],
    );
    expect(r.rows[0].v).toBe(true);
    expect(r.rows[1].v).toBe(false);
    expect(r.rows[2].v).toBe(true);
    expect(r.rows[3].v).toBe(false);
  });

  it("converts number to string", () => {
    const r = runPipeline(
      [{ v: 42 }],
      [{ kind: "changeType", column: "v", targetType: "string" }],
    );
    expect(r.rows[0].v).toBe("42");
  });

  it("onError=null replaces failed conversions with null", () => {
    const r = runPipeline(
      typed,
      [{ kind: "changeType", column: "score", targetType: "number", onError: "null" }],
    );
    expect(r.rows[0].score).toBe(85);
    expect(r.rows[1].score).toBeNull();
    expect(r.rows[2].score).toBe(42);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("onError=keep (default) leaves original value intact on failure", () => {
    const r = runPipeline(
      typed,
      [{ kind: "changeType", column: "score", targetType: "number" }],
    );
    expect(r.rows[1].score).toBe("not-a-number");
  });

  it("warns when column doesn't exist", () => {
    const r = runPipeline(typed, [{ kind: "changeType", column: "ghost", targetType: "number" }]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("converts ISO string to date (returns ISO string)", () => {
    const r = runPipeline(
      [{ d: "2024-01-15" }],
      [{ kind: "changeType", column: "d", targetType: "date" }],
    );
    expect(typeof r.rows[0].d).toBe("string");
    expect(r.rows[0].d).toContain("2024");
  });
});

describe("fillMissing", () => {
  const data: PipelineRow[] = [
    { x: 1 },
    { x: null },
    { x: null },
    { x: 4 },
    { x: null },
  ];

  it("forward fill propagates last non-null value", () => {
    const r = runPipeline(data, [{ kind: "fillMissing", column: "x", direction: "forward" }]);
    expect(r.rows.map((row) => row.x)).toEqual([1, 1, 1, 4, 4]);
  });

  it("backward fill propagates next non-null value", () => {
    const r = runPipeline(data, [{ kind: "fillMissing", column: "x", direction: "backward" }]);
    expect(r.rows.map((row) => row.x)).toEqual([1, 4, 4, 4, null]);
  });

  it("fixed fill replaces blanks with the given value", () => {
    const r = runPipeline(data, [{ kind: "fillMissing", column: "x", direction: "fixed", fixedValue: "0" }]);
    expect(r.rows.map((row) => row.x)).toEqual([1, "0", "0", 4, "0"]);
  });

  it("does not affect non-blank values", () => {
    const r = runPipeline(
      [{ x: "hello" }, { x: "" }],
      [{ kind: "fillMissing", column: "x", direction: "fixed", fixedValue: "N/A" }],
    );
    expect(r.rows[0].x).toBe("hello");
    expect(r.rows[1].x).toBe("N/A");
  });

  it("warns when column doesn't exist", () => {
    const r = runPipeline(data, [{ kind: "fillMissing", column: "ghost", direction: "forward" }]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("conditionalColumn", () => {
  const scores: PipelineRow[] = [
    { name: "Alice", score: 90 },
    { name: "Bob", score: 60 },
    { name: "Carol", score: 80 },
  ];

  it("adds a new column based on numeric comparison", () => {
    const r = runPipeline(scores, [
      {
        kind: "conditionalColumn",
        newColumn: "Grade",
        column: "score",
        op: ">=",
        value: "80",
        thenValue: "Pass",
        elseValue: "Fail",
      },
    ]);
    expect(r.columns).toContain("Grade");
    expect(r.rows[0].Grade).toBe("Pass"); // 90 >= 80
    expect(r.rows[1].Grade).toBe("Fail"); // 60 < 80
    expect(r.rows[2].Grade).toBe("Pass"); // 80 >= 80
  });

  it("supports isEmpty condition", () => {
    const data: PipelineRow[] = [{ v: "" }, { v: "hello" }];
    const r = runPipeline(data, [
      { kind: "conditionalColumn", newColumn: "HasValue", column: "v", op: "isEmpty", thenValue: "No", elseValue: "Yes" },
    ]);
    expect(r.rows[0].HasValue).toBe("No");
    expect(r.rows[1].HasValue).toBe("Yes");
  });

  it("supports contains condition", () => {
    const data: PipelineRow[] = [{ city: "New York" }, { city: "Los Angeles" }];
    const r = runPipeline(data, [
      { kind: "conditionalColumn", newColumn: "IsNY", column: "city", op: "contains", value: "York", thenValue: "Yes", elseValue: "No" },
    ]);
    expect(r.rows[0].IsNY).toBe("Yes");
    expect(r.rows[1].IsNY).toBe("No");
  });

  it("warns when source column doesn't exist", () => {
    const r = runPipeline(scores, [
      { kind: "conditionalColumn", newColumn: "X", column: "ghost", op: "==", value: "0", thenValue: "A", elseValue: "B" },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warns when newColumn already exists", () => {
    const r = runPipeline(scores, [
      { kind: "conditionalColumn", newColumn: "name", column: "score", op: ">=", value: "80", thenValue: "A", elseValue: "B" },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.columns).toEqual(["name", "score"]); // unchanged
  });
});

describe("replaceValue", () => {
  const data: PipelineRow[] = [
    { code: "A001", label: "foo bar" },
    { code: "B002", label: "foo baz" },
    { code: "A003", label: "qux" },
  ];

  it("replaces exact string in a column", () => {
    const r = runPipeline(data, [{ kind: "replaceValue", column: "code", find: "A", replace: "X" }]);
    expect(r.rows[0].code).toBe("X001");
    expect(r.rows[1].code).toBe("B002"); // no match
    expect(r.rows[2].code).toBe("X003");
  });

  it("replaces using regex", () => {
    const r = runPipeline(data, [
      { kind: "replaceValue", column: "label", find: "foo\\s+", replace: "", useRegex: true },
    ]);
    expect(r.rows[0].label).toBe("bar");
    expect(r.rows[1].label).toBe("baz");
    expect(r.rows[2].label).toBe("qux"); // no match
  });

  it("emits a warning and skips when regex is invalid", () => {
    const r = runPipeline(data, [
      { kind: "replaceValue", column: "label", find: "(invalid", replace: "x", useRegex: true },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
    // rows unchanged
    expect(r.rows[0].label).toBe("foo bar");
  });

  it("replaces multiple occurrences in a cell", () => {
    const r = runPipeline(
      [{ v: "aaa" }],
      [{ kind: "replaceValue", column: "v", find: "a", replace: "b" }],
    );
    expect(r.rows[0].v).toBe("bbb");
  });

  it("warns when column doesn't exist", () => {
    const r = runPipeline(data, [{ kind: "replaceValue", column: "ghost", find: "x", replace: "y" }]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("splitColumn", () => {
  const csv: PipelineRow[] = [
    { tags: "apple,banana,cherry" },
    { tags: "dog,cat" },
    { tags: "solo" },
  ];

  it("splits into new columns (default expand=columns)", () => {
    const r = runPipeline(csv, [{ kind: "splitColumn", column: "tags", delimiter: "," }]);
    expect(r.columns).toEqual(["tags_1", "tags_2", "tags_3"]);
    expect(r.rows[0]).toEqual({ tags_1: "apple", tags_2: "banana", tags_3: "cherry" });
    expect(r.rows[1]).toEqual({ tags_1: "dog", tags_2: "cat", tags_3: null });
    expect(r.rows[2]).toEqual({ tags_1: "solo", tags_2: null, tags_3: null });
  });

  it("splits into rows (expand=rows)", () => {
    const r = runPipeline(csv, [{ kind: "splitColumn", column: "tags", delimiter: ",", expand: "rows" }]);
    expect(r.rows).toHaveLength(6); // 3 + 2 + 1
    expect(r.rows[0].tags).toBe("apple");
    expect(r.rows[1].tags).toBe("banana");
  });

  it("respects maxParts", () => {
    const r = runPipeline(csv, [{ kind: "splitColumn", column: "tags", delimiter: ",", maxParts: 2 }]);
    expect(r.columns).toEqual(["tags_1", "tags_2"]);
    expect(r.rows[0]).toEqual({ tags_1: "apple", tags_2: "banana" });
  });

  it("preserves other columns in column order", () => {
    const data: PipelineRow[] = [{ name: "Alice", csv: "a,b" }];
    const r = runPipeline(data, [{ kind: "splitColumn", column: "csv", delimiter: "," }]);
    expect(r.columns).toEqual(["name", "csv_1", "csv_2"]);
  });

  it("warns when column doesn't exist", () => {
    const r = runPipeline(csv, [{ kind: "splitColumn", column: "ghost", delimiter: "," }]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("mergeColumns", () => {
  const people: PipelineRow[] = [
    { first: "Alice", last: "Smith", age: 30 },
    { first: "Bob", last: "Jones", age: 25 },
  ];

  it("merges columns with default space delimiter", () => {
    const r = runPipeline(people, [
      { kind: "mergeColumns", columns: ["first", "last"], newColumn: "fullName" },
    ]);
    expect(r.rows[0].fullName).toBe("Alice Smith");
    expect(r.rows[1].fullName).toBe("Bob Jones");
  });

  it("uses custom delimiter", () => {
    const r = runPipeline(people, [
      { kind: "mergeColumns", columns: ["first", "last"], newColumn: "name", delimiter: "_" },
    ]);
    expect(r.rows[0].name).toBe("Alice_Smith");
  });

  it("drops source columns by default", () => {
    const r = runPipeline(people, [
      { kind: "mergeColumns", columns: ["first", "last"], newColumn: "fullName" },
    ]);
    expect(r.columns).toEqual(["fullName", "age"]);
  });

  it("keeps source columns when dropSources=false", () => {
    const r = runPipeline(people, [
      { kind: "mergeColumns", columns: ["first", "last"], newColumn: "fullName", dropSources: false },
    ]);
    expect(r.columns).toContain("first");
    expect(r.columns).toContain("last");
    expect(r.columns).toContain("fullName");
  });

  it("warns when a source column doesn't exist", () => {
    const r = runPipeline(people, [
      { kind: "mergeColumns", columns: ["first", "ghost"], newColumn: "x" },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warns when newColumn already exists", () => {
    const r = runPipeline(people, [
      { kind: "mergeColumns", columns: ["first", "last"], newColumn: "age" },
    ]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("addIndexColumn", () => {
  const data: PipelineRow[] = [
    { name: "Alice" },
    { name: "Bob" },
    { name: "Carol" },
  ];

  it("adds a zero-based index column by default", () => {
    const r = runPipeline(data, [{ kind: "addIndexColumn" }]);
    expect(r.columns).toContain("Index");
    expect(r.rows.map((row) => row.Index)).toEqual([0, 1, 2]);
  });

  it("uses custom column name", () => {
    const r = runPipeline(data, [{ kind: "addIndexColumn", columnName: "No" }]);
    expect(r.columns).toContain("No");
    expect(r.rows[0].No).toBe(0);
  });

  it("respects startAt and increment", () => {
    const r = runPipeline(data, [{ kind: "addIndexColumn", startAt: 1, increment: 2 }]);
    expect(r.rows.map((row) => row.Index)).toEqual([1, 3, 5]);
  });

  it("appends after existing columns", () => {
    const r = runPipeline(data, [{ kind: "addIndexColumn" }]);
    expect(r.columns[r.columns.length - 1]).toBe("Index");
  });

  it("warns when column name already exists", () => {
    const r = runPipeline(
      [{ Index: "existing" }],
      [{ kind: "addIndexColumn" }],
    );
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("Step 3 pipeline composition", () => {
  it("changeType → conditionalColumn chain works", () => {
    const data: PipelineRow[] = [
      { val: "120" },
      { val: "80" },
    ];
    const r = runPipeline(data, [
      { kind: "changeType", column: "val", targetType: "number" },
      { kind: "conditionalColumn", newColumn: "cat", column: "val", op: ">", value: "100", thenValue: "High", elseValue: "Low" },
    ]);
    expect(r.rows[0].cat).toBe("High");
    expect(r.rows[1].cat).toBe("Low");
  });

  it("splitColumn → addIndexColumn chain", () => {
    const data: PipelineRow[] = [{ tags: "a,b" }];
    const r = runPipeline(data, [
      { kind: "splitColumn", column: "tags", delimiter: ",", expand: "rows" },
      { kind: "addIndexColumn", startAt: 1 },
    ]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].Index).toBe(1);
    expect(r.rows[1].Index).toBe(2);
  });
});

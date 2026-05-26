import { describe, it, expect } from "vitest";
import {
  aggregate,
  computePivot,
  generatePivotName,
  inferFieldNames,
  type PivotConfig,
  type PivotRange,
} from "./pivots";

// #237 — Regression suite for the pre-existing pivot engine. The
// `src/store/pivots.ts` module shipped without test coverage; this file locks
// the public behaviour so future refactors don't silently drift.

describe("generatePivotName", () => {
  it("returns Pivot1 on an empty workbook", () => {
    expect(generatePivotName([])).toBe("Pivot1");
  });

  it("picks the smallest unused index", () => {
    expect(generatePivotName(["Pivot1", "Pivot3"])).toBe("Pivot2");
    expect(generatePivotName(["Pivot1", "Pivot2", "Pivot4"])).toBe("Pivot3");
  });

  it("skips a verbatim taken name that looks like PivotN", () => {
    // Pivot2 is unused-by-number but exists verbatim, so generator must skip
    // it too.
    expect(generatePivotName(["Pivot2"])).toBe("Pivot1");
  });

  it("ignores malformed entries", () => {
    expect(generatePivotName(["Pivot1", "", "Pivot-junk"])).toBe("Pivot2");
  });
});

describe("inferFieldNames", () => {
  const cellData = {
    "0": {
      "0": { v: "Region" },
      "1": { v: "Sales" },
      "2": { v: "" }, // blank header
      "3": { v: "Region" }, // duplicate
    },
  };
  const range: PivotRange = { r1: 0, c1: 0, r2: 0, c2: 3 };

  it("reads header names when hasHeader=true", () => {
    const fields = inferFieldNames(cellData, range, true);
    expect(fields).toEqual(["Region", "Sales", "Column3", "Region2"]);
  });

  it("synthesises ColumnN when hasHeader=false", () => {
    const fields = inferFieldNames(cellData, range, false);
    expect(fields).toEqual(["Column1", "Column2", "Column3", "Column4"]);
  });

  it("uses ColumnN for blank header cells", () => {
    const fields = inferFieldNames(cellData, range, true);
    expect(fields[2]).toBe("Column3");
  });

  it("suffixes duplicates with a numeric tag", () => {
    const fields = inferFieldNames(cellData, range, true);
    // First "Region" stays; second becomes "Region2"
    expect(fields[0]).toBe("Region");
    expect(fields[3]).toBe("Region2");
  });
});

describe("aggregate", () => {
  it("computes SUM ignoring non-finite entries", () => {
    expect(aggregate([1, 2, 3, NaN], "SUM")).toBe(6);
  });

  it("returns 0 for an empty SUM", () => {
    expect(aggregate([], "SUM")).toBe(0);
  });

  it("returns NaN for empty AVERAGE / MIN / MAX", () => {
    expect(Number.isNaN(aggregate([], "AVERAGE"))).toBe(true);
    expect(Number.isNaN(aggregate([], "MIN"))).toBe(true);
    expect(Number.isNaN(aggregate([], "MAX"))).toBe(true);
  });

  it("computes AVERAGE", () => {
    expect(aggregate([1, 2, 3, 4], "AVERAGE")).toBe(2.5);
  });

  it("counts only numeric entries for COUNT", () => {
    expect(aggregate([1, NaN, 3, NaN], "COUNT")).toBe(2);
    expect(aggregate([], "COUNT")).toBe(0);
  });

  it("computes MIN / MAX", () => {
    expect(aggregate([3, 1, 4, 1, 5, 9, 2, 6], "MIN")).toBe(1);
    expect(aggregate([3, 1, 4, 1, 5, 9, 2, 6], "MAX")).toBe(9);
  });
});

describe("computePivot", () => {
  // Source: header row + 4 data rows (Year, Region, Sales)
  const source: Array<Array<unknown>> = [
    ["Year", "Region", "Sales"],
    [2024, "East", 100],
    [2024, "West", 200],
    [2025, "East", 150],
    [2025, "West", 250],
  ];
  const range: PivotRange = { r1: 0, c1: 0, r2: 4, c2: 2 };

  function makeConfig(overrides: Partial<PivotConfig> = {}): PivotConfig {
    return {
      source: { sheetId: "s1", range },
      destination: { row: 0, col: 5 },
      rows: ["Year"],
      cols: ["Region"],
      values: [{ field: "Sales", agg: "SUM" }],
      filters: [],
      hasHeader: true,
      ...overrides,
    };
  }

  it("builds a Year × Region cross-tab with SUM of Sales + totals", () => {
    const result = computePivot(source, makeConfig());
    // Spot-check: top-left corner is a label or blank, rest of header row
    // includes "East", "West", and "Total".
    const colHeader = result.output[0];
    expect(colHeader).toContain("East");
    expect(colHeader).toContain("West");
    expect(colHeader).toContain("Total");

    // Find data row for 2024 and 2025.
    const all = result.output;
    const rowFor = (year: string) =>
      all.find((row) => row.some((cell) => String(cell) === year)) ?? null;
    const r24 = rowFor("2024");
    const r25 = rowFor("2025");
    expect(r24).not.toBeNull();
    expect(r25).not.toBeNull();
    // The data cells include 100, 200, 150, 250 and totals 300/400.
    expect(r24).toEqual(expect.arrayContaining([100, 200, 300]));
    expect(r25).toEqual(expect.arrayContaining([150, 250, 400]));

    // Last row is the Total row; should contain 250, 450, 700.
    const lastRow = result.output[result.output.length - 1];
    expect(lastRow).toEqual(expect.arrayContaining([250, 450, 700]));
  });

  it("supports multiple value fields side-by-side", () => {
    const config = makeConfig({
      values: [
        { field: "Sales", agg: "SUM" },
        { field: "Sales", agg: "COUNT" },
      ],
    });
    const result = computePivot(source, config);
    // 2 value fields × (East + West + Total) → 6 data columns + row-header
    // column(s) + (maybe) Total trailing column. At minimum the matrix has
    // both value-field labels in the header.
    const headerCells = result.output.flatMap((r) => r.map(String));
    expect(headerCells).toContain("SUM of Sales");
    expect(headerCells).toContain("COUNT of Sales");
  });

  it("collapses to a single row when neither rows nor cols are configured", () => {
    const config = makeConfig({ rows: [], cols: [] });
    const result = computePivot(source, config);
    // Output has at least one data row carrying the grand-total SUM = 700.
    const flat = result.output.flat();
    expect(flat).toContain(700);
  });

  it("falls back to COUNT of the first field when no values are configured", () => {
    // Use rows=[], cols=[] so the COUNT label has a clear single position.
    const config = makeConfig({ values: [], rows: [], cols: [] });
    const result = computePivot(source, config);
    // Result should be non-empty and reflect COUNT (=4 data rows) somewhere.
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.output.flat()).toContain(4);
  });

  it("respects an explicit filter (only East rows considered)", () => {
    const config = makeConfig({
      filters: [{ field: "Region", values: ["East"] }],
    });
    const result = computePivot(source, config);
    // East-only filter → West column shouldn't appear in headers.
    const headerCells = result.output[0].map(String);
    expect(headerCells).not.toContain("West");
    expect(headerCells).toContain("East");
    // Grand-total row should equal 100 + 150 = 250.
    const lastRow = result.output[result.output.length - 1];
    expect(lastRow).toEqual(expect.arrayContaining([250]));
  });

  it("returns a matrix with rowCount/colCount matching the output dims", () => {
    const result = computePivot(source, makeConfig());
    expect(result.rowCount).toBe(result.output.length);
    expect(result.colCount).toBe(result.output[0]?.length ?? 0);
  });

  it("tolerates a source whose header row references unknown fields", () => {
    const config = makeConfig({
      rows: ["UnknownRowField"],
      cols: [],
      values: [{ field: "Sales", agg: "SUM" }],
    });
    // Unknown row field is silently dropped; computePivot still produces a
    // matrix (collapsed because rows ended up empty after the filter).
    const result = computePivot(source, config);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it("handles a hasHeader=false source by inventing ColumnN headers", () => {
    const noHeader: Array<Array<unknown>> = [
      [2024, "East", 100],
      [2024, "West", 200],
    ];
    const config = makeConfig({
      hasHeader: false,
      rows: ["Column1"],
      cols: ["Column2"],
      values: [{ field: "Column3", agg: "SUM" }],
    });
    const result = computePivot(noHeader, config);
    // Just confirm it produces a non-empty matrix with the expected totals.
    const flat = result.output.flat();
    expect(flat).toContain(100);
    expect(flat).toContain(200);
  });
});

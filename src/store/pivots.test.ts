import { describe, it, expect } from "vitest";
import {
  aggregate,
  computePivot,
  computeModelPivot,
  generatePivotName,
  inferFieldNames,
  normalizePivotEntry,
  refreshPivot,
  replacePivotInSheet,
  renameMeasureReferences,
  type PivotConfig,
  type PivotEntry,
  type PivotRange,
  type WorkbookPivotSnapshot,
} from "./pivots";
import type { CocoDataModel } from "./cocoDataModel";
import { applyCalculatedColumns, toDataModel } from "./cocoDataModel";

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
      source: { kind: "sheet" as const, sheetId: "s1", range },
      destination: { row: 0, col: 5 },
      rows: ["Year"],
      cols: ["Region"],
      values: [{ kind: "column" as const, field: "Sales", agg: "SUM" as const }],
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
        { kind: "column" as const, field: "Sales", agg: "SUM" as const },
        { kind: "column" as const, field: "Sales", agg: "COUNT" as const },
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
      values: [{ kind: "column" as const, field: "Sales", agg: "SUM" as const }],
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
      values: [{ kind: "column" as const, field: "Column3", agg: "SUM" as const }],
    });
    const result = computePivot(noHeader, config);
    // Just confirm it produces a non-empty matrix with the expected totals.
    const flat = result.output.flat();
    expect(flat).toContain(100);
    expect(flat).toContain(200);
  });
});

describe("replacePivotInSheet", () => {
  function makeWorkbook(): WorkbookPivotSnapshot {
    return {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Sheet1",
          cellData: {
            // Old pivot output at destination row=10, col=0 (3 rows × 2 cols)
            "10": { "0": { v: "Old header" }, "1": { v: "Total" } },
            "11": { "0": { v: "East" }, "1": { v: 100 } },
            "12": { "0": { v: "Total" }, "1": { v: 100 } },
          },
          _pivots: [
            {
              name: "Pivot1",
              source: { kind: "sheet" as const, sheetId: "s1", range: { r1: 0, c1: 0, r2: 4, c2: 2 } },
              destination: { row: 10, col: 0 },
              rows: ["Year"],
              cols: [],
              values: [{ kind: "column" as const, field: "Sales", agg: "SUM" as const }],
              filters: [],
              hasHeader: true,
              lastOutputRows: 3,
              lastOutputCols: 2,
            } satisfies PivotEntry,
          ],
        },
      },
    };
  }

  it("replaces the entry in _pivots", () => {
    const wb = makeWorkbook();
    const newEntry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "sheet" as const, sheetId: "s1", range: { r1: 0, c1: 0, r2: 4, c2: 2 } },
      destination: { row: 10, col: 0 },
      rows: ["Region"],
      cols: [],
      values: [{ kind: "column" as const, field: "Sales", agg: "AVERAGE" as const }],
      hasHeader: true,
      lastOutputRows: 2,
      lastOutputCols: 2,
    };
    const result = replacePivotInSheet(wb, newEntry);
    expect(result.ok).toBe(true);
    const pivots = wb.sheets!["s1"]!._pivots!;
    expect(pivots).toHaveLength(1);
    expect(pivots[0].rows).toEqual(["Region"]);
    const v0 = pivots[0].values[0];
    expect(v0.kind === "column" && v0.agg).toBe("AVERAGE");
  });

  it("wipes the old output footprint from cellData", () => {
    const wb = makeWorkbook();
    const newEntry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "sheet" as const, sheetId: "s1", range: { r1: 0, c1: 0, r2: 4, c2: 2 } },
      destination: { row: 10, col: 0 },
      rows: ["Region"],
      cols: [],
      values: [{ kind: "column" as const, field: "Sales", agg: "SUM" as const }],
      hasHeader: true,
      lastOutputRows: 2,
      lastOutputCols: 2,
    };
    replacePivotInSheet(wb, newEntry);
    // Old cells at rows 10-12 cols 0-1 should be deleted.
    const cellData = wb.sheets!["s1"]!.cellData!;
    expect(cellData["10"]?.["0"]).toBeUndefined();
    expect(cellData["10"]?.["1"]).toBeUndefined();
    expect(cellData["11"]?.["0"]).toBeUndefined();
    expect(cellData["12"]?.["0"]).toBeUndefined();
  });

  it("returns { ok: false } when the pivot name is not found", () => {
    const wb = makeWorkbook();
    const newEntry: PivotEntry = {
      name: "NonExistent",
      source: { kind: "sheet" as const, sheetId: "s1", range: { r1: 0, c1: 0, r2: 4, c2: 2 } },
      destination: { row: 0, col: 0 },
      rows: [],
      cols: [],
      values: [{ kind: "column" as const, field: "Sales", agg: "SUM" as const }],
      hasHeader: true,
    };
    const result = replacePivotInSheet(wb, newEntry);
    expect(result.ok).toBe(false);
  });

  it("returns { ok: false } for an empty workbook", () => {
    const result = replacePivotInSheet({}, {
      name: "Pivot1",
      source: { kind: "sheet" as const, sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      destination: { row: 0, col: 0 },
      rows: [],
      cols: [],
      values: [{ kind: "column" as const, field: "Sales", agg: "SUM" as const }],
      hasHeader: true,
    } satisfies PivotEntry);
    expect(result.ok).toBe(false);
  });
});

// ---------- #239 Step 7: normalizePivotEntry ----------

describe("normalizePivotEntry", () => {
  it("passes through a fully-formed entry unchanged", () => {
    const entry: PivotEntry = {
      name: "P1",
      source: { kind: "sheet", sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      destination: { row: 0, col: 0 },
      rows: [], cols: [],
      values: [{ kind: "column", field: "Sales", agg: "SUM" }],
      hasHeader: true,
    };
    const result = normalizePivotEntry(entry);
    expect(result.source.kind).toBe("sheet");
    expect(result.values[0].kind).toBe("column");
  });

  it("upgrades a legacy source (no kind) to kind='sheet'", () => {
    const raw = {
      name: "P1",
      source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      destination: { row: 0, col: 0 },
      rows: [], cols: [],
      values: [{ field: "Sales", agg: "SUM" }],
      hasHeader: true,
    } as unknown as PivotEntry;
    normalizePivotEntry(raw);
    expect(raw.source.kind).toBe("sheet");
  });

  it("upgrades legacy values (no kind) to kind='column'", () => {
    const raw = {
      name: "P1",
      source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      destination: { row: 0, col: 0 },
      rows: [], cols: [],
      values: [{ field: "Amount", agg: "SUM" }, { field: "Qty", agg: "COUNT" }],
      hasHeader: true,
    } as unknown as PivotEntry;
    normalizePivotEntry(raw);
    expect(raw.values[0].kind).toBe("column");
    expect(raw.values[1].kind).toBe("column");
  });

  it("preserves measure-kind values unchanged", () => {
    const entry: PivotEntry = {
      name: "P1",
      source: { kind: "model", tableName: "Sales" },
      destination: { row: 0, col: 0 },
      rows: ["Region"], cols: [],
      values: [{ kind: "measure", measureName: "TotalSales" }],
      hasHeader: false,
    };
    normalizePivotEntry(entry);
    expect(entry.values[0].kind).toBe("measure");
  });
});

// ---------- #239 Step 7: computeModelPivot ----------

describe("computeModelPivot", () => {
  // CocoDataModel with a single table "Sales" containing Region, Year, Amount.
  // One measure TotalSales = SUM(Sales[Amount]).
  function makeCocoModel(): CocoDataModel {
    return {
      tables: [
        {
          name: "Sales",
          columns: [
            { name: "Region", type: "string" },
            { name: "Year", type: "number" },
            { name: "Amount", type: "number" },
          ],
          rows: [
            { Region: "East", Year: 2024, Amount: 100 },
            { Region: "West", Year: 2024, Amount: 200 },
            { Region: "East", Year: 2025, Amount: 150 },
            { Region: "West", Year: 2025, Amount: 250 },
          ],
        },
      ],
      relationships: [],
      measures: [
        { id: "m1", name: "TotalSales", tableId: "Sales", expression: "SUM(Sales[Amount])" },
      ],
      calculatedColumns: [],
    };
  }

  function makeConfig(overrides: Partial<PivotConfig> = {}): PivotConfig {
    return {
      source: { kind: "model", tableName: "Sales" },
      destination: { row: 0, col: 0 },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "TotalSales" }],
      filters: [],
      hasHeader: false,
      ...overrides,
    };
  }

  it("builds a Region × Year matrix with measure values + totals", () => {
    const cocoModel = makeCocoModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const result = computeModelPivot(runtimeModel, cocoModel, makeConfig());

    const flat = result.output.flat().map(String);
    // Row headers present.
    expect(flat).toContain("East");
    expect(flat).toContain("West");
    // Col headers present.
    expect(flat).toContain("2024");
    expect(flat).toContain("2025");
    // Data values: East/2024=100, East/2025=150, West/2024=200, West/2025=250.
    const nums = result.output.flat().filter((v) => typeof v === "number");
    expect(nums).toContain(100);
    expect(nums).toContain(150);
    expect(nums).toContain(200);
    expect(nums).toContain(250);
  });

  it("computes correct Total row (row ALL per column)", () => {
    const cocoModel = makeCocoModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const result = computeModelPivot(runtimeModel, cocoModel, makeConfig());

    // Last row is Total row.
    const totalRow = result.output[result.output.length - 1];
    expect(totalRow[0]).toBe("Total");
    // Total for 2024 column: East(100) + West(200) = 300.
    // Total for 2025 column: East(150) + West(250) = 400.
    // Bottom-right grand total: 100+200+150+250 = 700.
    const nums = totalRow.filter((v): v is number => typeof v === "number");
    expect(nums).toContain(300);
    expect(nums).toContain(400);
    expect(nums).toContain(700);
  });

  it("computes correct Total column (col ALL per row)", () => {
    const cocoModel = makeCocoModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const result = computeModelPivot(runtimeModel, cocoModel, makeConfig());

    // Find East row and West row; last column is Total column.
    const lastCol = result.colCount - 1;
    const eastRow = result.output.find((row) => row[0] === "East");
    const westRow = result.output.find((row) => row[0] === "West");
    expect(eastRow).toBeDefined();
    expect(westRow).toBeDefined();
    // East total = 100 + 150 = 250, West total = 200 + 250 = 450.
    expect(eastRow![lastCol]).toBe(250);
    expect(westRow![lastCol]).toBe(450);
  });

  it("applies filter fields before bucketing", () => {
    const cocoModel = makeCocoModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const result = computeModelPivot(runtimeModel, cocoModel, makeConfig({
      filters: [{ field: "Region", values: ["East"] }],
    }));

    const flat = result.output.flat().map(String);
    // West should not appear anywhere — filtered out.
    expect(flat).not.toContain("West");
    expect(flat).toContain("East");
    // East/2024=100, East/2025=150, total=250.
    const nums = result.output.flat().filter((v): v is number => typeof v === "number");
    expect(nums).toContain(100);
    expect(nums).toContain(150);
  });

  it("handles a mixed column+measure values config", () => {
    const cocoModel = makeCocoModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const result = computeModelPivot(runtimeModel, cocoModel, {
      source: { kind: "model", tableName: "Sales" },
      destination: { row: 0, col: 0 },
      rows: ["Region"],
      cols: [],
      values: [
        { kind: "column", field: "Amount", agg: "SUM" },
        { kind: "measure", measureName: "TotalSales" },
      ],
      filters: [],
      hasHeader: false,
    });

    const flatStr = result.output.flat().map(String);
    // Both "SUM of Amount" label and "TotalSales" label should appear.
    expect(flatStr).toContain("SUM of Amount");
    expect(flatStr).toContain("TotalSales");
    // For East: SUM(Amount)=250, TotalSales=250 both present.
    const nums = result.output.flat().filter((v): v is number => typeof v === "number");
    expect(nums).toContain(250);
  });

  it("returns rowCount/colCount matching matrix dimensions", () => {
    const cocoModel = makeCocoModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const result = computeModelPivot(runtimeModel, cocoModel, makeConfig());
    expect(result.rowCount).toBe(result.output.length);
    expect(result.colCount).toBe(result.output[0]?.length ?? 0);
  });

  it("throws when source.kind is not 'model'", () => {
    const cocoModel = makeCocoModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const badConfig: PivotConfig = {
      source: { kind: "sheet", sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      destination: { row: 0, col: 0 },
      rows: [], cols: [],
      values: [],
      hasHeader: true,
    };
    expect(() => computeModelPivot(runtimeModel, cocoModel, badConfig)).toThrow();
  });
});

// ---------- #239 Step 7: refreshPivot model mode ----------

describe("refreshPivot (model source)", () => {
  function makeCocoModel(): CocoDataModel {
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
      measures: [
        { id: "m1", name: "Total", tableId: "Sales", expression: "SUM(Sales[Amount])" },
      ],
      calculatedColumns: [],
    };
  }

  it("writes computeModelPivot output into the destination sheet", () => {
    const cocoModel = makeCocoModel();
    const wb: WorkbookPivotSnapshot = {
      sheetOrder: ["dest"],
      sheets: {
        dest: {
          name: "Output",
          cellData: {},
          _pivots: [
            {
              name: "ModelPivot1",
              source: { kind: "model", tableName: "Sales" },
              destination: { row: 0, col: 0 },
              rows: ["Region"],
              cols: [],
              values: [{ kind: "measure", measureName: "Total" }],
              filters: [],
              hasHeader: false,
            },
          ],
        },
      },
    };

    const res = refreshPivot(wb, "ModelPivot1", cocoModel, "dest");
    expect(res.ok).toBe(true);

    const cellData = wb.sheets!["dest"]!.cellData!;
    const allValues = Object.values(cellData).flatMap((row) =>
      Object.values(row ?? {}).map((cell) => (cell as { v?: unknown })?.v),
    );
    // East=100, West=200, Total=300 should all appear in the written output.
    expect(allValues).toContain(100);
    expect(allValues).toContain(200);
    expect(allValues).toContain(300);
  });

  it("returns { ok: false } when cocoModel is not supplied for a model pivot", () => {
    const wb: WorkbookPivotSnapshot = {
      sheetOrder: ["dest"],
      sheets: {
        dest: {
          name: "Output",
          cellData: {},
          _pivots: [
            {
              name: "ModelPivot1",
              source: { kind: "model", tableName: "Sales" },
              destination: { row: 0, col: 0 },
              rows: [],
              cols: [],
              values: [{ kind: "measure", measureName: "Total" }],
              filters: [],
              hasHeader: false,
            },
          ],
        },
      },
    };
    const res = refreshPivot(wb, "ModelPivot1");
    expect(res.ok).toBe(false);
  });

  it("wipes old footprint before writing new output", () => {
    const cocoModel = makeCocoModel();
    const wb: WorkbookPivotSnapshot = {
      sheetOrder: ["dest"],
      sheets: {
        dest: {
          name: "Output",
          cellData: {
            // Old stale cells at row 0-4
            "0": { "0": { v: "Stale" }, "1": { v: "Header" } },
            "1": { "0": { v: "OldRow1" }, "1": { v: 999 } },
            "4": { "0": { v: "OldRow5" }, "1": { v: 999 } },
          },
          _pivots: [
            {
              name: "ModelPivot1",
              source: { kind: "model", tableName: "Sales" },
              destination: { row: 0, col: 0 },
              rows: ["Region"],
              cols: [],
              values: [{ kind: "measure", measureName: "Total" }],
              filters: [],
              hasHeader: false,
              lastOutputRows: 5,
              lastOutputCols: 2,
            },
          ],
        },
      },
    };

    refreshPivot(wb, "ModelPivot1", cocoModel, "dest");

    // The old cell at row 4 col 0 (outside new footprint) should be wiped.
    expect(wb.sheets!["dest"]!.cellData!["4"]?.["0"]).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// renameMeasureReferences
// ---------------------------------------------------------------------------

describe("renameMeasureReferences", () => {
  function makeWorkbook(pivots: PivotEntry[]): WorkbookPivotSnapshot {
    return {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Sheet1",
          _pivots: pivots,
        },
      },
    };
  }

  function measureEntry(name: string): PivotEntry {
    return {
      name,
      source: { kind: "model", tableName: "Sales" },
      destination: { row: 0, col: 0 },
      rows: [],
      cols: [],
      values: [{ kind: "measure", measureName: "Total Sales" }],
      hasHeader: false,
    };
  }

  it("returns updatedPivotCount:0 when no pivots reference oldName", () => {
    const wb = makeWorkbook([measureEntry("P1")]);
    const result = renameMeasureReferences(wb, "NoSuch", "NewName");
    expect(result.updatedPivotCount).toBe(0);
    const values = wb.sheets!["s1"]!._pivots![0].values;
    expect(values[0]).toEqual({ kind: "measure", measureName: "Total Sales" });
  });

  it("updates a single measure reference in a single pivot", () => {
    const wb = makeWorkbook([measureEntry("P1")]);
    const result = renameMeasureReferences(wb, "Total Sales", "Revenue");
    expect(result.updatedPivotCount).toBe(1);
    const values = wb.sheets!["s1"]!._pivots![0].values;
    expect(values[0]).toEqual({ kind: "measure", measureName: "Revenue" });
  });

  it("does not touch column-kind values", () => {
    const wb: WorkbookPivotSnapshot = {
      sheets: {
        s1: {
          _pivots: [
            {
              name: "P1",
              source: { kind: "model", tableName: "Sales" },
              destination: { row: 0, col: 0 },
              rows: [],
              cols: [],
              values: [
                { kind: "column", field: "Total Sales", agg: "SUM" },
                { kind: "measure", measureName: "Total Sales" },
              ],
              hasHeader: false,
            },
          ],
        },
      },
    };
    renameMeasureReferences(wb, "Total Sales", "Revenue");
    const values = wb.sheets!["s1"]!._pivots![0].values;
    // column-kind must stay untouched
    expect(values[0]).toEqual({ kind: "column", field: "Total Sales", agg: "SUM" });
    // measure-kind must be updated
    expect(values[1]).toEqual({ kind: "measure", measureName: "Revenue" });
  });

  it("updates references across multiple sheets and pivots", () => {
    const wb: WorkbookPivotSnapshot = {
      sheets: {
        s1: {
          _pivots: [
            {
              name: "P1",
              source: { kind: "model", tableName: "Sales" },
              destination: { row: 0, col: 0 },
              rows: [],
              cols: [],
              values: [{ kind: "measure", measureName: "Total Sales" }],
              hasHeader: false,
            },
          ],
        },
        s2: {
          _pivots: [
            {
              name: "P2",
              source: { kind: "model", tableName: "Sales" },
              destination: { row: 0, col: 0 },
              rows: [],
              cols: [],
              values: [
                { kind: "measure", measureName: "Total Sales" },
                { kind: "measure", measureName: "Avg Price" },
              ],
              hasHeader: false,
            },
          ],
        },
      },
    };
    const result = renameMeasureReferences(wb, "Total Sales", "Revenue");
    expect(result.updatedPivotCount).toBe(2);
    expect(wb.sheets!["s1"]!._pivots![0].values[0]).toEqual({ kind: "measure", measureName: "Revenue" });
    expect(wb.sheets!["s2"]!._pivots![0].values[0]).toEqual({ kind: "measure", measureName: "Revenue" });
    // Unrelated measure untouched
    expect(wb.sheets!["s2"]!._pivots![0].values[1]).toEqual({ kind: "measure", measureName: "Avg Price" });
  });

  it("handles an empty workbook gracefully", () => {
    const result = renameMeasureReferences({}, "Total Sales", "Revenue");
    expect(result.updatedPivotCount).toBe(0);
  });
});
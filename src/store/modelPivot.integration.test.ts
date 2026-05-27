/**
 * Integration tests for the Pivot Table × DAX Measure engine.
 * Issue #239 Step 7 — end-to-end coverage for computeModelPivot, addPivot,
 * refreshPivot, and the normalizePivotEntry legacy-compat path.
 *
 * All tests are pure (no Univer, no DOM, no network).
 */

import { describe, it, expect } from "vitest";
import {
  computeModelPivot,
  addPivot,
  refreshPivot,
  listAllPivots,
  normalizePivotEntry,
  type PivotConfig,
  type PivotEntry,
  type WorkbookPivotSnapshot,
} from "./pivots";
import {
  applyCalculatedColumns,
  toDataModel,
  type CocoDataModel,
  type StoredMeasure,
  type StoredCalculatedColumn,
} from "./cocoDataModel";
import type { ModelTable } from "./daxEngine";
import { MEASURE_ERROR } from "./daxEngine";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Base Sales table: Region × Year × Amount × ProductId.
 * Data is chosen so cross-group sums are unambiguous integers.
 *
 *   East / 2023 / 100 / P1
 *   East / 2024 / 200 / P1
 *   West / 2023 / 300 / P2
 *   West / 2024 / 400 / P2
 */
const SALES_TABLE: ModelTable = {
  name: "Sales",
  columns: [
    { name: "Region", type: "string" },
    { name: "Year", type: "number" },
    { name: "Amount", type: "number" },
    { name: "ProductId", type: "string" },
  ],
  rows: [
    { Region: "East", Year: 2023, Amount: 100, ProductId: "P1" },
    { Region: "East", Year: 2024, Amount: 200, ProductId: "P1" },
    { Region: "West", Year: 2023, Amount: 300, ProductId: "P2" },
    { Region: "West", Year: 2024, Amount: 400, ProductId: "P2" },
  ],
};

const TOTAL_MEASURE: StoredMeasure = {
  id: "m-total",
  name: "Total",
  tableId: "Sales",
  expression: "SUM(Sales[Amount])",
};

function makeBaseModel(): CocoDataModel {
  return {
    tables: [{ ...SALES_TABLE, rows: SALES_TABLE.rows.map((r) => ({ ...r })) }],
    relationships: [],
    measures: [TOTAL_MEASURE],
    calculatedColumns: [],
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: end-to-end measure pivot
// ---------------------------------------------------------------------------

describe("Scenario 1: end-to-end measure pivot", () => {
  /**
   * Matrix layout with rows=['Region'], cols=['Year'], values=[measure:Total]:
   *
   *   colLevels = 1, showValueLabelRow = false
   *   headerRowCount = 1, rowHeaderColCount = 1
   *   sortedColKeys = [2023, 2024], colKeyCount = 2
   *   totalCols = 1 + 2 + 1 = 4
   *   totalRows = 1 + 2 + 1 = 4
   *
   *   [0]: ['Region', 2023,    2024,    'Total']
   *   [1]: ['East',  100,     200,     300     ]
   *   [2]: ['West',  300,     400,     700     ]
   *   [3]: ['Total', 400,     600,     1000    ]
   */
  it("produces correct cross-tab values from SUM(Sales[Amount])", () => {
    const cocoModel = makeBaseModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const config: PivotConfig = {
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    const result = computeModelPivot(runtimeModel, cocoModel, config);

    expect(result.rowCount).toBe(4);
    expect(result.colCount).toBe(4);

    const m = result.output;

    // Header row: row-field label, col values, Total
    expect(m[0][0]).toBe("Region");
    expect(m[0][1]).toBe(2023);
    expect(m[0][2]).toBe(2024);
    expect(m[0][3]).toBe("Total");

    // East row
    expect(m[1][0]).toBe("East");
    expect(m[1][1]).toBe(100);  // SUM(Amount) where Region=East AND Year=2023
    expect(m[1][2]).toBe(200);  // SUM(Amount) where Region=East AND Year=2024
    expect(m[1][3]).toBe(300);  // SUM(Amount) where Region=East (all years)

    // West row
    expect(m[2][0]).toBe("West");
    expect(m[2][1]).toBe(300);  // SUM(Amount) where Region=West AND Year=2023
    expect(m[2][2]).toBe(400);  // SUM(Amount) where Region=West AND Year=2024
    expect(m[2][3]).toBe(700);  // SUM(Amount) where Region=West (all years)

    // Grand-total row
    expect(m[3][0]).toBe("Total");
    expect(m[3][1]).toBe(400);  // SUM(Amount) where Year=2023
    expect(m[3][2]).toBe(600);  // SUM(Amount) where Year=2024
    expect(m[3][3]).toBe(1000); // Grand total
  });

  it("throws when source.kind is not 'model'", () => {
    const cocoModel = makeBaseModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const badConfig: PivotConfig = {
      source: { kind: "sheet", sheetId: "s1", range: { r1: 0, c1: 0, r2: 0, c2: 0 } },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    expect(() => computeModelPivot(runtimeModel, cocoModel, badConfig)).toThrow(
      "computeModelPivot requires source.kind === 'model'",
    );
  });

  it("handles empty table gracefully — returns header + grand-total rows only", () => {
    const emptyModel: CocoDataModel = {
      tables: [{ name: "Sales", columns: SALES_TABLE.columns, rows: [] }],
      relationships: [],
      measures: [TOTAL_MEASURE],
      calculatedColumns: [],
    };
    const runtimeModel = applyCalculatedColumns(toDataModel(emptyModel), emptyModel);

    const config: PivotConfig = {
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    const result = computeModelPivot(runtimeModel, emptyModel, config);
    // No data rows → sortedRowKeys = [], sortedColKeys = []
    // totalRows = 1 + 0 + 1 = 2, totalCols = 1 + 1*1 + 1 = 3
    expect(result.rowCount).toBe(2);
    // Grand-total row exists at [1]
    expect(result.output[1][0]).toBe("Total");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: calculated column + measure interaction
// ---------------------------------------------------------------------------

describe("Scenario 2: calculated column + measure mixed pivot", () => {
  /**
   * NetAmount = Amount * 0.9
   * NetTotal  = SUM(Sales[NetAmount])
   *
   * Expected values:
   *   East/2023: 100 * 0.9 = 90
   *   East/2024: 200 * 0.9 = 180
   *   West/2023: 300 * 0.9 = 270
   *   West/2024: 400 * 0.9 = 360
   */
  function makeModelWithNetAmount(): CocoDataModel {
    const netAmountCol: StoredCalculatedColumn = {
      id: "cc-net",
      name: "NetAmount",
      tableId: "Sales",
      columnName: "NetAmount",
      expression: "Sales[Amount] * 0.9",
    };
    const netTotalMeasure: StoredMeasure = {
      id: "m-net",
      name: "NetTotal",
      tableId: "Sales",
      expression: "SUM(Sales[NetAmount])",
    };
    return {
      tables: [{ ...SALES_TABLE, rows: SALES_TABLE.rows.map((r) => ({ ...r })) }],
      relationships: [],
      measures: [TOTAL_MEASURE, netTotalMeasure],
      calculatedColumns: [netAmountCol],
    };
  }

  it("NetTotal measure reflects calculated column values", () => {
    const cocoModel = makeModelWithNetAmount();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const config: PivotConfig = {
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "NetTotal" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    const result = computeModelPivot(runtimeModel, cocoModel, config);
    const m = result.output;

    // East/2023 = 90, East/2024 = 180, row total = 270
    expect(m[1][0]).toBe("East");
    expect(m[1][1]).toBeCloseTo(90);
    expect(m[1][2]).toBeCloseTo(180);
    expect(m[1][3]).toBeCloseTo(270);

    // West/2023 = 270, West/2024 = 360, row total = 630
    expect(m[2][0]).toBe("West");
    expect(m[2][1]).toBeCloseTo(270);
    expect(m[2][2]).toBeCloseTo(360);
    expect(m[2][3]).toBeCloseTo(630);

    // Grand total = 90 + 180 + 270 + 360 = 900
    expect(m[3][3]).toBeCloseTo(900);
  });

  it("can pivot on the calculated column itself as a column-kind value field", () => {
    const cocoModel = makeModelWithNetAmount();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const config: PivotConfig = {
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: [],
      values: [{ kind: "column", field: "NetAmount", agg: "SUM" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    const result = computeModelPivot(runtimeModel, cocoModel, config);
    const m = result.output;

    // showValueLabelRow = true (cols.length === 0)
    // headerRowCount = 0 + 1 = 1
    // row 1 = East: SUM(NetAmount) = 90+180 = 270
    // row 2 = West: SUM(NetAmount) = 270+360 = 630
    // row 3 = Total: 900

    const eastRow = m.find((r) => r[0] === "East");
    const westRow = m.find((r) => r[0] === "West");
    expect(eastRow).toBeDefined();
    expect(westRow).toBeDefined();
    if (eastRow) expect(eastRow[1]).toBeCloseTo(270);
    if (westRow) expect(westRow[1]).toBeCloseTo(630);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: snapshot round-trip — addPivot → refreshPivot
// ---------------------------------------------------------------------------

describe("Scenario 3: snapshot round-trip with addPivot + refreshPivot", () => {
  function makeWorkbook(cocoModel: CocoDataModel): WorkbookPivotSnapshot {
    return {
      sheetOrder: ["sheet1"],
      sheets: {
        sheet1: {
          name: "Sheet1",
          cellData: {},
          _cocoDataModel: cocoModel,
        },
      },
    };
  }

  it("addPivot registers the entry on the destination sheet", () => {
    const cocoModel = makeBaseModel();
    const workbook = makeWorkbook(cocoModel);

    const entry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    addPivot(workbook, entry, cocoModel, "sheet1");

    const pivots = workbook.sheets?.sheet1?._pivots;
    expect(Array.isArray(pivots)).toBe(true);
    expect(pivots).toHaveLength(1);
    expect(pivots![0].name).toBe("Pivot1");
  });

  it("addPivot seeds lastOutputRows / lastOutputCols from computeModelPivot", () => {
    const cocoModel = makeBaseModel();
    const workbook = makeWorkbook(cocoModel);

    const entry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    addPivot(workbook, entry, cocoModel, "sheet1");

    const stored = workbook.sheets?.sheet1?._pivots?.[0];
    // 4 rows (header + East + West + Total) × 4 cols (Region, 2023, 2024, Total)
    expect(stored?.lastOutputRows).toBe(4);
    expect(stored?.lastOutputCols).toBe(4);
  });

  it("refreshPivot writes cell values at the correct destination coordinates", () => {
    const cocoModel = makeBaseModel();
    const workbook = makeWorkbook(cocoModel);

    const entry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 2, col: 3 }, // offset so we can check abs coords
      hasHeader: false,
    };

    addPivot(workbook, entry, cocoModel, "sheet1");
    const { ok } = refreshPivot(workbook, "Pivot1", cocoModel, "sheet1");
    expect(ok).toBe(true);

    const cellData = workbook.sheets!.sheet1!.cellData as Record<
      string,
      Record<string, { v?: unknown }>
    >;

    // destination row=2, col=3
    // matrix[0] = header row → abs row 2, abs col 3..6
    // matrix[1] = East row  → abs row 3
    // matrix[2] = West row  → abs row 4
    // matrix[3] = Total row → abs row 5

    // Header: m[0][0] = 'Region' at (2,3)
    expect(cellData["2"]["3"].v).toBe("Region");

    // East / 2023 cell: m[1][1] = 100 at abs (3, 4)
    expect(cellData["3"]["4"].v).toBe(100);

    // West / 2024 cell: m[2][2] = 400 at abs (4, 5)
    expect(cellData["4"]["5"].v).toBe(400);

    // Grand total cell: m[3][3] = 1000 at abs (5, 6)
    expect(cellData["5"]["6"].v).toBe(1000);
  });

  it("refreshPivot returns ok:false when pivot name is not found", () => {
    const cocoModel = makeBaseModel();
    const workbook = makeWorkbook(cocoModel);

    const result = refreshPivot(workbook, "NonExistent", cocoModel, "sheet1");
    expect(result.ok).toBe(false);
  });

  it("refreshPivot returns ok:false for model pivot when cocoModel is absent", () => {
    const cocoModel = makeBaseModel();
    const workbook = makeWorkbook(cocoModel);

    const entry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    addPivot(workbook, entry, cocoModel, "sheet1");
    // Pass no cocoModel → should fail gracefully
    const result = refreshPivot(workbook, "Pivot1", undefined, "sheet1");
    expect(result.ok).toBe(false);
  });

  it("listAllPivots reflects entry registered by addPivot", () => {
    const cocoModel = makeBaseModel();
    const workbook = makeWorkbook(cocoModel);

    const entry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: [],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    addPivot(workbook, entry, cocoModel, "sheet1");
    const listings = listAllPivots(workbook);
    expect(listings).toHaveLength(1);
    expect(listings[0].pivot.name).toBe("Pivot1");
    expect(listings[0].sheetId).toBe("sheet1");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: measure error propagation
// ---------------------------------------------------------------------------

describe("Scenario 4: invalid DAX expression propagates #ERROR! into pivot cells", () => {
  it("data cells show MEASURE_ERROR when the measure expression is invalid", () => {
    const brokenMeasure: StoredMeasure = {
      id: "m-broken",
      name: "Broken",
      tableId: "Sales",
      expression: "= INVALID(",
    };
    const cocoModel: CocoDataModel = {
      tables: [{ ...SALES_TABLE, rows: SALES_TABLE.rows.map((r) => ({ ...r })) }],
      relationships: [],
      measures: [brokenMeasure],
      calculatedColumns: [],
    };
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const config: PivotConfig = {
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: ["Year"],
      values: [{ kind: "measure", measureName: "Broken" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    const result = computeModelPivot(runtimeModel, cocoModel, config);
    const m = result.output;

    // Data cells (non-header, non-header-col, non-total-label) should be #ERROR!
    // Row 1 (East): data cells at cols 1 and 2
    expect(m[1][1]).toBe(MEASURE_ERROR);
    expect(m[1][2]).toBe(MEASURE_ERROR);
    // Row 2 (West): same
    expect(m[2][1]).toBe(MEASURE_ERROR);
    expect(m[2][2]).toBe(MEASURE_ERROR);
  });

  it("unknown measure name also yields MEASURE_ERROR", () => {
    const cocoModel = makeBaseModel();
    const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);

    const config: PivotConfig = {
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: [],
      values: [{ kind: "measure", measureName: "DoesNotExist" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    const result = computeModelPivot(runtimeModel, cocoModel, config);
    // showValueLabelRow=true, headerRowCount=1
    // Row 1 = East data
    expect(result.output[1][1]).toBe(MEASURE_ERROR);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: legacy snapshot normalization via normalizePivotEntry
// ---------------------------------------------------------------------------

describe("Scenario 5: legacy snapshot normalization", () => {
  /**
   * Pre-discriminated-union snapshots have:
   *   source: { sheetId, range }   — no 'kind'
   *   values: [{ field, agg }]     — no 'kind'
   *
   * normalizePivotEntry must upgrade them in-place so existing code paths
   * continue to work without a migration step.
   */
  it("normalizes a legacy sheet-source entry (no kind on source)", () => {
    const legacyEntry = {
      name: "OldPivot",
      source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 3, c2: 2 } },
      rows: ["Region"],
      cols: [],
      values: [{ field: "Amount", agg: "SUM" }],
      destination: { row: 0, col: 0 },
      hasHeader: true,
    } as unknown as PivotEntry;

    const normalized = normalizePivotEntry(legacyEntry);

    expect(normalized.source.kind).toBe("sheet");
    expect((normalized.source as { kind: "sheet"; sheetId: string }).sheetId).toBe("s1");
    expect(normalized.values[0].kind).toBe("column");
    expect((normalized.values[0] as { kind: "column"; field: string; agg: string }).field).toBe("Amount");
  });

  it("normalizePivotEntry is idempotent on already-normalized entries", () => {
    const modernEntry: PivotEntry = {
      name: "Pivot1",
      source: { kind: "model", tableName: "Sales" },
      rows: ["Region"],
      cols: [],
      values: [{ kind: "measure", measureName: "Total" }],
      destination: { row: 0, col: 0 },
      hasHeader: false,
    };

    const first = normalizePivotEntry({ ...modernEntry });
    const second = normalizePivotEntry({ ...first });
    expect(second.source.kind).toBe("model");
    expect(second.values[0].kind).toBe("measure");
  });

  it("listAllPivots normalizes legacy entries in a workbook snapshot", () => {
    /**
     * A legacy snapshot where _pivots contains entries with no 'kind' fields.
     * listAllPivots does NOT normalize (it reads as-is), but we can call
     * refreshPivot which internally calls normalizePivotEntry and must not crash.
     */
    const legacyPivotEntry = {
      name: "LegacyPivot",
      source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 4, c2: 2 } },
      rows: ["Region"],
      cols: [],
      values: [{ field: "Amount", agg: "SUM" }],
      destination: { row: 0, col: 0 },
      hasHeader: true,
    };

    // Build a workbook with both the source data and the legacy pivot entry.
    const workbook: WorkbookPivotSnapshot = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Sheet1",
          cellData: {
            "0": { "0": { v: "Region" }, "1": { v: "Year" }, "2": { v: "Amount" } },
            "1": { "0": { v: "East" }, "1": { v: 2023 }, "2": { v: 100 } },
            "2": { "0": { v: "West" }, "1": { v: 2023 }, "2": { v: 300 } },
          },
          _pivots: [legacyPivotEntry as unknown as PivotEntry],
        },
      },
    };

    // listAllPivots: should return the entry regardless of legacy shape.
    const listings = listAllPivots(workbook);
    expect(listings).toHaveLength(1);
    expect(listings[0].pivot.name).toBe("LegacyPivot");

    // refreshPivot: internally normalizes and must succeed without throwing.
    const result = refreshPivot(workbook, "LegacyPivot");
    expect(result.ok).toBe(true);

    // Verify a data cell was written — East/Amount SUM = 100
    const cellData = workbook.sheets!.s1!.cellData as Record<
      string,
      Record<string, { v?: unknown }>
    >;
    // header at row 0, data starts at row 1 of destination (dest row 0 = header)
    // East is at matrix body row 1 → abs row 1, col 0 = header label "Region"
    // but col 1 should have a value (the SUM result) at abs (1, 1)
    const dataCell = cellData["1"]?.["1"];
    expect(dataCell).toBeDefined();
    // The SUM value of Amount for East: 100
    expect(dataCell?.v).toBe(100);
  });
});

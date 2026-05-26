import { describe, it, expect } from "vitest";
import {
  aggregate,
  applySubtotals,
  shiftSheetRowsBelow,
  type SubtotalParams,
} from "./subtotals";

// #237/#235 follow-on — regression suite for subtotals.ts (743 lines, no
// tests). Locks the public surface so the row-insertion + sheet-structure-
// shift logic doesn't drift.

describe("aggregate", () => {
  it("SUM ignores NaN, returns 0 on empty", () => {
    expect(aggregate("SUM", [1, 2, NaN, 3])).toBe(6);
    expect(aggregate("SUM", [])).toBe(0);
  });

  it("AVERAGE returns NaN on empty", () => {
    expect(aggregate("AVERAGE", [2, 4, 6])).toBe(4);
    expect(Number.isNaN(aggregate("AVERAGE", []))).toBe(true);
  });

  it("COUNT counts numeric only", () => {
    expect(aggregate("COUNT", [1, NaN, 2])).toBe(2);
    expect(aggregate("COUNT", [])).toBe(0);
  });

  it("MAX / MIN work, NaN on empty", () => {
    expect(aggregate("MAX", [1, 5, 3])).toBe(5);
    expect(aggregate("MIN", [1, 5, 3])).toBe(1);
    expect(Number.isNaN(aggregate("MAX", []))).toBe(true);
    expect(Number.isNaN(aggregate("MIN", []))).toBe(true);
  });

  it("PRODUCT multiplies, NaN on empty", () => {
    expect(aggregate("PRODUCT", [2, 3, 4])).toBe(24);
    expect(Number.isNaN(aggregate("PRODUCT", []))).toBe(true);
  });
});

describe("applySubtotals", () => {
  // Source sheet: 5 detail rows grouped by Region (col 0), Sales in col 1.
  function makeSheet() {
    return {
      cellData: {
        "0": { "0": { v: "Region" }, "1": { v: "Sales" } },
        "1": { "0": { v: "East" }, "1": { v: 100 } },
        "2": { "0": { v: "East" }, "1": { v: 150 } },
        "3": { "0": { v: "West" }, "1": { v: 200 } },
        "4": { "0": { v: "West" }, "1": { v: 250 } },
      },
    };
  }

  const baseParams: SubtotalParams = {
    range: { r1: 0, c1: 0, r2: 4, c2: 1 },
    groupByCol: 1,        // 1-based: group by col 0 (Region)
    aggregate: "SUM",
    targetCols: [2],      // 1-based: aggregate col 1 (Sales)
    hasHeader: true,
    addOutline: false,
  };

  it("inserts per-group + grand total rows with correct aggregates", () => {
    const sheet = makeSheet();
    const result = applySubtotals(sheet, baseParams);
    // Expected output:
    //   row 0: header
    //   row 1: East 100
    //   row 2: East 150
    //   row 3: East Total / 250
    //   row 4: West 200
    //   row 5: West 250
    //   row 6: West Total / 450
    //   row 7: Grand Total / 700
    expect(result.newCellData["3"]["0"]).toEqual({ v: "East Total" });
    expect(result.newCellData["3"]["1"]).toEqual({ v: 250 });
    expect(result.newCellData["6"]["0"]).toEqual({ v: "West Total" });
    expect(result.newCellData["6"]["1"]).toEqual({ v: 450 });
    expect(result.newCellData["7"]["0"]).toEqual({ v: "Grand Total" });
    expect(result.newCellData["7"]["1"]).toEqual({ v: 700 });
    expect(result.newRowCount).toBeGreaterThanOrEqual(8);
  });

  it("supports COUNT aggregation", () => {
    const sheet = makeSheet();
    const result = applySubtotals(sheet, { ...baseParams, aggregate: "COUNT" });
    // East: 2 rows, West: 2 rows, grand: 4
    expect(result.newCellData["3"]["1"]).toEqual({ v: 2 });
    expect(result.newCellData["6"]["1"]).toEqual({ v: 2 });
    expect(result.newCellData["7"]["1"]).toEqual({ v: 4 });
  });

  it("supports multiple target columns", () => {
    const sheet = {
      cellData: {
        "0": { "0": { v: "G" }, "1": { v: "A" }, "2": { v: "B" } },
        "1": { "0": { v: "X" }, "1": { v: 10 }, "2": { v: 1 } },
        "2": { "0": { v: "X" }, "1": { v: 20 }, "2": { v: 2 } },
      },
    };
    const result = applySubtotals(sheet, {
      range: { r1: 0, c1: 0, r2: 2, c2: 2 },
      groupByCol: 1,
      aggregate: "SUM",
      targetCols: [2, 3], // both A and B
      hasHeader: true,
      addOutline: false,
    });
    // Row 3 should be the X Total
    expect(result.newCellData["3"]["1"]).toEqual({ v: 30 });
    expect(result.newCellData["3"]["2"]).toEqual({ v: 3 });
  });

  it("returns the input cellData unchanged when the range has no detail rows", () => {
    const sheet = {
      cellData: {
        "0": { "0": { v: "Header" } },
      },
    };
    const result = applySubtotals(sheet, {
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      groupByCol: 1,
      aggregate: "SUM",
      targetCols: [1],
      hasHeader: true,
      addOutline: false,
    });
    expect(result.newCellData["0"]).toEqual(sheet.cellData["0"]);
  });

  it("normalises swapped range corners", () => {
    const sheet = makeSheet();
    const result = applySubtotals(sheet, {
      ...baseParams,
      range: { r1: 4, c1: 1, r2: 0, c2: 0 }, // swapped
    });
    expect(result.newCellData["3"]["0"]).toEqual({ v: "East Total" });
  });

  it("returns outline groups when addOutline=true", () => {
    const sheet = makeSheet();
    const result = applySubtotals(sheet, { ...baseParams, addOutline: true });
    expect(result.outlineGroups).toBeDefined();
    expect(result.outlineGroups!.length).toBeGreaterThan(0);
    // Every outline group should be level 1 (detail rows below the level-0
    // summary).
    for (const g of result.outlineGroups!) expect(g.level).toBe(1);
  });

  it("omits outline groups when addOutline=false", () => {
    const sheet = makeSheet();
    const result = applySubtotals(sheet, { ...baseParams, addOutline: false });
    expect(result.outlineGroups).toBeUndefined();
  });

  it("handles hasHeader=false (treats first row as detail)", () => {
    const sheet = {
      cellData: {
        "0": { "0": { v: "X" }, "1": { v: 1 } },
        "1": { "0": { v: "X" }, "1": { v: 2 } },
        "2": { "0": { v: "Y" }, "1": { v: 3 } },
      },
    };
    const result = applySubtotals(sheet, {
      range: { r1: 0, c1: 0, r2: 2, c2: 1 },
      groupByCol: 1,
      aggregate: "SUM",
      targetCols: [2],
      hasHeader: false,
      addOutline: false,
    });
    // Expected: 3 detail + 2 group totals + 1 grand total = 6 rows minimum
    expect(result.newCellData["2"]["0"]).toEqual({ v: "X Total" });
    expect(result.newCellData["2"]["1"]).toEqual({ v: 3 });
  });
});

describe("shiftSheetRowsBelow", () => {
  it("shifts mergeData entries at or below fromRow by delta", () => {
    const sheet = {
      mergeData: [
        { startRow: 0, endRow: 1, startCol: 0, endCol: 0 },  // above
        { startRow: 5, endRow: 6, startCol: 0, endCol: 0 },  // below
      ],
    };
    shiftSheetRowsBelow(sheet, 3, 2);
    expect((sheet.mergeData[0] as { startRow: number }).startRow).toBe(0); // unchanged
    expect((sheet.mergeData[1] as { startRow: number }).startRow).toBe(7);
    expect((sheet.mergeData[1] as { endRow: number }).endRow).toBe(8);
  });

  it("handles a sheet with no row-indexed structures gracefully", () => {
    const sheet = { name: "Empty" };
    expect(() => shiftSheetRowsBelow(sheet, 0, 5)).not.toThrow();
  });

  it("is a no-op when delta is 0", () => {
    const sheet = {
      mergeData: [{ startRow: 5, endRow: 6, startCol: 0, endCol: 0 }],
    };
    shiftSheetRowsBelow(sheet, 3, 0);
    expect((sheet.mergeData[0] as { startRow: number }).startRow).toBe(5);
  });

  it("ignores non-integer fromRow / delta", () => {
    const sheet = {
      mergeData: [{ startRow: 5, endRow: 6, startCol: 0, endCol: 0 }],
    };
    shiftSheetRowsBelow(sheet, 1.5, 2);
    expect((sheet.mergeData[0] as { startRow: number }).startRow).toBe(5);
    shiftSheetRowsBelow(sheet, 3, NaN);
    expect((sheet.mergeData[0] as { startRow: number }).startRow).toBe(5);
  });

  it("tolerates a null/undefined sheet (no-op)", () => {
    expect(() => shiftSheetRowsBelow(null, 0, 1)).not.toThrow();
    expect(() => shiftSheetRowsBelow(undefined, 0, 1)).not.toThrow();
  });

  it("supports negative delta for upward shifts (row removals)", () => {
    const sheet = {
      mergeData: [{ startRow: 10, endRow: 12, startCol: 0, endCol: 0 }],
    };
    shiftSheetRowsBelow(sheet, 5, -3);
    expect((sheet.mergeData[0] as { startRow: number }).startRow).toBe(7);
    expect((sheet.mergeData[0] as { endRow: number }).endRow).toBe(9);
  });
});

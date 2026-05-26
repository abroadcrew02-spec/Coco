import { describe, it, expect } from "vitest";
import { collectWorkbookStats, formatBytes } from "./workbookStats";

// Regression suite for workbookStats.ts (401 lines, no tests).

describe("formatBytes", () => {
  it("formats bytes in human-readable units", () => {
    expect(formatBytes(0)).toMatch(/0/);
    expect(formatBytes(1023)).toMatch(/B/);
    expect(formatBytes(1024)).toMatch(/KB|KiB/i);
    expect(formatBytes(1024 * 1024)).toMatch(/MB|MiB/i);
  });
});

describe("collectWorkbookStats", () => {
  function fixture() {
    return JSON.stringify({
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: {
          name: "Data",
          cellData: {
            "0": {
              "0": { v: 10 },                  // numeric
              "1": { v: "Tokyo" },             // text
              "2": { v: true },                // boolean
              "3": { f: "=A1+B1", v: 10 },     // formula
              "4": { v: "" },                  // blank
            },
          },
          _comments: [{ cell: "A1", text: "x" }, { cell: "B1", text: "y" }],
          _hyperlinks: [{ ref: "A1", target: "https://example.com" }],
          _dataValidations: [{ ref: "A1:A10" }],
          _conditionalFormatting: [{ type: "cellIs" }],
          _sparklines: [{ id: "sp1" }],
          _charts: [{ id: "c1" }, { id: "c2" }],
          _tables: [{ name: "T1" }],
          _pivots: [{ name: "P1" }],
          _slicers: [{ name: "Slicer1" }],
          mergeData: [{ startRow: 0, endRow: 1, startCol: 0, endCol: 0 }],
        },
        s2: {
          name: "Hidden",
          _sheetState: "hidden",
          cellData: { "0": { "0": { v: 1 } } },
        },
      },
      styles: { "s1": {}, "s2": {} },
      namedRanges: [{ name: "Tax", ref: "Sheet1!A1" }],
    });
  }

  it("computes overview counts", () => {
    const b = collectWorkbookStats(fixture());
    expect(b.overview.sheetCount).toBe(2);
    expect(b.overview.hiddenSheetCount).toBe(1);
    expect(b.overview.totalCells).toBe(6); // 5 in s1 + 1 in s2
    expect(b.overview.formulaCells).toBe(1);
    expect(b.overview.sizeBytes).toBeGreaterThan(0);
  });

  it("classifies cell data types", () => {
    const b = collectWorkbookStats(fixture());
    expect(b.dataTypes.numeric).toBeGreaterThanOrEqual(2); // 10 + 1 in s2
    expect(b.dataTypes.text).toBeGreaterThanOrEqual(1);
    expect(b.dataTypes.boolean).toBeGreaterThanOrEqual(1);
    expect(b.dataTypes.formula).toBeGreaterThanOrEqual(1);
    expect(b.dataTypes.blank).toBeGreaterThanOrEqual(1);
  });

  it("counts per-sheet stats correctly", () => {
    const b = collectWorkbookStats(fixture());
    const s1 = b.perSheet.find((s) => s.sheetId === "s1");
    expect(s1).toBeDefined();
    expect(s1?.cellCount).toBe(5);
    expect(s1?.formulaCount).toBe(1);
    expect(s1?.commentCount).toBe(2);
    expect(s1?.cfRules).toBe(1);
    expect(s1?.dvRules).toBe(1);
    expect(s1?.mergedCount).toBe(1);
  });

  it("aggregates feature usage workbook-wide", () => {
    const b = collectWorkbookStats(fixture());
    expect(b.features.hyperlinks).toBe(1);
    expect(b.features.comments).toBe(2);
    expect(b.features.dataValidations).toBe(1);
    expect(b.features.conditionalFormats).toBe(1);
    expect(b.features.sparklines).toBe(1);
    expect(b.features.charts).toBe(2);
    expect(b.features.tables).toBe(1);
    expect(b.features.pivots).toBe(1);
    expect(b.features.slicers).toBe(1);
    expect(b.features.namedRanges).toBe(1);
  });

  it("counts unique workbook styles", () => {
    const b = collectWorkbookStats(fixture());
    // Two styles in workbook.styles map.
    expect(b.styles.uniqueStyles).toBeGreaterThanOrEqual(2);
  });

  it("ranks top sheets by cell count (descending)", () => {
    const b = collectWorkbookStats(fixture());
    expect(b.topSheets.length).toBeGreaterThan(0);
    expect(b.topSheets[0].sheetId).toBe("s1"); // 5 > 1
    // Top sheets is capped at 5.
    expect(b.topSheets.length).toBeLessThanOrEqual(5);
  });

  it("returns empty bundle for null / malformed input (sizeBytes preserved)", () => {
    const b1 = collectWorkbookStats(null);
    expect(b1.overview.sheetCount).toBe(0);
    expect(b1.overview.sizeBytes).toBe(0);

    const b2 = collectWorkbookStats("not json");
    expect(b2.overview.sheetCount).toBe(0);
    expect(b2.overview.sizeBytes).toBeGreaterThan(0); // raw byte length still counted
  });

  it("accepts both JSON string and parsed object", () => {
    const obj = JSON.parse(fixture());
    const fromStr = collectWorkbookStats(fixture());
    const fromObj = collectWorkbookStats(obj);
    expect(fromObj.overview.sheetCount).toBe(fromStr.overview.sheetCount);
    expect(fromObj.features).toEqual(fromStr.features);
  });

  it("handles a workbook with no sheets gracefully", () => {
    const b = collectWorkbookStats("{}");
    expect(b.overview.sheetCount).toBe(0);
    expect(b.perSheet).toEqual([]);
    expect(b.topSheets).toEqual([]);
  });
});

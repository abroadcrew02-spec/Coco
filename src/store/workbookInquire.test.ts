import { describe, it, expect } from "vitest";
import { computeWorkbookInquire } from "./workbookInquire";

describe("computeWorkbookInquire", () => {
  it("returns a zeroed report for null/undefined/malformed input", () => {
    expect(computeWorkbookInquire(null).sheets).toBe(0);
    expect(computeWorkbookInquire(undefined).totalCells).toBe(0);
    expect(computeWorkbookInquire("{not json").formulaCells).toBe(0);
    expect(computeWorkbookInquire("[]").formulaCells).toBe(0);
  });

  it("counts sheets, hidden sheets, named ranges", () => {
    const snap = {
      sheetOrder: ["s1", "s2", "s3"],
      sheets: {
        s1: { name: "Visible" },
        s2: { name: "Hidden", _sheetState: "hidden" },
        s3: { name: "VeryHidden", _sheetState: "veryHidden" },
      },
      namedRanges: [{ name: "Tax", ref: "Sheet1!B1" }, { name: "Year", ref: "Sheet1!A1" }],
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    expect(r.sheets).toBe(3);
    expect(r.hiddenSheets).toBe(2);
    expect(r.namedRanges).toBe(2);
  });

  it("classifies value vs formula vs empty cells", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          cellData: {
            "0": {
              "0": { v: 42 },
              "1": { v: "", f: "=A1+1" },
              "2": { v: "" },
              "3": { v: null },
            },
          },
        },
      },
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    expect(r.totalCells).toBe(4);
    expect(r.valueCells).toBe(1);
    expect(r.formulaCells).toBe(1);
    expect(r.emptyCells).toBe(2);
  });

  it("ranks top functions by count, ignoring cell-ref-shaped tokens", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          cellData: {
            "0": {
              "0": { f: "=SUM(A1:A10)+IF(B1>0, 1, 0)" },
              "1": { f: "=SUM(B1:B10)" },
              "2": { f: "=VLOOKUP(C1, D:E, 2, FALSE)" },
              "3": { f: "=A1(IF(1, 2, 3))" }, // A1 is cell-ref, IF is function
              "4": { f: '=CONCATENATE("hello", IF(A1>0, "x", "y"))' },
            },
          },
        },
      },
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    const names = r.topFunctions.map((f) => f.name);
    expect(names).toContain("SUM");
    expect(names).toContain("IF");
    expect(names).toContain("VLOOKUP");
    expect(names).toContain("CONCATENATE");
    expect(names).not.toContain("A1");
    const sum = r.topFunctions.find((f) => f.name === "SUM");
    expect(sum?.count).toBe(2);
  });

  it("computes a formula depth histogram", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          cellData: {
            "0": {
              "0": { f: "=A1+B1" }, // depth 0 (no parens)
              "1": { f: "=SUM(A1:A10)" }, // depth 1
              "2": { f: "=IF(A1>0, SUM(B1:B10), 0)" }, // depth 2
            },
          },
        },
      },
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    expect(r.formulaDepthHistogram).toEqual([
      { depth: 0, count: 1 },
      { depth: 1, count: 1 },
      { depth: 2, count: 1 },
    ]);
  });

  it("tallies formula error values and records first occurrence", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "DataSheet",
          cellData: {
            "0": {
              "0": { v: "#REF!", f: "=A99" },
              "1": { v: "#VALUE!", f: "=A1+\"x\"" },
            },
            "2": {
              "0": { v: "#REF!", f: "=Z99" },
            },
          },
        },
      },
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    const refErr = r.formulaErrors.find((e) => e.code === "#REF!");
    expect(refErr?.count).toBe(2);
    expect(refErr?.firstAt).toBe("DataSheet!A1");
  });

  it("extracts external links from bracket-file and HYPERLINK formulas", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Linked",
          cellData: {
            "0": {
              "0": { f: "=[Book2.xlsx]Sheet1!A1" },
              "1": { f: '=HYPERLINK("https://example.com", "site")' },
              "2": { f: "=SUM(A1:A5)" }, // not external
            },
          },
        },
      },
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    expect(r.externalLinks).toHaveLength(2);
    expect(r.externalLinks[0].target).toBe("Book2.xlsx");
    expect(r.externalLinks[1].target).toBe("https://example.com");
  });

  it("counts preserved-parts images and pivots", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: { s1: { name: "S" } },
      _preservedParts: {
        parts: {
          "xl/media/image1.png": "AAA",
          "xl/media/image2.jpg": "BBB",
          "xl/pivotTables/pivotTable1.xml": "<...",
          "xl/drawings/drawing1.xml": "<...",
        },
      },
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    expect(r.images).toBe(2);
    expect(r.pivots).toBe(1);
  });

  it("counts CF/DV/hyperlinks/comments/charts per sheet", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          _comments: [{ cell: "A1", text: "x" }, { cell: "B2", text: "y" }],
          _cfRules: [{ type: "cellIs" }],
          _dataValidations: [{ ref: "A1:A10" }, { ref: "B1:B10" }],
          _hyperlinks: [{ ref: "A1", target: "https://x" }],
          _charts: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
        },
      },
    };
    const r = computeWorkbookInquire(snap as Parameters<typeof computeWorkbookInquire>[0]);
    expect(r.comments).toBe(2);
    expect(r.conditionalFormatRules).toBe(1);
    expect(r.dataValidationRules).toBe(2);
    expect(r.hyperlinks).toBe(1);
    expect(r.charts).toBe(3);
  });

  it("survives a JSON-string input matching the same shape as parsed object", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          cellData: { "0": { "0": { v: 7 } } },
        },
      },
    };
    const fromObj = computeWorkbookInquire(snap);
    const fromStr = computeWorkbookInquire(JSON.stringify(snap));
    expect(fromObj).toEqual(fromStr);
  });
});

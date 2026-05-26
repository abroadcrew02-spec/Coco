import { describe, it, expect } from "vitest";
import {
  inspectDocument,
  isExternalLinkFormula,
  stripCategory,
  type InspectorSnapshot,
} from "./documentInspector";

// Regression suite for documentInspector.ts (647 lines, no tests). Locks the
// inspect + strip surface used by the "Inspect Document" dialog.

describe("isExternalLinkFormula", () => {
  it("returns false for non-string / empty input", () => {
    expect(isExternalLinkFormula(undefined)).toBe(false);
    expect(isExternalLinkFormula(null)).toBe(false);
    expect(isExternalLinkFormula("")).toBe(false);
    expect(isExternalLinkFormula(42)).toBe(false);
  });

  it("detects [Book.xlsx] external workbook refs", () => {
    expect(isExternalLinkFormula("=[Book2.xlsx]Sheet1!A1")).toBe(true);
    expect(isExternalLinkFormula("='C:\\path\\[Book.xlsx]Sheet1'!A1")).toBe(true);
  });

  it("detects HYPERLINK(http/https) formulas", () => {
    expect(isExternalLinkFormula('=HYPERLINK("http://example.com")')).toBe(true);
    expect(isExternalLinkFormula('=HYPERLINK("https://example.com")')).toBe(true);
  });

  it("returns false for plain formulas + internal refs", () => {
    expect(isExternalLinkFormula("=SUM(A1:A10)")).toBe(false);
    expect(isExternalLinkFormula("=Sheet2!A1")).toBe(false);
    expect(isExternalLinkFormula('=HYPERLINK("#Sheet1!A1")')).toBe(false);
  });
});

describe("inspectDocument", () => {
  function fixture(): InspectorSnapshot {
    return {
      name: "Test",
      creator: "Alice",
      lastModifiedBy: "Bob",
      sheetOrder: ["s1", "s2", "s3"],
      sheets: {
        s1: {
          name: "Visible",
          _comments: [{ cell: "A1", author: "Alice", text: "hi" }],
          cellData: {
            "0": { "0": { v: "=Sheet2!A1" }, "1": { v: 10, f: "=[Book2.xlsx]Sheet1!A1" } },
          },
          rowData: { "5": { hd: 1 } },
          columnData: { "3": { hd: 1 } },
        },
        s2: {
          name: "Hidden",
          _sheetState: "hidden",
        },
        s3: {
          name: "VeryHidden",
          _sheetState: "veryHidden",
        },
      },
      _preservedParts: { "xl/media/image1.png": "AAA" },
    };
  }

  it("returns 8 categories in fixed order", () => {
    const results = inspectDocument(fixture());
    expect(results.map((r) => r.category)).toEqual([
      "hiddenSheets",
      "comments",
      "personalInfo",
      "hiddenRowsCols",
      "externalLinks",
      "snapshots",
      "preservedParts",
      "metadata",
    ]);
  });

  it("counts hidden sheets (hidden + veryHidden)", () => {
    const r = inspectDocument(fixture());
    const cat = r.find((x) => x.category === "hiddenSheets")!;
    expect(cat.count).toBe(2);
    expect(cat.canStrip).toBe(true);
  });

  it("counts comments by cell", () => {
    const r = inspectDocument(fixture());
    const cat = r.find((x) => x.category === "comments")!;
    expect(cat.count).toBe(1);
    expect(cat.items[0].cellRef).toBe("A1");
  });

  it("counts personalInfo entries (creator + lastModifiedBy + comment authors)", () => {
    const r = inspectDocument(fixture());
    const cat = r.find((x) => x.category === "personalInfo")!;
    expect(cat.count).toBeGreaterThanOrEqual(2); // creator + lastModifiedBy + comment author
  });

  it("counts hidden rows/cols", () => {
    const r = inspectDocument(fixture());
    const cat = r.find((x) => x.category === "hiddenRowsCols")!;
    expect(cat.count).toBeGreaterThanOrEqual(2); // row 5 + col 3
  });

  it("detects external link formulas in cellData", () => {
    const r = inspectDocument(fixture());
    const cat = r.find((x) => x.category === "externalLinks")!;
    // HYPERLINK("https://...") not in fixture, but [Book2.xlsx] is in B1 of s1
    expect(cat.count).toBeGreaterThanOrEqual(1);
  });

  it("counts preservedParts entries", () => {
    const r = inspectDocument(fixture());
    const cat = r.find((x) => x.category === "preservedParts")!;
    expect(cat.count).toBeGreaterThanOrEqual(1);
  });

  it("counts metadata fields (creator + lastModifiedBy)", () => {
    const r = inspectDocument(fixture());
    const cat = r.find((x) => x.category === "metadata")!;
    expect(cat.count).toBeGreaterThanOrEqual(2);
  });

  it("returns [] for null / undefined / non-JSON input", () => {
    expect(inspectDocument(null)).toEqual([]);
    expect(inspectDocument(undefined)).toEqual([]);
    expect(inspectDocument("not-json")).toEqual([]);
  });

  it("returns 8 zero-count categories for an empty parsed snapshot", () => {
    // "[]" parses to an empty array, which the inspector tolerates by
    // returning 8 categories each with count=0.
    const r = inspectDocument("{}");
    expect(r).toHaveLength(8);
    expect(r.every((c) => c.count === 0)).toBe(true);
  });

  it("accepts both JSON string and parsed object inputs", () => {
    const obj = fixture();
    const str = JSON.stringify(obj);
    const a = inspectDocument(obj);
    const b = inspectDocument(str);
    expect(b.map((r) => r.count)).toEqual(a.map((r) => r.count));
  });
});

describe("stripCategory", () => {
  function fixture(): InspectorSnapshot {
    return {
      name: "Test",
      creator: "Alice",
      lastModifiedBy: "Bob",
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: {
          name: "S1",
          _comments: [
            { cell: "A1", author: "Alice", text: "hi" },
          ],
          rowData: { "5": { hd: 1 } },
        },
        s2: { name: "Hidden", _sheetState: "hidden" },
      },
      _preservedParts: { "xl/media/image1.png": "AAA" },
    };
  }

  it("strips hiddenSheets by unsetting the _sheetState", () => {
    const { snapshotMutated, strippedCount } = stripCategory(fixture(), "hiddenSheets");
    expect(strippedCount).toBe(1);
    expect(snapshotMutated.sheets?.s2?._sheetState).toBeUndefined();
  });

  it("strips comments by emptying _comments arrays", () => {
    const { snapshotMutated, strippedCount } = stripCategory(fixture(), "comments");
    expect(strippedCount).toBe(1);
    expect(snapshotMutated.sheets?.s1?._comments).toEqual([]);
  });

  it("strips personalInfo (blanks creator/lastModifiedBy/authors)", () => {
    const { snapshotMutated, strippedCount } = stripCategory(fixture(), "personalInfo");
    expect(strippedCount).toBeGreaterThanOrEqual(2);
    expect(snapshotMutated.creator).toBe("");
    expect(snapshotMutated.lastModifiedBy).toBe("");
  });

  it("strips hiddenRowsCols (unsets hd flags)", () => {
    const { snapshotMutated, strippedCount } = stripCategory(fixture(), "hiddenRowsCols");
    expect(strippedCount).toBeGreaterThanOrEqual(1);
    expect(snapshotMutated.sheets?.s1?.rowData?.["5"]?.hd).toBeUndefined();
  });

  it("strips preservedParts", () => {
    const { snapshotMutated, strippedCount } = stripCategory(fixture(), "preservedParts");
    expect(strippedCount).toBeGreaterThanOrEqual(1);
    expect(snapshotMutated._preservedParts).toBeUndefined();
  });

  it("strips metadata (blanks creator + lastModifiedBy)", () => {
    const { snapshotMutated, strippedCount } = stripCategory(fixture(), "metadata");
    expect(strippedCount).toBeGreaterThanOrEqual(2);
    expect(snapshotMutated.creator).toBe("");
    expect(snapshotMutated.lastModifiedBy).toBe("");
  });

  it("snapshots category is a no-op", () => {
    const { strippedCount } = stripCategory(fixture(), "snapshots");
    expect(strippedCount).toBe(0);
  });

  it("does not mutate the original input snapshot", () => {
    const original = fixture();
    const before = JSON.stringify(original);
    stripCategory(original, "personalInfo");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("returns empty result for null input", () => {
    expect(stripCategory(null, "comments")).toEqual({
      snapshotMutated: {},
      strippedCount: 0,
    });
  });
});

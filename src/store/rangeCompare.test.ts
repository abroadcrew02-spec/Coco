import { describe, it, expect } from "vitest";
import {
  cellRefToA1,
  compareRanges,
  listSheets,
  parseQualifiedA1Range,
  resolveSheetIdByName,
  summarizeRangeCompare,
} from "./rangeCompare";

// Regression suite for rangeCompare.ts (389 lines, no tests).

describe("cellRefToA1", () => {
  it("emits A1 for (0,0)", () => expect(cellRefToA1(0, 0)).toBe("A1"));
  it("emits Z1 for (0,25)", () => expect(cellRefToA1(0, 25)).toBe("Z1"));
  it("emits AA1 for (0,26)", () => expect(cellRefToA1(0, 26)).toBe("AA1"));
  it("emits AAA1 for (0,702)", () => expect(cellRefToA1(0, 702)).toBe("AAA1"));
  it("emits B10 for (9,1)", () => expect(cellRefToA1(9, 1)).toBe("B10"));
  it("clamps negative input to A1", () => expect(cellRefToA1(-1, -1)).toBe("A1"));
});

describe("parseQualifiedA1Range", () => {
  it("parses a sheet-qualified range", () => {
    expect(parseQualifiedA1Range("Sheet1!A1:C3")).toEqual({
      sheetName: "Sheet1",
      r1: 0,
      c1: 0,
      r2: 2,
      c2: 2,
    });
  });

  it("parses a bare range", () => {
    expect(parseQualifiedA1Range("B2:D5")).toEqual({
      sheetName: undefined,
      r1: 1,
      c1: 1,
      r2: 4,
      c2: 3,
    });
  });

  it("parses a single-cell ref into a 1×1 range", () => {
    expect(parseQualifiedA1Range("Sheet1!C5")).toEqual({
      sheetName: "Sheet1",
      r1: 4,
      c1: 2,
      r2: 4,
      c2: 2,
    });
  });

  it("handles quoted sheet names with internal punctuation", () => {
    const r = parseQualifiedA1Range("'My Sheet (final)'!A1:B2");
    expect(r?.sheetName).toBe("My Sheet (final)");
  });

  it("normalises swapped corners", () => {
    const r = parseQualifiedA1Range("D10:A1");
    expect(r).toEqual({
      sheetName: undefined,
      r1: 0,
      c1: 0,
      r2: 9,
      c2: 3,
    });
  });

  it("returns null on malformed input", () => {
    expect(parseQualifiedA1Range("")).toBeNull();
    expect(parseQualifiedA1Range("garbage")).toBeNull();
    expect(parseQualifiedA1Range("Sheet1!")).toBeNull();
  });
});

const fixture = {
  sheetOrder: ["s1", "s2"],
  sheets: {
    s1: {
      name: "Sheet1",
      cellData: {
        "0": { "0": { v: 10 }, "1": { v: 20 } },
        "1": { "0": { v: 30 }, "1": { v: 40, f: "A2*2" } },
      },
    },
    s2: {
      name: "Sheet2",
      cellData: {
        "0": { "0": { v: 10 }, "1": { v: 999 } }, // value mismatch at (0,1)
        "1": { "0": { v: 30 }, "1": { v: 40, f: "A2+10" } }, // formula-only differ
      },
    },
  },
};

describe("compareRanges", () => {
  it("reports value-differ when cells have different values", () => {
    const diffs = compareRanges(
      fixture,
      { sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      { sheetId: "s2", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
    );
    const valueDiffs = diffs.filter((d) => d.kind === "value-differ");
    expect(valueDiffs).toHaveLength(1);
    expect(valueDiffs[0].positionLabel).toBe("(1, 2)");
    expect(valueDiffs[0].aCell?.value).toBe(20);
    expect(valueDiffs[0].bCell?.value).toBe(999);
  });

  it("reports formula-differ-value-same when formulas drift but values match", () => {
    const diffs = compareRanges(
      fixture,
      { sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      { sheetId: "s2", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
    );
    const formulaDiffs = diffs.filter((d) => d.kind === "formula-differ-value-same");
    expect(formulaDiffs).toHaveLength(1);
    expect(formulaDiffs[0].aCell?.formula).toBe("A2*2");
    expect(formulaDiffs[0].bCell?.formula).toBe("A2+10");
  });

  it("emits only-in-a / only-in-b for size mismatch", () => {
    const oneCell = {
      sheets: {
        s1: {
          name: "A",
          cellData: { "0": { "0": { v: 1 }, "1": { v: 2 } } },
        },
        s2: {
          name: "B",
          cellData: { "0": { "0": { v: 1 } } },
        },
      },
    };
    const diffs = compareRanges(
      oneCell,
      { sheetId: "s1", range: { r1: 0, c1: 0, r2: 0, c2: 1 } },
      { sheetId: "s2", range: { r1: 0, c1: 0, r2: 0, c2: 0 } },
    );
    const onlyA = diffs.filter((d) => d.kind === "only-in-a");
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].positionLabel).toBe("(1, 2)");
  });

  it("returns empty when both ranges are blank", () => {
    const empty = { sheets: { s1: { name: "A" }, s2: { name: "B" } } };
    const diffs = compareRanges(
      empty,
      { sheetId: "s1", range: { r1: 0, c1: 0, r2: 2, c2: 2 } },
      { sheetId: "s2", range: { r1: 0, c1: 0, r2: 2, c2: 2 } },
    );
    expect(diffs).toEqual([]);
  });

  it("returns empty on malformed input", () => {
    expect(compareRanges("not json", { sheetId: "s1", range: { r1: 0, c1: 0, r2: 0, c2: 0 } }, { sheetId: "s2", range: { r1: 0, c1: 0, r2: 0, c2: 0 } })).toEqual([]);
    expect(compareRanges(fixture, null as unknown as Parameters<typeof compareRanges>[1], { sheetId: "s2", range: { r1: 0, c1: 0, r2: 0, c2: 0 } })).toEqual([]);
  });
});

describe("summarizeRangeCompare", () => {
  it("rolls up counts per diff kind", () => {
    const diffs = compareRanges(
      fixture,
      { sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
      { sheetId: "s2", range: { r1: 0, c1: 0, r2: 1, c2: 1 } },
    );
    const summary = summarizeRangeCompare(diffs);
    expect(summary.total).toBe(diffs.length);
    expect(summary.valueDiffer).toBe(1);
    expect(summary.formulaOnly).toBe(1);
  });

  it("returns zeroed summary for empty diffs", () => {
    expect(summarizeRangeCompare([])).toEqual({
      total: 0,
      valueDiffer: 0,
      formulaOnly: 0,
      onlyA: 0,
      onlyB: 0,
    });
  });
});

describe("resolveSheetIdByName", () => {
  it("returns the sheet id for a known name", () => {
    expect(resolveSheetIdByName(fixture, "Sheet2")).toBe("s2");
  });

  it("returns null for unknown name", () => {
    expect(resolveSheetIdByName(fixture, "MissingSheet")).toBeNull();
  });

  it("tolerates malformed input", () => {
    expect(resolveSheetIdByName("garbage", "Sheet1")).toBeNull();
  });
});

describe("listSheets", () => {
  it("returns sheets in sheetOrder when present", () => {
    const list = listSheets(fixture);
    expect(list).toEqual([
      { sheetId: "s1", name: "Sheet1" },
      { sheetId: "s2", name: "Sheet2" },
    ]);
  });

  it("falls back to insertion order when sheetOrder is missing", () => {
    const list = listSheets({ sheets: { x: { name: "X" }, y: { name: "Y" } } });
    expect(list).toHaveLength(2);
  });

  it("returns empty for malformed input", () => {
    expect(listSheets("garbage")).toEqual([]);
    expect(listSheets({})).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { inferAutoSumRange, buildSumFormula, toA1 } from "./autoSum";

describe("inferAutoSumRange", () => {
  it("picks 5 numeric cells above, stops at the blank cell above that", () => {
    // Column A (col=0): row 0 = blank, rows 1..5 = numeric, row 6 = active cell
    // Expected: SUM range rows 1..5, col 0.
    const cellData: Record<string, Record<string, { v?: unknown }>> = {
      "1": { "0": { v: 10 } },
      "2": { "0": { v: 20 } },
      "3": { "0": { v: 30 } },
      "4": { "0": { v: 40 } },
      "5": { "0": { v: 50 } },
      // row 0 is intentionally absent → counts as blank, stops the scan.
    };
    const snap = JSON.stringify({ sheets: { s1: { cellData } } });
    const result = inferAutoSumRange(snap, "s1", 6, 0);
    expect(result).toEqual({
      startRow: 1,
      endRow: 5,
      startCol: 0,
      endCol: 0,
      direction: "above",
    });
  });

  it("falls back to scanning left when nothing is above", () => {
    // Row 3: cols 0..2 numeric, col 3 active. Nothing above col 3.
    const cellData: Record<string, Record<string, { v?: unknown }>> = {
      "3": { "0": { v: 1 }, "1": { v: 2 }, "2": { v: 3 } },
    };
    const snap = JSON.stringify({ sheets: { s1: { cellData } } });
    const result = inferAutoSumRange(snap, "s1", 3, 3);
    expect(result).toEqual({
      startRow: 3,
      endRow: 3,
      startCol: 0,
      endCol: 2,
      direction: "left",
    });
  });

  it("returns null when neither above nor left has numeric cells", () => {
    const cellData: Record<string, Record<string, { v?: unknown }>> = {
      "2": { "2": { v: "hello" } }, // string — not numeric
    };
    const snap = JSON.stringify({ sheets: { s1: { cellData } } });
    expect(inferAutoSumRange(snap, "s1", 2, 2)).toBeNull();
  });

  it("treats numeric-looking strings as numeric (Univer editor input)", () => {
    const cellData: Record<string, Record<string, { v?: unknown }>> = {
      "0": { "0": { v: "42" } },
      "1": { "0": { v: "3.14" } },
    };
    const snap = JSON.stringify({ sheets: { s1: { cellData } } });
    const result = inferAutoSumRange(snap, "s1", 2, 0);
    expect(result?.startRow).toBe(0);
    expect(result?.endRow).toBe(1);
    expect(result?.direction).toBe("above");
  });

  it("returns null for malformed snapshot or missing sheet", () => {
    expect(inferAutoSumRange("not json", "s1", 1, 1)).toBeNull();
    expect(inferAutoSumRange(JSON.stringify({ sheets: {} }), "s1", 1, 1)).toBeNull();
    expect(inferAutoSumRange(null, "s1", 1, 1)).toBeNull();
  });
});

describe("buildSumFormula + toA1", () => {
  it("builds =SUM(A1:A5) for a 5-row range in column A", () => {
    expect(
      buildSumFormula({
        startRow: 0,
        endRow: 4,
        startCol: 0,
        endCol: 0,
        direction: "above",
      }),
    ).toBe("=SUM(A1:A5)");
  });

  it("builds =SUM(A4:C4) for a 3-col left scan", () => {
    expect(
      buildSumFormula({
        startRow: 3,
        endRow: 3,
        startCol: 0,
        endCol: 2,
        direction: "left",
      }),
    ).toBe("=SUM(A4:C4)");
  });

  it("toA1 handles multi-letter columns", () => {
    expect(toA1(0, 0)).toBe("A1");
    expect(toA1(0, 25)).toBe("Z1");
    expect(toA1(0, 26)).toBe("AA1");
    expect(toA1(9, 27)).toBe("AB10");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  cellRefToA1,
  clearFormulaTraceCache,
  extractCellRefs,
  findDependents,
  findPrecedents,
  getSheetName,
} from "./formulaTrace";

// Regression suite for formulaTrace.ts (512 lines, no tests).

beforeEach(() => {
  clearFormulaTraceCache();
});

describe("cellRefToA1", () => {
  it("emits A1, AA1, AAA1 boundaries", () => {
    expect(cellRefToA1(0, 0)).toBe("A1");
    expect(cellRefToA1(0, 25)).toBe("Z1");
    expect(cellRefToA1(0, 26)).toBe("AA1");
    expect(cellRefToA1(0, 702)).toBe("AAA1");
  });

  it("clamps negative input to A1", () => {
    expect(cellRefToA1(-1, -1)).toBe("A1");
  });
});

describe("extractCellRefs", () => {
  it("returns empty for non-string / empty / non-formula input", () => {
    expect(extractCellRefs("")).toEqual([]);
    expect(extractCellRefs(null as unknown as string)).toEqual([]);
  });

  it("strips a leading '='", () => {
    const refs = extractCellRefs("=A1");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "cell", r1: 0, c1: 0 });
  });

  it("extracts a single bare cell ref", () => {
    const refs = extractCellRefs("A1");
    expect(refs[0]).toMatchObject({ kind: "cell", r1: 0, c1: 0 });
  });

  it("extracts a bare range", () => {
    const refs = extractCellRefs("A1:B10");
    expect(refs[0]).toMatchObject({ kind: "range", r1: 0, c1: 0, r2: 9, c2: 1 });
  });

  it("extracts sheet-qualified cell refs (bare sheet name)", () => {
    const refs = extractCellRefs("Sheet1!B2");
    expect(refs[0].sheet).toBe("Sheet1");
    expect(refs[0]).toMatchObject({ r1: 1, c1: 1 });
  });

  it("extracts sheet-qualified cell refs (quoted sheet name with spaces)", () => {
    const refs = extractCellRefs("'My Sheet'!B2");
    expect(refs[0].sheet).toBe("My Sheet");
  });

  it("ignores A1-looking substrings inside string literals", () => {
    const refs = extractCellRefs('=CONCATENATE("A1", B2)');
    // Only B2 should match, A1 is inside the string literal.
    const cellRefs = refs.filter((r) => r.kind === "cell");
    expect(cellRefs.map((r) => r.raw)).not.toContain("A1");
    expect(cellRefs.some((r) => r.r1 === 1 && r.c1 === 1)).toBe(true);
  });

  it("extracts multiple refs in a single formula", () => {
    const refs = extractCellRefs("=A1+B2+SUM(C1:C10)");
    const cells = refs.filter((r) => r.kind === "cell").length;
    const ranges = refs.filter((r) => r.kind === "range").length;
    expect(cells).toBeGreaterThanOrEqual(2);
    expect(ranges).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed-looking matches gracefully (no throw)", () => {
    expect(() => extractCellRefs("=SUM(A:AB:B)")).not.toThrow();
  });
});

describe("findPrecedents", () => {
  const snap = {
    sheetOrder: ["s1", "s2"],
    sheets: {
      s1: {
        name: "Data",
        cellData: {
          "0": {
            "0": { v: 10 },           // A1 = 10
            "1": { f: "=A1+B2" },     // B1 = A1+B2
            "2": { f: "=SUM(A1:A5)" }, // C1 = SUM(A1:A5)
          },
          "1": { "1": { v: 5 } },     // B2 = 5
        },
      },
      s2: {
        name: "Other",
        cellData: {
          "0": { "0": { f: "=Data!A1" } }, // Other!A1 references Data!A1
        },
      },
    },
  };

  it("returns precedents for a simple cell+cell formula", () => {
    const prec = findPrecedents(snap, "s1", 0, 1);
    const refs = prec.map((p) => p.cellRef);
    expect(refs).toContain("A1");
    expect(refs).toContain("B2");
  });

  it("returns the range syntax for range refs", () => {
    const prec = findPrecedents(snap, "s1", 0, 2);
    const refs = prec.map((p) => p.cellRef);
    expect(refs).toContain("A1:A5");
  });

  it("returns cross-sheet precedents", () => {
    const prec = findPrecedents(snap, "s2", 0, 0);
    expect(prec).toHaveLength(1);
    expect(prec[0].sheetId).toBe("s1");
    expect(prec[0].cellRef).toBe("A1");
  });

  it("returns [] for a cell without a formula", () => {
    expect(findPrecedents(snap, "s1", 0, 0)).toEqual([]);
  });

  it("returns [] for malformed input", () => {
    expect(findPrecedents(null, "s1", 0, 0)).toEqual([]);
    expect(findPrecedents({}, "s1", 0, 0)).toEqual([]);
    expect(findPrecedents(snap, "nonexistent", 0, 0)).toEqual([]);
  });
});

describe("findDependents", () => {
  const snap = {
    sheetOrder: ["s1"],
    sheets: {
      s1: {
        name: "Data",
        cellData: {
          "0": {
            "0": { v: 10 },          // A1 = 10
            "1": { f: "=A1+10" },    // B1 depends on A1
            "2": { f: "=SUM(A1:A5)" }, // C1 depends on A1 via range
          },
          "1": { "1": { f: "=B1*2" } }, // B2 depends on B1
        },
      },
    },
  };

  it("returns formulas that directly reference the target cell", () => {
    const deps = findDependents(snap, "s1", 0, 0); // who depends on A1?
    const refs = deps.map((d) => d.cellRef);
    expect(refs).toContain("B1");
    expect(refs).toContain("C1"); // via range
  });

  it("returns [] when no formulas reference the target", () => {
    expect(findDependents(snap, "s1", 0, 5)).toEqual([]);
  });

  it("returns [] for malformed input", () => {
    expect(findDependents(null, "s1", 0, 0)).toEqual([]);
    expect(findDependents({}, "s1", 0, 0)).toEqual([]);
  });

  it("caches the reverse index across calls with the same snapshot", () => {
    const a = findDependents(snap, "s1", 0, 0);
    const b = findDependents(snap, "s1", 0, 0);
    expect(b).toEqual(a);
  });
});

describe("getSheetName", () => {
  const snap = {
    sheetOrder: ["s1", "s2"],
    sheets: {
      s1: { name: "Data" },
      s2: { /* no name */ },
    },
  };

  it("returns the sheet's stored name", () => {
    expect(getSheetName(snap, "s1")).toBe("Data");
  });

  it("falls back to sheet id when name is missing", () => {
    expect(getSheetName(snap, "s2")).toBe("s2");
  });

  it("returns the requested id for unknown sheets", () => {
    expect(getSheetName(snap, "nonexistent")).toBe("nonexistent");
  });

  it("tolerates malformed input", () => {
    expect(getSheetName(null, "s1")).toBe("s1");
    expect(getSheetName({}, "s1")).toBe("s1");
  });
});

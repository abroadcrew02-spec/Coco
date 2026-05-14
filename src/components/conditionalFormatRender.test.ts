// Unit tests for the conditional-formatting render helpers (Phase 2).
// Verifies each evaluator independently plus the snapshot patcher's
// per-rule-type behavior, priority ordering, and immutability.

import { describe, it, expect } from "vitest";
import {
  patchCfRenders,
  parseSqrefToCells,
  evaluateCellIs,
  evaluateContainsText,
  evaluateTop10,
  evaluateDuplicate,
  evaluateUnique,
  DEFAULT_CF_STYLE,
} from "./conditionalFormatRender";

describe("parseSqrefToCells", () => {
  it("parses a single A1 ref", () => {
    expect(parseSqrefToCells("B2")).toEqual([{ row: 1, col: 1 }]);
  });

  it("parses a rectangular range", () => {
    expect(parseSqrefToCells("A1:B2")).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ]);
  });

  it("parses a space-separated mix", () => {
    const got = parseSqrefToCells("A1 C3:C4");
    expect(got).toEqual([
      { row: 0, col: 0 },
      { row: 2, col: 2 },
      { row: 3, col: 2 },
    ]);
  });

  it("ignores absolute markers", () => {
    expect(parseSqrefToCells("$A$1")).toEqual([{ row: 0, col: 0 }]);
  });

  it("returns [] on malformed input", () => {
    expect(parseSqrefToCells("foo")).toEqual([]);
    expect(parseSqrefToCells("")).toEqual([]);
  });
});

describe("evaluateCellIs", () => {
  it("greaterThan / lessThan", () => {
    expect(evaluateCellIs(50, "greaterThan", "10", undefined)).toBe(true);
    expect(evaluateCellIs(5, "greaterThan", "10", undefined)).toBe(false);
    expect(evaluateCellIs(5, "lessThan", "10", undefined)).toBe(true);
  });

  it("greaterThanOrEqual / lessThanOrEqual", () => {
    expect(evaluateCellIs(10, "greaterThanOrEqual", "10", undefined)).toBe(true);
    expect(evaluateCellIs(10, "lessThanOrEqual", "10", undefined)).toBe(true);
    expect(evaluateCellIs(11, "lessThanOrEqual", "10", undefined)).toBe(false);
  });

  it("equal / notEqual (numeric)", () => {
    expect(evaluateCellIs(7, "equal", "7", undefined)).toBe(true);
    expect(evaluateCellIs(7, "notEqual", "8", undefined)).toBe(true);
  });

  it("equal (string with quoted formula)", () => {
    expect(evaluateCellIs("apple", "equal", '"apple"', undefined)).toBe(true);
    expect(evaluateCellIs("apple", "equal", '"orange"', undefined)).toBe(false);
  });

  it("between / notBetween", () => {
    expect(evaluateCellIs(5, "between", "1", "10")).toBe(true);
    expect(evaluateCellIs(15, "between", "1", "10")).toBe(false);
    expect(evaluateCellIs(15, "notBetween", "1", "10")).toBe(true);
  });

  it("returns false for non-numeric value vs numeric operator", () => {
    expect(evaluateCellIs("hello", "greaterThan", "10", undefined)).toBe(false);
  });

  it("returns false when formula is unparseable (e.g. cell reference)", () => {
    expect(evaluateCellIs(50, "greaterThan", "=A1", undefined)).toBe(false);
  });

  it("returns false for unknown operator", () => {
    expect(evaluateCellIs(50, "bogusOp", "10", undefined)).toBe(false);
  });
});

describe("evaluateContainsText", () => {
  it("matches a substring case-insensitively", () => {
    expect(evaluateContainsText("Error: bad input", "error")).toBe(true);
    expect(evaluateContainsText("OK", "error")).toBe(false);
  });

  it("treats undefined / empty inputs as false", () => {
    expect(evaluateContainsText(undefined, "x")).toBe(false);
    expect(evaluateContainsText("anything", "")).toBe(false);
  });

  it("coerces numeric cell values to string for matching", () => {
    expect(evaluateContainsText(12345, "23")).toBe(true);
  });
});

describe("evaluateTop10", () => {
  it("returns the top N numeric values", () => {
    const got = evaluateTop10([1, 5, 9, 3, 8], 2, false, false);
    expect(got.has(9)).toBe(true);
    expect(got.has(8)).toBe(true);
    expect(got.has(5)).toBe(false);
  });

  it("returns the bottom N when `bottom=true`", () => {
    const got = evaluateTop10([1, 5, 9, 3, 8], 2, false, true);
    expect(got.has(1)).toBe(true);
    expect(got.has(3)).toBe(true);
    expect(got.has(5)).toBe(false);
  });

  it("treats percent=true as a percentage of the populated count", () => {
    // 50% of 4 values rounds up to 2.
    const got = evaluateTop10([10, 20, 30, 40], 50, true, false);
    expect(got.has(40)).toBe(true);
    expect(got.has(30)).toBe(true);
    expect(got.size).toBe(2);
  });

  it("ignores non-numeric values when ranking", () => {
    const got = evaluateTop10([1, "abc", 9, null, 5], 1, false, false);
    expect(got.has(9)).toBe(true);
    expect(got.size).toBe(1);
  });

  it("returns empty set when the range has no numeric values", () => {
    expect(evaluateTop10(["a", "b"], 3, false, false).size).toBe(0);
  });
});

describe("evaluateDuplicate / evaluateUnique", () => {
  it("flags repeated values as duplicate", () => {
    expect(evaluateDuplicate(["a", "b", "a"], "a")).toBe(true);
    expect(evaluateDuplicate(["a", "b", "c"], "a")).toBe(false);
  });

  it("flags singletons as unique", () => {
    expect(evaluateUnique(["a", "b", "c"], "a")).toBe(true);
    expect(evaluateUnique(["a", "b", "a"], "a")).toBe(false);
  });

  it("ignores blank cells when counting", () => {
    expect(evaluateDuplicate(["a", "", "a"], "a")).toBe(true);
    expect(evaluateUnique(["a", "", ""], "a")).toBe(true);
  });
});

describe("patchCfRenders", () => {
  it("returns input unchanged when there are no rules", () => {
    const snap = {
      sheets: { s1: { cellData: { "0": { "0": { v: 1 } } } } },
    };
    const out = patchCfRenders(snap) as typeof snap;
    expect(out.sheets.s1.cellData).toEqual({ "0": { "0": { v: 1 } } });
  });

  it("highlights cellIs greaterThan matches with the default style", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 5 } },
            "1": { "0": { v: 50 } },
          },
          _conditionalFormatting: [
            {
              sqref: "A1:A2",
              type: "cellIs",
              operator: "greaterThan",
              formula1: "10",
              priority: 1,
            },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: Record<string, unknown> }>> } };
    };
    // A2 (50) matches, A1 (5) does not.
    expect(out.sheets.s1.cellData["1"]["0"].s).toEqual({
      bg: { rgb: DEFAULT_CF_STYLE.bg.rgb },
      bl: 1,
    });
    expect(out.sheets.s1.cellData["0"]["0"].s).toBeUndefined();
  });

  it("uses the rule's custom style when provided", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: 100 } } },
          _conditionalFormatting: [
            {
              sqref: "A1",
              type: "cellIs",
              operator: "greaterThan",
              formula1: "0",
              priority: 1,
              style: { bold: true, fontColor: "#ff0000", bgColor: "#ffff00" },
            },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: Record<string, unknown> }>> } };
    };
    expect(out.sheets.s1.cellData["0"]["0"].s).toEqual({
      bl: 1,
      cl: { rgb: "#ff0000" },
      bg: { rgb: "#ffff00" },
    });
  });

  it("applies containsText rules", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: "ok" } },
            "1": { "0": { v: "ERROR: db down" } },
          },
          _conditionalFormatting: [
            { sqref: "A1:A2", type: "containsText", text: "error", priority: 1 },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: unknown }>> } };
    };
    expect(out.sheets.s1.cellData["1"]["0"].s).toBeDefined();
    expect(out.sheets.s1.cellData["0"]["0"].s).toBeUndefined();
  });

  it("applies top10 rules over a range", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 1 } },
            "1": { "0": { v: 5 } },
            "2": { "0": { v: 9 } },
            "3": { "0": { v: 8 } },
          },
          _conditionalFormatting: [
            { sqref: "A1:A4", type: "top10", rank: 2, priority: 1 },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: unknown }>> } };
    };
    // Top 2 are 9 (row 2) and 8 (row 3).
    expect(out.sheets.s1.cellData["2"]["0"].s).toBeDefined();
    expect(out.sheets.s1.cellData["3"]["0"].s).toBeDefined();
    expect(out.sheets.s1.cellData["1"]["0"].s).toBeUndefined();
    expect(out.sheets.s1.cellData["0"]["0"].s).toBeUndefined();
  });

  it("applies duplicate-values rules", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: "a" } },
            "1": { "0": { v: "b" } },
            "2": { "0": { v: "a" } },
          },
          _conditionalFormatting: [
            { sqref: "A1:A3", type: "duplicateValues", priority: 1 },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: unknown }>> } };
    };
    expect(out.sheets.s1.cellData["0"]["0"].s).toBeDefined();
    expect(out.sheets.s1.cellData["2"]["0"].s).toBeDefined();
    expect(out.sheets.s1.cellData["1"]["0"].s).toBeUndefined();
  });

  it("applies unique-values rules", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: "a" } },
            "1": { "0": { v: "b" } },
            "2": { "0": { v: "a" } },
          },
          _conditionalFormatting: [
            { sqref: "A1:A3", type: "uniqueValues", priority: 1 },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: unknown }>> } };
    };
    expect(out.sheets.s1.cellData["1"]["0"].s).toBeDefined();
    expect(out.sheets.s1.cellData["0"]["0"].s).toBeUndefined();
  });

  it("respects priority: lower priority wins for overlapping rules", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: 100 } } },
          _conditionalFormatting: [
            // Lower priority number = wins. Rule A (red, priority 1) should
            // override rule B (green, priority 2) on the shared cell.
            {
              sqref: "A1",
              type: "cellIs",
              operator: "greaterThan",
              formula1: "0",
              priority: 1,
              style: { bgColor: "#ff0000" },
            },
            {
              sqref: "A1",
              type: "cellIs",
              operator: "greaterThan",
              formula1: "0",
              priority: 2,
              style: { bgColor: "#00ff00" },
            },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: Record<string, unknown> }>> } };
    };
    const bg = out.sheets.s1.cellData["0"]["0"].s?.bg as { rgb: string } | undefined;
    expect(bg?.rgb).toBe("#ff0000");
  });

  it("preserves existing inline styles", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: 100, s: { ff: "Arial" } } } },
          _conditionalFormatting: [
            {
              sqref: "A1",
              type: "cellIs",
              operator: "greaterThan",
              formula1: "0",
              priority: 1,
            },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: Record<string, unknown> }>> } };
    };
    const s = out.sheets.s1.cellData["0"]["0"].s;
    expect(s?.ff).toBe("Arial");
    expect(s?.bl).toBe(1);
  });

  it("does not mutate the input snapshot", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: 100 } } },
          _conditionalFormatting: [
            {
              sqref: "A1",
              type: "cellIs",
              operator: "greaterThan",
              formula1: "0",
              priority: 1,
            },
          ],
        },
      },
    };
    const before = JSON.stringify(snap);
    patchCfRenders(snap);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it("skips rules with unparseable sqref", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: 100 } } },
          _conditionalFormatting: [
            { sqref: "garbage", type: "cellIs", operator: "greaterThan", formula1: "0", priority: 1 },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: unknown }>> } };
    };
    expect(out.sheets.s1.cellData["0"]["0"].s).toBeUndefined();
  });
});

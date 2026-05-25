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
  evaluateDataBar,
  evaluateColorScale,
  evaluateIconSet,
  evaluateExpression,
  computeCfRepaint,
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

// ---------------------------------------------------------------------------
// Audit-requested coverage: the four advanced evaluators previously had no
// unit-level tests (only behavior verified indirectly through ad-hoc rendering).

describe("evaluateDataBar", () => {
  it("returns the base color (max lightness drop) at fillRatio=1", () => {
    // fillRatio 1 → lightness 40. fillRatio 0 → lightness 100 (near-white).
    const dark = evaluateDataBar("#638EC6", 1);
    const light = evaluateDataBar("#638EC6", 0);
    expect(dark).not.toBe(light);
    // Both must be valid hex.
    expect(dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(light).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("clamps out-of-range fillRatios", () => {
    expect(evaluateDataBar("#638EC6", -5)).toBe(evaluateDataBar("#638EC6", 0));
    expect(evaluateDataBar("#638EC6", 5)).toBe(evaluateDataBar("#638EC6", 1));
  });

  it("falls back to a sensible default when the hex is malformed", () => {
    expect(evaluateDataBar("not-a-color", 0.5)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("evaluateColorScale", () => {
  it("interpolates 2-color scale endpoints", () => {
    const lo = evaluateColorScale(0, "2color", 0, 10, 5, "#ff0000", "#ffffff", "#00ff00");
    const hi = evaluateColorScale(10, "2color", 0, 10, 5, "#ff0000", "#ffffff", "#00ff00");
    expect(lo?.toLowerCase()).toBe("#ff0000");
    expect(hi?.toLowerCase()).toBe("#00ff00");
  });

  it("interpolates 3-color scale at the median", () => {
    const mid = evaluateColorScale(5, "3color", 0, 10, 5, "#ff0000", "#00ff00", "#0000ff");
    expect(mid?.toLowerCase()).toBe("#00ff00");
  });

  it("returns null for non-numeric values", () => {
    expect(
      evaluateColorScale("abc", "2color", 0, 10, 5, "#ff0000", "#ffffff", "#00ff00"),
    ).toBeNull();
  });

  it("returns minColor when min==max (degenerate range)", () => {
    expect(
      evaluateColorScale(5, "2color", 5, 5, 5, "#ff0000", "#ffffff", "#00ff00")?.toLowerCase(),
    ).toBe("#ff0000");
  });
});

describe("evaluateIconSet", () => {
  it("returns the lowest-bucket glyph for the min value", () => {
    expect(evaluateIconSet(0, "3arrows", 0, 10)).toBe("↓");
  });

  it("returns the highest-bucket glyph for the max value", () => {
    expect(evaluateIconSet(10, "3arrows", 0, 10)).toBe("↑");
  });

  it("buckets midrange values", () => {
    // 3arrows: 3 buckets → idx = floor((5-0)/10 * 3) = floor(1.5) = 1 → "→".
    expect(evaluateIconSet(5, "3arrows", 0, 10)).toBe("→");
  });

  it("returns '' for non-numeric values", () => {
    expect(evaluateIconSet("abc", "3arrows", 0, 10)).toBe("");
  });

  it("falls back to 3arrows for an unknown iconStyle", () => {
    expect(evaluateIconSet(10, "nonexistent", 0, 10)).toBe("↑");
  });

  it("uses the 5-glyph bucket count for 5rating", () => {
    expect(evaluateIconSet(0, "5rating", 0, 10)).toBe("★☆☆☆☆");
    expect(evaluateIconSet(10, "5rating", 0, 10)).toBe("★★★★★");
  });
});

describe("evaluateExpression", () => {
  const ctx = {
    cellData: {
      "0": { "0": { v: 5 }, "1": { v: 10 } },
    },
    anchorRow: 0,
    anchorCol: 0,
    curRow: 0,
    curCol: 0,
  };

  it("evaluates a simple numeric comparison against a relative ref", () => {
    expect(evaluateExpression("=A1>3", ctx)).toBe(true);
    expect(evaluateExpression("=A1>10", ctx)).toBe(false);
  });

  it("supports ISBLANK / ISNUMBER / ISTEXT", () => {
    const blankCtx = {
      cellData: { "0": { "0": {} } },
      anchorRow: 0,
      anchorCol: 0,
      curRow: 0,
      curCol: 0,
    };
    expect(evaluateExpression("=ISBLANK(A1)", blankCtx)).toBe(true);
    expect(evaluateExpression("=ISNUMBER(A1)", ctx)).toBe(true);
  });

  it("returns false on malformed input (fail-closed)", () => {
    expect(evaluateExpression("not a formula", ctx)).toBe(false);
    expect(evaluateExpression(undefined, ctx)).toBe(false);
    expect(evaluateExpression("", ctx)).toBe(false);
  });

  it("supports MOD for striped highlighting (=MOD(ROW(),2)=0)", () => {
    // ROW() is 1-based; on row index 0 → ROW()=1 → MOD=1 → !=0 → false.
    // On row index 1 → ROW()=2 → MOD=0 → ==0 → true.
    const ctxR0 = { ...ctx, curRow: 0 };
    const ctxR1 = { ...ctx, curRow: 1 };
    expect(evaluateExpression("=MOD(ROW(),2)=0", ctxR0)).toBe(false);
    expect(evaluateExpression("=MOD(ROW(),2)=0", ctxR1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// patchCfRenders integration coverage for the advanced rule types.

describe("patchCfRenders — advanced rules", () => {
  it("dataBar paints a background on numeric cells, skips text", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 10 } },
            "1": { "0": { v: 50 } },
            "2": { "0": { v: "abc" } },
          },
          _conditionalFormatting: [
            { sqref: "A1:A3", type: "dataBar", color: "#638EC6", priority: 1 },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: Record<string, unknown> }>> } };
    };
    const r0 = out.sheets.s1.cellData["0"]["0"].s?.bg as { rgb?: string } | undefined;
    const r1 = out.sheets.s1.cellData["1"]["0"].s?.bg as { rgb?: string } | undefined;
    expect(r0?.rgb).toMatch(/^#[0-9a-f]{6}$/i);
    expect(r1?.rgb).toMatch(/^#[0-9a-f]{6}$/i);
    expect(out.sheets.s1.cellData["2"]["0"].s).toBeUndefined();
  });

  it("colorScale paints interpolated backgrounds", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 0 } },
            "1": { "0": { v: 10 } },
          },
          _conditionalFormatting: [
            {
              sqref: "A1:A2",
              type: "colorScale",
              colorScaleType: "2color" as const,
              minColor: "#ff0000",
              maxColor: "#00ff00",
              priority: 1,
            },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: Record<string, unknown> }>> } };
    };
    const r0 = out.sheets.s1.cellData["0"]["0"].s?.bg as { rgb?: string } | undefined;
    const r1 = out.sheets.s1.cellData["1"]["0"].s?.bg as { rgb?: string } | undefined;
    expect(r0?.rgb?.toLowerCase()).toBe("#ff0000");
    expect(r1?.rgb?.toLowerCase()).toBe("#00ff00");
  });

  it("iconSet prefixes the cell value with the chosen glyph", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 0 } },
            "1": { "0": { v: 10 } },
          },
          _conditionalFormatting: [
            { sqref: "A1:A2", type: "iconSet", iconStyle: "3arrows" as const, priority: 1 },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as unknown as {
      sheets: { s1: { cellData: Record<string, Record<string, { v?: string }>> } };
    };
    expect(out.sheets.s1.cellData["0"]["0"].v).toBe("↓ 0");
    expect(out.sheets.s1.cellData["1"]["0"].v).toBe("↑ 10");
  });

  it("expression rule styles only cells that satisfy the formula", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 5 } },
            "1": { "0": { v: 15 } },
          },
          _conditionalFormatting: [
            {
              sqref: "A1:A2",
              type: "expression",
              formula1: "=A1>10",
              priority: 1,
              style: { bgColor: "#ffff00" },
            },
          ],
        },
      },
    };
    const out = patchCfRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { s?: Record<string, unknown> }>> } };
    };
    // Row 0 (value 5) fails; Row 1 (value 15) passes.
    expect(out.sheets.s1.cellData["0"]["0"].s).toBeUndefined();
    const bg = out.sheets.s1.cellData["1"]["0"].s?.bg as { rgb?: string } | undefined;
    expect(bg?.rgb?.toLowerCase()).toBe("#ffff00");
  });
});

// ---------------------------------------------------------------------------
// computeCfRepaint — the new "live in-session re-paint" helper. Verifies the
// four edge cases the EditorScreen.applyCfRules fix needs to handle: add,
// modify, remove, range-shrink.

describe("computeCfRepaint", () => {
  const buildSnap = (rules: unknown[]) =>
    JSON.stringify({
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 5 }, "1": { v: 20 } },
            "1": { "0": { v: 50 }, "1": { v: 100 } },
          },
          _conditionalFormatting: rules,
        },
      },
    });

  it("rule added: emits actions for the new sqref's cells", () => {
    const nextJson = buildSnap([
      {
        sqref: "A1:A2",
        type: "cellIs",
        operator: "greaterThan",
        formula1: "10",
        priority: 1,
        style: { bgColor: "#ffff00" },
      },
    ]);
    const actions = computeCfRepaint(nextJson, "s1", []);
    // A2 (50) matches greaterThan 10 → set bg. A1 (5) does not match → no action.
    const a2 = actions.find((a) => a.row === 1 && a.col === 0);
    expect(a2?.set.bg?.toLowerCase()).toBe("#ffff00");
    expect(actions.find((a) => a.row === 0 && a.col === 0)).toBeUndefined();
  });

  it("rule modified: switches the bg color to the new style", () => {
    const prevRules = [
      {
        sqref: "A1:A2",
        type: "cellIs",
        operator: "greaterThan",
        formula1: "10",
        priority: 1,
        style: { bgColor: "#ff0000" },
      },
    ];
    const nextRules = [
      {
        sqref: "A1:A2",
        type: "cellIs",
        operator: "greaterThan",
        formula1: "10",
        priority: 1,
        style: { bgColor: "#00ff00" },
      },
    ];
    const nextJson = buildSnap(nextRules);
    const actions = computeCfRepaint(nextJson, "s1", prevRules);
    const a2 = actions.find((a) => a.row === 1 && a.col === 0);
    expect(a2?.set.bg?.toLowerCase()).toBe("#00ff00");
  });

  it("rule removed: emits a clear action for cells that no longer match", () => {
    const prevRules = [
      {
        sqref: "A1:A2",
        type: "cellIs",
        operator: "greaterThan",
        formula1: "10",
        priority: 1,
        style: { bgColor: "#ff0000" },
      },
    ];
    const nextJson = buildSnap([]);
    const actions = computeCfRepaint(nextJson, "s1", prevRules);
    const a2 = actions.find((a) => a.row === 1 && a.col === 0);
    // Previously matched; now no rule → must revert.
    expect(a2).toBeDefined();
    expect("bg" in (a2?.clear ?? {})).toBe(true);
  });

  it("range shrunk: reverts cells dropped from the sqref", () => {
    const prevRules = [
      {
        sqref: "A1:B2",
        type: "cellIs",
        operator: "greaterThan",
        formula1: "10",
        priority: 1,
        style: { bgColor: "#ff0000" },
      },
    ];
    // Shrink to A1:A2 only — B1 (20) and B2 (100) previously matched and now
    // must revert.
    const nextRules = [
      {
        sqref: "A1:A2",
        type: "cellIs",
        operator: "greaterThan",
        formula1: "10",
        priority: 1,
        style: { bgColor: "#ff0000" },
      },
    ];
    const nextJson = buildSnap(nextRules);
    const actions = computeCfRepaint(nextJson, "s1", prevRules);
    // B1 (row 0, col 1): value 20 previously matched → now outside sqref →
    // must clear. B2 (row 1, col 1): same.
    const b1 = actions.find((a) => a.row === 0 && a.col === 1);
    const b2 = actions.find((a) => a.row === 1 && a.col === 1);
    expect(b1).toBeDefined();
    expect("bg" in (b1?.clear ?? {})).toBe(true);
    expect(b2).toBeDefined();
    expect("bg" in (b2?.clear ?? {})).toBe(true);
    // A2 (row 1, col 0): still matches → stays painted, no action needed
    // because the PREV style equals the AFTER style.
    expect(actions.find((a) => a.row === 1 && a.col === 0)).toBeUndefined();
  });

  it("emits no actions when prev and next render identically", () => {
    const rules = [
      {
        sqref: "A1:A2",
        type: "cellIs",
        operator: "greaterThan",
        formula1: "10",
        priority: 1,
        style: { bgColor: "#ff0000" },
      },
    ];
    const nextJson = buildSnap(rules);
    expect(computeCfRepaint(nextJson, "s1", rules)).toEqual([]);
  });

  it("iconSet rule add: emits a value action to prefix the glyph", () => {
    const nextJson = buildSnap([
      { sqref: "A1:A2", type: "iconSet", iconStyle: "3arrows", priority: 1 },
    ]);
    const actions = computeCfRepaint(nextJson, "s1", []);
    const a1 = actions.find((a) => a.row === 0 && a.col === 0);
    const a2 = actions.find((a) => a.row === 1 && a.col === 0);
    // Both cells gain a glyph prefix (range = A1(5), A2(50)). With min=5 max=50:
    // - A1 = lowest bucket → "↓ 5"; A2 = highest → "↑ 50".
    expect(a1?.value).toBe("↓ 5");
    expect(a2?.value).toBe("↑ 50");
  });

  it("returns [] when the sheet doesn't exist", () => {
    const nextJson = buildSnap([]);
    expect(computeCfRepaint(nextJson, "nonexistent", [])).toEqual([]);
  });

  it("returns [] on malformed JSON", () => {
    expect(computeCfRepaint("not json", "s1", [])).toEqual([]);
  });
});

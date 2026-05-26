import { describe, it, expect } from "vitest";
import { batchCfPlan, rectToA1 } from "./cfRangeBatch";
import type { CfPlanEntry } from "./cfApplyPlan";

// #241 Step 3 — range batching tests.

function entry(
  row: number,
  col: number,
  style: { bg?: string; cl?: string },
  action: "paint" | "clear" | "noop" = "paint",
): CfPlanEntry {
  return {
    sheetId: "s1",
    row,
    col,
    action,
    finalStyle: style,
    ruleIds: [],
  };
}

describe("batchCfPlan", () => {
  it("returns empty for empty plan", () => {
    expect(batchCfPlan([])).toEqual([]);
  });

  it("skips noop entries", () => {
    expect(batchCfPlan([entry(0, 0, { bg: "#F" }, "noop")])).toEqual([]);
  });

  it("collapses a single contiguous row into one batch", () => {
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#F" }),
      entry(0, 1, { bg: "#F" }),
      entry(0, 2, { bg: "#F" }),
    ];
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(1);
    expect(out[0].rect).toEqual({ r1: 0, c1: 0, r2: 0, c2: 2 });
    expect(out[0].style.bg).toBe("#F");
  });

  it("collapses a single contiguous column into one batch", () => {
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#F" }),
      entry(1, 0, { bg: "#F" }),
      entry(2, 0, { bg: "#F" }),
    ];
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(1);
    expect(out[0].rect).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
  });

  it("collapses a full 3×3 block into one batch", () => {
    const plan: CfPlanEntry[] = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) plan.push(entry(r, c, { bg: "#F" }));
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(1);
    expect(out[0].rect).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
  });

  it("splits L-shape into 2 rectangles (greedy cover)", () => {
    // L: 3 cells in row 0 + 2 cells in row 1 col 0
    //   X X X
    //   X .
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#F" }),
      entry(0, 1, { bg: "#F" }),
      entry(0, 2, { bg: "#F" }),
      entry(1, 0, { bg: "#F" }),
    ];
    const out = batchCfPlan(plan);
    // Greedy: find 1×3 at (0,0), then 1×1 at (1,0). 2 rects.
    expect(out).toHaveLength(2);
    expect(out[0].rect).toEqual({ r1: 0, c1: 0, r2: 0, c2: 2 });
    expect(out[1].rect).toEqual({ r1: 1, c1: 0, r2: 1, c2: 0 });
  });

  it("separates buckets by style", () => {
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#RED" }),
      entry(0, 1, { bg: "#BLUE" }),
    ];
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(2);
    const reds = out.filter((b) => b.style.bg === "#RED");
    const blues = out.filter((b) => b.style.bg === "#BLUE");
    expect(reds).toHaveLength(1);
    expect(blues).toHaveLength(1);
  });

  it("separates buckets by action", () => {
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#F" }, "paint"),
      entry(0, 1, { bg: "#F" }, "clear"),
    ];
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(2);
    const paints = out.filter((b) => b.action === "paint");
    const clears = out.filter((b) => b.action === "clear");
    expect(paints).toHaveLength(1);
    expect(clears).toHaveLength(1);
  });

  it("separates buckets by sheetId", () => {
    const plan: CfPlanEntry[] = [
      { ...entry(0, 0, { bg: "#F" }), sheetId: "s1" },
      { ...entry(0, 0, { bg: "#F" }), sheetId: "s2" },
    ];
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(2);
  });

  it("treats styles with different keys as separate buckets", () => {
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#F" }),
      entry(0, 1, { bg: "#F", cl: "#000" }),
    ];
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(2);
  });

  it("handles sparse cells (each gets its own rect)", () => {
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#F" }),
      entry(0, 2, { bg: "#F" }),
      entry(2, 0, { bg: "#F" }),
    ];
    const out = batchCfPlan(plan);
    // Greedy will cover with 3 1×1 rects (no rectangle fits >1 cell).
    expect(out).toHaveLength(3);
  });

  it("expands rectangle width before height", () => {
    // Shape: 2 cols × 3 rows
    //   X X
    //   X X
    //   X X
    const plan: CfPlanEntry[] = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 2; c++) plan.push(entry(r, c, { bg: "#F" }));
    const out = batchCfPlan(plan);
    expect(out).toHaveLength(1);
    expect(out[0].rect).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
  });

  it("doesn't merge rectangles that would create a non-rectangular shape", () => {
    // Shape:
    //   X X
    //   . X
    //   X X
    const plan: CfPlanEntry[] = [
      entry(0, 0, { bg: "#F" }),
      entry(0, 1, { bg: "#F" }),
      entry(1, 1, { bg: "#F" }),
      entry(2, 0, { bg: "#F" }),
      entry(2, 1, { bg: "#F" }),
    ];
    const out = batchCfPlan(plan);
    // Must NOT be a single 3×2 (would include the empty cell (1,0))
    // Greedy: row 0 → (0,0,0,1); row 1 col 1 → (1,1,1,1); row 2 → (2,0,2,1)
    expect(out.length).toBeGreaterThanOrEqual(3);
    // Every input cell must be covered exactly once.
    const coveredCells = new Set<string>();
    for (const b of out) {
      for (let r = b.rect.r1; r <= b.rect.r2; r++) {
        for (let c = b.rect.c1; c <= b.rect.c2; c++) {
          const key = `${r}:${c}`;
          expect(coveredCells.has(key)).toBe(false); // no double-cover
          coveredCells.add(key);
        }
      }
    }
    expect(coveredCells.size).toBe(5);
    expect(coveredCells.has("1:0")).toBe(false); // empty cell stays empty
  });
});

describe("rectToA1", () => {
  it("converts (0,0,0,0) to A1:A1", () => {
    expect(rectToA1({ r1: 0, c1: 0, r2: 0, c2: 0 })).toBe("A1:A1");
  });

  it("converts (0,0,9,4) to A1:E10", () => {
    expect(rectToA1({ r1: 0, c1: 0, r2: 9, c2: 4 })).toBe("A1:E10");
  });

  it("handles AA-column boundary", () => {
    expect(rectToA1({ r1: 0, c1: 26, r2: 0, c2: 27 })).toBe("AA1:AB1");
  });
});

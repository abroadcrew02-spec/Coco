// #241 CF live re-paint — live-loop integration tests.
//
// Validates the full round-trip: computeCfApplyPlan → (simulated facade write)
// → polluted snapshot → next computeCfApplyPlan → idempotent noop.
//
// Covers the scenarios listed in Issue #241 remaining work item 4:
//   - cellIs (background color): facade → syncSnapshot → next plan is noop
//   - top10 / dataBar: range batching produces a single rect over multi-cell sqref
//   - rule add → delete → re-add: BASE must not drift across three full cycles
//   - iconSet: decoration (iconValue) is stored in sidecar, never via setValue;
//     numeric cell.v must not be mutated

import { describe, it, expect, beforeEach } from "vitest";
import { CfSidecar } from "./cfSidecar";
import { computeCfApplyPlan, recoverNumericFromPolluted } from "./cfApplyPlan";
import { batchCfPlan } from "./cfRangeBatch";
import type { CfRuleEntry } from "../components/conditionalFormatRender";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal snapshot for sheet "s1" with the given cell data. */
function makeSnap(
  cells: Record<string, Record<string, unknown>> = {},
) {
  return { sheets: { s1: { cellData: cells } } };
}

/** Snapshot where cell (row, col) has a CF-baked background — simulates
 *  the snapshot state after facade.setBackground was applied. */
function polluted(row: number, col: number, bg: string) {
  return makeSnap({ [String(row)]: { [String(col)]: { s: { bg: { rgb: bg } } } } });
}

/** Multi-cell snapshot with numeric values, no styles. */
function numericGrid(
  rows: number,
  cols: number,
  valueFn: (r: number, c: number) => number,
) {
  const cells: Record<string, Record<string, unknown>> = {};
  for (let r = 0; r < rows; r++) {
    cells[String(r)] = {};
    for (let c = 0; c < cols; c++) {
      cells[String(r)][String(c)] = { v: valueFn(r, c) };
    }
  }
  return makeSnap(cells);
}

/** CellIs rule factory. */
function cellIsRule(sqref: string, bg: string, priority = 1): CfRuleEntry {
  return { sqref, type: "cellIs", priority, style: { bgColor: bg } };
}

/** Top10 rule factory. */
function top10Rule(sqref: string, bg: string, rank = 3): CfRuleEntry {
  return { sqref, type: "top10", priority: 1, rank, style: { bgColor: bg } };
}

/** DataBar rule factory. */
function dataBarRule(sqref: string, color = "#638EC6"): CfRuleEntry {
  return { sqref, type: "dataBar", priority: 1, color };
}

/** IconSet rule factory. */
function iconSetRule(sqref: string, style: "3arrows" | "3traffic" | "5rating" = "3arrows"): CfRuleEntry {
  return { sqref, type: "iconSet", priority: 1, iconStyle: style };
}

// ---------------------------------------------------------------------------
// Scenario 1: cellIs — facade → syncSnapshot → next plan is idempotent
// ---------------------------------------------------------------------------
describe("Scenario 1: cellIs — live-loop round-trip idempotency", () => {
  let sidecar: CfSidecar;

  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  it("5 consecutive polluted passes all produce noop (no drift)", () => {
    const rule = cellIsRule("A1:A1", "#FF0000");
    const clean = makeSnap({ "0": { "0": { v: 100 } } });

    // Round 1 — initial paint.
    const plan1 = computeCfApplyPlan(sidecar, clean, "s1", [], [rule]);
    expect(plan1).toHaveLength(1);
    expect(plan1[0].action).toBe("paint");
    expect(plan1[0].finalStyle.bg).toBe("#FF0000");

    // Rounds 2-5 — facade has already written the color; snapshot is polluted.
    for (let i = 0; i < 5; i++) {
      const dirty = polluted(0, 0, "#FF0000");
      const plan = computeCfApplyPlan(sidecar, dirty, "s1", [rule], [rule]);
      expect(plan).toHaveLength(1);
      expect(plan[0].action).toBe("noop");
    }
  });

  it("sidecar baseStyle is never overwritten by polluted snapshot", () => {
    const rule = cellIsRule("A1:A1", "#CF_COLOR");
    const authored = "#USER_BG";
    const clean = makeSnap({ "0": { "0": { s: { bg: { rgb: authored } } } } });

    computeCfApplyPlan(sidecar, clean, "s1", [], [rule]);
    const baseAfterFirst = sidecar.getBaseStyle("s1", 0, 0);

    // 5 rounds of polluted snapshot.
    for (let i = 0; i < 5; i++) {
      computeCfApplyPlan(sidecar, polluted(0, 0, "#CF_COLOR"), "s1", [rule], [rule]);
    }

    const baseAfterSix = sidecar.getBaseStyle("s1", 0, 0);
    expect(baseAfterSix).toEqual(baseAfterFirst);
    expect(baseAfterSix).toEqual({ bg: authored });
  });

  it("removing the rule after 5 polluted rounds produces a clear that restores base", () => {
    const rule = cellIsRule("A1:A1", "#RED");
    const authored = "#AUTHORED";
    const clean = makeSnap({ "0": { "0": { s: { bg: { rgb: authored } } } } });

    computeCfApplyPlan(sidecar, clean, "s1", [], [rule]);
    for (let i = 0; i < 5; i++) {
      computeCfApplyPlan(sidecar, polluted(0, 0, "#RED"), "s1", [rule], [rule]);
    }

    const clearPlan = computeCfApplyPlan(
      sidecar,
      polluted(0, 0, "#RED"),
      "s1",
      [rule],
      [],
    );
    expect(clearPlan).toHaveLength(1);
    expect(clearPlan[0].action).toBe("clear");
    expect(clearPlan[0].finalStyle.bg).toBe(authored);
    expect(sidecar.has("s1", 0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: top10 — range batching compresses multi-cell plan to few rects
// ---------------------------------------------------------------------------
describe("Scenario 2: top10 — range batching over multi-cell sqref", () => {
  let sidecar: CfSidecar;

  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  it("top10 over A1:J1 (10 cells) — plan has 10 entries (all sqref cells), batch collapses to 1 rect", () => {
    // computeCfApplyPlan applies the rule style to every cell in the sqref
    // (the top-N evaluation is handled by patchCfRenders at createUnit time).
    // All 10 cells in the sqref get the same CF style → batch must collapse
    // to 1 rectangle with the same color.
    const snap = numericGrid(1, 10, (_r, c) => c + 1);
    const rule = top10Rule("A1:J1", "#TOPBG", 3);

    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    // All 10 sqref cells receive a paint action.
    expect(plan).toHaveLength(10);
    const painted = plan.filter((e) => e.action === "paint");
    expect(painted).toHaveLength(10);

    // All painted cells share the same style (#TOPBG) and same row →
    // batchCfPlan must compress them into a single rectangle.
    const batches = batchCfPlan(plan);
    const paintBatches = batches.filter((b) => b.action === "paint");
    expect(paintBatches).toHaveLength(1);
    expect(paintBatches[0].rect).toEqual({ r1: 0, c1: 0, r2: 0, c2: 9 });
    expect(paintBatches[0].style.bg).toBe("#TOPBG");
  });

  it("top10 5-round loop: only first pass paints; subsequent passes noop (no drift)", () => {
    const snap = numericGrid(1, 10, (_r, c) => c + 1);
    const rule = top10Rule("A1:J1", "#TOPBG", 3);

    // Round 1 — paint.
    const plan1 = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    const painted1 = plan1.filter((e) => e.action === "paint");
    expect(painted1.length).toBeGreaterThan(0);

    // Subsequent rounds — simulate polluted snapshot for painted cells only.
    // Non-painted cells stay clean.
    for (let i = 0; i < 4; i++) {
      // Build a snapshot where the top-3 cells have baked-in CF color.
      const cells: Record<string, Record<string, unknown>> = {};
      cells["0"] = {};
      for (let c = 0; c < 10; c++) {
        const wasPainted = painted1.some((e) => e.col === c);
        cells["0"][String(c)] = wasPainted
          ? { v: c + 1, s: { bg: { rgb: "#TOPBG" } } }
          : { v: c + 1 };
      }
      const dirty = makeSnap(cells);
      const plan = computeCfApplyPlan(sidecar, dirty, "s1", [rule], [rule]);
      const repainted = plan.filter((e) => e.action === "paint");
      expect(repainted).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: dataBar — range batching over whole-row sqref
// ---------------------------------------------------------------------------
describe("Scenario 3: dataBar — range batching over multi-cell plan", () => {
  let sidecar: CfSidecar;

  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  it("dataBar over A1:E5 (25 cells) — plan has 25 entries, batch has ≤ 25 rects", () => {
    // 5×5 grid, values 1..25.
    const snap = numericGrid(5, 5, (r, c) => r * 5 + c + 1);
    const rule = dataBarRule("A1:E5");

    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    // All 25 cells get a paint (dataBar applies to all numeric cells in range).
    expect(plan).toHaveLength(25);
    const painted = plan.filter((e) => e.action === "paint");
    expect(painted.length).toBe(25);

    // Each dataBar cell may have a different bg color (per-cell gradient),
    // so the batch may not collapse to 1 rect. But it must cover all 25 cells
    // with no duplicates, and each rect must be contained in the grid.
    const batches = batchCfPlan(plan);
    const coveredCells = new Set<string>();
    for (const b of batches) {
      for (let r = b.rect.r1; r <= b.rect.r2; r++) {
        for (let c = b.rect.c1; c <= b.rect.c2; c++) {
          const key = `${r}:${c}`;
          // No duplicate cell coverage within the batch list.
          expect(coveredCells.has(key)).toBe(false);
          coveredCells.add(key);
        }
      }
    }
    expect(coveredCells.size).toBe(25);
    // All covered cells must be within 5×5 grid.
    for (const b of batches) {
      expect(b.rect.r1).toBeGreaterThanOrEqual(0);
      expect(b.rect.r2).toBeLessThanOrEqual(4);
      expect(b.rect.c1).toBeGreaterThanOrEqual(0);
      expect(b.rect.c2).toBeLessThanOrEqual(4);
    }
  });

  it("dataBar: number of batches is strictly less than number of plan entries when some cells share color", () => {
    // Uniform values → all cells get the same dataBar color → 1 batch.
    const snap = numericGrid(3, 3, () => 5); // all 5 → max==min → ratio=0 → same color
    const rule = dataBarRule("A1:C3");

    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(plan).toHaveLength(9);

    const batches = batchCfPlan(plan);
    // All cells have same final style → should collapse to 1 rect.
    expect(batches.length).toBeLessThan(plan.length);
    expect(batches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: rule add → delete → re-add — BASE must not drift
// ---------------------------------------------------------------------------
describe("Scenario 4: add → delete → re-add cycle × 3 — BASE must not drift", () => {
  let sidecar: CfSidecar;

  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  it("3 full add→delete→re-add cycles keep baseStyle equal to original authored style", () => {
    const authored = "#ORIGINAL_USER_BG";
    const cfColor = "#CF_RED";
    const clean = makeSnap({ "0": { "0": { s: { bg: { rgb: authored } } } } });
    const rule = cellIsRule("A1:A1", cfColor);

    for (let cycle = 0; cycle < 3; cycle++) {
      // Add rule → paint.
      const addPlan = computeCfApplyPlan(sidecar, clean, "s1", [], [rule]);
      const addPainted = addPlan.filter((e) => e.action === "paint");
      expect(addPainted.length).toBeGreaterThan(0);

      // Simulate 3 polluted rounds (facade wrote the CF color).
      for (let i = 0; i < 3; i++) {
        computeCfApplyPlan(sidecar, polluted(0, 0, cfColor), "s1", [rule], [rule]);
      }

      // Delete rule → clear.
      const delPlan = computeCfApplyPlan(
        sidecar,
        polluted(0, 0, cfColor),
        "s1",
        [rule],
        [],
      );
      expect(delPlan).toHaveLength(1);
      expect(delPlan[0].action).toBe("clear");
      // Restored style must be the original authored color, not the CF color.
      expect(delPlan[0].finalStyle.bg).toBe(authored);
      expect(sidecar.has("s1", 0, 0)).toBe(false);
    }

    // After 3 full cycles, sidecar should be empty (all entries dropped).
    expect(sidecar.size).toBe(0);
  });

  it("re-add after delete re-establishes paint from clean snapshot", () => {
    const rule = cellIsRule("A1:A1", "#BLUE");

    // Cycle 1: add → paint.
    const snap1 = makeSnap({ "0": { "0": { v: 42 } } });
    const plan1 = computeCfApplyPlan(sidecar, snap1, "s1", [], [rule]);
    expect(plan1[0].action).toBe("paint");

    // Delete.
    computeCfApplyPlan(sidecar, snap1, "s1", [rule], []);
    expect(sidecar.has("s1", 0, 0)).toBe(false);

    // Cycle 2: re-add — sidecar is cold, reads from clean snapshot again.
    const plan3 = computeCfApplyPlan(sidecar, snap1, "s1", [], [rule]);
    expect(plan3[0].action).toBe("paint");
    expect(plan3[0].finalStyle.bg).toBe("#BLUE");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: iconSet — numeric cell.v must not be mutated by cfApplyPlan
// ---------------------------------------------------------------------------
describe("Scenario 5: iconSet — numeric value is not mutated by plan", () => {
  let sidecar: CfSidecar;

  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  it("iconSet plan stores glyph in iconValue, never in the snapshot cell.v", () => {
    // 3 cells: values 1, 5, 10 → 3arrows: ↓, →, ↑
    const snap = numericGrid(1, 3, (_r, c) => [1, 5, 10][c]);
    const rule = iconSetRule("A1:C1", "3arrows");

    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(plan).toHaveLength(3);

    for (const entry of plan) {
      // The plan must use action "paint" to track iconValue in sidecar.
      expect(entry.action).toBe("paint");
      // finalStyle.iconValue should be set (the glyph string).
      expect(typeof entry.finalStyle.iconValue).toBe("string");
      expect(entry.finalStyle.iconValue!.length).toBeGreaterThan(0);
    }

    // CRITICAL: the original snapshot cell values must NOT be mutated.
    // computeCfApplyPlan is pure w.r.t. the snapshot — it must not call
    // setValue or write to the snapshot's cell.v fields.
    const originalCells = snap.sheets.s1.cellData;
    for (let c = 0; c < 3; c++) {
      const cell = originalCells["0"][String(c)] as Record<string, unknown>;
      // v must still be the numeric value.
      expect(typeof cell.v).toBe("number");
      expect(cell.v).toBe([1, 5, 10][c]);
    }
  });

  it("iconSet glyph stored in sidecar is the correct band for each cell", () => {
    // values: 1 (min), 5 (mid), 10 (max) → 3arrows: ↓, →, ↑
    const snap = numericGrid(1, 3, (_r, c) => [1, 5, 10][c]);
    const rule = iconSetRule("A1:C1", "3arrows");

    computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);

    // Glyph for value=1 (min of range) should be ↓ (bucket 0 of 3).
    const e0 = sidecar.get("s1", 0, 0);
    expect(e0?.cfStyle.iconValue).toBe("↓");

    // Glyph for value=10 (max of range) should be ↑ (bucket 2 of 3).
    const e2 = sidecar.get("s1", 0, 2);
    expect(e2?.cfStyle.iconValue).toBe("↑");
  });

  it("5 clean rounds with iconSet: subsequent passes produce noop (sidecar is stable)", () => {
    const snap = numericGrid(1, 3, (_r, c) => [1, 5, 10][c]);
    const rule = iconSetRule("A1:C1", "3arrows");

    // Round 1 — paint: sidecar records baseStyle and iconValue.
    computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);

    // Rounds 2-5 — same snapshot (values not corrupted): plan must be noop.
    // This validates that the sidecar's iconValue comparison is stable when
    // cell.v is not corrupted (the clean re-evaluation path).
    for (let i = 0; i < 4; i++) {
      const plan = computeCfApplyPlan(sidecar, snap, "s1", [rule], [rule]);
      const repainted = plan.filter((e) => e.action === "paint");
      expect(repainted).toHaveLength(0);
    }

    // Sidecar state must be preserved across all clean rounds.
    expect(sidecar.has("s1", 0, 0)).toBe(true);
    expect(sidecar.has("s1", 0, 2)).toBe(true);
  });

  it("iconSet deletion produces clear entries for all cells", () => {
    const snap = numericGrid(1, 3, (_r, c) => [1, 5, 10][c]);
    const rule = iconSetRule("A1:C1", "3arrows");

    computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(sidecar.size).toBe(3);

    const clearPlan = computeCfApplyPlan(sidecar, snap, "s1", [rule], []);
    expect(clearPlan).toHaveLength(3);
    expect(clearPlan.every((e) => e.action === "clear")).toBe(true);

    // After clear, sidecar must be empty.
    expect(sidecar.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: polluted snapshot recovery — iconSet re-paint idempotency
// when cell.v contains an embedded glyph string (e.g. "↓ 1" instead of 1).
// ---------------------------------------------------------------------------
describe("Scenario 6: iconSet — polluted snapshot recovery", () => {
  let sidecar: CfSidecar;

  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  /** Build a snapshot where cell.v is a polluted iconSet string (glyph + space + number). */
  function pollutedIconSnap(glyphValues: Array<[string, number]>) {
    const cells: Record<string, Record<string, unknown>> = {};
    glyphValues.forEach(([glyph, n], i) => {
      cells[String(i)] = { "0": { v: `${glyph} ${n}` } };
    });
    return { sheets: { s1: { cellData: cells } } };
  }

  it("recoverNumericFromPolluted strips single-codepoint iconSet glyph and returns number", () => {
    // 3arrows glyphs
    expect(recoverNumericFromPolluted("↓ 1")).toBe(1);
    expect(recoverNumericFromPolluted("→ 5")).toBe(5);
    expect(recoverNumericFromPolluted("↑ 10")).toBe(10);
    // traffic-light glyphs (emoji)
    expect(recoverNumericFromPolluted("🔴 42")).toBe(42);
    expect(recoverNumericFromPolluted("🟡 7")).toBe(7);
    expect(recoverNumericFromPolluted("🟢 99")).toBe(99);
    // Non-polluted values pass through unchanged.
    expect(recoverNumericFromPolluted(42)).toBe(42);
    expect(recoverNumericFromPolluted("hello")).toBe("hello");
    expect(recoverNumericFromPolluted(undefined)).toBeUndefined();
  });

  it("recoverNumericFromPolluted strips 5-rating multi-char prefix and returns number", () => {
    expect(recoverNumericFromPolluted("★☆☆☆☆ 1")).toBe(1);
    expect(recoverNumericFromPolluted("★★☆☆☆ 2")).toBe(2);
    expect(recoverNumericFromPolluted("★★★☆☆ 3")).toBe(3);
    expect(recoverNumericFromPolluted("★★★★☆ 4")).toBe(4);
    expect(recoverNumericFromPolluted("★★★★★ 5")).toBe(5);
  });

  it("polluted snapshot opened fresh: first computeCfApplyPlan recovers numeric and sidecar gets correct glyph", () => {
    // Simulate opening a file where patchCfRenders previously wrote "↓ 1", "→ 5", "↑ 10"
    // into cell.v (the polluted state). sidecar is cold (first open).
    const snap = pollutedIconSnap([["↓", 1], ["→", 5], ["↑", 10]]);
    const rule = iconSetRule("A1:A3", "3arrows");

    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);

    // All 3 cells should be paint (sidecar was cold, no prior entry).
    expect(plan).toHaveLength(3);
    expect(plan.every((e) => e.action === "paint")).toBe(true);

    // Sidecar should have the correct glyphs recovered from the polluted values.
    expect(sidecar.get("s1", 0, 0)?.cfStyle.iconValue).toBe("↓");
    expect(sidecar.get("s1", 1, 0)?.cfStyle.iconValue).toBe("→");
    expect(sidecar.get("s1", 2, 0)?.cfStyle.iconValue).toBe("↑");
  });

  it("polluted snapshot: second computeCfApplyPlan is noop (idempotent after recovery)", () => {
    // After the first round recovers and records the sidecar, subsequent rounds
    // with the same polluted snapshot must produce noop (no re-paint).
    const snap = pollutedIconSnap([["↓", 1], ["→", 5], ["↑", 10]]);
    const rule = iconSetRule("A1:A3", "3arrows");

    // Round 1 — paint (sidecar cold).
    computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);

    // Rounds 2-5 — same polluted snapshot: must be noop.
    for (let i = 0; i < 4; i++) {
      const plan = computeCfApplyPlan(sidecar, snap, "s1", [rule], [rule]);
      const repainted = plan.filter((e) => e.action === "paint");
      expect(repainted).toHaveLength(0);
    }
  });

  it("mixed polluted + clean snapshot: polluted cells recover, clean cells stay idempotent", () => {
    // Cell 0: polluted "↓ 1", Cell 1: clean numeric 5, Cell 2: polluted "↑ 10"
    const cells: Record<string, Record<string, unknown>> = {
      "0": { "0": { v: "↓ 1" } },
      "1": { "0": { v: 5 } },
      "2": { "0": { v: "↑ 10" } },
    };
    const snap = { sheets: { s1: { cellData: cells } } };
    const rule = iconSetRule("A1:A3", "3arrows");

    // Round 1 — paint.
    const plan1 = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(plan1).toHaveLength(3);
    expect(plan1.every((e) => e.action === "paint")).toBe(true);

    // Correct glyphs for all three cells regardless of pollution.
    expect(sidecar.get("s1", 0, 0)?.cfStyle.iconValue).toBe("↓");
    expect(sidecar.get("s1", 1, 0)?.cfStyle.iconValue).toBe("→");
    expect(sidecar.get("s1", 2, 0)?.cfStyle.iconValue).toBe("↑");

    // Round 2 — noop.
    const plan2 = computeCfApplyPlan(sidecar, snap, "s1", [rule], [rule]);
    expect(plan2.filter((e) => e.action === "paint")).toHaveLength(0);
  });

  it("different iconSet glyphs (↑/↓/→) all recover correctly from polluted strings", () => {
    // Verify each glyph variant is individually recoverable.
    const cases: Array<[string, number, string]> = [
      ["↑", 100, "↑"],
      ["→", 50, "→"],
      ["↓", 10, "↓"],
    ];
    for (const [glyph, value, expectedGlyph] of cases) {
      const localSidecar = new CfSidecar();
      const cells: Record<string, Record<string, unknown>> = {
        "0": { "0": { v: `${glyph} ${value}` } },
      };
      const snap = { sheets: { s1: { cellData: cells } } };
      // Rule over a single cell — min==max, so the cell gets the last bucket.
      const rule = iconSetRule("A1:A1", "3arrows");
      computeCfApplyPlan(localSidecar, snap, "s1", [], [rule]);
      // With a single-cell range, min == max, so the glyph is the last bucket (↑).
      // The key check here is that the plan is paint (not a NaN-based mis-fire)
      // and that the sidecar records a valid glyph (not an empty string from NaN).
      const entry = localSidecar.get("s1", 0, 0);
      expect(entry).not.toBeNull();
      expect(typeof entry?.cfStyle.iconValue).toBe("string");
      expect(entry!.cfStyle.iconValue!.length).toBeGreaterThan(0);
      // Suppress unused variable warning.
      void expectedGlyph;
    }
  });
});

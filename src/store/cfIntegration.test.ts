// #241 CF live re-paint — end-to-end integration tests.
//
// Validates the three foundation modules (cfSidecar, cfApplyPlan, cfRangeBatch)
// working together through realistic round-trip scenarios.

import { describe, it, expect, beforeEach } from "vitest";
import { CfSidecar } from "./cfSidecar";
import { computeCfApplyPlan, ruleKey } from "./cfApplyPlan";
import { batchCfPlan } from "./cfRangeBatch";
import type { CfRuleEntry } from "../components/conditionalFormatRender";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal snapshot shape for a single sheet. */
function snap(cells: Record<string, Record<string, unknown>> = {}) {
  return { sheets: { s1: { cellData: cells } } };
}

/** Snapshot with a polluted background (simulating a prior CF write). */
function pollutedSnap(row: number, col: number, pollutedBg: string) {
  return snap({
    [String(row)]: {
      [String(col)]: { s: { bg: { rgb: pollutedBg } } },
    },
  });
}

/** Clean snapshot: cell has no CF paint — only user-authored style. */
function cleanSnap(
  row: number,
  col: number,
  authoredBg?: string,
) {
  if (!authoredBg) return snap({ [String(row)]: { [String(col)]: {} } });
  return snap({
    [String(row)]: {
      [String(col)]: { s: { bg: { rgb: authoredBg } } },
    },
  });
}

/** Single-cell rule factory. */
function rule(
  sqref: string,
  bg: string,
  priority = 1,
): CfRuleEntry {
  return { sqref, type: "cellIs", priority, style: { bgColor: bg } };
}

/** All cells covered by batches — for set-equality checks. */
function batchCells(
  batches: ReturnType<typeof batchCfPlan>,
): string[] {
  const out: string[] = [];
  for (const b of batches) {
    for (let r = b.rect.r1; r <= b.rect.r2; r++) {
      for (let c = b.rect.c1; c <= b.rect.c2; c++) {
        out.push(`${r}:${c}`);
      }
    }
  }
  return out.sort();
}

/** Unique cells covered (deduped). */
function uniqueBatchCells(batches: ReturnType<typeof batchCfPlan>): string[] {
  return [...new Set(batchCells(batches))].sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cfIntegration — end-to-end round-trips", () => {
  let sidecar: CfSidecar;

  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  // -------------------------------------------------------------------------
  // 1. Basic round-trip
  // -------------------------------------------------------------------------
  describe("1. basic round-trip: add rule → paint → stable noop", () => {
    it("first pass: plan contains one paint entry", () => {
      const r1 = rule("A1:A1", "#FF0000");
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      expect(plan).toHaveLength(1);
      expect(plan[0].action).toBe("paint");
      expect(plan[0].finalStyle.bg).toBe("#FF0000");
    });

    it("first pass: batch compresses single cell into 1 rect", () => {
      const r1 = rule("A1:A1", "#FF0000");
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      const batches = batchCfPlan(plan);
      expect(batches).toHaveLength(1);
      expect(batches[0].rect).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    });

    it("second pass with polluted snapshot → noop (sidecar guards base)", () => {
      const r1 = rule("A1:A1", "#FF0000");
      // First pass: establish sidecar entry.
      computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      // Simulate: facade wrote #FF0000 → snapshot is now polluted.
      const polluted = pollutedSnap(0, 0, "#FF0000");
      const plan2 = computeCfApplyPlan(sidecar, polluted, "s1", [r1], [r1]);
      expect(plan2[0].action).toBe("noop");
    });
  });

  // -------------------------------------------------------------------------
  // 2. 5 round-trip stability — base must not drift
  // -------------------------------------------------------------------------
  describe("2. 5 round-trip stability: baseStyle must not drift", () => {
    it("sidecar.getBaseStyle stays equal to original across 5 polluted passes", () => {
      const authored = "#ORIGINAL";
      const r1 = rule("A1:A1", "#CF_COLOR");
      const originalSnap = cleanSnap(0, 0, authored);

      // First pass from clean snapshot (records base).
      computeCfApplyPlan(sidecar, originalSnap, "s1", [], [r1]);
      const baseAfterFirst = sidecar.getBaseStyle("s1", 0, 0);

      // 4 more passes with increasingly "polluted" snapshot.
      for (let i = 0; i < 4; i++) {
        const polluted = pollutedSnap(0, 0, "#CF_COLOR"); // CF paint baked in
        computeCfApplyPlan(sidecar, polluted, "s1", [r1], [r1]);
      }

      const baseAfterFive = sidecar.getBaseStyle("s1", 0, 0);
      expect(baseAfterFive).toEqual(baseAfterFirst);
      expect(baseAfterFive).toEqual({ bg: authored });
    });

    it("all 5 passes after the first produce noop (no drift)", () => {
      const r1 = rule("A1:A1", "#CF_COLOR");
      computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);

      for (let i = 0; i < 5; i++) {
        const polluted = pollutedSnap(0, 0, "#CF_COLOR");
        const plan = computeCfApplyPlan(sidecar, polluted, "s1", [r1], [r1]);
        expect(plan[0].action).toBe("noop");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Rule deletion after 5 paint passes
  // -------------------------------------------------------------------------
  describe("3. rule deletion after 5 round-trips → clear + sidecar drop", () => {
    it("plan contains 'clear' action for the painted cell", () => {
      const r1 = rule("A1:A1", "#RED");
      computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      for (let i = 0; i < 4; i++) {
        computeCfApplyPlan(sidecar, pollutedSnap(0, 0, "#RED"), "s1", [r1], [r1]);
      }
      const clearPlan = computeCfApplyPlan(
        sidecar,
        pollutedSnap(0, 0, "#RED"),
        "s1",
        [r1],
        [],
      );
      expect(clearPlan).toHaveLength(1);
      expect(clearPlan[0].action).toBe("clear");
    });

    it("sidecar entry is dropped after clear", () => {
      const r1 = rule("A1:A1", "#RED");
      computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      computeCfApplyPlan(sidecar, snap(), "s1", [r1], []);
      expect(sidecar.has("s1", 0, 0)).toBe(false);
    });

    it("clear restores authored base even through polluted snapshot", () => {
      const r1 = rule("A1:A1", "#RED");
      const originalSnap = cleanSnap(0, 0, "#AUTHORED");
      computeCfApplyPlan(sidecar, originalSnap, "s1", [], [r1]);
      // 4 polluted rounds.
      for (let i = 0; i < 4; i++) {
        computeCfApplyPlan(sidecar, pollutedSnap(0, 0, "#RED"), "s1", [r1], [r1]);
      }
      const clearPlan = computeCfApplyPlan(
        sidecar,
        pollutedSnap(0, 0, "#RED"),
        "s1",
        [r1],
        [],
      );
      expect(clearPlan[0].finalStyle.bg).toBe("#AUTHORED");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multi-rule overlap — higher priority wins
  // -------------------------------------------------------------------------
  describe("4. multi-rule overlap: higher-priority rule wins", () => {
    it("priority-1 rule overrides priority-2 rule on same cell", () => {
      // priority 1 = highest in Excel (lower number = higher priority).
      const rHigh = rule("A1:A1", "#HIGH", 1);
      const rLow = rule("A1:A1", "#LOW", 2);
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], [rHigh, rLow]);
      expect(plan).toHaveLength(1);
      expect(plan[0].action).toBe("paint");
      expect(plan[0].finalStyle.bg).toBe("#HIGH");
    });

    it("batch groups the one resulting paint into a single rect", () => {
      const rHigh = rule("A1:A1", "#HIGH", 1);
      const rLow = rule("A1:A1", "#LOW", 2);
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], [rHigh, rLow]);
      const batches = batchCfPlan(plan);
      expect(batches).toHaveLength(1);
      expect(batches[0].style.bg).toBe("#HIGH");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Range batching — 10×10 full grid
  // -------------------------------------------------------------------------
  describe("5. 10×10 full grid batches to a single rect", () => {
    it("batch produces exactly 1 rect covering the whole grid", () => {
      const r1 = rule("A1:J10", "#FILL");
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      expect(plan).toHaveLength(100);
      const batches = batchCfPlan(plan);
      expect(batches).toHaveLength(1);
      expect(batches[0].rect).toEqual({ r1: 0, c1: 0, r2: 9, c2: 9 });
    });

    it("batch cell set equals all 100 input cells", () => {
      const r1 = rule("A1:J10", "#FILL");
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      const batches = batchCfPlan(plan);
      const covered = batchCells(batches);
      const expected: string[] = [];
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) expected.push(`${r}:${c}`);
      }
      expect(covered.sort()).toEqual(expected.sort());
    });
  });

  // -------------------------------------------------------------------------
  // 6. L-shape coverage — batches cover all cells, no duplicates
  // -------------------------------------------------------------------------
  describe("6. L-shape: batches cover all cells with no duplicates", () => {
    it("L-shape plan cells are fully covered without duplicates", () => {
      // L-shape: A1:A5 (column) + B5:E5 (bottom row).
      const colRule = rule("A1:A5", "#L");
      const rowRule: CfRuleEntry = {
        sqref: "B5:E5",
        type: "cellIs",
        priority: 1,
        style: { bgColor: "#L" },
      };
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], [colRule, rowRule]);
      // A1:A5 = 5 cells, B5:E5 = 4 cells, total = 9 (no overlap).
      expect(plan).toHaveLength(9);

      const batches = batchCfPlan(plan);
      // All batches same style → possibly multiple rects due to L-shape.
      const covered = batchCells(batches);
      const unique = uniqueBatchCells(batches);

      // No duplicates.
      expect(covered.length).toBe(unique.length);

      // All 9 plan cells are covered.
      const planCells = plan
        .map((e) => `${e.row}:${e.col}`)
        .sort();
      expect(unique).toEqual(planCells);
    });
  });

  // -------------------------------------------------------------------------
  // 7. clear + paint mixed — batch separates by action
  // -------------------------------------------------------------------------
  describe("7. clear + paint mixed: batches separate by action", () => {
    it("batch produces separate clear and paint groups", () => {
      const rOld = rule("A1:A2", "#OLD");
      const rNew = rule("B1:B2", "#NEW");

      // Establish old rule.
      computeCfApplyPlan(sidecar, snap(), "s1", [], [rOld]);
      // Transition: remove old, add new.
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [rOld], [rNew]);

      const clearEntries = plan.filter((e) => e.action === "clear");
      const paintEntries = plan.filter((e) => e.action === "paint");
      expect(clearEntries).toHaveLength(2); // A1, A2
      expect(paintEntries).toHaveLength(2); // B1, B2

      const batches = batchCfPlan(plan);
      const clearBatches = batches.filter((b) => b.action === "clear");
      const paintBatches = batches.filter((b) => b.action === "paint");
      expect(clearBatches.length).toBeGreaterThanOrEqual(1);
      expect(paintBatches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Empty plan
  // -------------------------------------------------------------------------
  describe("8. empty plan → empty batch", () => {
    it("no prev, no next → empty plan", () => {
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], []);
      expect(plan).toHaveLength(0);
    });

    it("empty plan → empty batch", () => {
      const plan = computeCfApplyPlan(sidecar, snap(), "s1", [], []);
      expect(batchCfPlan(plan)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Single cell — 5 round-trip stability
  // -------------------------------------------------------------------------
  describe("9. single cell 5 round-trip stability", () => {
    it("single cell baseStyle stays equal to authored across 5 passes", () => {
      const r1 = rule("C3:C3", "#BLUE");
      const authored = "#AUTH";
      const originalSnap = cleanSnap(2, 2, authored);

      computeCfApplyPlan(sidecar, originalSnap, "s1", [], [r1]);
      const baseFirst = sidecar.getBaseStyle("s1", 2, 2);

      for (let i = 0; i < 4; i++) {
        computeCfApplyPlan(
          sidecar,
          pollutedSnap(2, 2, "#BLUE"),
          "s1",
          [r1],
          [r1],
        );
      }

      expect(sidecar.getBaseStyle("s1", 2, 2)).toEqual(baseFirst);
      expect(sidecar.getBaseStyle("s1", 2, 2)).toEqual({ bg: authored });
    });
  });

  // -------------------------------------------------------------------------
  // 10. clearRule cascade — all cells drop from sidecar
  // -------------------------------------------------------------------------
  describe("10. clearRule cascade: 1 rule × 10 cells → all dropped", () => {
    it("clearRule removes all 10 cell entries from sidecar", () => {
      // Rule covers A1:J1 (row 0, cols 0-9).
      const r1 = rule("A1:J1", "#CASCADE");
      computeCfApplyPlan(sidecar, snap(), "s1", [], [r1]);
      expect(sidecar.size).toBe(10);

      const rid = ruleKey(r1, 0);
      const dropped = sidecar.clearRule(rid);

      expect(dropped).toHaveLength(10);
      expect(sidecar.size).toBe(0);
      // Confirm each cell is no longer tracked.
      for (let c = 0; c < 10; c++) {
        expect(sidecar.has("s1", 0, c)).toBe(false);
      }
    });

    it("clearRule returns baseStyle for each dropped cell", () => {
      const r1 = rule("A1:J1", "#CASCADE");
      // Give each cell a distinct authored bg via snapshot.
      const cellData: Record<string, Record<string, unknown>> = {};
      for (let c = 0; c < 10; c++) {
        cellData["0"] = cellData["0"] ?? {};
        cellData["0"][String(c)] = { s: { bg: { rgb: `#C${c}` } } };
      }
      const originalSnap = snap(cellData);
      computeCfApplyPlan(sidecar, originalSnap, "s1", [], [r1]);

      const rid = ruleKey(r1, 0);
      const dropped = sidecar.clearRule(rid);

      // Each tuple carries the authored base, not the CF color.
      for (const entry of dropped) {
        const expectedBg = `#C${entry.col}`;
        expect(entry.baseStyle.bg).toBe(expectedBg);
      }
    });
  });
});

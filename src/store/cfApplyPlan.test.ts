import { describe, it, expect, beforeEach } from "vitest";
import { CfSidecar } from "./cfSidecar";
import { computeCfApplyPlan, readBaseStyle, ruleKey } from "./cfApplyPlan";
import type { CfRuleEntry } from "../components/conditionalFormatRender";

// #241 Step 2 — CfApplyPlan orchestrator tests.
// These prove the PR #211 revert bug scenarios are defeated by the sidecar.

function snapshot(cells: Record<string, Record<string, unknown>>) {
  return { sheets: { s1: { cellData: cells } } };
}

describe("ruleKey", () => {
  it("synthesises a stable key from rule fields", () => {
    const rule: CfRuleEntry = { sqref: "A1:A10", type: "cellIs", priority: 1 };
    expect(ruleKey(rule, 0)).toBe("1-cellIs-A1:A10");
  });

  it("falls back to index when priority missing", () => {
    const rule: CfRuleEntry = { sqref: "B1", type: "containsText" };
    expect(ruleKey(rule, 3)).toBe("3-containsText-B1");
  });
});

describe("readBaseStyle", () => {
  it("returns empty slice for untracked cells", () => {
    expect(readBaseStyle(snapshot({}), "s1", 0, 0)).toEqual({});
  });

  it("reads bg / cl / bl / it / ul from cell.s", () => {
    const snap = snapshot({
      "0": {
        "0": {
          v: 1,
          s: {
            bg: { rgb: "#FFF" },
            cl: { rgb: "#000" },
            bl: 1,
            it: 1,
            ul: 0,
          },
        },
      },
    });
    expect(readBaseStyle(snap, "s1", 0, 0)).toEqual({
      bg: "#FFF",
      cl: "#000",
      bl: 1,
      it: 1,
      ul: 0,
    });
  });

  it("tolerates malformed cell shape", () => {
    expect(readBaseStyle(snapshot({ "0": { "0": "garbage" as unknown as Record<string, unknown> } }), "s1", 0, 0))
      .toEqual({});
    expect(readBaseStyle({}, "s1", 0, 0)).toEqual({});
  });
});

describe("computeCfApplyPlan", () => {
  let sidecar: CfSidecar;
  beforeEach(() => {
    sidecar = new CfSidecar();
  });

  it("returns paint actions for cells covered by NEXT rules only", () => {
    const snap = snapshot({ "0": { "0": { v: 100 } } });
    const next: CfRuleEntry[] = [
      {
        sqref: "A1:A1",
        type: "cellIs",
        priority: 1,
        style: { bgColor: "#FF0000" },
      },
    ];
    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], next);
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("paint");
    expect(plan[0].finalStyle.bg).toBe("#FF0000");
  });

  it("returns clear actions for cells dropped from NEXT", () => {
    const snap = snapshot({ "0": { "0": { v: 100, s: { bg: { rgb: "#WHITE" } } } } });
    const rule: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 1,
      style: { bgColor: "#FF0000" },
    };
    // First: apply the rule.
    computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    // Then: rule removed.
    const plan = computeCfApplyPlan(sidecar, snap, "s1", [rule], []);
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("clear");
    // Final style = baseStyle (the user-authored white, not the painted red).
    expect(plan[0].finalStyle.bg).toBe("#WHITE");
  });

  it("noop when NEXT rule set is structurally identical to PREV", () => {
    const snap = snapshot({ "0": { "0": { v: 100 } } });
    const rules: CfRuleEntry[] = [
      {
        sqref: "A1:A1",
        type: "cellIs",
        priority: 1,
        style: { bgColor: "#FF0000" },
      },
    ];
    // First pass: paint.
    computeCfApplyPlan(sidecar, snap, "s1", [], rules);
    // Second pass: same rules → noop.
    const plan = computeCfApplyPlan(sidecar, snap, "s1", rules, rules);
    expect(plan[0].action).toBe("noop");
  });

  it("higher-priority rule wins on overlapping sqref", () => {
    const snap = snapshot({ "0": { "0": { v: 100 } } });
    const low: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 1, // priority 1 = highest
      style: { bgColor: "#GREEN" },
    };
    const high: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 2,
      style: { bgColor: "#YELLOW" },
    };
    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [low, high]);
    expect(plan[0].action).toBe("paint");
    // priority 1 is lower number = higher priority → applied LAST in our
    // sort → wins per key. So bg should be GREEN.
    expect(plan[0].finalStyle.bg).toBe("#GREEN");
  });

  it("PR #211 bug 1 defeated: iconSet glyph snapshot pollution doesn't poison BASE", () => {
    // Scenario: the snapshot has a polluted bg (from a prior CF write
    // that was baked in). On rule removal, the orchestrator must restore
    // the ORIGINAL authored bg — not the polluted value.
    //
    // Setup: pre-record the sidecar with the ORIGINAL base (#WHITE) and a
    // cfStyle of #RED. The snapshot itself is polluted (#RED).
    sidecar.recordBase("s1", 0, 0, { bg: "#WHITE" });
    const rule: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 1,
      style: { bgColor: "#RED" },
    };
    sidecar.trackWrite("s1", 0, 0, { bg: "#WHITE" }, { bg: "#RED" }, ruleKey(rule, 0));
    // Polluted snapshot reflects the previous paint, not the user authoring.
    const pollutedSnap = snapshot({
      "0": { "0": { v: 100, s: { bg: { rgb: "#RED" } } } },
    });

    // Removing the rule → clear → bg should restore to #WHITE (from sidecar),
    // NOT to #RED (which is what the polluted snapshot says).
    const plan = computeCfApplyPlan(sidecar, pollutedSnap, "s1", [rule], []);
    expect(plan[0].action).toBe("clear");
    expect(plan[0].finalStyle.bg).toBe("#WHITE");
  });

  it("PR #211 bug 2 defeated: CF removal correctly diffs against sidecar (not snapshot)", () => {
    // Setup: rule paints #RED. Apply twice (simulating a re-render).
    sidecar.recordBase("s1", 0, 0, {}); // no original bg
    const rule: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 1,
      style: { bgColor: "#RED" },
    };
    // First pass: paint.
    computeCfApplyPlan(
      sidecar,
      snapshot({ "0": { "0": {} } }),
      "s1",
      [],
      [rule],
    );
    // Second pass: still rule present, snapshot still polluted.
    // The orchestrator should report noop (cf already applied).
    const plan2 = computeCfApplyPlan(
      sidecar,
      snapshot({ "0": { "0": { s: { bg: { rgb: "#RED" } } } } }),
      "s1",
      [rule],
      [rule],
    );
    expect(plan2[0].action).toBe("noop");
    // Third pass: rule removed.
    const plan3 = computeCfApplyPlan(
      sidecar,
      snapshot({ "0": { "0": { s: { bg: { rgb: "#RED" } } } } }),
      "s1",
      [rule],
      [],
    );
    expect(plan3[0].action).toBe("clear");
    expect(plan3[0].finalStyle.bg).toBeUndefined(); // base had no bg
  });

  it("handles multi-cell sqref (A1:A3)", () => {
    const snap = snapshot({
      "0": { "0": { v: 1 } },
      "1": { "0": { v: 2 } },
      "2": { "0": { v: 3 } },
    });
    const rule: CfRuleEntry = {
      sqref: "A1:A3",
      type: "cellIs",
      priority: 1,
      style: { bgColor: "#YELLOW" },
    };
    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(plan).toHaveLength(3);
    for (const entry of plan) {
      expect(entry.action).toBe("paint");
      expect(entry.finalStyle.bg).toBe("#YELLOW");
    }
  });

  it("applies default highlight when rule has no explicit style", () => {
    const snap = snapshot({ "0": { "0": { v: 1 } } });
    const rule: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 1,
    };
    const plan = computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(plan[0].finalStyle.bg).toBe("#fff2a8");
    expect(plan[0].finalStyle.bl).toBe(1);
  });

  it("sidecar entries persist across plan calls", () => {
    const snap = snapshot({ "0": { "0": { v: 1, s: { bg: { rgb: "#W" } } } } });
    const rule: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 1,
      style: { bgColor: "#R" },
    };
    computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(sidecar.has("s1", 0, 0)).toBe(true);
    expect(sidecar.getBaseStyle("s1", 0, 0)).toEqual({ bg: "#W" });
  });

  it("clearing the last rule drops the sidecar entry entirely", () => {
    const snap = snapshot({ "0": { "0": { v: 1 } } });
    const rule: CfRuleEntry = {
      sqref: "A1:A1",
      type: "cellIs",
      priority: 1,
      style: { bgColor: "#R" },
    };
    computeCfApplyPlan(sidecar, snap, "s1", [], [rule]);
    expect(sidecar.has("s1", 0, 0)).toBe(true);
    computeCfApplyPlan(sidecar, snap, "s1", [rule], []);
    expect(sidecar.has("s1", 0, 0)).toBe(false);
  });
});

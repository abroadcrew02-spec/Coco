import { describe, it, expect, beforeEach } from "vitest";
import { CfSidecar, composeStyle, makeCellKey } from "./cfSidecar";

// #241 — CF live re-paint sidecar foundation tests.

describe("makeCellKey", () => {
  it("composes the stable key format", () => {
    expect(makeCellKey("s1", 0, 0)).toBe("s1:0:0");
    expect(makeCellKey("Sheet1", 5, 3)).toBe("Sheet1:5:3");
  });
});

describe("CfSidecar", () => {
  let sc: CfSidecar;
  beforeEach(() => {
    sc = new CfSidecar();
  });

  describe("recordBase + has + get", () => {
    it("recordBase creates an entry with the given baseStyle", () => {
      sc.recordBase("s1", 0, 0, { bg: "#FFF" });
      expect(sc.has("s1", 0, 0)).toBe(true);
      const entry = sc.get("s1", 0, 0)!;
      expect(entry.baseStyle).toEqual({ bg: "#FFF" });
      expect(entry.cfStyle).toEqual({});
      expect(entry.ruleIds.size).toBe(0);
    });

    it("recordBase is IDEMPOTENT — second call does not overwrite", () => {
      sc.recordBase("s1", 0, 0, { bg: "#FFF" });
      sc.recordBase("s1", 0, 0, { bg: "#000" }); // would-be polluted
      const entry = sc.get("s1", 0, 0)!;
      expect(entry.baseStyle).toEqual({ bg: "#FFF" });
    });

    it("get returns null for untracked cells", () => {
      expect(sc.get("s1", 0, 0)).toBeNull();
    });

    it("size reflects entry count", () => {
      sc.recordBase("s1", 0, 0, {});
      sc.recordBase("s1", 1, 0, {});
      sc.recordBase("s2", 0, 0, {});
      expect(sc.size).toBe(3);
    });
  });

  describe("trackWrite", () => {
    it("creates an entry on first contact (with baseStyle)", () => {
      sc.trackWrite(
        "s1", 0, 0,
        { bg: "#FFF" }, // base
        { bg: "#FF0" }, // cf
        "rule-1",
      );
      const entry = sc.get("s1", 0, 0)!;
      expect(entry.baseStyle).toEqual({ bg: "#FFF" });
      expect(entry.cfStyle).toEqual({ bg: "#FF0" });
      expect(entry.ruleIds.has("rule-1")).toBe(true);
    });

    it("preserves baseStyle across subsequent trackWrites (never overwritten)", () => {
      sc.trackWrite("s1", 0, 0, { bg: "#FFF" }, { bg: "red" }, "rule-1");
      // Simulate the BUG scenario from PR #211: a second trackWrite that
      // accidentally passes the polluted post-write style as base.
      sc.trackWrite("s1", 0, 0, { bg: "red" }, { bg: "green" }, "rule-2");
      const entry = sc.get("s1", 0, 0)!;
      // baseStyle must STILL be the original user-authored white, NOT red.
      expect(entry.baseStyle).toEqual({ bg: "#FFF" });
      expect(entry.cfStyle).toEqual({ bg: "green" });
      expect(entry.ruleIds.has("rule-1")).toBe(true);
      expect(entry.ruleIds.has("rule-2")).toBe(true);
    });

    it("replaces cfStyle wholesale (does NOT merge)", () => {
      sc.trackWrite("s1", 0, 0, {}, { bg: "red", cl: "white" }, "rule-1");
      sc.trackWrite("s1", 0, 0, {}, { bg: "green" }, "rule-1");
      const entry = sc.get("s1", 0, 0)!;
      // cl from first write is gone; only the new cfStyle remains.
      expect(entry.cfStyle).toEqual({ bg: "green" });
    });

    it("accumulates rule ids when multiple rules touch the same cell", () => {
      sc.trackWrite("s1", 0, 0, {}, { bg: "red" }, "rule-1");
      sc.trackWrite("s1", 0, 0, {}, { bg: "red", bl: 1 }, "rule-2");
      const entry = sc.get("s1", 0, 0)!;
      expect(entry.ruleIds.size).toBe(2);
    });
  });

  describe("untrackRule", () => {
    it("removes only the named rule's contribution; cell stays tracked when others remain", () => {
      sc.trackWrite("s1", 0, 0, { bg: "#FFF" }, { bg: "red" }, "rule-1");
      sc.trackWrite("s1", 0, 0, { bg: "#FFF" }, { bg: "red", bl: 1 }, "rule-2");
      const base = sc.untrackRule("s1", 0, 0, "rule-1");
      expect(base).toEqual({ bg: "#FFF" });
      const entry = sc.get("s1", 0, 0)!;
      expect(entry).not.toBeNull();
      expect(entry.ruleIds.has("rule-1")).toBe(false);
      expect(entry.ruleIds.has("rule-2")).toBe(true);
    });

    it("drops the entry entirely when the last rule leaves", () => {
      sc.trackWrite("s1", 0, 0, { bg: "#FFF" }, { bg: "red" }, "rule-1");
      const base = sc.untrackRule("s1", 0, 0, "rule-1");
      expect(base).toEqual({ bg: "#FFF" });
      expect(sc.has("s1", 0, 0)).toBe(false);
    });

    it("returns null when the rule wasn't contributing", () => {
      sc.trackWrite("s1", 0, 0, {}, { bg: "red" }, "rule-1");
      expect(sc.untrackRule("s1", 0, 0, "rule-other")).toBeNull();
    });

    it("returns null when the cell isn't tracked at all", () => {
      expect(sc.untrackRule("s1", 0, 0, "rule-1")).toBeNull();
    });
  });

  describe("clearRule", () => {
    it("returns every cell where the rule was contributing", () => {
      sc.trackWrite("s1", 0, 0, { bg: "#A" }, { bg: "red" }, "rule-1");
      sc.trackWrite("s1", 1, 0, { bg: "#B" }, { bg: "red" }, "rule-1");
      sc.trackWrite("s1", 2, 0, { bg: "#C" }, { bg: "blue" }, "rule-2");
      const affected = sc.clearRule("rule-1");
      const refs = affected.map((a) => `${a.sheetId}:${a.row}:${a.col}`);
      expect(refs).toContain("s1:0:0");
      expect(refs).toContain("s1:1:0");
      expect(refs).not.toContain("s1:2:0");
    });

    it("preserves entry when other rules still contribute", () => {
      sc.trackWrite("s1", 0, 0, {}, { bg: "red" }, "rule-1");
      sc.trackWrite("s1", 0, 0, {}, { bg: "red", bl: 1 }, "rule-2");
      sc.clearRule("rule-1");
      expect(sc.has("s1", 0, 0)).toBe(true);
      expect(sc.get("s1", 0, 0)?.ruleIds.has("rule-2")).toBe(true);
    });

    it("drops entries whose last rule was the cleared one", () => {
      sc.trackWrite("s1", 0, 0, {}, { bg: "red" }, "rule-1");
      sc.clearRule("rule-1");
      expect(sc.has("s1", 0, 0)).toBe(false);
    });

    it("returns the cell's baseStyle on each affected entry (caller rolls back)", () => {
      sc.trackWrite("s1", 0, 0, { bg: "#authored" }, { bg: "red" }, "rule-1");
      const affected = sc.clearRule("rule-1");
      expect(affected[0].baseStyle).toEqual({ bg: "#authored" });
    });

    it("empty when no cells were touched by the rule", () => {
      expect(sc.clearRule("never-existed")).toEqual([]);
    });
  });

  describe("getBaseStyle", () => {
    it("returns the recorded baseStyle for a tracked cell", () => {
      sc.recordBase("s1", 0, 0, { bg: "#FFF" });
      expect(sc.getBaseStyle("s1", 0, 0)).toEqual({ bg: "#FFF" });
    });

    it("returns null for untracked cells", () => {
      expect(sc.getBaseStyle("s1", 0, 0)).toBeNull();
    });

    it("returns a fresh copy (caller can mutate safely)", () => {
      sc.recordBase("s1", 0, 0, { bg: "#FFF" });
      const a = sc.getBaseStyle("s1", 0, 0)!;
      a.bg = "MUTATED";
      const b = sc.getBaseStyle("s1", 0, 0)!;
      expect(b.bg).toBe("#FFF");
    });
  });

  describe("clearAll + cells iterator", () => {
    it("clearAll drops every entry", () => {
      sc.recordBase("s1", 0, 0, {});
      sc.recordBase("s1", 1, 0, {});
      sc.clearAll();
      expect(sc.size).toBe(0);
    });

    it("cells iterator yields every tracked cell", () => {
      sc.recordBase("s1", 0, 0, { bg: "A" });
      sc.recordBase("s2", 5, 3, { bg: "B" });
      const out = [...sc.cells()];
      expect(out).toHaveLength(2);
      const refs = out.map((c) => `${c.sheetId}:${c.row}:${c.col}`);
      expect(refs).toContain("s1:0:0");
      expect(refs).toContain("s2:5:3");
    });
  });
});

describe("composeStyle", () => {
  it("merges cf keys on top of base", () => {
    expect(composeStyle({ bg: "#FFF" }, { cl: "#000" })).toEqual({
      bg: "#FFF",
      cl: "#000",
    });
  });

  it("cf keys override base keys", () => {
    expect(composeStyle({ bg: "#FFF", bl: 1 }, { bg: "red" })).toEqual({
      bg: "red",
      bl: 1,
    });
  });

  it("returns just base when cf is empty", () => {
    expect(composeStyle({ bg: "#FFF" }, {})).toEqual({ bg: "#FFF" });
  });

  it("handles iconValue overlay", () => {
    expect(composeStyle({ bg: "#FFF" }, { iconValue: "↑ 42" })).toEqual({
      bg: "#FFF",
      iconValue: "↑ 42",
    });
  });
});

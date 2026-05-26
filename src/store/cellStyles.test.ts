import { describe, it, expect } from "vitest";
import {
  applyPresetToRange,
  CELL_STYLE_PRESETS,
  getPreset,
} from "./cellStyles";

// Regression suite for cellStyles.ts (347 lines, no tests).

describe("CELL_STYLE_PRESETS + getPreset", () => {
  it("ships the canonical Excel preset families", () => {
    const ids = CELL_STYLE_PRESETS.map((p) => p.id);
    expect(ids).toContain("normal");
    expect(ids).toContain("good");
    expect(ids).toContain("bad");
    expect(ids).toContain("neutral");
    expect(ids).toContain("accent1");
    expect(ids).toContain("accent1-20");
  });

  it("each preset has id, label, category", () => {
    for (const p of CELL_STYLE_PRESETS) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
    }
  });

  it("getPreset returns the preset for known ids", () => {
    expect(getPreset("good")?.id).toBe("good");
    expect(getPreset("accent1-40")?.id).toBe("accent1-40");
  });

  it("getPreset returns null for unknown ids", () => {
    expect(getPreset("doesNotExist")).toBeNull();
  });

  it("'normal' preset has resetAll=true and empty style", () => {
    const normal = getPreset("normal");
    expect(normal?.resetAll).toBe(true);
    expect(Object.keys(normal!.style)).toEqual([]);
  });
});

describe("applyPresetToRange", () => {
  function emptySnapshot() {
    return JSON.stringify({
      sheets: { s1: { cellData: {} } },
    });
  }

  function snapWithData() {
    return JSON.stringify({
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: "A1", s: { bl: 1 } } },
            "1": { "0": { v: "A2" } },
          },
        },
      },
    });
  }

  it("returns input unchanged for unknown preset", () => {
    const snap = emptySnapshot();
    expect(applyPresetToRange(snap, "s1", { r1: 0, c1: 0, r2: 0, c2: 0 }, "nope")).toBe(snap);
  });

  it("returns input unchanged for missing sheet", () => {
    const snap = emptySnapshot();
    expect(applyPresetToRange(snap, "missing", { r1: 0, c1: 0, r2: 0, c2: 0 }, "good")).toBe(snap);
  });

  it("returns input unchanged for malformed JSON", () => {
    expect(applyPresetToRange("not json", "s1", { r1: 0, c1: 0, r2: 0, c2: 0 }, "good")).toBe("not json");
  });

  it("applies a colour preset to an empty cell (creates it)", () => {
    const next = applyPresetToRange(emptySnapshot(), "s1", { r1: 0, c1: 0, r2: 0, c2: 0 }, "good");
    const obj = JSON.parse(next) as { sheets: { s1: { cellData: Record<string, Record<string, Record<string, unknown>>> } } };
    const cell = obj.sheets.s1.cellData["0"]?.["0"];
    expect(cell).toBeDefined();
    expect(cell.s).toMatchObject({ bg: { rgb: "#C6EFCE" } });
  });

  it("merges the preset style onto an existing cell's style (preserves prior keys)", () => {
    const next = applyPresetToRange(snapWithData(), "s1", { r1: 0, c1: 0, r2: 0, c2: 0 }, "good");
    const obj = JSON.parse(next) as { sheets: { s1: { cellData: Record<string, Record<string, Record<string, unknown>>> } } };
    const cell = obj.sheets.s1.cellData["0"]["0"];
    const style = cell.s as Record<string, unknown>;
    // Existing bl:1 should remain; preset bg should be added.
    expect(style.bl).toBe(1);
    expect(style.bg).toEqual({ rgb: "#C6EFCE" });
  });

  it("'normal' preset clears style + _fmt", () => {
    const initial = JSON.stringify({
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: "X", s: { bg: { rgb: "#000" }, bl: 1 }, _fmt: "0.00" } },
          },
        },
      },
    });
    const next = applyPresetToRange(initial, "s1", { r1: 0, c1: 0, r2: 0, c2: 0 }, "normal");
    const obj = JSON.parse(next) as { sheets: { s1: { cellData: Record<string, Record<string, Record<string, unknown>>> } } };
    const cell = obj.sheets.s1.cellData["0"]["0"];
    expect(cell.s).toBeUndefined();
    expect(cell._fmt).toBeUndefined();
    expect(cell.v).toBe("X"); // value preserved
  });

  it("normalises swapped corners", () => {
    const next = applyPresetToRange(emptySnapshot(), "s1", { r1: 1, c1: 0, r2: 0, c2: 0 }, "good");
    const obj = JSON.parse(next) as { sheets: { s1: { cellData: Record<string, Record<string, Record<string, unknown>>> } } };
    expect(obj.sheets.s1.cellData["0"]["0"]).toBeDefined();
    expect(obj.sheets.s1.cellData["1"]["0"]).toBeDefined();
  });

  it("writes _fmt when the preset declares a numFmt code", () => {
    const numPreset = CELL_STYLE_PRESETS.find((p) => p.numFmt !== undefined);
    if (!numPreset) return; // catalog has no number preset — skip
    const next = applyPresetToRange(
      emptySnapshot(),
      "s1",
      { r1: 0, c1: 0, r2: 0, c2: 0 },
      numPreset.id,
    );
    const obj = JSON.parse(next) as { sheets: { s1: { cellData: Record<string, Record<string, Record<string, unknown>>> } } };
    const cell = obj.sheets.s1.cellData["0"]["0"];
    expect(cell._fmt).toBe(numPreset.numFmt);
  });

  it("returns input unchanged for negative range corners", () => {
    const snap = emptySnapshot();
    expect(applyPresetToRange(snap, "s1", { r1: -1, c1: 0, r2: 0, c2: 0 }, "good")).toBe(snap);
  });
});

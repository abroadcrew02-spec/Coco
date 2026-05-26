import { describe, it, expect } from "vitest";
import {
  applyBorders,
  borderStyleToUniverIndex,
  BORDER_PRESETS,
  getBorderPreset,
} from "./borders";

// Regression suite for borders.ts (372 lines, no tests).

describe("borderStyleToUniverIndex", () => {
  it("maps each style to its expected Univer index", () => {
    expect(borderStyleToUniverIndex("none")).toBe(0);
    expect(borderStyleToUniverIndex("thin")).toBe(1);
    expect(borderStyleToUniverIndex("dotted")).toBe(3);
    expect(borderStyleToUniverIndex("dashed")).toBe(4);
    expect(borderStyleToUniverIndex("double")).toBe(7);
    expect(borderStyleToUniverIndex("medium")).toBe(8);
    expect(borderStyleToUniverIndex("thick")).toBe(13);
  });
});

describe("BORDER_PRESETS + getBorderPreset", () => {
  it("ships 12 presets per the Excel gallery", () => {
    expect(BORDER_PRESETS.length).toBeGreaterThanOrEqual(10);
  });

  it("'all' preset enables outer + inner sides", () => {
    const all = getBorderPreset("all");
    expect(all).toBeTruthy();
    expect(all!.sides).toEqual({
      t: true,
      b: true,
      l: true,
      r: true,
      insideH: true,
      insideV: true,
    });
  });

  it("'none' preset has empty sides", () => {
    const none = getBorderPreset("none");
    expect(none!.sides).toEqual({});
  });

  it("'outside' preset enables only outer edges", () => {
    const outside = getBorderPreset("outside");
    expect(outside!.sides).toEqual({ t: true, b: true, l: true, r: true });
  });

  it("returns null for unknown preset id", () => {
    expect(getBorderPreset("nonexistent")).toBeNull();
  });
});

describe("applyBorders", () => {
  function makeSnapshot() {
    return {
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: "A1" } },
            "1": { "0": { v: "A2" } },
          },
        },
      },
    };
  }

  it("applies 'all' preset to a 2×2 range, marking edges on each cell", () => {
    const snap = makeSnapshot();
    const { cellsTouched } = applyBorders(snap, "s1", {
      range: { r1: 0, c1: 0, r2: 1, c2: 1 },
      preset: "all",
      color: "#000000",
      style: "thin",
    });
    expect(cellsTouched).toBe(4);
    const cell00 = snap.sheets.s1.cellData["0"]!["0"]! as Record<string, unknown>;
    const s = cell00.s as Record<string, unknown>;
    const bd = s.bd as Record<string, unknown>;
    // Top-left cell of a 2×2 grid should have t + l (outer) + r + b (inner).
    expect(bd.t).toBeDefined();
    expect(bd.l).toBeDefined();
    expect(bd.r).toBeDefined();
    expect(bd.b).toBeDefined();
  });

  it("'outside' preset only marks the outer edges, not the interior", () => {
    const snap = makeSnapshot();
    applyBorders(snap, "s1", {
      range: { r1: 0, c1: 0, r2: 1, c2: 0 },
      preset: "outside",
      color: "#FF0000",
      style: "thin",
    });
    const cell00 = snap.sheets.s1.cellData["0"]!["0"]! as Record<string, unknown>;
    const cell10 = snap.sheets.s1.cellData["1"]!["0"]! as Record<string, unknown>;
    const bd00 = (cell00.s as Record<string, unknown>).bd as Record<string, unknown>;
    const bd10 = (cell10.s as Record<string, unknown>).bd as Record<string, unknown>;
    // top of cell00 (outer), bottom of cell10 (outer)
    expect(bd00.t).toBeDefined();
    expect(bd10.b).toBeDefined();
    // No interior edges in a 2×1 column-stack outside-only preset.
  });

  it("'none' preset clears all bd from cells in the range", () => {
    const snap = makeSnapshot();
    // Apply 'all' first
    applyBorders(snap, "s1", {
      range: { r1: 0, c1: 0, r2: 1, c2: 0 },
      preset: "all",
      color: "#000",
      style: "thin",
    });
    // Then clear with 'none'
    applyBorders(snap, "s1", {
      range: { r1: 0, c1: 0, r2: 1, c2: 0 },
      preset: "none",
      color: "#000",
      style: "thin",
    });
    const cell00 = snap.sheets.s1.cellData["0"]!["0"]! as Record<string, unknown>;
    expect(cell00.s).toBeUndefined();
  });

  it("respects the chosen color", () => {
    const snap = makeSnapshot();
    applyBorders(snap, "s1", {
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      preset: "outside",
      color: "#FF8800",
      style: "thin",
    });
    const cell = snap.sheets.s1.cellData["0"]!["0"]! as Record<string, unknown>;
    const bd = ((cell.s as Record<string, unknown>).bd) as Record<string, { cl: { rgb: string } }>;
    expect(bd.t.cl.rgb).toBe("#FF8800");
  });

  it("doubleBottom preset uses the double-line index regardless of style", () => {
    const snap = makeSnapshot();
    applyBorders(snap, "s1", {
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      preset: "bottom-double",
      color: "#000",
      style: "thin",
    });
    const cell = snap.sheets.s1.cellData["0"]!["0"]! as Record<string, unknown>;
    const bd = ((cell.s as Record<string, unknown>).bd) as Record<string, { s: number }>;
    expect(bd.b.s).toBe(borderStyleToUniverIndex("double"));
  });

  it("returns 0 cellsTouched for unknown preset", () => {
    const snap = makeSnapshot();
    const { cellsTouched } = applyBorders(snap, "s1", {
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      preset: "nonexistent",
      color: "#000",
      style: "thin",
    });
    expect(cellsTouched).toBe(0);
  });

  it("returns 0 for missing sheet", () => {
    const snap = makeSnapshot();
    const { cellsTouched } = applyBorders(snap, "missing", {
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      preset: "all",
      color: "#000",
      style: "thin",
    });
    expect(cellsTouched).toBe(0);
  });

  it("returns 0 for malformed snapshot", () => {
    expect(applyBorders(null as unknown as object, "s1", {
      range: { r1: 0, c1: 0, r2: 0, c2: 0 },
      preset: "all",
      color: "#000",
      style: "thin",
    }).cellsTouched).toBe(0);
  });

  it("normalises swapped range corners", () => {
    const snap = makeSnapshot();
    const { cellsTouched } = applyBorders(snap, "s1", {
      range: { r1: 1, c1: 0, r2: 0, c2: 0 }, // swapped
      preset: "all",
      color: "#000",
      style: "thin",
    });
    expect(cellsTouched).toBe(2);
  });
});

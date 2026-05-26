import { describe, it, expect } from "vitest";
import { resolveInGridChartsForSheet } from "./inGridChartLayout";

// Default pixel constants from cellPixelBounds:
//   DEFAULT_COL_WIDTH_PX = 73, DEFAULT_ROW_HEIGHT_PX = 19
//   DEFAULT_HEADER_LEFT = 46, DEFAULT_HEADER_TOP = 20

function makeSnapshot(
  sheetId: string,
  charts: unknown[],
  extraSheets: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    sheetOrder: [sheetId, ...Object.keys(extraSheets)],
    sheets: {
      [sheetId]: {
        name: "Sheet1",
        _charts: charts,
      },
      ...extraSheets,
    },
  });
}

describe("resolveInGridChartsForSheet", () => {
  it("returns one placement for a fully-anchored entry", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B5", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const placements = resolveInGridChartsForSheet(snap, "s1");
    expect(placements).toHaveLength(1);
    expect(placements[0].key).toBe("s1-0");
    // anchorRow=0, anchorCol=0 → top = headerTop = 20, left = headerLeft = 46
    expect(placements[0].box.left).toBe(46);
    expect(placements[0].box.top).toBe(20);
    expect(placements[0].box.width).toBe(480);
    expect(placements[0].box.height).toBe(300);
  });

  it("excludes entries without anchor fields (range-only)", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B5", type: "line" },
    ]);
    expect(resolveInGridChartsForSheet(snap, "s1")).toHaveLength(0);
  });

  it("excludes entries with widthPx <= 0", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B5", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 0, heightPx: 300 },
    ]);
    expect(resolveInGridChartsForSheet(snap, "s1")).toHaveLength(0);
  });

  it("returns [] for invalid JSON", () => {
    expect(resolveInGridChartsForSheet("{not valid json", "s1")).toHaveLength(0);
  });

  it("returns [] for null snapshot", () => {
    expect(resolveInGridChartsForSheet(null, "s1")).toHaveLength(0);
  });

  it("returns [] for null sheetId", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B5", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    expect(resolveInGridChartsForSheet(snap, null)).toHaveLength(0);
  });

  it("returns [] for an unknown sheetId", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B5", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    expect(resolveInGridChartsForSheet(snap, "does-not-exist")).toHaveLength(0);
  });

  it("only returns placements for the specified sheet, not other sheets", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: {
          name: "Sheet1",
          _charts: [
            { range: "A1:B5", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
          ],
        },
        s2: {
          name: "Sheet2",
          _charts: [
            { range: "A1:C10", type: "line", anchorRow: 1, anchorCol: 1, widthPx: 200, heightPx: 150 },
          ],
        },
      },
    });
    const s1 = resolveInGridChartsForSheet(snap, "s1");
    const s2 = resolveInGridChartsForSheet(snap, "s2");
    expect(s1).toHaveLength(1);
    expect(s1[0].key).toBe("s1-0");
    expect(s2).toHaveLength(1);
    expect(s2[0].key).toBe("s2-0");
  });

  it("respects custom defaultRowHeight in opts", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B5", type: "bar", anchorRow: 2, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const defaultPlacement = resolveInGridChartsForSheet(snap, "s1");
    const tallPlacement = resolveInGridChartsForSheet(snap, "s1", { defaultRowHeight: 40 });
    // With taller rows, top offset should be larger.
    expect(tallPlacement[0].box.top).toBeGreaterThan(defaultPlacement[0].box.top);
  });

  it("excludes entries with non-finite anchor values", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B5", type: "bar", anchorRow: NaN, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    expect(resolveInGridChartsForSheet(snap, "s1")).toHaveLength(0);
  });
});

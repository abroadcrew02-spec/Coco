import { describe, it, expect } from "vitest";
import {
  bakeDefaultAnchor,
  moveChartAnchor,
  resizeChartAnchor,
  resolveChartBox,
  snapAnchorToPixel,
  CHART_MIN_WIDTH_PX,
  CHART_MIN_HEIGHT_PX,
  type BoxableEntry,
} from "./inGridChart";

// #236 Step 2 — in-grid chart anchor + box resolution.

describe("resolveChartBox", () => {
  it("returns null when entry has neither anchor nor range", () => {
    expect(resolveChartBox({}, {})).toBeNull();
  });

  it("uses explicit anchor when all 4 fields present", () => {
    const entry: BoxableEntry = {
      anchorRow: 2,
      anchorCol: 3,
      widthPx: 500,
      heightPx: 200,
    };
    const box = resolveChartBox(entry, {});
    expect(box).not.toBeNull();
    expect(box!.width).toBe(500);
    expect(box!.height).toBe(200);
    // left/top should be > 0 (past the header offsets).
    expect(box!.left).toBeGreaterThan(0);
    expect(box!.top).toBeGreaterThan(0);
  });

  it("falls back to defaultChartAnchorPx when anchor fields missing", () => {
    const entry: BoxableEntry = { range: "A1:C5" };
    const box = resolveChartBox(entry, {});
    expect(box).not.toBeNull();
    expect(box!.width).toBe(480); // default
    expect(box!.height).toBe(300);
  });

  it("returns null when range is malformed and no anchor", () => {
    expect(resolveChartBox({ range: "garbage" }, {})).toBeNull();
  });

  it("respects custom default col/row in layout", () => {
    const entry: BoxableEntry = {
      anchorRow: 1,
      anchorCol: 1,
      widthPx: 200,
      heightPx: 100,
    };
    const baseBox = resolveChartBox(entry, {})!;
    const wideBox = resolveChartBox(entry, { defaultColumnWidth: 200 })!;
    expect(wideBox.left).toBeGreaterThan(baseBox.left);
  });

  it("treats negative anchor as missing (fallback to range)", () => {
    const entry: BoxableEntry = {
      anchorRow: -1,
      anchorCol: 0,
      widthPx: 100,
      heightPx: 100,
      range: "A1:B2",
    };
    const box = resolveChartBox(entry, {})!;
    // Negative anchor rejected → fallback to default-anchor 480×300.
    expect(box.width).toBe(480);
  });

  it("treats zero widthPx as missing", () => {
    const entry: BoxableEntry = {
      anchorRow: 0,
      anchorCol: 0,
      widthPx: 0,
      heightPx: 100,
      range: "A1",
    };
    const box = resolveChartBox(entry, {})!;
    expect(box.width).toBe(480);
  });
});

describe("bakeDefaultAnchor", () => {
  it("returns entry unchanged when anchor already set", () => {
    const entry: BoxableEntry = { anchorRow: 5, anchorCol: 5 };
    expect(bakeDefaultAnchor(entry, {})).toBe(entry);
  });

  it("returns entry unchanged when no range", () => {
    const entry: BoxableEntry = {};
    expect(bakeDefaultAnchor(entry, {})).toBe(entry);
  });

  it("bakes anchor + size from range", () => {
    const entry: BoxableEntry = { range: "A1:C5" };
    const out = bakeDefaultAnchor(entry, {});
    expect(out.anchorRow).toBe(0);
    expect(out.anchorCol).toBe(3); // c1+1 (right of source)
    expect(out.widthPx).toBe(480);
    expect(out.heightPx).toBe(300);
  });

  it("preserves other entry fields", () => {
    const entry = {
      range: "A1:B2",
      type: "bar",
      title: "Sales",
    } as BoxableEntry & { type: string; title: string };
    const out = bakeDefaultAnchor(entry, {}) as typeof entry;
    expect(out.type).toBe("bar");
    expect(out.title).toBe("Sales");
  });

  it("doesn't bake when range is malformed", () => {
    const entry: BoxableEntry = { range: "garbage" };
    const out = bakeDefaultAnchor(entry, {});
    expect(out.anchorRow).toBeUndefined();
  });
});

describe("moveChartAnchor", () => {
  it("offsets anchor by delta", () => {
    const entry: BoxableEntry = { anchorRow: 5, anchorCol: 3 };
    const moved = moveChartAnchor(entry, 2, -1);
    expect(moved.anchorRow).toBe(7);
    expect(moved.anchorCol).toBe(2);
  });

  it("clamps to non-negative", () => {
    const entry: BoxableEntry = { anchorRow: 1, anchorCol: 1 };
    const moved = moveChartAnchor(entry, -100, -100);
    expect(moved.anchorRow).toBe(0);
    expect(moved.anchorCol).toBe(0);
  });

  it("treats missing anchor as 0", () => {
    const entry: BoxableEntry = { range: "A1" };
    const moved = moveChartAnchor(entry, 3, 4);
    expect(moved.anchorRow).toBe(3);
    expect(moved.anchorCol).toBe(4);
  });

  it("does not mutate input", () => {
    const entry: BoxableEntry = { anchorRow: 1, anchorCol: 1 };
    moveChartAnchor(entry, 5, 5);
    expect(entry.anchorRow).toBe(1);
  });
});

describe("snapAnchorToPixel", () => {
  it("snaps to row 0 col 0 for a pixel inside A1", () => {
    // A1 starts at headerLeft=46, headerTop=20; point (50, 25) is inside A1.
    const entry: BoxableEntry = { anchorRow: 5, anchorCol: 5 };
    const snapped = snapAnchorToPixel(entry, 50, 25, {});
    expect(snapped.anchorRow).toBe(0);
    expect(snapped.anchorCol).toBe(0);
  });

  it("snaps to row 1 col 1 for a pixel inside B2", () => {
    // DEFAULT_COL=73, DEFAULT_ROW=19, HEADER_LEFT=46, HEADER_TOP=20
    // B2 left = 46+73=119, top = 20+19=39; pick (125, 45) inside B2
    const entry: BoxableEntry = { anchorRow: 0, anchorCol: 0 };
    const snapped = snapAnchorToPixel(entry, 125, 45, {});
    expect(snapped.anchorRow).toBe(1);
    expect(snapped.anchorCol).toBe(1);
  });

  it("preserves other entry fields", () => {
    const entry = { anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300, range: "A1:B2" } as BoxableEntry;
    const snapped = snapAnchorToPixel(entry, 50, 25, {});
    expect(snapped.widthPx).toBe(480);
    expect(snapped.heightPx).toBe(300);
    expect(snapped.range).toBe("A1:B2");
  });

  it("clamps to (0,0) for a point in the header region", () => {
    const entry: BoxableEntry = { anchorRow: 3, anchorCol: 3 };
    const snapped = snapAnchorToPixel(entry, 5, 5, {});
    expect(snapped.anchorRow).toBe(0);
    expect(snapped.anchorCol).toBe(0);
  });
});

describe("resizeChartAnchor", () => {
  it("updates widthPx + heightPx", () => {
    const entry: BoxableEntry = { widthPx: 100, heightPx: 50 };
    const resized = resizeChartAnchor(entry, 500, 250);
    expect(resized.widthPx).toBe(500);
    expect(resized.heightPx).toBe(250);
  });

  it("enforces minimum size (60 × 40)", () => {
    const entry: BoxableEntry = { widthPx: 100, heightPx: 50 };
    const resized = resizeChartAnchor(entry, 10, 10);
    expect(resized.widthPx).toBe(60);
    expect(resized.heightPx).toBe(40);
  });

  it("floors fractional values", () => {
    const entry: BoxableEntry = { widthPx: 100, heightPx: 50 };
    const resized = resizeChartAnchor(entry, 123.7, 99.2);
    expect(resized.widthPx).toBe(123);
    expect(resized.heightPx).toBe(99);
  });
});

describe("CHART_MIN_WIDTH_PX / CHART_MIN_HEIGHT_PX constants", () => {
  it("exports CHART_MIN_WIDTH_PX as 60", () => {
    expect(CHART_MIN_WIDTH_PX).toBe(60);
  });

  it("exports CHART_MIN_HEIGHT_PX as 40", () => {
    expect(CHART_MIN_HEIGHT_PX).toBe(40);
  });

  it("resizeChartAnchor uses the exported constants as floor", () => {
    const entry: BoxableEntry = { widthPx: 200, heightPx: 200 };
    const resized = resizeChartAnchor(entry, 0, 0);
    expect(resized.widthPx).toBe(CHART_MIN_WIDTH_PX);
    expect(resized.heightPx).toBe(CHART_MIN_HEIGHT_PX);
  });
});

// ---------------------------------------------------------------------------
// Snapshot persistence logic (Step 5) — unit tests for the pure transform
// that handleChartAnchorChange performs inside EditorScreen.
// We test the logic directly rather than mounting the full component.
// ---------------------------------------------------------------------------
describe("chart anchor snapshot persistence (Step 5)", () => {
  function makeSnapshotWithChart(
    sheetId: string,
    charts: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      sheetOrder: [sheetId],
      sheets: {
        [sheetId]: {
          name: "Sheet1",
          cellData: {
            "0": { "0": { v: "Q1" }, "1": { v: "Q2" } },
            "1": { "0": { v: 10 }, "1": { v: 20 } },
          },
          _charts: charts,
        },
      },
    };
  }

  /**
   * Replicates the pure snapshot-mutation logic from handleChartAnchorChange
   * without any React / Zustand dependency.
   */
  function applyAnchorChange(
    snapshot: Record<string, unknown>,
    sheetId: string,
    chartIndex: number,
    updated: Record<string, unknown>,
  ): Record<string, unknown> {
    const sheets = (snapshot.sheets as Record<string, Record<string, unknown>> | undefined) ?? {};
    const sheetObj = sheets[sheetId];
    if (!sheetObj) return snapshot;
    const existing = Array.isArray(sheetObj._charts)
      ? (sheetObj._charts as Array<Record<string, unknown>>)
      : [];
    if (chartIndex < 0 || chartIndex >= existing.length) return snapshot;
    const next = existing.map((c, i) => (i === chartIndex ? { ...c, ...updated } : c));
    return {
      ...snapshot,
      sheets: {
        ...sheets,
        [sheetId]: { ...sheetObj, _charts: next },
      },
    };
  }

  it("updates anchorRow/anchorCol/widthPx/heightPx for the target chart", () => {
    const snap = makeSnapshotWithChart("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const updated = { anchorRow: 3, anchorCol: 2, widthPx: 480, heightPx: 300 };
    const next = applyAnchorChange(snap, "s1", 0, updated);
    const charts = (next.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._charts as Array<Record<string, unknown>>;
    expect(charts[0].anchorRow).toBe(3);
    expect(charts[0].anchorCol).toBe(2);
    expect(charts[0].widthPx).toBe(480);
    expect(charts[0].heightPx).toBe(300);
  });

  it("does not mutate other charts in the array", () => {
    const snap = makeSnapshotWithChart("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 200, heightPx: 150 },
      { range: "C1:D2", type: "line", anchorRow: 0, anchorCol: 4, widthPx: 200, heightPx: 150 },
    ]);
    const updated = { anchorRow: 5, anchorCol: 1, widthPx: 200, heightPx: 150 };
    const next = applyAnchorChange(snap, "s1", 0, updated);
    const charts = (next.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._charts as Array<Record<string, unknown>>;
    // chart[0] updated
    expect(charts[0].anchorRow).toBe(5);
    // chart[1] untouched
    expect(charts[1].anchorCol).toBe(4);
  });

  it("preserves existing chart fields not in the updated payload", () => {
    const snap = makeSnapshotWithChart("s1", [
      { range: "A1:B2", type: "pie", title: "Revenue", anchorRow: 0, anchorCol: 0, widthPx: 300, heightPx: 200 },
    ]);
    const updated = { anchorRow: 1, anchorCol: 1, widthPx: 300, heightPx: 200 };
    const next = applyAnchorChange(snap, "s1", 0, updated);
    const charts = (next.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._charts as Array<Record<string, unknown>>;
    expect(charts[0].type).toBe("pie");
    expect(charts[0].title).toBe("Revenue");
    expect(charts[0].range).toBe("A1:B2");
  });

  it("does not mutate the original snapshot object", () => {
    const snap = makeSnapshotWithChart("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const origChart = ((snap.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._charts as Array<Record<string, unknown>>)[0];
    applyAnchorChange(snap, "s1", 0, { anchorRow: 99, anchorCol: 99, widthPx: 480, heightPx: 300 });
    // original should be unchanged
    expect(origChart.anchorRow).toBe(0);
  });

  it("returns snapshot unchanged when chartIndex is out of bounds", () => {
    const snap = makeSnapshotWithChart("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const result = applyAnchorChange(snap, "s1", 5, { anchorRow: 99, anchorCol: 99, widthPx: 100, heightPx: 100 });
    const charts = (result.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._charts as Array<Record<string, unknown>>;
    expect(charts[0].anchorRow).toBe(0);
  });

  it("returns snapshot unchanged when sheetId does not exist", () => {
    const snap = makeSnapshotWithChart("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const result = applyAnchorChange(snap, "s99", 0, { anchorRow: 5, anchorCol: 5, widthPx: 200, heightPx: 100 });
    // s1 charts should be untouched
    const charts = (result.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._charts as Array<Record<string, unknown>>;
    expect(charts[0].anchorRow).toBe(0);
  });

  it("round-trip: serialize → deserialize → anchor fields are preserved", () => {
    const snap = makeSnapshotWithChart("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const updated = { anchorRow: 7, anchorCol: 3, widthPx: 320, heightPx: 180 };
    const next = applyAnchorChange(snap, "s1", 0, updated);
    // Simulate xlsx round-trip by JSON serializing and re-parsing.
    const roundTripped = JSON.parse(JSON.stringify(next)) as typeof next;
    const charts = (roundTripped.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._charts as Array<Record<string, unknown>>;
    expect(charts[0].anchorRow).toBe(7);
    expect(charts[0].anchorCol).toBe(3);
    expect(charts[0].widthPx).toBe(320);
    expect(charts[0].heightPx).toBe(180);
  });
});

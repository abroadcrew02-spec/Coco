import { describe, it, expect } from "vitest";
import {
  bakeDefaultAnchor,
  moveChartAnchor,
  resizeChartAnchor,
  resolveChartBox,
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

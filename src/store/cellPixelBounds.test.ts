import { describe, it, expect } from "vitest";
import {
  cellBoundsPx,
  defaultChartAnchorPx,
  rangeBoundsPx,
  type SheetPixelLayout,
} from "./cellPixelBounds";

// #236 In-grid chart foundation — pure pixel-bounds helper tests.

const DEFAULT_COL = 73;
const DEFAULT_ROW = 19;
const HEADER_LEFT = 46;
const HEADER_TOP = 20;

describe("cellBoundsPx", () => {
  it("A1 is just past the header offsets", () => {
    const b = cellBoundsPx({}, 0, 0);
    expect(b.left).toBe(HEADER_LEFT);
    expect(b.top).toBe(HEADER_TOP);
    expect(b.width).toBe(DEFAULT_COL);
    expect(b.height).toBe(DEFAULT_ROW);
  });

  it("B1 is shifted right by one default column width", () => {
    const b = cellBoundsPx({}, 0, 1);
    expect(b.left).toBe(HEADER_LEFT + DEFAULT_COL);
    expect(b.top).toBe(HEADER_TOP);
  });

  it("A2 is shifted down by one default row height", () => {
    const b = cellBoundsPx({}, 1, 0);
    expect(b.left).toBe(HEADER_LEFT);
    expect(b.top).toBe(HEADER_TOP + DEFAULT_ROW);
  });

  it("per-column width override is honoured", () => {
    const layout: SheetPixelLayout = { columnData: { "0": { w: 100 } } };
    const b = cellBoundsPx(layout, 0, 1);
    // B1.left = headerLeft + 100 (not + 73).
    expect(b.left).toBe(HEADER_LEFT + 100);
    expect(b.width).toBe(DEFAULT_COL);
  });

  it("per-row height override is honoured", () => {
    const layout: SheetPixelLayout = { rowData: { "0": { h: 50 } } };
    const b = cellBoundsPx(layout, 1, 0);
    expect(b.top).toBe(HEADER_TOP + 50);
  });

  it("hidden columns/rows contribute 0 px", () => {
    const layout: SheetPixelLayout = {
      columnData: { "0": { hd: 1 } },
      rowData: { "0": { hd: 1 } },
    };
    const b = cellBoundsPx(layout, 1, 1);
    // B2.left = headerLeft + (col 0 hidden = 0 px) → sits flush against header.
    expect(b.left).toBe(HEADER_LEFT);
    expect(b.top).toBe(HEADER_TOP);
  });

  it("sheet-level defaults override the constants", () => {
    const layout: SheetPixelLayout = { defaultColumnWidth: 50, defaultRowHeight: 25 };
    const b = cellBoundsPx(layout, 1, 1);
    expect(b.left).toBe(HEADER_LEFT + 50);
    expect(b.top).toBe(HEADER_TOP + 25);
  });

  it("opts-level header offsets override the defaults", () => {
    const b = cellBoundsPx({}, 0, 0, {
      headerOffsetLeft: 0,
      headerOffsetTop: 0,
    });
    expect(b.left).toBe(0);
    expect(b.top).toBe(0);
  });

  it("ignores non-finite or negative widths/heights", () => {
    const layout: SheetPixelLayout = {
      columnData: { "0": { w: -10 } },
      rowData: { "0": { h: NaN } },
    };
    const b = cellBoundsPx(layout, 0, 0);
    // Negative/NaN dropped → fall back to default.
    // Negative is accepted only if Number.isFinite returns true AND >= 0;
    // -10 passes isFinite but fails >=0, so default applies. NaN fails isFinite.
    expect(b.width).toBe(DEFAULT_COL);
    expect(b.height).toBe(DEFAULT_ROW);
  });
});

describe("rangeBoundsPx", () => {
  it("returns the anchor cell's bounds for a single-cell range", () => {
    const b = rangeBoundsPx({}, { r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(b).toEqual({
      left: HEADER_LEFT,
      top: HEADER_TOP,
      width: DEFAULT_COL,
      height: DEFAULT_ROW,
    });
  });

  it("sums widths and heights for a multi-cell range", () => {
    const b = rangeBoundsPx({}, { r1: 0, c1: 0, r2: 1, c2: 2 });
    // 3 cols wide × 2 rows tall
    expect(b.width).toBe(3 * DEFAULT_COL);
    expect(b.height).toBe(2 * DEFAULT_ROW);
  });

  it("normalises swapped corners", () => {
    const a = rangeBoundsPx({}, { r1: 1, c1: 0, r2: 0, c2: 1 });
    const b = rangeBoundsPx({}, { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(a).toEqual(b);
  });

  it("returns zero-bounds for negative corners", () => {
    expect(rangeBoundsPx({}, { r1: -1, c1: 0, r2: 5, c2: 5 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });

  it("handles overrides per row/col when summing", () => {
    const layout: SheetPixelLayout = {
      columnData: { "0": { w: 200 }, "1": { w: 50 } },
      rowData: { "0": { h: 50 } },
    };
    const b = rangeBoundsPx(layout, { r1: 0, c1: 0, r2: 0, c2: 1 });
    // width = 200 + 50 = 250, height = 50
    expect(b.width).toBe(250);
    expect(b.height).toBe(50);
  });
});

describe("defaultChartAnchorPx", () => {
  it("anchors to the right of the source range with a column-gap", () => {
    const a = defaultChartAnchorPx({}, { r1: 0, c1: 0, r2: 4, c2: 1 });
    // source spans cols 0-1, so right edge = header + 2*defaultCol.
    // anchor.left = right edge + one column-gap.
    expect(a.left).toBe(HEADER_LEFT + 2 * DEFAULT_COL + DEFAULT_COL);
    expect(a.top).toBe(HEADER_TOP);
    expect(a.width).toBe(480);
    expect(a.height).toBe(300);
  });

  it("respects sheet-level default column width when computing the gap", () => {
    const layout: SheetPixelLayout = { defaultColumnWidth: 100 };
    const a = defaultChartAnchorPx(layout, { r1: 0, c1: 0, r2: 0, c2: 0 });
    // anchor.left = HEADER_LEFT + 1*100 (range) + 100 (gap)
    expect(a.left).toBe(HEADER_LEFT + 100 + 100);
  });

  it("includes default chart dimensions (480 × 300)", () => {
    const a = defaultChartAnchorPx({}, { r1: 5, c1: 5, r2: 6, c2: 6 });
    expect(a.width).toBe(480);
    expect(a.height).toBe(300);
  });
});

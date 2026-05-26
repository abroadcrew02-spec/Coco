import { describe, it, expect } from "vitest";
import {
  inferDataType,
  optionsByCategory,
  QUICK_ANALYSIS_OPTIONS,
  recommendForRange,
} from "./quickAnalysis";

// Regression suite for quickAnalysis.ts (339 lines, no tests).

describe("QUICK_ANALYSIS_OPTIONS", () => {
  it("contains the core categories", () => {
    const cats = new Set(QUICK_ANALYSIS_OPTIONS.map((o) => o.category));
    expect(cats.has("format")).toBe(true);
    expect(cats.has("chart")).toBe(true);
    expect(cats.has("total")).toBe(true);
  });

  it("every option has id + label + description", () => {
    for (const o of QUICK_ANALYSIS_OPTIONS) {
      expect(o.id.length).toBeGreaterThan(0);
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.description.length).toBeGreaterThan(0);
    }
  });
});

describe("inferDataType", () => {
  it("classifies all-numeric ranges", () => {
    expect(inferDataType([[1, 2, 3], [4, 5, 6]])).toBe("all-numeric");
  });

  it("classifies all-text ranges", () => {
    expect(inferDataType([["a", "b"], ["c", "d"]])).toBe("all-text");
  });

  it("detects header-data shape when body is mostly numeric", () => {
    // 1 row of text headers + body that's >=70% numeric.
    expect(inferDataType([
      ["Q1", "Q2", "Q3", "Q4"],
      [10, 20, 30, 40],
      [11, 21, 31, 41],
    ])).toBe("header-data");
  });

  it("falls back to 'mixed' when no clean pattern", () => {
    expect(inferDataType([[1, "a", 3], ["b", 2, "c"]])).toBe("mixed");
  });

  it("returns 'mixed' for empty / blank slices", () => {
    expect(inferDataType([])).toBe("mixed");
    expect(inferDataType([[]])).toBe("mixed");
    expect(inferDataType([[null, "", null]])).toBe("mixed");
  });

  it("coerces numeric strings to numeric classification", () => {
    expect(inferDataType([["10", "20"], ["30", "40"]])).toBe("all-numeric");
  });
});

describe("recommendForRange", () => {
  it("recommends chart + databar + sparkline for all-numeric ranges", () => {
    const out = recommendForRange([[1, 2, 3], [4, 5, 6]]);
    const ids = out.map((o) => o.id);
    expect(ids).toContain("chart-bar");
    expect(ids).toContain("format-databar");
    expect(ids).toContain("total-sum");
  });

  it("recommends count + table-format + format-clear for all-text ranges", () => {
    const out = recommendForRange([["a", "b"], ["c", "d"]]);
    const ids = out.map((o) => o.id);
    expect(ids).toContain("total-count");
    expect(ids).toContain("format-clear");
  });

  it("recommends table-format + chart-bar for header-data ranges", () => {
    const out = recommendForRange([
      ["Q1", "Q2", "Q3", "Q4"],
      [10, 20, 30, 40],
      [11, 21, 31, 41],
    ]);
    const ids = out.map((o) => o.id);
    expect(ids).toContain("table-format");
    expect(ids).toContain("chart-bar");
    expect(ids).toContain("total-sum");
  });

  it("adds sparkline-line for a single numeric column", () => {
    const out = recommendForRange([[1], [2], [3], [4]]);
    const ids = out.map((o) => o.id);
    expect(ids).toContain("sparkline-line");
  });

  it("preserves catalog order in the result", () => {
    const out = recommendForRange([[1, 2], [3, 4]]);
    const orderedIds = out.map((o) => o.id);
    const catalogIds = QUICK_ANALYSIS_OPTIONS
      .map((o) => o.id)
      .filter((id) => orderedIds.includes(id));
    expect(orderedIds).toEqual(catalogIds);
  });

  it("always returns a non-empty list for non-empty input", () => {
    const out = recommendForRange([["mix", 1, "of stuff"]]);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("optionsByCategory", () => {
  it("groups options by category", () => {
    const groups = optionsByCategory();
    expect(groups.format.length).toBeGreaterThan(0);
    expect(groups.chart.length).toBeGreaterThan(0);
    expect(groups.total.length).toBeGreaterThan(0);
  });

  it("respects an explicit filter", () => {
    const subset = QUICK_ANALYSIS_OPTIONS.filter((o) => o.category === "chart").slice(0, 2);
    const groups = optionsByCategory(subset);
    expect(groups.chart).toHaveLength(2);
    expect(groups.format).toHaveLength(0);
  });
});

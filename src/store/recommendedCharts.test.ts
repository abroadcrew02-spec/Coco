import { describe, it, expect } from "vitest";
import {
  analyzeRange,
  generateMiniSvg,
  type ChartRecommendation,
} from "./recommendedCharts";

// Regression suite for recommendedCharts.ts (480 lines, no tests).

describe("analyzeRange", () => {
  it("returns [] for empty input", () => {
    expect(analyzeRange([], false)).toEqual([]);
    expect(analyzeRange([[]], false)).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(analyzeRange(null as unknown as unknown[][], false)).toEqual([]);
  });

  it("returns recommendations for categorical + numeric data (chart variety)", () => {
    const out = analyzeRange(
      [
        ["Region", "Sales"],
        ["East", 100],
        ["West", 200],
        ["North", 150],
      ],
      true,
    );
    expect(out.length).toBeGreaterThan(0);
    // At minimum, one chart type relevant to categorical breakdowns is present.
    const types = out.map((c) => c.type);
    const hasCategoryFit =
      types.includes("column") ||
      types.includes("bar") ||
      types.includes("pie") ||
      types.includes("doughnut");
    expect(hasCategoryFit).toBe(true);
  });

  it("recommends line for time-series data", () => {
    const out = analyzeRange(
      [
        ["Date", "Sales"],
        ["2024-01", 100],
        ["2024-02", 120],
        ["2024-03", 110],
      ],
      true,
    );
    const types = out.map((c) => c.type);
    expect(types).toContain("line");
  });

  it("recommends pie/doughnut when category count is small", () => {
    const out = analyzeRange(
      [
        ["Category", "Value"],
        ["A", 10],
        ["B", 20],
        ["C", 30],
      ],
      true,
    );
    const types = out.map((c) => c.type);
    expect(types).toContain("pie");
  });

  it("sorts recommendations by descending score", () => {
    const out = analyzeRange(
      [
        ["Region", "Sales"],
        ["East", 100],
        ["West", 200],
      ],
      true,
    );
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  it("caps the result at 5 recommendations", () => {
    const out = analyzeRange(
      [
        ["A", "B", "C"],
        ["x", 1, 10],
        ["y", 2, 20],
        ["z", 3, 30],
      ],
      true,
    );
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("returns recommendations with non-empty SVG previews", () => {
    const out = analyzeRange(
      [
        ["Region", "Sales"],
        ["East", 100],
        ["West", 200],
      ],
      true,
    );
    for (const r of out) {
      expect(r.svgPreview).toContain("<svg");
      expect(r.svgPreview).toContain("</svg>");
    }
  });

  it("excludes recommendations with score 0", () => {
    const out = analyzeRange(
      [["just text", "more text"]],
      false,
    );
    // All scores must be > 0
    for (const r of out) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("attaches a non-empty reason to each recommendation", () => {
    const out = analyzeRange(
      [
        ["X", "Y"],
        ["a", 1],
        ["b", 2],
      ],
      true,
    );
    for (const r of out) {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("generateMiniSvg", () => {
  const sample = {
    seriesNames: ["Sales"],
    categories: ["Jan", "Feb", "Mar", "Apr"],
    values: [[1, 2, 3, 4]],
  };

  it("emits SVG markup", () => {
    const svg = generateMiniSvg("bar", sample);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("handles each supported chart type without throwing", () => {
    const types = ["column", "bar", "line", "area", "pie", "doughnut", "scatter"] as const;
    for (const t of types) {
      expect(() => generateMiniSvg(t, sample)).not.toThrow();
    }
  });

  it("renders an empty-data placeholder for no-data input", () => {
    const svg = generateMiniSvg("bar", { seriesNames: [], categories: [], values: [] });
    expect(svg).toContain("<svg");
  });

  it("handles all-zero data without crashing (no division by zero)", () => {
    const zeros = {
      seriesNames: ["S"],
      categories: ["A", "B", "C"],
      values: [[0, 0, 0]],
    };
    expect(() => generateMiniSvg("bar", zeros)).not.toThrow();
    expect(() => generateMiniSvg("line", zeros)).not.toThrow();
  });
});

describe("ChartRecommendation shape", () => {
  it("includes type / score / reason / svgPreview", () => {
    const out: ChartRecommendation[] = analyzeRange(
      [
        ["Region", "Sales"],
        ["East", 100],
        ["West", 200],
      ],
      true,
    );
    if (out.length > 0) {
      const r = out[0];
      expect(typeof r.type).toBe("string");
      expect(typeof r.score).toBe("number");
      expect(typeof r.reason).toBe("string");
      expect(typeof r.svgPreview).toBe("string");
    }
  });
});

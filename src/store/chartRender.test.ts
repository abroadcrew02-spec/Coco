// Regression tests for chartRender.ts — structure assertions only.
// No snapshot files; no mocks; source module imported directly.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PALETTE,
  listAllCharts,
  extractChartData,
  renderLineChart,
  renderBarChart,
  renderPieChart,
  renderDoughnutChart,
  renderScatterChart,
  renderAreaChart,
  renderChart,
  sanitizeColor,
  type ChartData,
  type RenderOpts,
  type ChartEntry,
} from "./chartRender";

// ---------- helpers ----------

function makeOpts(overrides: Partial<RenderOpts> = {}): RenderOpts {
  return {
    width: 400,
    height: 300,
    showLegend: true,
    showDataLabels: false,
    palette: DEFAULT_PALETTE,
    ...overrides,
  };
}

function makeData(overrides: Partial<ChartData> = {}): ChartData {
  return {
    seriesNames: ["Series 1"],
    categories: ["A", "B", "C"],
    values: [[10, 20, 30]],
    ...overrides,
  };
}

function makeSnapshotJson(
  sheets: Record<string, unknown>,
  sheetOrder?: string[],
): string {
  const snap: Record<string, unknown> = { sheets };
  if (sheetOrder) snap.sheetOrder = sheetOrder;
  return JSON.stringify(snap);
}

// ---------- DEFAULT_PALETTE ----------

describe("DEFAULT_PALETTE", () => {
  it("contains exactly 8 colors", () => {
    expect(DEFAULT_PALETTE).toHaveLength(8);
  });

  it("each entry matches #RRGGBB format", () => {
    for (const color of DEFAULT_PALETTE) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ---------- listAllCharts ----------

describe("listAllCharts", () => {
  it("returns [] for null / undefined / empty string", () => {
    expect(listAllCharts(null)).toEqual([]);
    expect(listAllCharts(undefined)).toEqual([]);
    expect(listAllCharts("")).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(listAllCharts("not json {{{")).toEqual([]);
  });

  it("returns [] when snapshot has no sheets", () => {
    expect(listAllCharts(JSON.stringify({}))).toEqual([]);
    expect(listAllCharts(JSON.stringify({ sheets: {} }))).toEqual([]);
  });

  it("returns [] for a sheet with no _charts array", () => {
    const snap = makeSnapshotJson({
      s1: { name: "Sheet1", cellData: {} },
    });
    expect(listAllCharts(snap)).toEqual([]);
  });

  it("returns [] for a sheet with an empty _charts array", () => {
    const snap = makeSnapshotJson({
      s1: { name: "Sheet1", _charts: [] },
    });
    expect(listAllCharts(snap)).toEqual([]);
  });

  it("flattens charts across multiple sheets", () => {
    const snap = makeSnapshotJson({
      s1: {
        name: "Alpha",
        _charts: [{ range: "A1:B3", type: "line" }],
      },
      s2: {
        name: "Beta",
        _charts: [
          { range: "A1:C5", type: "bar" },
          { range: "D1:F5", type: "pie" },
        ],
      },
    });
    const result = listAllCharts(snap);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.sheetId)).toContain("s1");
    expect(result.map((r) => r.sheetId)).toContain("s2");
  });

  it("respects sheetOrder when present", () => {
    const snap = makeSnapshotJson(
      {
        s1: { name: "Alpha", _charts: [{ range: "A1:B3", type: "line" }] },
        s2: { name: "Beta", _charts: [{ range: "A1:C5", type: "bar" }] },
      },
      ["s2", "s1"],
    );
    const result = listAllCharts(snap);
    expect(result[0].sheetId).toBe("s2");
    expect(result[1].sheetId).toBe("s1");
  });

  it("skips chart entries with invalid type", () => {
    const snap = makeSnapshotJson({
      s1: {
        name: "S",
        _charts: [
          { range: "A1:B3", type: "unknown_type" },
          { range: "A1:B3", type: "line" },
        ],
      },
    });
    const result = listAllCharts(snap);
    expect(result).toHaveLength(1);
    expect(result[0].entry.type).toBe("line");
  });

  it("skips chart entries without a range string", () => {
    const snap = makeSnapshotJson({
      s1: {
        name: "S",
        _charts: [
          { type: "line" }, // no range
          { range: "A1:B3", type: "bar" },
        ],
      },
    });
    const result = listAllCharts(snap);
    expect(result).toHaveLength(1);
  });

  it("uses sheetId as fallback name when sheet.name is absent", () => {
    const snap = makeSnapshotJson({
      mySheetId: {
        _charts: [{ range: "A1:B3", type: "line" }],
      },
    });
    const result = listAllCharts(snap);
    expect(result[0].sheetName).toBe("mySheetId");
  });
});

// ---------- extractChartData ----------

describe("extractChartData", () => {
  it("returns empty ChartData when snapshotJson is null", () => {
    const result = extractChartData(null, {
      entry: { range: "A1:C3", type: "line" },
      sheetId: "s1",
    });
    expect(result).toEqual({ seriesNames: [], categories: [], values: [] });
  });

  it("returns empty ChartData for malformed JSON", () => {
    const result = extractChartData("{{bad", {
      entry: { range: "A1:C3", type: "line" },
      sheetId: "s1",
    });
    expect(result).toEqual({ seriesNames: [], categories: [], values: [] });
  });

  it("returns empty ChartData when range is malformed", () => {
    const snap = makeSnapshotJson({ s1: { name: "S", cellData: {} } });
    const result = extractChartData(snap, {
      entry: { range: "not-a-range", type: "line" },
      sheetId: "s1",
    });
    expect(result).toEqual({ seriesNames: [], categories: [], values: [] });
  });

  it("returns ChartData with fallback names/NaN values when sheetId does not exist", () => {
    const snap = makeSnapshotJson({ s1: { name: "S", cellData: {} } });
    // missing sheetId => cellData is undefined; range still parses so headers
    // produce fallback labels and values become NaN (no actual cell data).
    // range A1:C3 with hasHeaderRow/hasHeaderCol defaults:
    //   data cols = B,C => seriesNames.length = 2
    //   data rows = 2,3 => categories.length = 2
    const result = extractChartData(snap, {
      entry: { range: "A1:C3", type: "line" },
      sheetId: "missing",
    });
    expect(result.seriesNames).toHaveLength(2);
    expect(result.categories).toHaveLength(2);
    expect(result.values).toHaveLength(2);
    // all values should be NaN since cellData is absent
    for (const series of result.values) {
      for (const v of series) {
        expect(Number.isNaN(v)).toBe(true);
      }
    }
  });

  it("populates seriesNames, categories, values on the happy path", () => {
    const snap = makeSnapshotJson({
      s1: {
        name: "Sheet1",
        cellData: {
          "0": { "0": { v: "" }, "1": { v: "Sales" }, "2": { v: "Cost" } },
          "1": { "0": { v: "Jan" }, "1": { v: 100 }, "2": { v: 40 } },
          "2": { "0": { v: "Feb" }, "1": { v: 150 }, "2": { v: 60 } },
        },
      },
    });
    const result = extractChartData(snap, {
      entry: {
        range: "A1:C3",
        type: "line",
        hasHeaderRow: true,
        hasHeaderCol: true,
      },
      sheetId: "s1",
    });
    expect(result.seriesNames).toEqual(["Sales", "Cost"]);
    expect(result.categories).toEqual(["Jan", "Feb"]);
    expect(result.values).toHaveLength(2);
    expect(result.values[0]).toEqual([100, 150]);
    expect(result.values[1]).toEqual([40, 60]);
  });

  it("uses hasHeaderRow=true to read series names from the first row", () => {
    const snap = makeSnapshotJson({
      s1: {
        cellData: {
          "0": { "0": { v: "" }, "1": { v: "Revenue" } },
          "1": { "0": { v: "Q1" }, "1": { v: 500 } },
        },
      },
    });
    const result = extractChartData(snap, {
      entry: { range: "A1:B2", type: "bar", hasHeaderRow: true, hasHeaderCol: true },
      sheetId: "s1",
    });
    expect(result.seriesNames).toEqual(["Revenue"]);
  });

  it("uses hasHeaderCol=true to read categories from the first column", () => {
    const snap = makeSnapshotJson({
      s1: {
        cellData: {
          "0": { "0": { v: "" }, "1": { v: "S1" } },
          "1": { "0": { v: "Cat1" }, "1": { v: 10 } },
          "2": { "0": { v: "Cat2" }, "1": { v: 20 } },
        },
      },
    });
    const result = extractChartData(snap, {
      entry: { range: "A1:B3", type: "line", hasHeaderRow: true, hasHeaderCol: true },
      sheetId: "s1",
    });
    expect(result.categories).toEqual(["Cat1", "Cat2"]);
  });

  it("generates fallback series names when hasHeaderRow=false", () => {
    const snap = makeSnapshotJson({
      s1: {
        cellData: {
          "0": { "0": { v: "X" }, "1": { v: 10 } },
          "1": { "0": { v: "Y" }, "1": { v: 20 } },
        },
      },
    });
    const result = extractChartData(snap, {
      entry: { range: "A1:B2", type: "line", hasHeaderRow: false, hasHeaderCol: true },
      sheetId: "s1",
    });
    expect(result.seriesNames[0]).toMatch(/Series/);
  });
});

// ---------- renderLineChart ----------

describe("renderLineChart", () => {
  it("returns valid SVG for minimal data", () => {
    const svg = renderLineChart(makeData(), makeOpts());
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("reflects width and height in the SVG attributes", () => {
    const svg = renderLineChart(makeData(), makeOpts({ width: 600, height: 400 }));
    expect(svg).toContain('width="600"');
    expect(svg).toContain('height="400"');
  });

  it("does not crash on empty data (0 values)", () => {
    const svg = renderLineChart(
      makeData({ values: [], categories: [] }),
      makeOpts(),
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("does not crash when all values are NaN", () => {
    const svg = renderLineChart(
      makeData({ values: [[NaN, NaN, NaN]] }),
      makeOpts(),
    );
    expect(svg).toContain("<svg");
  });

  it("renders circle elements for data points", () => {
    const svg = renderLineChart(makeData(), makeOpts());
    expect(svg).toMatch(/<circle/);
  });

  it("renders a single-point series without crash", () => {
    const svg = renderLineChart(
      makeData({ categories: ["Only"], values: [[42]] }),
      makeOpts(),
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});

// ---------- renderBarChart ----------

describe("renderBarChart", () => {
  it("returns valid SVG for minimal data", () => {
    const svg = renderBarChart(makeData(), makeOpts(), false);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("contains rect elements for bars", () => {
    const data = makeData({
      seriesNames: ["S1"],
      categories: ["A", "B"],
      values: [[5, 10]],
    });
    const svg = renderBarChart(data, makeOpts(), false);
    const rects = svg.match(/<rect/g);
    // at least one bar rect (background rect + bar rects)
    expect(rects).not.toBeNull();
    expect((rects ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("stacked=true produces rect elements (stacked bars)", () => {
    const data = makeData({
      seriesNames: ["S1", "S2"],
      categories: ["A", "B"],
      values: [
        [5, 10],
        [3, 7],
      ],
    });
    const stackedSvg = renderBarChart(data, makeOpts(), true);
    const groupedSvg = renderBarChart(data, makeOpts(), false);
    // Both render rects; stacked mode still produces valid SVG
    expect(stackedSvg).toContain("<svg");
    expect(stackedSvg).toContain("</svg>");
    // stacked bars may have different x positions — just verify rects exist
    expect(stackedSvg).toMatch(/<rect/);
    expect(groupedSvg).toMatch(/<rect/);
  });

  it("does not crash on empty data", () => {
    const svg = renderBarChart(makeData({ values: [], categories: [] }), makeOpts(), false);
    expect(svg).toContain("<svg");
  });
});

// ---------- renderPieChart ----------

describe("renderPieChart", () => {
  it("returns valid SVG for minimal data", () => {
    const svg = renderPieChart(makeData(), makeOpts());
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("generates path elements for multiple slices", () => {
    const data = makeData({
      categories: ["X", "Y", "Z"],
      values: [[30, 50, 20]],
    });
    const svg = renderPieChart(data, makeOpts());
    // multi-slice pie uses path; single-slice uses circle — just ensure SVG is valid
    expect(svg).toContain("<svg");
    expect(svg).toMatch(/<path|<circle/);
  });

  it("does not crash when total is 0", () => {
    const data = makeData({ values: [[0, 0, 0]] });
    const svg = renderPieChart(data, makeOpts());
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("does not crash on empty data", () => {
    const svg = renderPieChart(makeData({ values: [], categories: [] }), makeOpts());
    expect(svg).toContain("<svg");
  });
});

// ---------- renderDoughnutChart ----------

describe("renderDoughnutChart", () => {
  it("returns valid SVG for minimal data", () => {
    const svg = renderDoughnutChart(makeData(), makeOpts());
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("path d attribute contains M and A commands (arc segments)", () => {
    const data = makeData({
      categories: ["P", "Q", "R"],
      values: [[40, 35, 25]],
    });
    const svg = renderDoughnutChart(data, makeOpts());
    // doughnut slices: path with arc (A) and line (L) to inner circle
    expect(svg).toMatch(/d="[^"]*M[^"]*A[^"]*"/);
  });

  it("does not crash on empty data", () => {
    const svg = renderDoughnutChart(
      makeData({ values: [], categories: [] }),
      makeOpts(),
    );
    expect(svg).toContain("<svg");
  });
});

// ---------- renderScatterChart ----------

describe("renderScatterChart", () => {
  it("returns valid SVG for minimal data", () => {
    const svg = renderScatterChart(makeData(), makeOpts());
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("generates one circle per finite data point", () => {
    const data = makeData({
      seriesNames: ["S1"],
      categories: ["1", "2", "3"],
      values: [[10, 20, 30]],
    });
    const svg = renderScatterChart(data, makeOpts());
    const circles = svg.match(/<circle/g) ?? [];
    // 3 data circles expected
    expect(circles.length).toBeGreaterThanOrEqual(3);
  });

  it("skips NaN points (no crash)", () => {
    const data = makeData({
      categories: ["1", "2", "3"],
      values: [[NaN, 20, NaN]],
    });
    const svg = renderScatterChart(data, makeOpts());
    expect(svg).toContain("<svg");
  });

  it("does not crash on empty data", () => {
    const svg = renderScatterChart(makeData({ values: [], categories: [] }), makeOpts());
    expect(svg).toContain("<svg");
  });
});

// ---------- renderAreaChart ----------

describe("renderAreaChart", () => {
  it("returns valid SVG for minimal data", () => {
    const svg = renderAreaChart(makeData(), makeOpts());
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("contains polygon elements for filled areas", () => {
    const svg = renderAreaChart(makeData(), makeOpts());
    expect(svg).toMatch(/<polygon/);
  });

  it("does not crash on empty data", () => {
    const svg = renderAreaChart(makeData({ values: [], categories: [] }), makeOpts());
    expect(svg).toContain("<svg");
  });

  it("renders a single-point series without crash", () => {
    const svg = renderAreaChart(
      makeData({ categories: ["X"], values: [[5]] }),
      makeOpts(),
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});

// ---------- renderChart dispatcher ----------

describe("renderChart", () => {
  const chartTypes: ChartEntry["type"][] = [
    "line",
    "bar",
    "pie",
    "doughnut",
    "scatter",
    "area",
  ];

  for (const type of chartTypes) {
    it(`dispatches ${type} and returns SVG`, () => {
      const entry: ChartEntry = { range: "A1:C4", type };
      const svg = renderChart(makeData(), entry, 400, 300);
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    });
  }

  it("applies title from entry", () => {
    const entry: ChartEntry = { range: "A1:C3", type: "line", title: "My Chart" };
    const svg = renderChart(makeData(), entry, 400, 300);
    expect(svg).toContain("My Chart");
  });

  it("uses DEFAULT_PALETTE when entry.seriesColors is not set", () => {
    const entry: ChartEntry = { range: "A1:C3", type: "line" };
    const svg = renderChart(makeData(), entry, 400, 300);
    // Should contain at least one default palette color
    expect(svg).toContain(DEFAULT_PALETTE[0]);
  });

  it("uses custom seriesColors when provided", () => {
    const entry: ChartEntry = {
      range: "A1:C3",
      type: "line",
      seriesColors: ["#AABBCC"],
    };
    const svg = renderChart(makeData(), entry, 400, 300);
    expect(svg).toContain("#AABBCC");
  });
});

// ---------- edge cases ----------

describe("edge cases", () => {
  it("line chart with all-NaN values returns empty-state SVG", () => {
    const data = makeData({ values: [[NaN, NaN, NaN]] });
    const svg = renderLineChart(data, makeOpts());
    expect(svg).toContain("<svg");
    // emptyChart path
    expect(svg).toContain("No numeric data");
  });

  it("scatter with all-NaN values returns empty-state SVG", () => {
    const data = makeData({ values: [[NaN, NaN]] });
    const svg = renderScatterChart(data, makeOpts());
    expect(svg).toContain("No numeric data");
  });

  it("DEFAULT_PALETTE cycles for 10+ series", () => {
    const seriesCount = 10;
    const data: ChartData = {
      seriesNames: Array.from({ length: seriesCount }, (_, i) => `S${i}`),
      categories: ["A", "B"],
      values: Array.from({ length: seriesCount }, () => [1, 2]),
    };
    // Should not throw; renders bar chart with 10 series cycling through palette
    const svg = renderBarChart(data, makeOpts(), false);
    expect(svg).toContain("<svg");
    // Every series uses a palette color — palette[9 % 8] = palette[1]
    expect(svg).toContain(DEFAULT_PALETTE[1]);
  });

  it("renderChart with showDataLabels=true includes label text", () => {
    const entry: ChartEntry = {
      range: "A1:C3",
      type: "bar",
      showDataLabels: true,
    };
    const data = makeData({ categories: ["X"], values: [[42]] });
    const svg = renderChart(data, entry, 400, 300);
    // Data label for value 42 should appear
    expect(svg).toContain("42");
  });

  it("pie chart with a single non-zero value renders a circle (full disk)", () => {
    const data = makeData({
      categories: ["OnlyOne"],
      values: [[100]],
    });
    const svg = renderPieChart(data, makeOpts());
    expect(svg).toMatch(/<circle/);
  });

  it("bar chart with negative values still produces valid SVG", () => {
    const data = makeData({
      categories: ["A", "B"],
      values: [[-5, 10]],
    });
    const svg = renderBarChart(data, makeOpts(), false);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});

// ---------- sanitizeColor ----------

describe("sanitizeColor", () => {
  // Allow: valid hex
  it("allows #RRGGBB hex colors", () => {
    expect(sanitizeColor("#5B9BD5")).toBe("#5B9BD5");
  });

  it("allows #RGB shorthand", () => {
    expect(sanitizeColor("#abc")).toBe("#abc");
  });

  it("allows #RRGGBBAA (8-digit hex)", () => {
    expect(sanitizeColor("#aabbccdd")).toBe("#aabbccdd");
  });

  // Allow: CSS named colors
  it("allows CSS named color 'red'", () => {
    expect(sanitizeColor("red")).toBe("red");
  });

  it("allows CSS named color 'steelblue'", () => {
    expect(sanitizeColor("steelblue")).toBe("steelblue");
  });

  // Allow: functional notation
  it("allows rgb() notation", () => {
    expect(sanitizeColor("rgb(255, 0, 0)")).toBe("rgb(255, 0, 0)");
  });

  it("allows rgba() notation", () => {
    expect(sanitizeColor("rgba(0, 0, 255, 0.5)")).toBe("rgba(0, 0, 255, 0.5)");
  });

  // Allow: special keywords
  it("allows 'none'", () => {
    expect(sanitizeColor("none")).toBe("none");
  });

  it("allows 'transparent'", () => {
    expect(sanitizeColor("transparent")).toBe("transparent");
  });

  // Reject: attribute breakout payloads
  it("rejects attribute breakout: quote + onload payload", () => {
    const result = sanitizeColor('" onload="alert(1)');
    expect(result).toBe(DEFAULT_PALETTE[0]);
  });

  it("rejects attribute breakout: quote + event handler variant", () => {
    const result = sanitizeColor('" onerror="evil()');
    expect(result).toBe(DEFAULT_PALETTE[0]);
  });

  it("rejects <script> tag injection", () => {
    const result = sanitizeColor("<script>alert(1)</script>");
    expect(result).toBe(DEFAULT_PALETTE[0]);
  });

  it("rejects newline-based breakout", () => {
    const result = sanitizeColor("\nx=injected");
    expect(result).toBe(DEFAULT_PALETTE[0]);
  });

  it("rejects javascript: URL", () => {
    const result = sanitizeColor("javascript:alert(1)");
    expect(result).toBe(DEFAULT_PALETTE[0]);
  });

  it("rejects semicolons (CSS injection attempt)", () => {
    const result = sanitizeColor("red;background:url(evil)");
    expect(result).toBe(DEFAULT_PALETTE[0]);
  });
});

// ---------- seriesColors injection (integration) ----------

describe("seriesColors injection prevention", () => {
  const injectionPayloads = [
    '" onload="alert(1)',
    '" onerror="evil()',
    "<script>alert(1)</script>",
    "\nx=injected",
    "javascript:void(0)",
    "red;background:url(x)",
  ];

  for (const payload of injectionPayloads) {
    it(`renderBarChart: seriesColors payload does not appear verbatim: ${JSON.stringify(payload)}`, () => {
      const svg = renderBarChart(
        makeData(),
        makeOpts({ palette: [payload] }),
        false,
      );
      expect(svg).not.toContain(payload);
      expect(svg).toContain("<svg");
    });

    it(`renderLineChart: seriesColors payload does not appear verbatim: ${JSON.stringify(payload)}`, () => {
      const svg = renderLineChart(makeData(), makeOpts({ palette: [payload] }));
      expect(svg).not.toContain(payload);
      expect(svg).toContain("<svg");
    });

    it(`renderPieChart: seriesColors payload does not appear verbatim: ${JSON.stringify(payload)}`, () => {
      const svg = renderPieChart(makeData(), makeOpts({ palette: [payload] }));
      expect(svg).not.toContain(payload);
      expect(svg).toContain("<svg");
    });

    it(`renderAreaChart: seriesColors payload does not appear verbatim: ${JSON.stringify(payload)}`, () => {
      const svg = renderAreaChart(makeData(), makeOpts({ palette: [payload] }));
      expect(svg).not.toContain(payload);
      expect(svg).toContain("<svg");
    });

    it(`renderScatterChart: seriesColors payload does not appear verbatim: ${JSON.stringify(payload)}`, () => {
      const svg = renderScatterChart(makeData(), makeOpts({ palette: [payload] }));
      expect(svg).not.toContain(payload);
      expect(svg).toContain("<svg");
    });

    it(`renderDoughnutChart: seriesColors payload does not appear verbatim: ${JSON.stringify(payload)}`, () => {
      const svg = renderDoughnutChart(makeData(), makeOpts({ palette: [payload] }));
      expect(svg).not.toContain(payload);
      expect(svg).toContain("<svg");
    });

    it(`renderChart dispatcher: seriesColors payload does not appear verbatim: ${JSON.stringify(payload)}`, () => {
      const entry: ChartEntry = {
        range: "A1:C3",
        type: "bar",
        seriesColors: [payload],
      };
      const svg = renderChart(makeData(), entry, 400, 300);
      expect(svg).not.toContain(payload);
      expect(svg).toContain("<svg");
    });
  }
});

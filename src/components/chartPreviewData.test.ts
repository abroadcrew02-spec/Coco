// Unit tests for the chart-preview data extraction helpers.

import { describe, it, expect } from "vitest";
import {
  parseRange,
  extractSeries,
  computeChartPreviews,
} from "./chartPreviewData";

describe("parseRange", () => {
  it("parses a single-cell ref", () => {
    expect(parseRange("B2")).toEqual({ r0: 1, r1: 1, c0: 1, c1: 1 });
  });

  it("parses a rectangular range", () => {
    expect(parseRange("A1:C3")).toEqual({ r0: 0, r1: 2, c0: 0, c1: 2 });
  });

  it("normalises reversed corners", () => {
    expect(parseRange("C3:A1")).toEqual({ r0: 0, r1: 2, c0: 0, c1: 2 });
  });

  it("strips sheet qualifier and absolute markers", () => {
    expect(parseRange("Sheet1!$A$1:$B$5")).toEqual({ r0: 0, r1: 4, c0: 0, c1: 1 });
  });

  it("returns null on malformed input", () => {
    expect(parseRange("foo")).toBeNull();
    expect(parseRange("")).toBeNull();
    expect(parseRange("A0")).toBeNull();
  });
});

describe("extractSeries", () => {
  it("reads labels from col 0 and values from col 1 for 2-col ranges", () => {
    const cellData = {
      "0": { "0": { v: "Jan" }, "1": { v: 10 } },
      "1": { "0": { v: "Feb" }, "1": { v: 20 } },
      "2": { "0": { v: "Mar" }, "1": { v: 30 } },
    };
    const got = extractSeries(cellData, { r0: 0, r1: 2, c0: 0, c1: 1 });
    expect(got).toEqual({ labels: ["Jan", "Feb", "Mar"], data: [10, 20, 30] });
  });

  it("skips rows where the value column is non-numeric", () => {
    const cellData = {
      "0": { "0": { v: "A" }, "1": { v: 10 } },
      "1": { "0": { v: "B" }, "1": { v: "text" } },
      "2": { "0": { v: "C" }, "1": { v: 30 } },
    };
    const got = extractSeries(cellData, { r0: 0, r1: 2, c0: 0, c1: 1 });
    expect(got).toEqual({ labels: ["A", "C"], data: [10, 30] });
  });

  it("coerces numeric strings into numbers", () => {
    const cellData = {
      "0": { "0": { v: "X" }, "1": { v: "42" } },
    };
    const got = extractSeries(cellData, { r0: 0, r1: 0, c0: 0, c1: 1 });
    expect(got).toEqual({ labels: ["X"], data: [42] });
  });

  it("falls back to row-index labels for single-column ranges", () => {
    const cellData = {
      "0": { "0": { v: 5 } },
      "1": { "0": { v: 7 } },
      "2": { "0": { v: 11 } },
    };
    const got = extractSeries(cellData, { r0: 0, r1: 2, c0: 0, c1: 0 });
    expect(got).toEqual({ labels: ["1", "2", "3"], data: [5, 7, 11] });
  });

  it("returns empty series when cellData is missing", () => {
    const got = extractSeries(undefined, { r0: 0, r1: 2, c0: 0, c1: 1 });
    expect(got).toEqual({ labels: [], data: [] });
  });
});

describe("computeChartPreviews", () => {
  it("flattens charts across sheets preserving sheetOrder", () => {
    const snapshot = {
      sheetOrder: ["s2", "s1"],
      sheets: {
        s1: {
          name: "Alpha",
          cellData: {
            "0": { "0": { v: "Q1" }, "1": { v: 100 } },
            "1": { "0": { v: "Q2" }, "1": { v: 150 } },
          },
          _charts: [{ range: "A1:B2", type: "bar", title: "Sales" }],
        },
        s2: {
          name: "Beta",
          cellData: {
            "0": { "0": { v: 1 } },
            "1": { "0": { v: 2 } },
            "2": { "0": { v: 3 } },
          },
          _charts: [{ range: "A1:A3", type: "line" }],
        },
      },
    };
    const got = computeChartPreviews(JSON.stringify(snapshot));
    expect(got).toHaveLength(2);
    // sheetOrder dictates iteration: s2 first, then s1.
    expect(got[0]).toMatchObject({
      sheetId: "s2",
      sheetName: "Beta",
      range: "A1:A3",
      type: "line",
      labels: ["1", "2", "3"],
      data: [1, 2, 3],
    });
    expect(got[0].title).toBeUndefined();
    expect(got[1]).toMatchObject({
      sheetId: "s1",
      sheetName: "Alpha",
      range: "A1:B2",
      type: "bar",
      title: "Sales",
      labels: ["Q1", "Q2"],
      data: [100, 150],
    });
  });

  it("returns [] on null / malformed / empty input", () => {
    expect(computeChartPreviews(null)).toEqual([]);
    expect(computeChartPreviews("")).toEqual([]);
    expect(computeChartPreviews("not json")).toEqual([]);
    expect(computeChartPreviews(JSON.stringify({ sheets: {} }))).toEqual([]);
  });

  it("silently skips entries with unknown chart types or bad ranges", () => {
    const snapshot = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          cellData: { "0": { "0": { v: 1 } } },
          _charts: [
            { range: "A1", type: "scatter" }, // unsupported type
            { range: "not-a-range", type: "bar" }, // malformed range
            { range: "A1", type: "bar" }, // ok
          ],
        },
      },
    };
    const got = computeChartPreviews(JSON.stringify(snapshot));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ range: "A1", type: "bar" });
  });
});

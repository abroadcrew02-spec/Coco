import { describe, it, expect } from "vitest";
import { computeSnapshotStats, formatSnapshotStats } from "./snapshotStats";

describe("computeSnapshotStats", () => {
  it("returns zero counts for null / undefined / empty input", () => {
    expect(computeSnapshotStats(null)).toEqual({ sheetCount: 0, cellCount: 0 });
    expect(computeSnapshotStats(undefined)).toEqual({ sheetCount: 0, cellCount: 0 });
    expect(computeSnapshotStats("")).toEqual({ sheetCount: 0, cellCount: 0 });
  });

  it("returns zero counts for malformed JSON without throwing", () => {
    expect(computeSnapshotStats("not json")).toEqual({ sheetCount: 0, cellCount: 0 });
    expect(computeSnapshotStats("{")).toEqual({ sheetCount: 0, cellCount: 0 });
  });

  it("returns zero counts when sheets is missing", () => {
    expect(computeSnapshotStats("{}")).toEqual({ sheetCount: 0, cellCount: 0 });
  });

  it("counts a single-cell single-sheet workbook", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: { cellData: { "0": { "0": { v: "hello" } } } } },
    });
    expect(computeSnapshotStats(snap)).toEqual({ sheetCount: 1, cellCount: 1 });
  });

  it("counts cells across multiple rows and columns", () => {
    const snap = JSON.stringify({
      sheets: {
        s1: {
          cellData: {
            "0": { "0": {}, "1": {}, "2": {} },
            "1": { "0": {} },
            "5": { "9": {} },
          },
        },
      },
    });
    expect(computeSnapshotStats(snap)).toEqual({ sheetCount: 1, cellCount: 5 });
  });

  it("aggregates cells across multiple sheets", () => {
    const snap = JSON.stringify({
      sheets: {
        s1: { cellData: { "0": { "0": {} } } },
        s2: { cellData: { "0": { "0": {}, "1": {} } } },
        s3: { cellData: {} },
      },
    });
    expect(computeSnapshotStats(snap)).toEqual({ sheetCount: 3, cellCount: 3 });
  });

  it("ignores sheets without cellData", () => {
    const snap = JSON.stringify({
      sheets: {
        s1: { name: "Empty" },
        s2: { cellData: { "0": { "0": {} } } },
      },
    });
    expect(computeSnapshotStats(snap)).toEqual({ sheetCount: 2, cellCount: 1 });
  });

  it("returns sheetCount > 0 even when all cells are empty", () => {
    const snap = JSON.stringify({
      sheets: { s1: { cellData: {} }, s2: { cellData: {} } },
    });
    expect(computeSnapshotStats(snap)).toEqual({ sheetCount: 2, cellCount: 0 });
  });
});

describe("formatSnapshotStats", () => {
  it("returns null for an entirely empty workbook (no sheets, no cells)", () => {
    expect(formatSnapshotStats({ sheetCount: 0, cellCount: 0 })).toBeNull();
  });

  it("formats sheets + cells with Japanese thousands separators", () => {
    expect(formatSnapshotStats({ sheetCount: 1, cellCount: 5 })).toBe("1 シート · 5 セル");
    expect(formatSnapshotStats({ sheetCount: 3, cellCount: 12_345 })).toBe(
      "3 シート · 12,345 セル"
    );
  });

  it("returns a non-null label even when only sheets exist (zero cells)", () => {
    expect(formatSnapshotStats({ sheetCount: 2, cellCount: 0 })).toBe("2 シート · 0 セル");
  });
});

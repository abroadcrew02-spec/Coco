import { describe, it, expect } from "vitest";
import { extractCellStyle, applyCellStyle } from "./formatPainter";

describe("extractCellStyle", () => {
  it("returns null for null/empty/malformed input", () => {
    expect(extractCellStyle(null, "s1", 0, 0)).toBeNull();
    expect(extractCellStyle(undefined, "s1", 0, 0)).toBeNull();
    expect(extractCellStyle("", "s1", 0, 0)).toBeNull();
    expect(extractCellStyle("not json {", "s1", 0, 0)).toBeNull();
  });

  it("returns null when the sheet/cell is missing", () => {
    const snap = JSON.stringify({ sheets: { s1: { cellData: {} } } });
    expect(extractCellStyle(snap, "missing", 0, 0)).toBeNull();
    expect(extractCellStyle(snap, "s1", 5, 5)).toBeNull();
  });

  it("returns null when the cell has no s field", () => {
    const snap = JSON.stringify({
      sheets: { s1: { cellData: { 0: { 0: { v: 42 } } } } },
    });
    expect(extractCellStyle(snap, "s1", 0, 0)).toBeNull();
  });

  it("returns an inline style object copy", () => {
    const style = { bg: { rgb: "#ff0000" }, ff: "Arial" };
    const snap = JSON.stringify({
      sheets: { s1: { cellData: { 2: { 3: { s: style, v: "x" } } } } },
    });
    const result = extractCellStyle(snap, "s1", 2, 3);
    expect(result).toEqual(style);
    // Returned object is a clone, not the original reference.
    expect(result).not.toBe(style);
  });

  it("resolves a style-id reference through workbook.styles", () => {
    const snap = JSON.stringify({
      styles: { "style-a": { bg: { rgb: "#00ff00" } } },
      sheets: { s1: { cellData: { 0: { 0: { s: "style-a" } } } } },
    });
    expect(extractCellStyle(snap, "s1", 0, 0)).toEqual({ bg: { rgb: "#00ff00" } });
  });

  it("returns null when a style-id reference doesn't resolve", () => {
    const snap = JSON.stringify({
      styles: {},
      sheets: { s1: { cellData: { 0: { 0: { s: "missing-id" } } } } },
    });
    expect(extractCellStyle(snap, "s1", 0, 0)).toBeNull();
  });
});

describe("applyCellStyle", () => {
  const baseSnapshot = () =>
    JSON.stringify({
      sheets: {
        s1: {
          cellData: {
            0: { 0: { v: "hello" } },
          },
        },
      },
    });

  it("returns the input unchanged for null/empty style", () => {
    const snap = baseSnapshot();
    expect(applyCellStyle(snap, "s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, null)).toBe(snap);
    expect(applyCellStyle(snap, "s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, {})).toBe(snap);
  });

  it("returns the input unchanged for a degenerate range", () => {
    const snap = baseSnapshot();
    const style = { bg: { rgb: "#ff0000" } };
    expect(applyCellStyle(snap, "s1", { startRow: 2, endRow: 1, startCol: 0, endCol: 0 }, style)).toBe(snap);
    expect(applyCellStyle(snap, "s1", { startRow: 0, endRow: 0, startCol: 5, endCol: 3 }, style)).toBe(snap);
  });

  it("returns the input unchanged when the sheet doesn't exist", () => {
    const snap = baseSnapshot();
    const style = { bg: { rgb: "#ff0000" } };
    expect(applyCellStyle(snap, "missing", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, style)).toBe(snap);
  });

  it("applies the style to a single existing cell and preserves its value", () => {
    const snap = baseSnapshot();
    const style = { bg: { rgb: "#ff0000" } };
    const result = applyCellStyle(snap, "s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, style);
    const parsed = JSON.parse(result) as {
      sheets: { s1: { cellData: { [r: string]: { [c: string]: { s?: unknown; v?: unknown } } } } };
    };
    expect(parsed.sheets.s1.cellData["0"]["0"].v).toBe("hello");
    expect(parsed.sheets.s1.cellData["0"]["0"].s).toEqual(style);
  });

  it("creates missing cells when applying to a blank region", () => {
    const snap = baseSnapshot();
    const style = { ff: "Arial" };
    const result = applyCellStyle(snap, "s1", { startRow: 1, endRow: 2, startCol: 1, endCol: 2 }, style);
    const parsed = JSON.parse(result) as {
      sheets: { s1: { cellData: { [r: string]: { [c: string]: { s?: unknown } } } } };
    };
    expect(parsed.sheets.s1.cellData["1"]["1"].s).toEqual(style);
    expect(parsed.sheets.s1.cellData["1"]["2"].s).toEqual(style);
    expect(parsed.sheets.s1.cellData["2"]["1"].s).toEqual(style);
    expect(parsed.sheets.s1.cellData["2"]["2"].s).toEqual(style);
  });

  it("clones the style per cell so later mutation doesn't bleed across targets", () => {
    const snap = baseSnapshot();
    const style: Record<string, unknown> = { bg: { rgb: "#ff0000" } };
    const result = applyCellStyle(snap, "s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 1 }, style);
    const parsed = JSON.parse(result) as {
      sheets: { s1: { cellData: { [r: string]: { [c: string]: { s?: Record<string, unknown> } } } } };
    };
    // After parsing back, each cell holds its own object — mutating one
    // doesn't reach the other.
    const a = parsed.sheets.s1.cellData["0"]["0"].s!;
    const b = parsed.sheets.s1.cellData["0"]["1"].s!;
    expect(a).not.toBe(b);
    a.ff = "Calibri";
    expect(b.ff).toBeUndefined();
  });

  it("does not mutate the caller's snapshot string", () => {
    const snap = baseSnapshot();
    const style = { bg: { rgb: "#0000ff" } };
    applyCellStyle(snap, "s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, style);
    // Re-parse and confirm the original is untouched.
    const reparsed = JSON.parse(snap) as {
      sheets: { s1: { cellData: { [r: string]: { [c: string]: { s?: unknown } } } } };
    };
    expect(reparsed.sheets.s1.cellData["0"]["0"].s).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { isDefaultFormat } from "@univerjs/core";
import {
  GENERAL_PATTERN,
  NUMBER_FORMAT_MAX_CELLS,
  clearPatternFor,
  existingCellsInRect,
  normalizeNumberFormatCode,
  planSteppedNumberFormat,
  planUniformNumberFormat,
  resolveCellNumberFormat,
  runNumberFormatJob,
  styleLookupFromTable,
  type NumberFormatDeps,
  type NumberFormatJob,
  type NumfmtSheet,
  type SheetCellData,
} from "./numberFormat";

type Cell = Record<string, unknown>;
type Styles = Record<string, Record<string, unknown>>;

/**
 * Minimal stand-in for Univer's live model + the numfmt facade. Applying a
 * pattern behaves like @univerjs/sheets NumfmtService.setValues/deleteValues:
 * the cell's resolved style gets `n` set (or removed) and is interned into
 * the styles table under an id, so the cell ends up with a string `s`.
 * Clearing a cell that doesn't exist is a no-op, as in deleteValues.
 */
function fakeWorkbook(styles: Styles, cellData: SheetCellData) {
  let generated = 0;
  const intern = (style: Record<string, unknown>): string => {
    const key = JSON.stringify(style);
    for (const [id, s] of Object.entries(styles)) {
      if (JSON.stringify(s) === key) return id;
    }
    generated += 1;
    const id = `gen${generated}`;
    styles[id] = style;
    return id;
  };
  const setPattern = (row: number, col: number, pattern: string): void => {
    const rowObj = (cellData[String(row)] ??= {});
    const existing = rowObj[String(col)] as Cell | undefined;
    if (!pattern && !existing) return;
    const cell = existing ?? {};
    const base: Record<string, unknown> =
      typeof cell.s === "string"
        ? { ...(styles[cell.s] ?? {}) }
        : { ...((cell.s as Record<string, unknown> | undefined) ?? {}) };
    if (pattern) base.n = { pattern };
    else delete base.n;
    cell.s = intern(base);
    rowObj[String(col)] = cell;
  };

  const rangeCalls: Array<{
    at: [number, number, number, number];
    pattern?: string;
    patterns?: string[][];
  }> = [];
  const cellCalls: Array<{ sheetId: string; writes: unknown[] }> = [];

  const sheet: NumfmtSheet = {
    getRange(row, col, numRows, numCols) {
      return {
        setNumberFormat(pattern: string) {
          rangeCalls.push({ at: [row, col, numRows, numCols], pattern });
          for (let r = row; r < row + numRows; r++) {
            for (let c = col; c < col + numCols; c++) setPattern(r, c, pattern);
          }
          return this;
        },
        setNumberFormats(patterns: string[][]) {
          rangeCalls.push({ at: [row, col, numRows, numCols], patterns });
          for (let r = row; r < row + numRows; r++) {
            for (let c = col; c < col + numCols; c++) {
              setPattern(r, c, patterns[r - row]?.[c - col] ?? "");
            }
          }
          return this;
        },
      };
    },
  };

  const deps: NumberFormatDeps = {
    getSheet: (sheetId) => (sheetId === "s1" ? sheet : null),
    setCells: (sheetId, writes) => {
      cellCalls.push({ sheetId, writes });
      for (const w of writes) setPattern(w.row, w.col, w.pattern);
      return true;
    },
  };

  const cell = (row: number, col: number) =>
    cellData[String(row)]?.[String(col)] as Cell | undefined;
  const patternAt = (row: number, col: number) =>
    resolveCellNumberFormat(cell(row, col), (id) => styles[id]);

  return { deps, rangeCalls, cellCalls, cell, patternAt, styles, cellData };
}

// Canary for the "General" marker: Nicel writes n.pattern = "General" to mean
// "no format" on cells with an imported _fmt. That only renders as no format
// while Univer's isDefaultFormat keeps matching exactly "General".
describe("Univer isDefaultFormat (canary for GENERAL_PATTERN)", () => {
  it("treats GENERAL_PATTERN as the default format", () => {
    expect(GENERAL_PATTERN).toBe("General");
    expect(isDefaultFormat("General")).toBe(true);
    expect(isDefaultFormat(GENERAL_PATTERN)).toBe(true);
  });

  it("is case-sensitive, which is why Nicel always writes the exact spelling", () => {
    expect(isDefaultFormat("general")).toBe(false);
  });
});

describe("normalizeNumberFormatCode", () => {
  it("trims and maps General (any case) to the empty 'no format' code", () => {
    expect(normalizeNumberFormatCode("  #,##0.00 ")).toBe("#,##0.00");
    expect(normalizeNumberFormatCode("General")).toBe("");
    expect(normalizeNumberFormatCode(" general ")).toBe("");
    expect(normalizeNumberFormatCode("")).toBe("");
  });
});

describe("resolveCellNumberFormat", () => {
  const lookup = styleLookupFromTable({ st1: { bl: 1, n: { pattern: "0.00%" } }, st2: { bl: 1 } });

  it("reads n.pattern through a style id", () => {
    expect(resolveCellNumberFormat({ s: "st1" }, lookup)).toBe("0.00%");
  });

  it("reads n.pattern from an inline style object", () => {
    expect(resolveCellNumberFormat({ s: { n: { pattern: "#,##0" } } }, lookup)).toBe("#,##0");
  });

  it("prefers a non-empty style pattern over the _fmt sidecar", () => {
    expect(resolveCellNumberFormat({ s: "st1", _fmt: "0%" }, lookup)).toBe("0.00%");
  });

  it("reads _fmt when the style id resolves to a style without n.pattern (bold only)", () => {
    const styles = styleLookupFromTable({ s1: { bl: 1 } });
    expect(resolveCellNumberFormat({ v: 0.5, _fmt: "0%", s: "s1" }, styles)).toBe("0%");
    expect(resolveCellNumberFormat({ s: "st2", _fmt: "yyyy-mm-dd" }, lookup)).toBe("yyyy-mm-dd");
  });

  it("imported cell with a different style pattern reads the style pattern", () => {
    const styles = styleLookupFromTable({ s1: { n: { pattern: "#,##0.00" } } });
    expect(resolveCellNumberFormat({ v: 0.5, _fmt: "0%", s: "s1" }, styles)).toBe("#,##0.00");
  });

  it("reads a style pattern of General (any case) as no format, hiding _fmt", () => {
    const styles = styleLookupFromTable({
      s2: { n: { pattern: "General" } },
      lower: { n: { pattern: "general" } },
    });
    expect(resolveCellNumberFormat({ _fmt: "0%", s: "s2" }, styles)).toBe("");
    expect(resolveCellNumberFormat({ _fmt: "0%", s: "lower" }, styles)).toBe("");
    expect(resolveCellNumberFormat({ s: "s2" }, styles)).toBe("");
    expect(resolveCellNumberFormat({ _fmt: "0%", s: { n: { pattern: "General" } } }, styles)).toBe("");
  });

  it("reads an inline style pattern before _fmt", () => {
    expect(resolveCellNumberFormat({ s: { n: { pattern: "0.0" } }, _fmt: "0%" }, lookup)).toBe("0.0");
  });

  it("falls back to _fmt when the style has no non-empty n.pattern", () => {
    expect(resolveCellNumberFormat({ _fmt: "0.0" }, lookup)).toBe("0.0");
    expect(resolveCellNumberFormat({ s: "missing", _fmt: "0%" }, lookup)).toBe("0%");
    expect(resolveCellNumberFormat({ s: { bl: 1 }, _fmt: "0.0" }, lookup)).toBe("0.0");
    expect(resolveCellNumberFormat({ s: { n: { pattern: "  " } }, _fmt: "0.0" }, lookup)).toBe("0.0");
  });

  it("reads a _fmt of General (any case) as no format", () => {
    expect(resolveCellNumberFormat({ _fmt: "General" }, lookup)).toBe("");
    expect(resolveCellNumberFormat({ _fmt: " GENERAL " }, lookup)).toBe("");
    expect(resolveCellNumberFormat({ s: "st2", _fmt: "General" }, lookup)).toBe("");
  });

  // Clear Formatting drops the cell's `s` (and with it the "General" marker)
  // but keeps `_fmt`, so the imported format shows through again. Pinned here
  // until #343 の (a) is fixed; update this expectation together with it.
  it("known issue (#343 の (a)): after Clear Formatting drops s, the imported _fmt shows through", () => {
    expect(resolveCellNumberFormat({ v: 0.5, _fmt: "0%" }, lookup)).toBe("0%");
  });

  it("returns '' for no format, unknown ids and non-objects", () => {
    expect(resolveCellNumberFormat({ v: 1 }, lookup)).toBe("");
    expect(resolveCellNumberFormat({ s: "missing" }, lookup)).toBe("");
    expect(resolveCellNumberFormat({ _fmt: "   " }, lookup)).toBe("");
    expect(resolveCellNumberFormat(null, lookup)).toBe("");
    expect(resolveCellNumberFormat("x", lookup)).toBe("");
  });
});

describe("clearPatternFor", () => {
  it("returns GENERAL_PATTERN for a cell with a real _fmt, '' otherwise", () => {
    expect(clearPatternFor({ _fmt: "0%", s: "s1" })).toBe(GENERAL_PATTERN);
    expect(clearPatternFor({ _fmt: "0%" })).toBe(GENERAL_PATTERN);
    expect(clearPatternFor({ s: "s1" })).toBe("");
    expect(clearPatternFor({ _fmt: "  " })).toBe("");
    expect(clearPatternFor({ _fmt: "general" })).toBe("");
    expect(clearPatternFor(undefined)).toBe("");
  });
});

describe("existingCellsInRect", () => {
  it("returns only populated cells inside the rect, row-major", () => {
    const cellData: SheetCellData = {
      "5": { "2": { v: 1 }, "0": { v: 2 }, "9": { v: 3 } },
      "1": { "1": { v: 4 } },
      "50": { "1": { v: 5 } },
    };
    expect(existingCellsInRect(cellData, { startRow: 0, endRow: 10, startCol: 0, endCol: 5 })).toEqual([
      { row: 1, col: 1 },
      { row: 5, col: 0 },
      { row: 5, col: 2 },
    ]);
  });

  it("handles missing cellData", () => {
    expect(existingCellsInRect(undefined, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 })).toEqual([]);
  });
});

describe("planUniformNumberFormat", () => {
  it("plans one dense facade call for a normal selection", () => {
    const job = planUniformNumberFormat("s1", { startRow: 1, endRow: 3, startCol: 0, endCol: 1 }, " #,##0.00 ");
    expect(job).toEqual({
      kind: "uniform",
      sheetId: "s1",
      rect: { startRow: 1, endRow: 3, startCol: 0, endCol: 1 },
      pattern: "#,##0.00",
    });
  });

  it("normalises reversed corners and rejects negative ones", () => {
    const job = planUniformNumberFormat("s1", { startRow: 3, endRow: 1, startCol: 2, endCol: 0 }, "0%");
    expect(job?.kind === "uniform" && job.rect).toEqual({ startRow: 1, endRow: 3, startCol: 0, endCol: 2 });
    expect(planUniformNumberFormat("s1", { startRow: -1, endRow: 0, startCol: 0, endCol: 0 }, "0%")).toBeNull();
  });

  it("plans General / blank as a removal (empty pattern)", () => {
    const job = planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "General");
    expect(job?.kind === "uniform" && job.pattern).toBe("");
  });

  it("'標準' on an imported cell plans a General marker, and the result reads as no format", () => {
    const cellData: SheetCellData = { "0": { "0": { _fmt: "0%", s: "s1" } } };
    const before = styleLookupFromTable({ s1: { n: { pattern: "0%" } } });
    expect(resolveCellNumberFormat(cellData["0"]!["0"], before)).toBe("0%");

    const job = planUniformNumberFormat("sheet", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "", cellData);
    expect(job).toEqual({
      kind: "grid",
      sheetId: "sheet",
      rect: { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
      patterns: [["General"]],
    });

    // What NumfmtService.setValues leaves behind: a new style id with n.pattern "General".
    const after = styleLookupFromTable({ s2: { n: { pattern: "General" } } });
    expect(resolveCellNumberFormat({ _fmt: "0%", s: "s2" }, after)).toBe("");
  });

  it("'標準' over a range mixing _fmt cells, plain cells and blanks marks only the _fmt cells", () => {
    const cellData: SheetCellData = {
      "0": { "0": { v: 1, _fmt: "0%" }, "1": { v: 2, s: "plain" } },
      "1": { "1": { v: 3, _fmt: "General" } },
    };
    const job = planUniformNumberFormat("s1", { startRow: 0, endRow: 1, startCol: 0, endCol: 2 }, "General", cellData);
    expect(job).toEqual({
      kind: "grid",
      sheetId: "s1",
      rect: { startRow: 0, endRow: 1, startCol: 0, endCol: 2 },
      patterns: [
        ["General", "", ""],
        ["", "", ""],
      ],
    });
  });

  it("'標準' with no _fmt cell in the range stays a single uniform removal", () => {
    const cellData: SheetCellData = {
      "0": { "0": { v: 1, s: "st1" } },
      "9": { "0": { v: 2, _fmt: "0%" } }, // outside the rectangle
    };
    const job = planUniformNumberFormat("s1", { startRow: 0, endRow: 2, startCol: 0, endCol: 1 }, "", cellData);
    expect(job).toEqual({
      kind: "uniform",
      sheetId: "s1",
      rect: { startRow: 0, endRow: 2, startCol: 0, endCol: 1 },
      pattern: "",
    });
  });

  it("applying a real format to _fmt cells stays a uniform job (the style pattern wins on read)", () => {
    const cellData: SheetCellData = { "0": { "0": { v: 1, _fmt: "0%" } } };
    const job = planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "0.00", cellData);
    expect(job?.kind === "uniform" && job.pattern).toBe("0.00");
  });

  it("'標準' past the cell cap writes General only to the existing _fmt cells", () => {
    const cellData: SheetCellData = {
      "0": { "0": { v: 1 } },
      "7": { "1": { v: 2, _fmt: "yyyy/m/d" } },
    };
    const job = planUniformNumberFormat(
      "s1",
      { startRow: 0, endRow: NUMBER_FORMAT_MAX_CELLS, startCol: 0, endCol: 1 },
      "",
      cellData,
    );
    expect(job).toEqual({
      kind: "cells",
      sheetId: "s1",
      writes: [
        { row: 0, col: 0, pattern: "" },
        { row: 7, col: 1, pattern: "General" },
      ],
    });
  });

  it("past the cell cap, targets only cells that already exist (whole-column selection)", () => {
    const rows = Math.ceil(NUMBER_FORMAT_MAX_CELLS / 2) + 1; // 2 columns -> over the cap
    const cellData: SheetCellData = { "0": { "0": { v: 1 } }, "7": { "1": { v: 2 } }, "9": { "4": { v: 3 } } };
    const job = planUniformNumberFormat("s1", { startRow: 0, endRow: rows - 1, startCol: 0, endCol: 1 }, "0%", cellData);
    expect(job).toEqual({
      kind: "cells",
      sheetId: "s1",
      writes: [
        { row: 0, col: 0, pattern: "0%" },
        { row: 7, col: 1, pattern: "0%" },
      ],
    });
  });

  it("past the cell cap with no existing cells, plans nothing", () => {
    expect(
      planUniformNumberFormat("s1", { startRow: 0, endRow: 1_048_575, startCol: 0, endCol: 0 }, "0%", {}),
    ).toBeNull();
  });

  it("cap boundary: exactly NUMBER_FORMAT_MAX_CELLS still plans one dense facade call", () => {
    // A single row of exactly NUMBER_FORMAT_MAX_CELLS columns — the <= cap
    // comparison in planUniformNumberFormat must include this exact count in
    // the dense path, not just counts strictly under it.
    const job = planUniformNumberFormat(
      "s1",
      { startRow: 0, endRow: 0, startCol: 0, endCol: NUMBER_FORMAT_MAX_CELLS - 1 },
      "0%",
    );
    expect(job?.kind).toBe("uniform");
  });

  it("cap boundary: one cell past NUMBER_FORMAT_MAX_CELLS switches to the existing-cells-only path", () => {
    // Same rectangle shape as the previous test plus one more column — must
    // flip from a dense job to a sparse "cells" job restricted to what's
    // already in cellData.
    const cellData: SheetCellData = { "0": { "5": { v: 1 } } };
    const job = planUniformNumberFormat(
      "s1",
      { startRow: 0, endRow: 0, startCol: 0, endCol: NUMBER_FORMAT_MAX_CELLS },
      "0%",
      cellData,
    );
    expect(job).toEqual({
      kind: "cells",
      sheetId: "s1",
      writes: [{ row: 0, col: 5, pattern: "0%" }],
    });
  });
});

describe("planSteppedNumberFormat", () => {
  const lookup = styleLookupFromTable({ pct: { n: { pattern: "0.0" } } });
  const addDecimal = (prev: string) => (prev ? `${prev}0` : "0.0");

  it("computes each cell's next pattern from its current one (style first, then _fmt)", () => {
    const cellData: SheetCellData = { "0": { "0": { s: "pct" }, "1": { _fmt: "0.00" } } };
    const job = planSteppedNumberFormat(
      "s1",
      { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
      addDecimal,
      cellData,
      lookup,
    );
    expect(job).toEqual({
      kind: "grid",
      sheetId: "s1",
      rect: { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
      patterns: [
        ["0.00", "0.000"],
        ["0.0", "0.0"],
      ],
    });
  });

  it("a step that yields no format writes General to a _fmt cell and '' elsewhere", () => {
    // Toggling the comma style off: "#,##0" -> "" (as nextNumberFormatCode does).
    const toggleCommaOff = (prev: string) => (prev.includes(",") ? "" : "#,##0");
    const styles = styleLookupFromTable({ comma: { n: { pattern: "#,##0" } } });
    const cellData: SheetCellData = {
      "0": { "0": { v: 1, s: "comma", _fmt: "#,##0" }, "1": { v: 2, s: "comma" } },
    };
    const job = planSteppedNumberFormat(
      "s1",
      { startRow: 0, endRow: 0, startCol: 0, endCol: 1 },
      toggleCommaOff,
      cellData,
      styles,
    );
    expect(job).toEqual({
      kind: "grid",
      sheetId: "s1",
      rect: { startRow: 0, endRow: 0, startCol: 0, endCol: 1 },
      patterns: [["General", ""]],
    });
  });

  it("past the cell cap, a step that yields no format still marks _fmt cells with General", () => {
    const cellData: SheetCellData = { "3": { "0": { _fmt: "#,##0" } } };
    const job = planSteppedNumberFormat(
      "s1",
      { startRow: 0, endRow: NUMBER_FORMAT_MAX_CELLS, startCol: 0, endCol: 0 },
      () => "",
      cellData,
      lookup,
    );
    expect(job).toEqual({ kind: "cells", sheetId: "s1", writes: [{ row: 3, col: 0, pattern: "General" }] });
  });

  it("cap boundary: exactly NUMBER_FORMAT_MAX_CELLS still plans one dense grid job", () => {
    const cellData: SheetCellData = { "3": { "0": { s: "pct" } } };
    const job = planSteppedNumberFormat(
      "s1",
      { startRow: 0, endRow: NUMBER_FORMAT_MAX_CELLS - 1, startCol: 0, endCol: 0 },
      addDecimal,
      cellData,
      lookup,
    );
    expect(job?.kind).toBe("grid");
  });

  it("past the cell cap, only existing cells get a write", () => {
    const cellData: SheetCellData = { "3": { "0": { s: "pct" } } };
    const job = planSteppedNumberFormat(
      "s1",
      { startRow: 0, endRow: NUMBER_FORMAT_MAX_CELLS, startCol: 0, endCol: 0 },
      addDecimal,
      cellData,
      lookup,
    );
    expect(job).toEqual({ kind: "cells", sheetId: "s1", writes: [{ row: 3, col: 0, pattern: "0.00" }] });
  });
});

describe("runNumberFormatJob", () => {
  it("applies #,##0.00 through FRange.setNumberFormat on exactly the target range", () => {
    const wb = fakeWorkbook({}, { "0": { "0": { v: 1234.5 } } });
    const job = planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "#,##0.00");
    expect(runNumberFormatJob(job!, wb.deps)).toBe(true);
    expect(wb.rangeCalls).toEqual([{ at: [0, 0, 1, 1], pattern: "#,##0.00" }]);
    expect(wb.patternAt(0, 0)).toBe("#,##0.00");
    expect(wb.cell(0, 0)?.v).toBe(1234.5);
    // Univer interns the style: the cell keeps a string id, never an inline object.
    expect(typeof wb.cell(0, 0)?.s).toBe("string");
  });

  it("passes the selection size to getRange for a multi-cell selection", () => {
    const wb = fakeWorkbook({}, {});
    runNumberFormatJob(
      planUniformNumberFormat("s1", { startRow: 2, endRow: 4, startCol: 1, endCol: 3 }, "0%")!,
      wb.deps,
    );
    expect(wb.rangeCalls).toEqual([{ at: [2, 1, 3, 3], pattern: "0%" }]);
  });

  it("'標準' (empty code) calls setNumberFormat('') and removes the format", () => {
    const styles: Styles = { st1: { bl: 1, n: { pattern: "0.00" } } };
    const wb = fakeWorkbook(styles, { "0": { "0": { v: 1, s: "st1" } } });
    runNumberFormatJob(
      planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "")!,
      wb.deps,
    );
    expect(wb.rangeCalls).toEqual([{ at: [0, 0, 1, 1], pattern: "" }]);
    expect(wb.patternAt(0, 0)).toBe("");
    // Other style keys survive the removal.
    expect(wb.styles[wb.cell(0, 0)!.s as string]).toEqual({ bl: 1 });
  });

  it("applying to one of two cells sharing a style id leaves the other cell's s untouched", () => {
    const styles: Styles = { st1: { bl: 1 } };
    const wb = fakeWorkbook(styles, { "0": { "0": { v: 1, s: "st1" }, "1": { v: 2, s: "st1" } } });
    runNumberFormatJob(
      planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "0%")!,
      wb.deps,
    );
    // Only A1 was addressed.
    expect(wb.rangeCalls.map((c) => c.at)).toEqual([[0, 0, 1, 1]]);
    // B1 still points at the untouched shared style.
    expect(wb.cell(0, 1)?.s).toBe("st1");
    expect(wb.styles.st1).toEqual({ bl: 1 });
    // A1 moved to a new style that keeps the bold flag and adds the pattern.
    const a1Style = wb.styles[wb.cell(0, 0)!.s as string];
    expect(a1Style).toEqual({ bl: 1, n: { pattern: "0%" } });
  });

  it("runs a grid job through FRange.setNumberFormats", () => {
    const wb = fakeWorkbook({}, {});
    const job: NumberFormatJob = {
      kind: "grid",
      sheetId: "s1",
      rect: { startRow: 0, endRow: 0, startCol: 0, endCol: 1 },
      patterns: [["#,##0", "0.0"]],
    };
    runNumberFormatJob(job, wb.deps);
    expect(wb.rangeCalls).toEqual([{ at: [0, 0, 1, 2], patterns: [["#,##0", "0.0"]] }]);
    expect(wb.patternAt(0, 1)).toBe("0.0");
  });

  it("runs a sparse job through setCells (SetNumfmtCommand), not the facade", () => {
    const wb = fakeWorkbook({}, { "3": { "0": { v: 1 } } });
    const job: NumberFormatJob = { kind: "cells", sheetId: "s1", writes: [{ row: 3, col: 0, pattern: "0%" }] };
    runNumberFormatJob(job, wb.deps);
    expect(wb.rangeCalls).toEqual([]);
    expect(wb.cellCalls).toEqual([{ sheetId: "s1", writes: [{ row: 3, col: 0, pattern: "0%" }] }]);
    expect(wb.patternAt(3, 0)).toBe("0%");
  });

  // `_fmt` is never written or cleared here. A non-empty style n.pattern
  // outranks it on read (here, in the xlsx writer and in the CSV writer), and
  // removing a format writes n.pattern "General" to cells that carry `_fmt`
  // so the stale sidecar does not show through again.
  it("leaves an imported _fmt in place; the new style pattern is what the cell reads as", () => {
    const styles: Styles = { imported: { bl: 1, n: { pattern: "0%" } } };
    const wb = fakeWorkbook(styles, { "0": { "0": { v: 0.5, s: "imported", _fmt: "0%" } } });
    runNumberFormatJob(
      planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "#,##0.00")!,
      wb.deps,
    );
    expect(wb.cell(0, 0)?._fmt).toBe("0%");
    expect(wb.patternAt(0, 0)).toBe("#,##0.00");
  });

  it("'標準' on an imported cell leaves _fmt, stores General through the facade and reads as no format", () => {
    const styles: Styles = { imported: { bl: 1, n: { pattern: "0.00" } } };
    const wb = fakeWorkbook(styles, { "0": { "0": { v: 1, s: "imported", _fmt: "0.00" } } });
    runNumberFormatJob(
      planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "", wb.cellData)!,
      wb.deps,
    );
    // Written through FRange.setNumberFormats, i.e. SetNumfmtCommand (undoable).
    expect(wb.rangeCalls).toEqual([{ at: [0, 0, 1, 1], patterns: [["General"]] }]);
    expect(wb.cell(0, 0)?._fmt).toBe("0.00");
    expect(wb.styles[wb.cell(0, 0)!.s as string]).toEqual({ bl: 1, n: { pattern: "General" } });
    expect(wb.patternAt(0, 0)).toBe("");
    // The shared imported style is left alone.
    expect(wb.styles.imported).toEqual({ bl: 1, n: { pattern: "0.00" } });
  });

  it("'標準' on a _fmt-only cell (no style yet) also reads as no format afterwards", () => {
    const wb = fakeWorkbook({}, { "0": { "0": { v: 1, _fmt: "yyyy-mm-dd" } } });
    runNumberFormatJob(
      planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "", wb.cellData)!,
      wb.deps,
    );
    // Like NumfmtService.setValues, the cell now carries a style id with n.pattern "General".
    expect(typeof wb.cell(0, 0)?.s).toBe("string");
    expect(wb.styles[wb.cell(0, 0)!.s as string]).toEqual({ n: { pattern: "General" } });
    expect(wb.patternAt(0, 0)).toBe("");
  });

  it("re-applying a format after '標準' on an imported cell replaces the General marker", () => {
    const wb = fakeWorkbook({}, { "0": { "0": { v: 0.5, _fmt: "0%" } } });
    const a1 = { startRow: 0, endRow: 0, startCol: 0, endCol: 0 };
    runNumberFormatJob(planUniformNumberFormat("s1", a1, "", wb.cellData)!, wb.deps);
    expect(wb.patternAt(0, 0)).toBe("");
    runNumberFormatJob(planUniformNumberFormat("s1", a1, "0.0%", wb.cellData)!, wb.deps);
    expect(wb.patternAt(0, 0)).toBe("0.0%");
  });

  it("reports not applied when the sparse command is rejected", () => {
    const wb = fakeWorkbook({}, { "0": { "0": { v: 1 } } });
    const deps: NumberFormatDeps = { ...wb.deps, setCells: () => false };
    expect(
      runNumberFormatJob({ kind: "cells", sheetId: "s1", writes: [{ row: 0, col: 0, pattern: "" }] }, deps),
    ).toBe(false);
  });

  it("reports not applied for an empty sparse job without calling the command", () => {
    const wb = fakeWorkbook({}, {});
    expect(runNumberFormatJob({ kind: "cells", sheetId: "s1", writes: [] }, wb.deps)).toBe(false);
    expect(wb.cellCalls).toEqual([]);
  });

  it("reports not applied when the sheet is gone", () => {
    const wb = fakeWorkbook({}, {});
    expect(
      runNumberFormatJob(
        planUniformNumberFormat("deleted", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "0%")!,
        wb.deps,
      ),
    ).toBe(false);
    expect(wb.rangeCalls).toEqual([]);
  });

  it("propagates facade errors to the caller", () => {
    const deps: NumberFormatDeps = {
      getSheet: () => ({
        getRange: () => ({
          setNumberFormat: () => {
            throw new Error("boom");
          },
          setNumberFormats: () => undefined,
        }),
      }),
      setCells: () => true,
    };
    expect(() =>
      runNumberFormatJob(
        planUniformNumberFormat("s1", { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }, "0%")!,
        deps,
      ),
    ).toThrow("boom");
  });
});

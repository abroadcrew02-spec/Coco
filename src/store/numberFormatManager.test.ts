import { describe, it, expect } from "vitest";
import {
  listAllFormatCodes,
  planFormatCodeRename,
  planFormatCodeDelete,
} from "./numberFormatManager";

describe("listAllFormatCodes", () => {
  it("dedupes by code across sheets and counts cells", () => {
    const snap = {
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: { cellData: { "0": { "0": { _fmt: "0.00" }, "1": { _fmt: "0.00" } } } },
        s2: { cellData: { "0": { "0": { _fmt: "0.00" } } } },
      },
    };
    const entries = listAllFormatCodes(snap);
    expect(entries).toHaveLength(1);
    expect(entries[0].code).toBe("0.00");
    expect(entries[0].cellCount).toBe(3);
    expect(entries[0].sheetIds).toEqual(["s1", "s2"]);
  });

  it("reads codes through style ids (the shape Univer's save() produces)", () => {
    const snap = {
      styles: { a: { bl: 1, n: { pattern: "#,##0.00" } }, b: { bl: 1 } },
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { s: "a" }, "1": { s: "a" }, "2": { s: "b" } },
          },
        },
      },
    };
    const entries = listAllFormatCodes(snap);
    expect(entries.map((e) => [e.code, e.cellCount])).toEqual([["#,##0.00", 2]]);
  });

  it("lists the style's pattern, not a stale _fmt, when both are present", () => {
    const snap = {
      styles: { a: { n: { pattern: "0.0%" } } },
      sheets: { s1: { cellData: { "0": { "0": { s: "a", _fmt: "0%" } } } } },
    };
    expect(listAllFormatCodes(snap).map((e) => e.code)).toEqual(["0.0%"]);
  });

  it("does not list a leftover _fmt on a cell whose style id has no pattern (cleared with '標準')", () => {
    const snap = {
      styles: { cleared: { bl: 1 } },
      sheets: { s1: { cellData: { "0": { "0": { s: "cleared", _fmt: "0%" }, "1": { _fmt: "0.0" } } } } },
    };
    expect(listAllFormatCodes(snap).map((e) => e.code)).toEqual(["0.0"]);
  });

  it("returns [] for malformed input", () => {
    expect(listAllFormatCodes(null)).toEqual([]);
    expect(listAllFormatCodes("not json")).toEqual([]);
    expect(listAllFormatCodes({})).toEqual([]);
  });
});

describe("planFormatCodeRename", () => {
  it("plans one sparse job per sheet covering exactly the matching cells", () => {
    const snap = {
      styles: { a: { n: { pattern: "0.00" } }, b: { n: { pattern: "0%" } } },
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { s: "a", v: 1 }, "1": { s: "b", v: 2 } },
            "3": { "2": { _fmt: "0.00", v: 3 } },
          },
        },
        s2: { cellData: { "5": { "5": { s: "b" } } } },
      },
    };
    const { jobs, changedCount } = planFormatCodeRename(snap, "0.00", "0.000");
    expect(changedCount).toBe(2);
    expect(jobs).toEqual([
      {
        kind: "cells",
        sheetId: "s1",
        writes: [
          { row: 0, col: 0, pattern: "0.000" },
          { row: 3, col: 2, pattern: "0.000" },
        ],
      },
    ]);
  });

  it("does not modify the snapshot it was given", () => {
    const snap = { sheets: { s1: { cellData: { "0": { "0": { _fmt: "0.00" } } } } } };
    const before = JSON.stringify(snap);
    planFormatCodeRename(snap, "0.00", "0.000");
    expect(JSON.stringify(snap)).toBe(before);
  });

  it("accepts a JSON string snapshot", () => {
    const snap = JSON.stringify({ sheets: { s1: { cellData: { "0": { "0": { _fmt: "0.00" } } } } } });
    expect(planFormatCodeRename(snap, "0.00", "0.0").changedCount).toBe(1);
  });

  it("no-ops when oldCode is empty or unchanged", () => {
    const snap = { sheets: { s1: { cellData: { "0": { "0": { _fmt: "0.00" } } } } } };
    expect(planFormatCodeRename(snap, "", "0.000")).toEqual({ jobs: [], changedCount: 0 });
    expect(planFormatCodeRename(snap, "0.00", "0.00")).toEqual({ jobs: [], changedCount: 0 });
  });

  it("treats a blank or General newCode as delete (empty pattern)", () => {
    const snap = { sheets: { s1: { cellData: { "0": { "0": { _fmt: "0.00" } } } } } };
    for (const blank of ["", "  ", "General"]) {
      const { jobs, changedCount } = planFormatCodeRename(snap, "0.00", blank);
      expect(changedCount).toBe(1);
      expect(jobs).toEqual([{ kind: "cells", sheetId: "s1", writes: [{ row: 0, col: 0, pattern: "" }] }]);
    }
  });
});

describe("planFormatCodeDelete", () => {
  it("plans an empty pattern for every matching cell", () => {
    const snap = {
      styles: { a: { bl: 1, n: { pattern: "0.00" } } },
      sheets: {
        s1: { cellData: { "0": { "0": { s: "a", v: 1 } }, "1": { "0": { v: 2 } } } },
      },
    };
    const { jobs, changedCount } = planFormatCodeDelete(snap, "0.00");
    expect(changedCount).toBe(1);
    expect(jobs).toEqual([{ kind: "cells", sheetId: "s1", writes: [{ row: 0, col: 0, pattern: "" }] }]);
  });

  it("no-ops for an empty code or no match", () => {
    const snap = { sheets: { s1: { cellData: { "0": { "0": { _fmt: "0.00" } } } } } };
    expect(planFormatCodeDelete(snap, "")).toEqual({ jobs: [], changedCount: 0 });
    expect(planFormatCodeDelete(snap, "0%")).toEqual({ jobs: [], changedCount: 0 });
  });
});

import { describe, it, expect } from "vitest";
import {
  computeSplitEntry,
  hasSplitPane,
  readSplitPane,
  splitModeFor,
  writeSplitPaneInto,
  type SplitSnapshotShape,
} from "./splitPane";

describe("splitModeFor", () => {
  it("returns null when both row and col are 0", () => {
    expect(splitModeFor(0, 0)).toBe(null);
  });

  it("returns 'horizontal' for row>0, col==0", () => {
    expect(splitModeFor(5, 0)).toBe("horizontal");
  });

  it("returns 'vertical' for row==0, col>0", () => {
    expect(splitModeFor(0, 3)).toBe("vertical");
  });

  it("returns 'both' when both > 0", () => {
    expect(splitModeFor(5, 3)).toBe("both");
  });
});

describe("computeSplitEntry", () => {
  it("'both' uses active row+col", () => {
    expect(computeSplitEntry(4, 2, "both")).toEqual({ row: 4, col: 2 });
  });

  it("'horizontal' uses active row, col=0", () => {
    expect(computeSplitEntry(4, 2, "horizontal")).toEqual({ row: 4, col: 0 });
  });

  it("'vertical' uses col, row=0", () => {
    expect(computeSplitEntry(4, 2, "vertical")).toEqual({ row: 0, col: 2 });
  });

  it("clamps negative inputs to 0", () => {
    expect(computeSplitEntry(-3, -7, "both")).toBe(null);
  });

  it("floors fractional inputs", () => {
    expect(computeSplitEntry(4.9, 2.5, "both")).toEqual({ row: 4, col: 2 });
  });

  it("returns null when 'horizontal' on row 0 (no-op split)", () => {
    expect(computeSplitEntry(0, 5, "horizontal")).toBe(null);
  });

  it("returns null when 'vertical' on col 0 (no-op split)", () => {
    expect(computeSplitEntry(5, 0, "vertical")).toBe(null);
  });

  it("returns null when 'both' at A1 (row=0, col=0)", () => {
    expect(computeSplitEntry(0, 0, "both")).toBe(null);
  });
});

describe("readSplitPane", () => {
  it("returns null for empty / null snapshot", () => {
    expect(readSplitPane(null, "s1")).toBe(null);
    expect(readSplitPane(undefined, "s1")).toBe(null);
    expect(readSplitPane("", "s1")).toBe(null);
  });

  it("returns null when sheetId is missing", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 5, col: 0, state: "split" } } },
    });
    expect(readSplitPane(snap, null)).toBe(null);
    expect(readSplitPane(snap, "")).toBe(null);
  });

  it("returns null on malformed JSON", () => {
    expect(readSplitPane("not json {", "s1")).toBe(null);
  });

  it("returns null when sheet has no _freezePane", () => {
    const snap = JSON.stringify({ sheets: { s1: {} } });
    expect(readSplitPane(snap, "s1")).toBe(null);
  });

  it("returns null when state is 'frozen' (not split)", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 3, col: 0, state: "frozen" } } },
    });
    expect(readSplitPane(snap, "s1")).toBe(null);
  });

  it("returns null when state is missing (defaults to frozen-style reading)", () => {
    // A `_freezePane` without `state` is treated as a frozen pane on read.
    // The split UI must explicitly carry `state: "split"`.
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 3, col: 0 } } },
    });
    expect(readSplitPane(snap, "s1")).toBe(null);
  });

  it("returns null when row+col are both 0 even with state='split'", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 0, col: 0, state: "split" } } },
    });
    expect(readSplitPane(snap, "s1")).toBe(null);
  });

  it("reads a horizontal split", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 5, col: 0, state: "split" } } },
    });
    expect(readSplitPane(snap, "s1")).toEqual({ row: 5, col: 0 });
  });

  it("reads a vertical split", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 0, col: 3, state: "split" } } },
    });
    expect(readSplitPane(snap, "s1")).toEqual({ row: 0, col: 3 });
  });

  it("reads a 4-way split with topLeft", () => {
    const snap = JSON.stringify({
      sheets: {
        s1: { _freezePane: { row: 4, col: 2, state: "split", topLeft: "C5" } },
      },
    });
    expect(readSplitPane(snap, "s1")).toEqual({
      row: 4,
      col: 2,
      topLeft: "C5",
    });
  });

  it("clamps negative row/col to 0", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: -3, col: 5, state: "split" } } },
    });
    expect(readSplitPane(snap, "s1")).toEqual({ row: 0, col: 5 });
  });
});

describe("hasSplitPane", () => {
  it("false when no split", () => {
    expect(hasSplitPane(null, "s1")).toBe(false);
  });

  it("true when split exists", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 2, col: 0, state: "split" } } },
    });
    expect(hasSplitPane(snap, "s1")).toBe(true);
  });

  it("false for frozen panes", () => {
    const snap = JSON.stringify({
      sheets: { s1: { _freezePane: { row: 2, col: 0, state: "frozen" } } },
    });
    expect(hasSplitPane(snap, "s1")).toBe(false);
  });
});

describe("writeSplitPaneInto", () => {
  it("returns false when sheets is missing", () => {
    const snap: SplitSnapshotShape = {};
    expect(writeSplitPaneInto(snap, "s1", { row: 2, col: 0 })).toBe(false);
  });

  it("returns false when target sheet does not exist", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    expect(writeSplitPaneInto(snap, "s2", { row: 2, col: 0 })).toBe(false);
  });

  it("writes a horizontal split", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    expect(writeSplitPaneInto(snap, "s1", { row: 5, col: 0 })).toBe(true);
    expect(snap.sheets!.s1!._freezePane).toEqual({
      row: 5,
      col: 0,
      state: "split",
    });
    // Mirrored onto Univer's native freeze (startColumn=-1 = "no col split").
    expect(snap.sheets!.s1!.freeze).toEqual({
      xSplit: 0,
      ySplit: 5,
      startRow: 5,
      startColumn: -1,
    });
  });

  it("writes a 4-way split with topLeft", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    expect(
      writeSplitPaneInto(snap, "s1", { row: 4, col: 2, topLeft: "C5" }),
    ).toBe(true);
    expect(snap.sheets!.s1!._freezePane).toEqual({
      row: 4,
      col: 2,
      state: "split",
      topLeft: "C5",
    });
    expect(snap.sheets!.s1!.freeze).toEqual({
      xSplit: 2,
      ySplit: 4,
      startRow: 4,
      startColumn: 2,
    });
  });

  it("vertical-only split has startRow=-1", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    expect(writeSplitPaneInto(snap, "s1", { row: 0, col: 3 })).toBe(true);
    expect(snap.sheets!.s1!.freeze).toEqual({
      xSplit: 3,
      ySplit: 0,
      startRow: -1,
      startColumn: 3,
    });
  });

  it("clearing with null deletes _freezePane and resets freeze", () => {
    const snap: SplitSnapshotShape = {
      sheets: {
        s1: {
          _freezePane: { row: 3, col: 0, state: "split" },
          freeze: { xSplit: 0, ySplit: 3, startRow: 3, startColumn: -1 },
        },
      },
    };
    expect(writeSplitPaneInto(snap, "s1", null)).toBe(true);
    expect(snap.sheets!.s1!._freezePane).toBeUndefined();
    expect(snap.sheets!.s1!.freeze).toEqual({
      xSplit: 0,
      ySplit: 0,
      startRow: -1,
      startColumn: -1,
    });
  });

  it("clearing on a sheet with no _freezePane is a no-op (returns false)", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    expect(writeSplitPaneInto(snap, "s1", null)).toBe(false);
  });

  it("overwrites a frozen pane (split + frozen are mutually exclusive)", () => {
    const snap: SplitSnapshotShape = {
      sheets: {
        s1: { _freezePane: { row: 1, col: 0, state: "frozen" } },
      },
    };
    expect(writeSplitPaneInto(snap, "s1", { row: 4, col: 2 })).toBe(true);
    expect(snap.sheets!.s1!._freezePane).toEqual({
      row: 4,
      col: 2,
      state: "split",
    });
  });

  it("strips empty topLeft", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    writeSplitPaneInto(snap, "s1", { row: 2, col: 0, topLeft: "   " });
    expect(snap.sheets!.s1!._freezePane).toEqual({
      row: 2,
      col: 0,
      state: "split",
    });
  });
});

describe("round-trip semantics", () => {
  it("write→read returns the same entry", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    const entry = computeSplitEntry(7, 3, "both");
    expect(entry).not.toBe(null);
    writeSplitPaneInto(snap, "s1", entry!);
    const json = JSON.stringify(snap);
    expect(readSplitPane(json, "s1")).toEqual({ row: 7, col: 3 });
  });

  it("toggle off via null", () => {
    const snap: SplitSnapshotShape = { sheets: { s1: {} } };
    writeSplitPaneInto(snap, "s1", { row: 5, col: 2 });
    expect(hasSplitPane(JSON.stringify(snap), "s1")).toBe(true);
    writeSplitPaneInto(snap, "s1", null);
    expect(hasSplitPane(JSON.stringify(snap), "s1")).toBe(false);
  });
});

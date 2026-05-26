import { describe, it, expect } from "vitest";
import {
  addSlicer,
  applySlicerFilters,
  applySlicerFiltersToPivots,
  clearAllSlicers,
  clearSlicerSelection,
  collectAllSlicerNames,
  generateSlicerName,
  invertSlicerSelection,
  listAllSlicers,
  listDistinctValues,
  removeSlicer,
  setSlicerSelection,
  toggleSlicerValue,
  type SlicerEntry,
  type WorkbookSlicerPivotSnapshot,
  type WorkbookSlicerSnapshot,
} from "./slicers";
import type { PivotEntry } from "./pivots";

// #235 — Regression suite for the pre-existing slicer engine. The
// `src/store/slicers.ts` module shipped without tests; locking the public
// behaviour here before future refactors.

// Helper: a workbook with one sheet, one table (Region, Sales) on rows 0-3.
function fixture(): WorkbookSlicerSnapshot {
  return {
    sheetOrder: ["s1"],
    sheets: {
      s1: {
        name: "Data",
        cellData: {
          "0": { "0": { v: "Region" }, "1": { v: "Sales" } },
          "1": { "0": { v: "East" }, "1": { v: 100 } },
          "2": { "0": { v: "West" }, "1": { v: 200 } },
          "3": { "0": { v: "East" }, "1": { v: 150 } },
        },
        _tables: [
          {
            name: "T1",
            range: { r1: 0, c1: 0, r2: 3, c2: 1 },
            headerRow: true,
            columns: [{ name: "Region" }, { name: "Sales" }],
          },
        ],
      },
    },
  };
}

describe("generateSlicerName", () => {
  it("returns Slicer1 on an empty workbook", () => {
    expect(generateSlicerName([])).toBe("Slicer1");
  });

  it("picks the smallest unused index", () => {
    expect(generateSlicerName(["Slicer1", "Slicer3"])).toBe("Slicer2");
  });

  it("skips a verbatim taken name even when its number index is free", () => {
    expect(generateSlicerName(["Slicer2"])).toBe("Slicer1");
  });

  it("ignores malformed entries", () => {
    expect(generateSlicerName(["Slicer-junk", "", "Slicer1"])).toBe("Slicer2");
  });
});

describe("listDistinctValues", () => {
  it("returns sorted unique column values, skipping the header", () => {
    const v = listDistinctValues(fixture(), "T1", "Region");
    expect(v).toEqual(["East", "West"]);
  });

  it("includes blanks as empty string", () => {
    const wb = fixture();
    // Add a row with a missing Region cell.
    wb.sheets!.s1!.cellData!["4"] = { "1": { v: 300 } };
    wb.sheets!.s1!._tables![0].range.r2 = 4;
    const v = listDistinctValues(wb, "T1", "Region");
    expect(v).toContain("");
  });

  it("returns empty array when the table is missing", () => {
    expect(listDistinctValues(fixture(), "Nope", "Region")).toEqual([]);
  });

  it("returns empty array when the field is missing", () => {
    expect(listDistinctValues(fixture(), "T1", "NotAField")).toEqual([]);
  });
});

describe("addSlicer / removeSlicer", () => {
  const entry: SlicerEntry = {
    name: "Slicer1",
    targetTable: "T1",
    field: "Region",
    selectedValues: ["East"],
  };

  it("addSlicer appends the entry to the host sheet (immutably)", () => {
    const wb = fixture();
    const next = addSlicer(wb, "s1", entry);
    expect(next.sheets?.s1?._slicers).toHaveLength(1);
    expect(next.sheets?.s1?._slicers?.[0].name).toBe("Slicer1");
    // Original untouched
    expect(wb.sheets?.s1?._slicers).toBeUndefined();
  });

  it("addSlicer replaces an entry of the same name idempotently", () => {
    const wb = addSlicer(fixture(), "s1", entry);
    const updated: SlicerEntry = { ...entry, selectedValues: ["West"] };
    const next = addSlicer(wb, "s1", updated);
    expect(next.sheets?.s1?._slicers).toHaveLength(1);
    expect(next.sheets?.s1?._slicers?.[0].selectedValues).toEqual(["West"]);
  });

  it("addSlicer leaves the snapshot unchanged when the sheet is missing", () => {
    const wb = fixture();
    const next = addSlicer(wb, "missing-sheet-id", entry);
    expect(next).toBe(wb);
  });

  it("removeSlicer drops the named slicer from every sheet", () => {
    const wb = addSlicer(fixture(), "s1", entry);
    const next = removeSlicer(wb, "Slicer1");
    expect(next.sheets?.s1?._slicers).toEqual([]);
  });

  it("removeSlicer is a no-op when the name doesn't exist", () => {
    const wb = addSlicer(fixture(), "s1", entry);
    const next = removeSlicer(wb, "Other");
    expect(next).toBe(wb);
  });
});

describe("toggleSlicerValue", () => {
  it("removes a value already selected", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East", "West"],
    });
    const next = toggleSlicerValue(wb, "Slicer1", "East");
    expect(next?.sheets?.s1?._slicers?.[0].selectedValues).toEqual(["West"]);
  });

  it("adds a value not currently selected", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"],
    });
    const next = toggleSlicerValue(wb, "Slicer1", "West");
    expect(next?.sheets?.s1?._slicers?.[0].selectedValues).toEqual(["East", "West"]);
  });

  it("returns null when the slicer name is unknown", () => {
    const wb = fixture();
    expect(toggleSlicerValue(wb, "Slicer-nope", "x")).toBeNull();
  });

  it("returns a deep clone (doesn't mutate the input)", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"],
    });
    const before = JSON.stringify(wb);
    toggleSlicerValue(wb, "Slicer1", "West");
    expect(JSON.stringify(wb)).toBe(before);
  });
});

describe("applySlicerFilters", () => {
  it("hides rows that don't match the selected values", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"], // West rows should hide
    });
    const filtered = applySlicerFilters(wb);
    const cells = filtered.sheets?.s1?.cellData ?? {};
    // Row 1 (East) visible
    expect(cells["1"]?.["0"]?.hd).toBeUndefined();
    // Row 2 (West) hidden
    expect(cells["2"]?.["0"]?.hd).toBe(1);
    // Row 3 (East) visible
    expect(cells["3"]?.["0"]?.hd).toBeUndefined();
  });

  it("treats empty selectedValues as 'show all'", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: [],
    });
    const filtered = applySlicerFilters(wb);
    const cells = filtered.sheets?.s1?.cellData ?? {};
    expect(cells["1"]?.["0"]?.hd).toBeUndefined();
    expect(cells["2"]?.["0"]?.hd).toBeUndefined();
  });

  it("ANDs predicates from multiple slicers on the same table", () => {
    let wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"],
    });
    wb = addSlicer(wb, "s1", {
      name: "Slicer2",
      targetTable: "T1",
      field: "Sales",
      selectedValues: ["150"],
    });
    const filtered = applySlicerFilters(wb);
    const cells = filtered.sheets?.s1?.cellData ?? {};
    // Row 1 (East, 100) hidden (Sales!=150)
    expect(cells["1"]?.["0"]?.hd).toBe(1);
    // Row 2 (West, 200) hidden (Region!=East AND Sales!=150)
    expect(cells["2"]?.["0"]?.hd).toBe(1);
    // Row 3 (East, 150) visible (both pass)
    expect(cells["3"]?.["0"]?.hd).toBeUndefined();
  });

  it("clears stale hd:1 when a row now passes all predicates", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East", "West"], // all pass
    });
    // Pre-mark row 2 as hidden to simulate a stale filter state.
    const sheet = wb.sheets!.s1!;
    sheet.cellData!["2"]!["0"] = { v: "West", hd: 1 };
    sheet.cellData!["2"]!["1"] = { v: 200, hd: 1 };
    const filtered = applySlicerFilters(wb);
    const cells = filtered.sheets?.s1?.cellData ?? {};
    // Row 2's hd flag should be cleared since predicate admits all values.
    expect(cells["2"]?.["0"]?.hd).toBeUndefined();
  });

  it("silently skips slicers with missing table or unknown field", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "BadSlicer",
      targetTable: "T-missing",
      field: "Region",
      selectedValues: ["East"],
    });
    expect(() => applySlicerFilters(wb)).not.toThrow();
  });
});

describe("applySlicerFiltersToPivots", () => {
  // Source data 4 rows on sheet s1; pivot on the same sheet at row 10.
  function pivotFixture(): WorkbookSlicerPivotSnapshot {
    const pivotEntry: PivotEntry = {
      name: "Pivot1",
      source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 4, c2: 2 } },
      destination: { row: 10, col: 0 },
      rows: ["Region"],
      cols: [],
      values: [{ field: "Sales", agg: "SUM" }],
      filters: [],
      hasHeader: true,
    };
    return {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Data",
          cellData: {
            "0": { "0": { v: "Region" }, "1": { v: "Sales" }, "2": { v: "Year" } },
            "1": { "0": { v: "East" }, "1": { v: 100 }, "2": { v: 2024 } },
            "2": { "0": { v: "West" }, "1": { v: 200 }, "2": { v: 2024 } },
            "3": { "0": { v: "East" }, "1": { v: 150 }, "2": { v: 2025 } },
            "4": { "0": { v: "West" }, "1": { v: 250 }, "2": { v: 2025 } },
          },
          _pivots: [pivotEntry],
        },
      },
    };
  }

  it("re-renders a pivot when its slicer-driven filter changes", () => {
    const wb = pivotFixture();
    // Initial pivot output (no filter): East = 250, West = 450, Total = 700
    wb.sheets!.s1!._slicers = [
      {
        name: "Slicer1",
        targetTable: "Pivot1",
        targetKind: "pivot",
        field: "Region",
        selectedValues: ["East"],
      },
    ];
    const result = applySlicerFiltersToPivots(wb);
    expect(result.refreshedPivots).toEqual(["Pivot1"]);
    expect(result.skippedSlicers).toEqual([]);
    // Pivot filters were augmented with the slicer's selection.
    const entry = wb.sheets!.s1!._pivots![0] as PivotEntry;
    expect(entry.filters).toEqual([{ field: "Region", values: ["East"] }]);
    // Destination cells (row 10+) include the East total = 250; West=450 absent.
    const dest = wb.sheets!.s1!.cellData!;
    const pivotCells: unknown[] = [];
    for (let r = 10; r < 25; r++) {
      const row = dest[String(r)];
      if (!row) continue;
      for (const cell of Object.values(row)) {
        if (cell && typeof cell === "object") pivotCells.push((cell as { v?: unknown }).v);
      }
    }
    expect(pivotCells).toContain(250); // East total
    expect(pivotCells).not.toContain(450); // West total absent (filtered out)
  });

  it("replaces (not appends) a pre-existing filter on the same field", () => {
    const wb = pivotFixture();
    // Seed with a stale slicer filter from a previous run.
    const entry = wb.sheets!.s1!._pivots![0] as PivotEntry;
    entry.filters = [{ field: "Region", values: ["West"] }];
    wb.sheets!.s1!._slicers = [
      {
        name: "Slicer1",
        targetTable: "Pivot1",
        targetKind: "pivot",
        field: "Region",
        selectedValues: ["East"],
      },
    ];
    applySlicerFiltersToPivots(wb);
    // Should be replaced with the East filter, not appended.
    expect(entry.filters).toHaveLength(1);
    expect(entry.filters?.[0]).toEqual({ field: "Region", values: ["East"] });
  });

  it("preserves user-authored filters on fields the slicer doesn't touch", () => {
    const wb = pivotFixture();
    const entry = wb.sheets!.s1!._pivots![0] as PivotEntry;
    entry.filters = [{ field: "Year", values: ["2024"] }]; // user authored
    wb.sheets!.s1!._slicers = [
      {
        name: "Slicer1",
        targetTable: "Pivot1",
        targetKind: "pivot",
        field: "Region",
        selectedValues: ["East"],
      },
    ];
    applySlicerFiltersToPivots(wb);
    // Both filters should be present (Year preserved, Region from slicer).
    expect(entry.filters).toEqual(expect.arrayContaining([
      { field: "Year", values: ["2024"] },
      { field: "Region", values: ["East"] },
    ]));
  });

  it("removes the filter when selectedValues is empty (Clear Filter semantic)", () => {
    const wb = pivotFixture();
    const entry = wb.sheets!.s1!._pivots![0] as PivotEntry;
    entry.filters = [{ field: "Region", values: ["West"] }];
    wb.sheets!.s1!._slicers = [
      {
        name: "Slicer1",
        targetTable: "Pivot1",
        targetKind: "pivot",
        field: "Region",
        selectedValues: [], // clear
      },
    ];
    applySlicerFiltersToPivots(wb);
    // No filters left after clearing.
    expect(entry.filters).toEqual([]);
  });

  it("skips slicers whose target pivot doesn't exist", () => {
    const wb = pivotFixture();
    wb.sheets!.s1!._slicers = [
      {
        name: "Slicer1",
        targetTable: "NonExistentPivot",
        targetKind: "pivot",
        field: "Region",
        selectedValues: ["East"],
      },
    ];
    const result = applySlicerFiltersToPivots(wb);
    expect(result.refreshedPivots).toEqual([]);
    expect(result.skippedSlicers).toContain("NonExistentPivot");
  });

  it("ignores slicers with targetKind != 'pivot' (table slicers handled separately)", () => {
    const wb = pivotFixture();
    wb.sheets!.s1!._slicers = [
      {
        name: "TableSlicer",
        targetTable: "Pivot1", // same name happens to match a pivot
        field: "Region",
        selectedValues: ["East"],
        // targetKind omitted → defaults to "table"
      },
    ];
    const result = applySlicerFiltersToPivots(wb);
    // No pivot was refreshed because the slicer is table-scoped.
    expect(result.refreshedPivots).toEqual([]);
    const entry = wb.sheets!.s1!._pivots![0] as PivotEntry;
    expect(entry.filters).toEqual([]); // pivot's filters untouched
  });

  it("handles multiple slicers on the same pivot (AND across fields)", () => {
    const wb = pivotFixture();
    wb.sheets!.s1!._slicers = [
      {
        name: "RegionSlicer",
        targetTable: "Pivot1",
        targetKind: "pivot",
        field: "Region",
        selectedValues: ["East"],
      },
      {
        name: "YearSlicer",
        targetTable: "Pivot1",
        targetKind: "pivot",
        field: "Year",
        selectedValues: ["2025"],
      },
    ];
    applySlicerFiltersToPivots(wb);
    const entry = wb.sheets!.s1!._pivots![0] as PivotEntry;
    expect(entry.filters).toHaveLength(2);
    expect(entry.filters).toEqual(expect.arrayContaining([
      { field: "Region", values: ["East"] },
      { field: "Year", values: ["2025"] },
    ]));
    // Only East+2025 row passes (Sales=150). Check only the destination
    // rows (row 10+) to avoid the source data noise at rows 1-4.
    const dest = wb.sheets!.s1!.cellData!;
    const pivotCells: unknown[] = [];
    for (let r = 10; r < 25; r++) {
      const row = dest[String(r)];
      if (!row) continue;
      for (const cell of Object.values(row)) {
        if (cell && typeof cell === "object") pivotCells.push((cell as { v?: unknown }).v);
      }
    }
    expect(pivotCells).toContain(150);
    expect(pivotCells).not.toContain(100); // East+2024 filtered
    expect(pivotCells).not.toContain(450); // West* filtered
  });

  it("tolerates malformed / empty input", () => {
    expect(applySlicerFiltersToPivots({})).toEqual({
      refreshedPivots: [],
      skippedSlicers: [],
    });
    expect(
      applySlicerFiltersToPivots(null as unknown as WorkbookSlicerPivotSnapshot),
    ).toEqual({ refreshedPivots: [], skippedSlicers: [] });
  });
});

describe("listDistinctValues (pivot kind)", () => {
  it("returns sorted unique values from the pivot's source range", () => {
    const wb: WorkbookSlicerPivotSnapshot = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Data",
          cellData: {
            "0": { "0": { v: "Region" }, "1": { v: "Sales" } },
            "1": { "0": { v: "East" }, "1": { v: 100 } },
            "2": { "0": { v: "West" }, "1": { v: 200 } },
            "3": { "0": { v: "East" }, "1": { v: 150 } },
          },
          _pivots: [
            {
              name: "Pivot1",
              source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 3, c2: 1 } },
              destination: { row: 10, col: 0 },
              rows: ["Region"],
              cols: [],
              values: [{ field: "Sales", agg: "SUM" }],
              filters: [],
              hasHeader: true,
            },
          ],
        },
      },
    };
    expect(listDistinctValues(wb, "Pivot1", "Region", "pivot")).toEqual(["East", "West"]);
  });

  it("returns [] when the pivot is missing", () => {
    expect(listDistinctValues({}, "NoSuchPivot", "Region", "pivot")).toEqual([]);
  });

  it("returns [] when the field is not in the source header", () => {
    const wb: WorkbookSlicerPivotSnapshot = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Data",
          cellData: { "0": { "0": { v: "A" } }, "1": { "0": { v: 1 } } },
          _pivots: [
            {
              name: "Pivot1",
              source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 1, c2: 0 } },
              destination: { row: 5, col: 0 },
              rows: [], cols: [],
              values: [{ field: "A", agg: "SUM" }],
              filters: [],
              hasHeader: true,
            },
          ],
        },
      },
    };
    expect(listDistinctValues(wb, "Pivot1", "Missing", "pivot")).toEqual([]);
  });
});

describe("setSlicerSelection / clearSlicerSelection", () => {
  function fx() {
    return addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"],
    });
  }

  it("setSlicerSelection replaces the selection wholesale", () => {
    const next = setSlicerSelection(fx(), "Slicer1", ["West", "North"]);
    expect(next?.sheets?.s1?._slicers?.[0].selectedValues).toEqual(["West", "North"]);
  });

  it("clearSlicerSelection empties the array", () => {
    const next = clearSlicerSelection(fx(), "Slicer1");
    expect(next?.sheets?.s1?._slicers?.[0].selectedValues).toEqual([]);
  });

  it("returns null when the slicer doesn't exist", () => {
    expect(setSlicerSelection(fx(), "Nope", ["x"])).toBeNull();
    expect(clearSlicerSelection(fx(), "Nope")).toBeNull();
  });

  it("does not mutate the input workbook", () => {
    const wb = fx();
    const before = JSON.stringify(wb);
    setSlicerSelection(wb, "Slicer1", ["X"]);
    expect(JSON.stringify(wb)).toBe(before);
  });
});

describe("clearAllSlicers", () => {
  it("clears every slicer in the workbook and reports the count", () => {
    let wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"],
    });
    wb = addSlicer(wb, "s1", {
      name: "Slicer2",
      targetTable: "T1",
      field: "Sales",
      selectedValues: ["100", "200"],
    });
    const result = clearAllSlicers(wb);
    expect(result?.clearedCount).toBe(2);
    const sl = result!.snapshotMutated.sheets!.s1!._slicers!;
    expect(sl[0].selectedValues).toEqual([]);
    expect(sl[1].selectedValues).toEqual([]);
  });

  it("counts only slicers that were actually non-empty", () => {
    let wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: [], // already cleared
    });
    wb = addSlicer(wb, "s1", {
      name: "Slicer2",
      targetTable: "T1",
      field: "Sales",
      selectedValues: ["X"],
    });
    const result = clearAllSlicers(wb);
    expect(result?.clearedCount).toBe(1);
  });

  it("returns clearedCount=0 when no slicers exist", () => {
    const result = clearAllSlicers(fixture());
    expect(result?.clearedCount).toBe(0);
  });

  it("returns null on malformed input", () => {
    expect(clearAllSlicers(null as unknown as WorkbookSlicerSnapshot)).toBeNull();
  });

  it("does not mutate the original workbook", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"],
    });
    const before = JSON.stringify(wb);
    clearAllSlicers(wb);
    expect(JSON.stringify(wb)).toBe(before);
  });
});

describe("invertSlicerSelection", () => {
  it("inverts a non-empty selection (keeps the complement of selected)", () => {
    // fixture() has rows East, West, East. distinct = [East, West].
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: ["East"],
    });
    const next = invertSlicerSelection(wb, "Slicer1");
    expect(next?.sheets?.s1?._slicers?.[0].selectedValues).toEqual(["West"]);
  });

  it("inverts an empty selection to empty (show-all → show-none)", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: [],
    });
    const next = invertSlicerSelection(wb, "Slicer1");
    expect(next?.sheets?.s1?._slicers?.[0].selectedValues).toEqual([]);
  });

  it("works for pivot-targeting slicers", () => {
    const wb: WorkbookSlicerPivotSnapshot = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Data",
          cellData: {
            "0": { "0": { v: "Region" } },
            "1": { "0": { v: "East" } },
            "2": { "0": { v: "West" } },
          },
          _pivots: [{
            name: "Pivot1",
            source: { sheetId: "s1", range: { r1: 0, c1: 0, r2: 2, c2: 0 } },
            destination: { row: 5, col: 0 },
            rows: [], cols: [],
            values: [{ field: "Region", agg: "COUNT" }],
            filters: [],
            hasHeader: true,
          }],
          _slicers: [{
            name: "S1",
            targetTable: "Pivot1",
            targetKind: "pivot",
            field: "Region",
            selectedValues: ["East"],
          }],
        },
      },
    };
    const next = invertSlicerSelection(wb, "S1");
    expect(next?.sheets?.s1?._slicers?.[0].selectedValues).toEqual(["West"]);
  });

  it("returns null when the slicer doesn't exist", () => {
    expect(invertSlicerSelection(fixture(), "Nope")).toBeNull();
  });
});

describe("listAllSlicers + collectAllSlicerNames", () => {
  it("returns slicers in sheetOrder", () => {
    let wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: [],
    });
    wb = addSlicer(wb, "s1", {
      name: "Slicer2",
      targetTable: "T1",
      field: "Sales",
      selectedValues: [],
    });
    const list = listAllSlicers(wb);
    expect(list).toHaveLength(2);
    expect(list[0].slicer.name).toBe("Slicer1");
    expect(list[1].slicer.name).toBe("Slicer2");
    expect(list[0].sheetName).toBe("Data");
  });

  it("collectAllSlicerNames extracts just the names", () => {
    const wb = addSlicer(fixture(), "s1", {
      name: "Slicer1",
      targetTable: "T1",
      field: "Region",
      selectedValues: [],
    });
    expect(collectAllSlicerNames(wb)).toEqual(["Slicer1"]);
  });

  it("returns empty list for an empty workbook", () => {
    expect(listAllSlicers({})).toEqual([]);
    expect(collectAllSlicerNames({})).toEqual([]);
  });
});

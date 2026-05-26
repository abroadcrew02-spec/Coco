import { describe, it, expect } from "vitest";
import {
  addSlicer,
  applySlicerFilters,
  collectAllSlicerNames,
  generateSlicerName,
  listAllSlicers,
  listDistinctValues,
  removeSlicer,
  toggleSlicerValue,
  type SlicerEntry,
  type WorkbookSlicerSnapshot,
} from "./slicers";

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

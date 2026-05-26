import { describe, it, expect } from "vitest";
import {
  collectAllTableNames,
  createTable,
  generateTableName,
  inferColumns,
  listAllTables,
  parseA1ToRange,
  rangeToA1,
  removeTable,
  renameTable,
  type SheetWithTables,
  type TableEntry,
  type WorkbookTableSnapshot,
} from "./tables";

// Regression suite for tables.ts (390 lines, no tests). Locks the public
// surface — tables underpin slicers (PR #253) and filters, so silent drift
// would cascade.

describe("generateTableName", () => {
  it("returns Table1 on an empty list", () => {
    expect(generateTableName([])).toBe("Table1");
  });

  it("picks the smallest unused index", () => {
    expect(generateTableName(["Table1", "Table3"])).toBe("Table2");
  });

  it("skips verbatim names that don't match TableN pattern", () => {
    expect(generateTableName(["MyTable", "Table2"])).toBe("Table1");
  });

  it("verbatim taken Table3 blocks N=3", () => {
    expect(generateTableName(["Table3"])).toBe("Table1");
  });
});

describe("inferColumns", () => {
  const cellData = {
    "0": {
      "0": { v: "Region" },
      "1": { v: "Sales" },
      "2": { v: "" },        // blank
      "3": { v: "Region" },  // duplicate
    },
  };
  const range = { r1: 0, c1: 0, r2: 3, c2: 3 };

  it("reads header names when headerRow=true", () => {
    const cols = inferColumns(cellData, range, true);
    expect(cols.map((c) => c.name)).toEqual(["Region", "Sales", "Column3", "Region2"]);
  });

  it("synthesises ColumnN when headerRow=false", () => {
    const cols = inferColumns(cellData, range, false);
    expect(cols.map((c) => c.name)).toEqual(["Column1", "Column2", "Column3", "Column4"]);
  });

  it("returns at least one column for a 1-cell range", () => {
    const cols = inferColumns(undefined, { r1: 0, c1: 0, r2: 0, c2: 0 }, false);
    expect(cols).toHaveLength(1);
  });
});

describe("createTable", () => {
  const sheet: SheetWithTables = {
    name: "Data",
    cellData: {
      "0": { "0": { v: "Region" }, "1": { v: "Sales" } },
      "1": { "0": { v: "East" }, "1": { v: 100 } },
    },
  };

  it("creates a TableEntry with inferred columns + default style", () => {
    const t = createTable(sheet, { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(t.name).toBe("Table1");
    expect(t.headerRow).toBe(true);
    expect(t.columns.map((c) => c.name)).toEqual(["Region", "Sales"]);
    expect(t.style).toBe("TableStyleMedium2");
    expect(t.showBandedRows).toBe(true);
    expect(t.showFilterButton).toBe(true);
  });

  it("respects an explicit name", () => {
    const t = createTable(sheet, { r1: 0, c1: 0, r2: 1, c2: 1 }, { name: "MyTable" });
    expect(t.name).toBe("MyTable");
  });

  it("auto-generates name considering workbook-wide existing names", () => {
    const t = createTable(sheet, { r1: 0, c1: 0, r2: 1, c2: 1 }, {
      existingTableNames: ["Table1", "Table2"],
    });
    expect(t.name).toBe("Table3");
  });

  it("preserves totalsRow when requested", () => {
    const t = createTable(sheet, { r1: 0, c1: 0, r2: 1, c2: 1 }, { totalsRow: true });
    expect(t.totalsRow).toBe(true);
  });
});

describe("removeTable", () => {
  it("removes the named table", () => {
    const sheet: SheetWithTables = {
      _tables: [
        { name: "T1", range: { r1: 0, c1: 0, r2: 0, c2: 0 }, headerRow: true, columns: [] },
        { name: "T2", range: { r1: 5, c1: 0, r2: 5, c2: 0 }, headerRow: true, columns: [] },
      ],
    };
    const next = removeTable(sheet, "T1");
    expect(next).toHaveLength(1);
    expect(next[0].name).toBe("T2");
  });

  it("returns a fresh copy even when the name isn't present", () => {
    const sheet: SheetWithTables = {
      _tables: [{ name: "T1", range: { r1: 0, c1: 0, r2: 0, c2: 0 }, headerRow: true, columns: [] }],
    };
    const next = removeTable(sheet, "DoesNotExist");
    expect(next).toHaveLength(1);
    expect(next).not.toBe(sheet._tables);
  });

  it("handles a sheet with no _tables", () => {
    expect(removeTable({}, "X")).toEqual([]);
  });
});

describe("renameTable", () => {
  function fixture(): WorkbookTableSnapshot {
    return {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Data",
          _tables: [
            { name: "T1", range: { r1: 0, c1: 0, r2: 0, c2: 0 }, headerRow: true, columns: [] },
            { name: "T2", range: { r1: 5, c1: 0, r2: 5, c2: 0 }, headerRow: true, columns: [] },
          ],
        },
      },
    };
  }

  it("renames a single matching table", () => {
    const next = renameTable(fixture(), "T1", "Sales");
    expect(next).not.toBeNull();
    expect(next!.sheets!.s1!._tables![0].name).toBe("Sales");
  });

  it("rejects rename to a name already in use (case-insensitive)", () => {
    expect(renameTable(fixture(), "T1", "T2")).toBeNull();
    expect(renameTable(fixture(), "T1", "t2")).toBeNull();
  });

  it("returns null on empty / whitespace-only new name", () => {
    expect(renameTable(fixture(), "T1", "")).toBeNull();
    expect(renameTable(fixture(), "T1", "   ")).toBeNull();
  });

  it("no-op when new name equals old name (returns original)", () => {
    const wb = fixture();
    const next = renameTable(wb, "T1", "T1");
    expect(next).toBe(wb);
  });

  it("returns null on structurally malformed input", () => {
    expect(renameTable({} as WorkbookTableSnapshot, "T1", "T2")).toBeNull();
  });

  it("does not mutate the input workbook on success", () => {
    const wb = fixture();
    const before = JSON.stringify(wb);
    renameTable(wb, "T1", "Sales");
    expect(JSON.stringify(wb)).toBe(before);
  });
});

describe("listAllTables + collectAllTableNames", () => {
  const wb: WorkbookTableSnapshot = {
    sheetOrder: ["s1", "s2"],
    sheets: {
      s1: {
        name: "A",
        _tables: [
          { name: "T1", range: { r1: 0, c1: 0, r2: 0, c2: 0 }, headerRow: true, columns: [] },
        ],
      },
      s2: {
        name: "B",
        _tables: [
          { name: "T2", range: { r1: 0, c1: 0, r2: 0, c2: 0 }, headerRow: true, columns: [] },
          { name: "T3", range: { r1: 5, c1: 0, r2: 5, c2: 0 }, headerRow: true, columns: [] },
        ],
      },
    },
  };

  it("listAllTables returns all tables with sheet info, sheetOrder respected", () => {
    const list = listAllTables(wb);
    expect(list).toHaveLength(3);
    expect(list[0].table.name).toBe("T1");
    expect(list[0].sheetName).toBe("A");
  });

  it("collectAllTableNames returns just the names", () => {
    expect(collectAllTableNames(wb)).toEqual(["T1", "T2", "T3"]);
  });

  it("returns empty for empty / malformed workbook", () => {
    expect(listAllTables({})).toEqual([]);
    expect(collectAllTableNames({})).toEqual([]);
  });
});

describe("rangeToA1 + parseA1ToRange", () => {
  it("rangeToA1 emits a colon range, abbreviates 1-cell", () => {
    expect(rangeToA1({ r1: 0, c1: 0, r2: 0, c2: 0 })).toBe("A1");
    expect(rangeToA1({ r1: 0, c1: 0, r2: 4, c2: 2 })).toBe("A1:C5");
  });

  it("parseA1ToRange parses a sheet-qualified range", () => {
    expect(parseA1ToRange("Sheet1!A1:C5")).toEqual({
      sheetName: "Sheet1",
      range: { r1: 0, c1: 0, r2: 4, c2: 2 },
    });
  });

  it("parseA1ToRange parses a bare range + single cell", () => {
    expect(parseA1ToRange("B2:D5")).toEqual({
      sheetName: null,
      range: { r1: 1, c1: 1, r2: 4, c2: 3 },
    });
    expect(parseA1ToRange("C5")).toEqual({
      sheetName: null,
      range: { r1: 4, c1: 2, r2: 4, c2: 2 },
    });
  });

  it("parseA1ToRange normalises swapped corners", () => {
    expect(parseA1ToRange("D10:A1")).toEqual({
      sheetName: null,
      range: { r1: 0, c1: 0, r2: 9, c2: 3 },
    });
  });

  it("parseA1ToRange returns null on malformed input", () => {
    expect(parseA1ToRange("")).toBeNull();
    expect(parseA1ToRange("garbage")).toBeNull();
    expect(parseA1ToRange("A1:garbage")).toBeNull();
  });

  it("rangeToA1 ↔ parseA1ToRange round-trip", () => {
    const original = { r1: 2, c1: 1, r2: 9, c2: 5 };
    const a1 = rangeToA1(original);
    const parsed = parseA1ToRange(a1);
    expect(parsed?.range).toEqual(original);
  });
});

// Smoke test that ties to TableEntry usage downstream.
describe("TableEntry shape (consumer contract)", () => {
  it("createTable result satisfies the SheetWithTables._tables shape", () => {
    const sheet: SheetWithTables = {
      cellData: { "0": { "0": { v: "h" } } },
    };
    const t = createTable(sheet, { r1: 0, c1: 0, r2: 5, c2: 2 });
    sheet._tables = [t];
    // No assertion needed — if TableEntry drifted from SheetWithTables, the
    // assignment wouldn't typecheck.
    const verify: TableEntry = sheet._tables[0];
    expect(verify.name).toBe(t.name);
  });
});

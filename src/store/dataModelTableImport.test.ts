import { describe, it, expect } from "vitest";
import { excelTableToModelTable } from "./dataModelTableImport";
import type { WorkbookTableSnapshot } from "./tables";

// ---------------------------------------------------------------------------
// Helper to build a minimal snapshot
// ---------------------------------------------------------------------------

function makeSnapshot(
  sheetId: string,
  table: {
    name: string;
    range: { r1: number; c1: number; r2: number; c2: number };
    headerRow: boolean;
    columns: Array<{ name: string }>;
  },
  cellData: Record<string, Record<string, { v?: unknown }>>,
): WorkbookTableSnapshot {
  return {
    sheets: {
      [sheetId]: {
        cellData,
        _tables: [
          {
            ...table,
            style: "TableStyleMedium2",
            showBandedRows: true,
            showFilterButton: true,
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("excelTableToModelTable", () => {
  it("basic conversion — headerRow=true, 3 columns × 4 data rows", () => {
    const snap = makeSnapshot(
      "sheet1",
      {
        name: "Sales",
        range: { r1: 0, c1: 0, r2: 4, c2: 2 },
        headerRow: true,
        columns: [{ name: "Product" }, { name: "Region" }, { name: "Amount" }],
      },
      {
        "0": { "0": { v: "Product" }, "1": { v: "Region" }, "2": { v: "Amount" } },
        "1": { "0": { v: "Apple" }, "1": { v: "East" }, "2": { v: 100 } },
        "2": { "0": { v: "Banana" }, "1": { v: "West" }, "2": { v: 200 } },
        "3": { "0": { v: "Cherry" }, "1": { v: "East" }, "2": { v: 150 } },
        "4": { "0": { v: "Date" }, "1": { v: "South" }, "2": { v: 75 } },
      },
    );

    const result = excelTableToModelTable(snap, "sheet1", "Sales");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Sales");
    expect(result!.columns).toHaveLength(3);
    expect(result!.rows).toHaveLength(4);
    expect(result!.rows[0]).toEqual({ Product: "Apple", Region: "East", Amount: 100 });
    expect(result!.columns[2].type).toBe("number");
  });

  it("headerRow=false — uses synthesised Column1, Column2, ... names", () => {
    const snap = makeSnapshot(
      "sheet1",
      {
        name: "NoHeader",
        range: { r1: 0, c1: 0, r2: 1, c2: 1 },
        headerRow: false,
        columns: [{ name: "Column1" }, { name: "Column2" }],
      },
      {
        "0": { "0": { v: "A" }, "1": { v: 1 } },
        "1": { "0": { v: "B" }, "1": { v: 2 } },
      },
    );

    const result = excelTableToModelTable(snap, "sheet1", "NoHeader");
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
    expect(result!.columns[0].name).toBe("Column1");
    expect(result!.columns[1].name).toBe("Column2");
  });

  it("numeric-only column → infers type 'number'", () => {
    const snap = makeSnapshot(
      "s1",
      {
        name: "T",
        range: { r1: 0, c1: 0, r2: 2, c2: 0 },
        headerRow: true,
        columns: [{ name: "Val" }],
      },
      {
        "0": { "0": { v: "Val" } },
        "1": { "0": { v: 42 } },
        "2": { "0": { v: 99 } },
      },
    );

    const result = excelTableToModelTable(snap, "s1", "T");
    expect(result!.columns[0].type).toBe("number");
  });

  it("boolean-only column → infers type 'boolean'", () => {
    const snap = makeSnapshot(
      "s1",
      {
        name: "T",
        range: { r1: 0, c1: 0, r2: 2, c2: 0 },
        headerRow: true,
        columns: [{ name: "Active" }],
      },
      {
        "0": { "0": { v: "Active" } },
        "1": { "0": { v: true } },
        "2": { "0": { v: false } },
      },
    );

    const result = excelTableToModelTable(snap, "s1", "T");
    expect(result!.columns[0].type).toBe("boolean");
  });

  it("date-like string column → infers type 'date'", () => {
    const snap = makeSnapshot(
      "s1",
      {
        name: "T",
        range: { r1: 0, c1: 0, r2: 2, c2: 0 },
        headerRow: true,
        columns: [{ name: "Date" }],
      },
      {
        "0": { "0": { v: "Date" } },
        "1": { "0": { v: "2024-01-15" } },
        "2": { "0": { v: "2024-06-30" } },
      },
    );

    const result = excelTableToModelTable(snap, "s1", "T");
    expect(result!.columns[0].type).toBe("date");
  });

  it("empty cells / undefined values are stored as null in rows", () => {
    const snap = makeSnapshot(
      "s1",
      {
        name: "T",
        range: { r1: 0, c1: 0, r2: 2, c2: 1 },
        headerRow: true,
        columns: [{ name: "A" }, { name: "B" }],
      },
      {
        "0": { "0": { v: "A" }, "1": { v: "B" } },
        "1": { "0": { v: "hello" } },
        "2": {},
      },
    );

    const result = excelTableToModelTable(snap, "s1", "T");
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual({ A: "hello", B: null });
    expect(result!.rows[1]).toEqual({ A: null, B: null });
  });

  it("returns null when sheet does not exist", () => {
    const snap: WorkbookTableSnapshot = { sheets: {} };
    expect(excelTableToModelTable(snap, "missing", "T")).toBeNull();
  });

  it("returns null when table name is not found on the sheet", () => {
    const snap = makeSnapshot(
      "s1",
      {
        name: "Exists",
        range: { r1: 0, c1: 0, r2: 1, c2: 0 },
        headerRow: true,
        columns: [{ name: "X" }],
      },
      { "0": { "0": { v: "X" } }, "1": { "0": { v: 1 } } },
    );

    expect(excelTableToModelTable(snap, "s1", "DoesNotExist")).toBeNull();
  });
});

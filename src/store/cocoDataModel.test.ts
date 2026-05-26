import { describe, it, expect } from "vitest";
import {
  addCalculatedColumn,
  addMeasure,
  addRelationship,
  addTable,
  applyCalculatedColumns,
  EMPTY_DATA_MODEL,
  readDataModel,
  removeCalculatedColumn,
  removeMeasure,
  removeRelationship,
  removeTable,
  toDataModel,
  writeDataModel,
  type CocoDataModel,
  type StoredCalculatedColumn,
  type StoredMeasure,
} from "./cocoDataModel";
import type { ModelRelationship, ModelTable } from "./daxEngine";

const sampleTable: ModelTable = {
  name: "Sales",
  columns: [
    { name: "Region", type: "string" },
    { name: "Amount", type: "number" },
  ],
  rows: [{ Region: "East", Amount: 100 }],
};

const sampleRel: ModelRelationship = {
  fromTable: "Sales",
  fromColumn: "Region",
  toTable: "Regions",
  toColumn: "Code",
};

function makeMeasure(id: string, name: string = id): StoredMeasure {
  return {
    id,
    name,
    tableId: "Sales",
    expression: "SUM(Sales[Amount])",
  };
}

describe("readDataModel", () => {
  it("returns EMPTY_DATA_MODEL for missing snapshot", () => {
    expect(readDataModel(null)).toEqual(EMPTY_DATA_MODEL);
    expect(readDataModel(undefined)).toEqual(EMPTY_DATA_MODEL);
    expect(readDataModel({})).toEqual(EMPTY_DATA_MODEL);
  });

  it("reads a populated _cocoDataModel", () => {
    const snap = {
      _cocoDataModel: {
        tables: [sampleTable],
        relationships: [sampleRel],
        measures: [makeMeasure("m1")],
        calculatedColumns: [],
        updatedAt: "2026-05-26T00:00:00.000Z",
      },
    };
    const m = readDataModel(snap);
    expect(m.tables).toHaveLength(1);
    expect(m.relationships).toHaveLength(1);
    expect(m.measures).toHaveLength(1);
    expect(m.updatedAt).toBe("2026-05-26T00:00:00.000Z");
  });

  it("tolerates partial / malformed _cocoDataModel", () => {
    expect(readDataModel({ _cocoDataModel: "garbage" })).toEqual(EMPTY_DATA_MODEL);
    expect(readDataModel({ _cocoDataModel: { tables: "no" } })).toEqual({
      tables: [],
      relationships: [],
      measures: [],
      calculatedColumns: [],
      updatedAt: undefined,
    });
  });
});

describe("writeDataModel", () => {
  it("writes a fresh _cocoDataModel and stamps updatedAt", () => {
    const out = writeDataModel({}, { ...EMPTY_DATA_MODEL, tables: [sampleTable] });
    const dm = (out as { _cocoDataModel: { tables: ModelTable[]; updatedAt?: string } })
      ._cocoDataModel;
    expect(dm.tables).toHaveLength(1);
    expect(typeof dm.updatedAt).toBe("string");
  });

  it("removes the _cocoDataModel key when the model is empty", () => {
    const snap = { _cocoDataModel: { tables: [sampleTable] } };
    const out = writeDataModel(snap, EMPTY_DATA_MODEL);
    expect(out._cocoDataModel).toBeUndefined();
  });

  it("does NOT mutate the input snapshot", () => {
    const snap = { foo: "bar" };
    writeDataModel(snap, { ...EMPTY_DATA_MODEL, tables: [sampleTable] });
    expect(snap).toEqual({ foo: "bar" });
  });

  it("returns a fresh object even for nil snapshots", () => {
    const out = writeDataModel(null, EMPTY_DATA_MODEL);
    expect(out).toEqual({});
  });

  it("preserves other root keys (doesn't strip non-model fields)", () => {
    const snap = { foo: "bar", _scenarios: [{ name: "s1" }] };
    const out = writeDataModel(snap, {
      ...EMPTY_DATA_MODEL,
      tables: [sampleTable],
    });
    expect(out.foo).toBe("bar");
    expect(out._scenarios).toEqual([{ name: "s1" }]);
  });
});

describe("toDataModel", () => {
  it("converts stored model into runtime DataModel (DAX-engine input)", () => {
    const stored: CocoDataModel = {
      tables: [sampleTable],
      relationships: [sampleRel],
      measures: [makeMeasure("m1")],
      calculatedColumns: [],
    };
    const dm = toDataModel(stored);
    expect(dm.tables).toHaveLength(1);
    expect(dm.relationships).toHaveLength(1);
    // Rows are cloned (slice) — caller can mutate safely.
    expect(dm.tables[0].rows).not.toBe(sampleTable.rows);
    expect(dm.tables[0].rows).toEqual(sampleTable.rows);
  });
});

describe("addTable / removeTable", () => {
  it("addTable appends a new table", () => {
    const m = addTable(EMPTY_DATA_MODEL, sampleTable);
    expect(m.tables).toHaveLength(1);
  });

  it("addTable replaces same-named tables idempotently", () => {
    const m = addTable(addTable(EMPTY_DATA_MODEL, sampleTable), {
      ...sampleTable,
      columns: [{ name: "NewCol", type: "string" }],
    });
    expect(m.tables).toHaveLength(1);
    expect(m.tables[0].columns).toHaveLength(1);
    expect(m.tables[0].columns[0].name).toBe("NewCol");
  });

  it("removeTable drops the named table + its relationships + measures + calc cols", () => {
    let m = addTable(EMPTY_DATA_MODEL, sampleTable);
    m = addRelationship(m, sampleRel);
    m = addMeasure(m, makeMeasure("m1"));
    const cc: StoredCalculatedColumn = {
      id: "c1",
      name: "FullName",
      tableId: "Sales",
      expression: "Sales[Region] & 'x'",
      columnName: "FullName",
    };
    m = addCalculatedColumn(m, cc);

    m = removeTable(m, "Sales");
    expect(m.tables).toEqual([]);
    expect(m.relationships).toEqual([]); // dropped relationships involving Sales
    expect(m.measures).toEqual([]); // dropped Sales-owned measures
    expect(m.calculatedColumns).toEqual([]);
  });
});

describe("addRelationship / removeRelationship", () => {
  it("addRelationship replaces a same-(from,to)-key relationship", () => {
    let m = addRelationship(EMPTY_DATA_MODEL, sampleRel);
    m = addRelationship(m, { ...sampleRel, fromColumn: "Region2" });
    // Different fromColumn → new relationship (not a replacement)
    expect(m.relationships).toHaveLength(2);

    // Same 4-tuple → replace
    m = addRelationship(m, sampleRel);
    expect(m.relationships).toHaveLength(2);
  });

  it("removeRelationship drops by (fromTable, toTable)", () => {
    let m = addRelationship(EMPTY_DATA_MODEL, sampleRel);
    m = removeRelationship(m, "Sales", "Regions");
    expect(m.relationships).toEqual([]);
  });
});

describe("addMeasure / removeMeasure", () => {
  it("addMeasure replaces by id idempotently", () => {
    const m1 = makeMeasure("m1", "Original");
    const m2 = { ...m1, name: "Updated" };
    const m = addMeasure(addMeasure(EMPTY_DATA_MODEL, m1), m2);
    expect(m.measures).toHaveLength(1);
    expect(m.measures[0].name).toBe("Updated");
  });

  it("removeMeasure drops by id", () => {
    let m = addMeasure(EMPTY_DATA_MODEL, makeMeasure("m1"));
    m = removeMeasure(m, "m1");
    expect(m.measures).toEqual([]);
  });
});

describe("addCalculatedColumn / removeCalculatedColumn", () => {
  const cc: StoredCalculatedColumn = {
    id: "cc1",
    name: "FullName",
    tableId: "Sales",
    expression: "Sales[Region] & 'x'",
    columnName: "FullName",
  };

  it("addCalculatedColumn replaces by id idempotently", () => {
    const cc2 = { ...cc, expression: "UPPER(Sales[Region])" };
    const m = addCalculatedColumn(addCalculatedColumn(EMPTY_DATA_MODEL, cc), cc2);
    expect(m.calculatedColumns).toHaveLength(1);
    expect(m.calculatedColumns[0].expression).toBe("UPPER(Sales[Region])");
  });

  it("removeCalculatedColumn drops by id", () => {
    let m = addCalculatedColumn(EMPTY_DATA_MODEL, cc);
    m = removeCalculatedColumn(m, "cc1");
    expect(m.calculatedColumns).toEqual([]);
  });
});

describe("round-trip (read ↔ write)", () => {
  it("write + read returns an equivalent model", () => {
    let m: CocoDataModel = EMPTY_DATA_MODEL;
    m = addTable(m, sampleTable);
    m = addRelationship(m, sampleRel);
    m = addMeasure(m, makeMeasure("m1", "Total Sales"));

    const snap = writeDataModel({ id: "wb-1", appVersion: "x" }, m);
    const reread = readDataModel(snap);
    expect(reread.tables.length).toBe(m.tables.length);
    expect(reread.relationships.length).toBe(m.relationships.length);
    expect(reread.measures.length).toBe(m.measures.length);
    expect(reread.measures[0].name).toBe("Total Sales");
  });

  it("write(empty) drops the key — second read returns EMPTY", () => {
    const snap = writeDataModel(
      { _cocoDataModel: { tables: [sampleTable] } },
      EMPTY_DATA_MODEL,
    );
    expect(readDataModel(snap)).toEqual(EMPTY_DATA_MODEL);
  });
});

// ---------------------------------------------------------------------------
// Step 4: applyCalculatedColumns bridge
// ---------------------------------------------------------------------------

describe("applyCalculatedColumns", () => {
  const tableWithRows: ModelTable = {
    name: "Sales",
    columns: [
      { name: "Region", type: "string" },
      { name: "Amount", type: "number" },
    ],
    rows: [
      { Region: "East", Amount: 100 },
      { Region: "West", Amount: 200 },
    ],
  };

  function modelWithTable(): CocoDataModel {
    return addTable(EMPTY_DATA_MODEL, tableWithRows);
  }

  it("applies stored calculated columns to the runtime DataModel", () => {
    const cc: StoredCalculatedColumn = {
      id: "cc1",
      name: "AmountX2",
      tableId: "Sales",
      expression: "Sales[Amount] * 2",
      columnName: "AmountX2",
    };
    const cocoModel = addCalculatedColumn(modelWithTable(), cc);
    const base = toDataModel(cocoModel);
    const runtime = applyCalculatedColumns(base, cocoModel);

    expect(runtime.tables[0].rows[0].AmountX2).toBe(200);
    expect(runtime.tables[0].rows[1].AmountX2).toBe(400);
  });

  it("does nothing when calculatedColumns array is empty", () => {
    const base = toDataModel(modelWithTable());
    const runtime = applyCalculatedColumns(base, modelWithTable());
    // Same rows, no new columns.
    expect(runtime.tables[0].rows[0]).not.toHaveProperty("AmountX2");
    expect(runtime.tables[0].columns).toHaveLength(2);
  });

  it("multiple stored columns are applied in definition order", () => {
    let cocoModel = modelWithTable();
    const cc1: StoredCalculatedColumn = {
      id: "cc1",
      name: "AmountX2",
      tableId: "Sales",
      expression: "Sales[Amount] * 2",
      columnName: "AmountX2",
    };
    const cc2: StoredCalculatedColumn = {
      id: "cc2",
      name: "AmountX4",
      tableId: "Sales",
      expression: "Sales[AmountX2] * 2",
      columnName: "AmountX4",
    };
    cocoModel = addCalculatedColumn(addCalculatedColumn(cocoModel, cc1), cc2);
    const runtime = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);
    expect(runtime.tables[0].rows[0].AmountX4).toBe(400);  // 100*2*2
    expect(runtime.tables[0].rows[1].AmountX4).toBe(800);  // 200*2*2
  });

  it("bad expression marks cells as #ERROR! without crashing", () => {
    const cc: StoredCalculatedColumn = {
      id: "cc-bad",
      name: "Bad",
      tableId: "Sales",
      expression: "1 +",  // trailing operator → parse error
      columnName: "Bad",
    };
    const cocoModel = addCalculatedColumn(modelWithTable(), cc);
    const runtime = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);
    expect(runtime.tables[0].rows[0].Bad).toBe("#ERROR!");
    expect(runtime.tables[0].rows[1].Bad).toBe("#ERROR!");
  });
});

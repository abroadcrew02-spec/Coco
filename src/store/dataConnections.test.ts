import { describe, expect, it } from "vitest";
import {
  addConnection,
  applyFragmentToSheet,
  applyStep,
  applySteps,
  defaultConnectionName,
  describeStep,
  fragmentToGrid,
  gridToFragment,
  inferConnectionType,
  listConnections,
  removeConnection,
  transformFragment,
  updateConnection,
  validateSqliteQuery,
  type DataConnection,
  type EtlStep,
  type Grid,
  type SheetFragment,
} from "./dataConnections";

const makeConn = (overrides: Partial<DataConnection> = {}): DataConnection => ({
  id: "conn-1",
  name: "test",
  type: "csv",
  sourcePath: "/tmp/foo.csv",
  targetSheetId: null,
  targetSheetName: "Imported",
  lastRefreshedAt: null,
  ...overrides,
});

const fragment = (): SheetFragment => ({
  cellData: {
    "0": { "0": { v: "name" }, "1": { v: "age" } },
    "1": { "0": { v: "alice" }, "1": { v: 30 } },
  },
  rowCount: 2,
  columnCount: 2,
  headers: ["name", "age"],
});

describe("dataConnections - basics", () => {
  it("inferConnectionType handles csv/tsv/json/sqlite and rejects other", () => {
    expect(inferConnectionType("a.csv")).toBe("csv");
    expect(inferConnectionType("a.CSV")).toBe("csv");
    expect(inferConnectionType("a.tsv")).toBe("csv");
    expect(inferConnectionType("a.json")).toBe("json");
    expect(inferConnectionType("a.db")).toBe("sqlite");
    expect(inferConnectionType("a.sqlite")).toBe("sqlite");
    expect(inferConnectionType("a.xlsx")).toBeNull();
    expect(inferConnectionType("no-extension")).toBeNull();
  });

  it("defaultConnectionName strips extension and directory", () => {
    expect(defaultConnectionName("/tmp/sales.csv")).toBe("sales");
    expect(defaultConnectionName("C:\\data\\sales.json")).toBe("sales");
    expect(defaultConnectionName("plain")).toBe("plain");
  });

  it("addConnection appends and listConnections reads back", () => {
    const snap = {};
    addConnection(snap, makeConn());
    expect(listConnections(snap)).toHaveLength(1);
    expect(listConnections(snap)[0].id).toBe("conn-1");
  });

  it("updateConnection patches by id", () => {
    const snap = {};
    addConnection(snap, makeConn());
    updateConnection(snap, "conn-1", { name: "renamed" });
    expect(listConnections(snap)[0].name).toBe("renamed");
  });

  it("removeConnection filters out by id", () => {
    const snap = {};
    addConnection(snap, makeConn({ id: "a" }));
    addConnection(snap, makeConn({ id: "b" }));
    removeConnection(snap, "a");
    expect(listConnections(snap).map((c) => c.id)).toEqual(["b"]);
  });

  it("listConnections drops malformed entries defensively", () => {
    const snap = {
      _connections: [
        makeConn(),
        { id: "bad", type: "bogus", sourcePath: "x" }, // invalid type
        { type: "csv", sourcePath: "x" }, // missing id
        null,
        "string",
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(listConnections(snap as any)).toHaveLength(1);
  });
});

// --- #190 Phase 2: ETL pipeline ---

const sample = (): SheetFragment => ({
  cellData: {
    "0": { "0": { v: "name" }, "1": { v: "age" }, "2": { v: "city" } },
    "1": { "0": { v: "alice" }, "1": { v: 30 }, "2": { v: "tokyo" } },
    "2": { "0": { v: "bob" }, "1": { v: 25 }, "2": { v: "osaka" } },
    "3": { "0": { v: "carol" }, "1": { v: 40 }, "2": { v: "tokyo" } },
  },
  rowCount: 4,
  columnCount: 3,
  headers: ["name", "age", "city"],
});

describe("ETL grid <-> fragment", () => {
  it("fragmentToGrid produces a dense grid with header row 0", () => {
    const grid = fragmentToGrid(sample());
    expect(grid[0]).toEqual(["name", "age", "city"]);
    expect(grid[1]).toEqual(["alice", 30, "tokyo"]);
    expect(grid).toHaveLength(4);
  });

  it("gridToFragment round-trips", () => {
    const grid = fragmentToGrid(sample());
    const frag = gridToFragment(grid);
    expect(frag.headers).toEqual(["name", "age", "city"]);
    expect(frag.cellData["1"]["1"]).toEqual({ v: 30 });
  });

  it("transformFragment with no steps returns the input untouched", () => {
    const f = sample();
    expect(transformFragment(f, [])).toBe(f);
    expect(transformFragment(f, undefined)).toBe(f);
  });
});

describe("ETL steps", () => {
  const grid = (): Grid => fragmentToGrid(sample());

  it("filter eq keeps matching rows", () => {
    const out = applyStep(grid(), { kind: "filter", column: "city", op: "eq", value: "tokyo" });
    expect(out).toHaveLength(3); // header + alice + carol
    expect(out[1][0]).toBe("alice");
    expect(out[2][0]).toBe("carol");
  });

  it("filter gt compares numerically", () => {
    const out = applyStep(grid(), { kind: "filter", column: "age", op: "gt", value: "28" });
    expect(out.slice(1).map((r) => r[0])).toEqual(["alice", "carol"]);
  });

  it("filter contains is case-insensitive", () => {
    const out = applyStep(grid(), {
      kind: "filter",
      column: "name",
      op: "contains",
      value: "AL",
    });
    expect(out.slice(1).map((r) => r[0])).toEqual(["alice"]);
  });

  it("filter on unknown column is a no-op", () => {
    const g = grid();
    expect(applyStep(g, { kind: "filter", column: "nope", op: "eq", value: "x" })).toEqual(g);
  });

  it("rename changes the header only", () => {
    const out = applyStep(grid(), { kind: "rename", column: "age", to: "years" });
    expect(out[0]).toEqual(["name", "years", "city"]);
    expect(out[1]).toEqual(["alice", 30, "tokyo"]);
  });

  it("cast to number coerces strings", () => {
    const g: Grid = [
      ["v"],
      ["10"],
      ["20"],
      ["x"],
    ];
    const out = applyStep(g, { kind: "cast", column: "v", to: "number" });
    expect(out[1][0]).toBe(10);
    expect(out[2][0]).toBe(20);
    expect(out[3][0]).toBe("x"); // unparseable left alone
  });

  it("cast to boolean recognizes common truthy/falsy strings", () => {
    const g: Grid = [["v"], ["true"], ["0"], ["yes"]];
    const out = applyStep(g, { kind: "cast", column: "v", to: "boolean" });
    expect(out[1][0]).toBe(true);
    expect(out[2][0]).toBe(false);
    expect(out[3][0]).toBe(true);
  });

  it("select keeps and reorders columns", () => {
    const out = applyStep(grid(), { kind: "select", columns: ["city", "name"] });
    expect(out[0]).toEqual(["city", "name"]);
    expect(out[1]).toEqual(["tokyo", "alice"]);
  });

  it("sort ascending and descending numerically", () => {
    const asc = applyStep(grid(), { kind: "sort", column: "age", direction: "asc" });
    expect(asc.slice(1).map((r) => r[1])).toEqual([25, 30, 40]);
    const desc = applyStep(grid(), { kind: "sort", column: "age", direction: "desc" });
    expect(desc.slice(1).map((r) => r[1])).toEqual([40, 30, 25]);
  });

  it("dedup removes duplicate rows by key columns", () => {
    const g: Grid = [
      ["city"],
      ["tokyo"],
      ["osaka"],
      ["tokyo"],
    ];
    const out = applyStep(g, { kind: "dedup", columns: ["city"] });
    expect(out.slice(1).map((r) => r[0])).toEqual(["tokyo", "osaka"]);
  });

  it("applySteps runs the pipeline in order", () => {
    const steps: EtlStep[] = [
      { kind: "filter", column: "city", op: "eq", value: "tokyo" },
      { kind: "select", columns: ["name", "age"] },
      { kind: "sort", column: "age", direction: "desc" },
    ];
    const out = applySteps(grid(), steps);
    expect(out[0]).toEqual(["name", "age"]);
    expect(out.slice(1).map((r) => r[0])).toEqual(["carol", "alice"]);
  });

  it("transformFragment applies steps end-to-end", () => {
    const frag = transformFragment(sample(), [
      { kind: "filter", column: "city", op: "eq", value: "osaka" },
    ]);
    expect(frag.rowCount).toBe(2); // header + bob
    expect(frag.cellData["1"]["0"]).toEqual({ v: "bob" });
  });

  it("describeStep produces a human-readable summary", () => {
    expect(describeStep({ kind: "rename", column: "a", to: "b" })).toContain("a");
    expect(describeStep({ kind: "filter", column: "x", op: "eq", value: "1" })).toContain(
      "フィルター",
    );
  });
});

describe("validateSqliteQuery", () => {
  it("accepts SELECT and WITH", () => {
    expect(validateSqliteQuery("SELECT * FROM t")).toBeNull();
    expect(validateSqliteQuery("  with x as (select 1) select * from x")).toBeNull();
    expect(validateSqliteQuery("SELECT 1;")).toBeNull(); // trailing ; ok
  });

  it("rejects writes, empty and multi-statement queries", () => {
    expect(validateSqliteQuery("")).not.toBeNull();
    expect(validateSqliteQuery("DELETE FROM t")).not.toBeNull();
    expect(validateSqliteQuery("INSERT INTO t VALUES (1)")).not.toBeNull();
    expect(validateSqliteQuery("SELECT 1; DROP TABLE t")).not.toBeNull();
  });

  it("tolerates a leading comment before SELECT", () => {
    expect(validateSqliteQuery("-- note\nSELECT * FROM t")).toBeNull();
  });
});

describe("applyFragmentToSheet", () => {
  it("creates a new sheet on first load and writes back the sheetId", () => {
    const snap = {};
    const conn = makeConn();
    const { sheetId } = applyFragmentToSheet(snap, conn, fragment());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = snap as any;
    expect(s.sheetOrder).toEqual([sheetId]);
    expect(s.sheets[sheetId].name).toBe("Imported");
    expect(s.sheets[sheetId].cellData["0"]["0"].v).toBe("name");
    expect(s.sheets[sheetId].rowCount).toBeGreaterThanOrEqual(1000); // default min
  });

  it("refresh overwrites existing target sheet in place", () => {
    const snap = {};
    const conn = makeConn();
    const first = applyFragmentToSheet(snap, conn, fragment());
    conn.targetSheetId = first.sheetId;
    const newFragment: SheetFragment = {
      cellData: { "0": { "0": { v: "x" } } },
      rowCount: 1,
      columnCount: 1,
      headers: ["x"],
    };
    const second = applyFragmentToSheet(snap, conn, newFragment);
    expect(second.sheetId).toBe(first.sheetId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = snap as any;
    expect(s.sheets[first.sheetId].cellData["0"]["0"].v).toBe("x");
    // Did not append a second sheet.
    expect(s.sheetOrder).toHaveLength(1);
  });

  it("re-creates sheet if user deleted target between refreshes", () => {
    const snap = {};
    const conn = makeConn();
    const first = applyFragmentToSheet(snap, conn, fragment());
    conn.targetSheetId = first.sheetId;
    // Simulate user deleting the sheet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = snap as any;
    delete s.sheets[first.sheetId];
    s.sheetOrder = [];
    const second = applyFragmentToSheet(snap, conn, fragment());
    expect(s.sheets[second.sheetId]).toBeDefined();
  });

  it("avoids name collisions with existing sheets", () => {
    const snap = {
      sheetOrder: ["sheet-1"],
      sheets: { "sheet-1": { id: "sheet-1", name: "Imported" } },
    };
    const conn = makeConn();
    const { sheetId } = applyFragmentToSheet(snap, conn, fragment());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = snap as any;
    expect(s.sheets[sheetId].name).toBe("Imported (2)");
  });
});

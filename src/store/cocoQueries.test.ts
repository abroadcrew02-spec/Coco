import { describe, it, expect } from "vitest";
import {
  findQuery,
  generateQueryName,
  readQueries,
  removeQuery,
  removeQueryOnSnapshot,
  upsertQuery,
  upsertQueryOnSnapshot,
  writeQueries,
  type SavedQuery,
} from "./cocoQueries";

function makeQuery(id: string, name: string = id): SavedQuery {
  const now = "2026-05-26T00:00:00.000Z";
  return {
    id,
    name,
    source: { kind: "csv", path: "/tmp/x.csv" },
    steps: [],
    outputSheet: "Result",
    createdAt: now,
    updatedAt: now,
  };
}

describe("readQueries", () => {
  it("returns [] for null/undefined/malformed snapshot", () => {
    expect(readQueries(null)).toEqual([]);
    expect(readQueries(undefined)).toEqual([]);
    expect(readQueries({})).toEqual([]);
    expect(readQueries({ _cocoQueries: "not array" })).toEqual([]);
  });

  it("returns a defensive copy (caller mutate safe)", () => {
    const snap = { _cocoQueries: [makeQuery("q1")] };
    const a = readQueries(snap);
    a.push(makeQuery("q2"));
    expect(readQueries(snap)).toHaveLength(1);
  });
});

describe("writeQueries", () => {
  it("writes a fresh _cocoQueries array", () => {
    const out = writeQueries({}, [makeQuery("q1")]);
    expect(((out as { _cocoQueries: SavedQuery[] })._cocoQueries)).toHaveLength(1);
  });

  it("removes the key when array is empty", () => {
    const snap = { _cocoQueries: [makeQuery("q1")] };
    const out = writeQueries(snap, []);
    expect(out._cocoQueries).toBeUndefined();
  });

  it("does NOT mutate the input snapshot", () => {
    const snap = { foo: "bar" };
    writeQueries(snap, [makeQuery("q1")]);
    expect(snap).toEqual({ foo: "bar" });
  });

  it("preserves other root keys", () => {
    const snap = { foo: "bar", _scenarios: [] };
    const out = writeQueries(snap, [makeQuery("q1")]);
    expect(out.foo).toBe("bar");
    expect(out._scenarios).toEqual([]);
  });

  it("handles nil input", () => {
    const out = writeQueries(null, []);
    expect(out).toEqual({});
  });
});

describe("upsertQuery", () => {
  it("appends a new query", () => {
    const queries = upsertQuery([], makeQuery("q1"));
    expect(queries).toHaveLength(1);
  });

  it("replaces by id idempotently", () => {
    const initial = upsertQuery([], makeQuery("q1", "Original"));
    const updated = upsertQuery(initial, makeQuery("q1", "Updated"));
    expect(updated).toHaveLength(1);
    expect(updated[0].name).toBe("Updated");
  });

  it("preserves createdAt when replacing", () => {
    const q1 = makeQuery("q1");
    q1.createdAt = "2024-01-01T00:00:00.000Z";
    const initial = upsertQuery([], q1);
    const replaced = upsertQuery(initial, { ...q1, name: "Updated" });
    expect(replaced[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("stamps updatedAt with current time", () => {
    const initial = upsertQuery([], makeQuery("q1"));
    const before = Date.now();
    const updated = upsertQuery(initial, makeQuery("q1", "Updated"));
    const stampMs = new Date(updated[0].updatedAt).getTime();
    expect(stampMs).toBeGreaterThanOrEqual(before);
  });
});

describe("removeQuery", () => {
  it("drops by id", () => {
    const queries = [makeQuery("q1"), makeQuery("q2")];
    expect(removeQuery(queries, "q1")).toHaveLength(1);
    expect(removeQuery(queries, "q1")[0].id).toBe("q2");
  });

  it("no-op when id missing", () => {
    const queries = [makeQuery("q1")];
    expect(removeQuery(queries, "ghost")).toHaveLength(1);
  });
});

describe("convenience wrappers", () => {
  it("upsertQueryOnSnapshot ↔ removeQueryOnSnapshot round-trip", () => {
    const snap1 = upsertQueryOnSnapshot({}, makeQuery("q1"));
    expect(readQueries(snap1)).toHaveLength(1);
    const snap2 = removeQueryOnSnapshot(snap1, "q1");
    expect(readQueries(snap2)).toHaveLength(0);
    expect(snap2._cocoQueries).toBeUndefined();
  });

  it("upsertQueryOnSnapshot preserves other root keys", () => {
    const out = upsertQueryOnSnapshot({ foo: "bar" }, makeQuery("q1"));
    expect(out.foo).toBe("bar");
  });
});

describe("generateQueryName", () => {
  it("returns Query1 on empty list", () => {
    expect(generateQueryName([])).toBe("Query1");
  });

  it("picks the smallest unused index", () => {
    expect(
      generateQueryName([makeQuery("a", "Query1"), makeQuery("c", "Query3")]),
    ).toBe("Query2");
  });

  it("skips verbatim taken names not matching pattern", () => {
    expect(
      generateQueryName([
        makeQuery("a", "MyQuery"),
        makeQuery("b", "Query2"),
      ]),
    ).toBe("Query1");
  });

  it("skips verbatim taken Query3 even when index 3 free", () => {
    expect(generateQueryName([makeQuery("a", "Query3")])).toBe("Query1");
  });
});

describe("findQuery", () => {
  it("finds a query by id", () => {
    const snap = upsertQueryOnSnapshot({}, makeQuery("q1", "Hello"));
    expect(findQuery(snap, "q1")?.name).toBe("Hello");
  });

  it("returns null for unknown id / malformed snapshot", () => {
    expect(findQuery({}, "q1")).toBeNull();
    expect(findQuery(null, "q1")).toBeNull();
  });
});

describe("source variants", () => {
  it("stores csv source", () => {
    const q = makeQuery("q1");
    q.source = { kind: "csv", path: "/tmp/x.csv", encoding: "sjis" };
    const snap = upsertQueryOnSnapshot({}, q);
    expect((readQueries(snap)[0].source as { kind: string }).kind).toBe("csv");
  });

  it("stores sqlite source", () => {
    const q = makeQuery("q1");
    q.source = { kind: "sqlite", path: "/tmp/x.db", query: "SELECT * FROM t" };
    const snap = upsertQueryOnSnapshot({}, q);
    expect((readQueries(snap)[0].source as { kind: string }).kind).toBe("sqlite");
  });

  it("stores static-rows source", () => {
    const q = makeQuery("q1");
    q.source = {
      kind: "static",
      rows: [{ a: 1, b: 2 }],
      columns: ["a", "b"],
    };
    const snap = upsertQueryOnSnapshot({}, q);
    const s = readQueries(snap)[0].source;
    expect(s.kind).toBe("static");
    if (s.kind === "static") {
      expect(s.rows).toHaveLength(1);
    }
  });
});

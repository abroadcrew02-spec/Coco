// #244 — Tests for linkedDataTypes.ts (local CSV linked data types).

import { describe, it, expect } from "vitest";
import {
  type CocoLinkedDataTypes,
  type LinkedDataTypeSource,
  EMPTY_LINKED_DATA_TYPES,
  readLinkedDataTypes,
  writeLinkedDataTypes,
  addSource,
  removeSource,
  updateSource,
  listSources,
  lookupInSource,
  normalizeSource,
} from "./linkedDataTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<LinkedDataTypeSource> = {}): LinkedDataTypeSource {
  return {
    id: "src-1",
    name: "株価データ",
    sourcePath: "/data/stocks.csv",
    keyColumn: "Ticker",
    columns: ["Ticker", "Price", "Industry"],
    updatedAt: "2026-05-27T00:00:00.000Z",
    kind: "csv",
    ...overrides,
  };
}

function makeSqliteSource(overrides: Partial<LinkedDataTypeSource> = {}): LinkedDataTypeSource {
  return {
    id: "src-sqlite-1",
    name: "SQLite データ",
    sourcePath: "/data/stocks.db",
    keyColumn: "ticker",
    columns: ["ticker", "price", "industry"],
    updatedAt: "2026-05-27T00:00:00.000Z",
    kind: "sqlite",
    sqliteTable: "stocks",
    ...overrides,
  };
}

const SAMPLE_CSV_DATA: Array<Record<string, string>> = [
  { Ticker: "MSFT", Price: "420", Industry: "Technology" },
  { Ticker: "AAPL", Price: "185", Industry: "Technology" },
  { Ticker: "Toyota", Price: "3200", Industry: "Automotive" },
];

// ---------------------------------------------------------------------------
// CRUD tests
// ---------------------------------------------------------------------------

describe("addSource", () => {
  it("adds a source to an empty model", () => {
    const src = makeSource();
    const model = addSource(EMPTY_LINKED_DATA_TYPES, src);
    expect(model.sources).toHaveLength(1);
    expect(model.sources[0].id).toBe("src-1");
  });

  it("replaces an existing source with the same id (idempotent)", () => {
    const src = makeSource();
    const updated = makeSource({ name: "更新後" });
    const model = addSource(addSource(EMPTY_LINKED_DATA_TYPES, src), updated);
    expect(model.sources).toHaveLength(1);
    expect(model.sources[0].name).toBe("更新後");
  });

  it("does not mutate the original model", () => {
    const original = EMPTY_LINKED_DATA_TYPES;
    addSource(original, makeSource());
    expect(original.sources).toHaveLength(0);
  });
});

describe("removeSource", () => {
  it("removes a source by id", () => {
    const model = addSource(EMPTY_LINKED_DATA_TYPES, makeSource());
    const after = removeSource(model, "src-1");
    expect(after.sources).toHaveLength(0);
  });

  it("is a no-op when id does not exist", () => {
    const model = addSource(EMPTY_LINKED_DATA_TYPES, makeSource());
    const after = removeSource(model, "nonexistent");
    expect(after.sources).toHaveLength(1);
  });
});

describe("updateSource", () => {
  it("patches only the specified fields", () => {
    const model = addSource(EMPTY_LINKED_DATA_TYPES, makeSource());
    const after = updateSource(model, "src-1", { name: "新名称" });
    expect(after.sources[0].name).toBe("新名称");
    expect(after.sources[0].keyColumn).toBe("Ticker"); // unchanged
    expect(after.sources[0].updatedAt).not.toBe("2026-05-27T00:00:00.000Z"); // refreshed
  });
});

describe("listSources", () => {
  it("returns all sources", () => {
    const m1 = addSource(EMPTY_LINKED_DATA_TYPES, makeSource({ id: "a" }));
    const m2 = addSource(m1, makeSource({ id: "b" }));
    expect(listSources(m2)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Snapshot I/O tests
// ---------------------------------------------------------------------------

describe("readLinkedDataTypes", () => {
  it("returns EMPTY for null input", () => {
    expect(readLinkedDataTypes(null)).toEqual(EMPTY_LINKED_DATA_TYPES);
  });

  it("returns EMPTY when _cocoDataTypes key is absent (legacy snapshot)", () => {
    expect(readLinkedDataTypes({ sheets: {}, sheetOrder: [] })).toEqual(
      EMPTY_LINKED_DATA_TYPES,
    );
  });

  it("returns EMPTY when _cocoDataTypes.sources is not an array", () => {
    expect(readLinkedDataTypes({ _cocoDataTypes: { sources: null } })).toEqual(
      EMPTY_LINKED_DATA_TYPES,
    );
  });

  it("filters out malformed source entries", () => {
    const snap = {
      _cocoDataTypes: {
        sources: [
          makeSource(), // valid
          { id: 123 }, // invalid — id is not a string
          { id: "x", name: "ok" }, // incomplete
        ],
      },
    };
    const result = readLinkedDataTypes(snap);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].id).toBe("src-1");
  });
});

describe("writeLinkedDataTypes", () => {
  it("removes _cocoDataTypes when sources is empty", () => {
    const snap = { _cocoDataTypes: { sources: [makeSource()] }, sheets: {} };
    const out = writeLinkedDataTypes(snap, EMPTY_LINKED_DATA_TYPES);
    expect(out).not.toHaveProperty("_cocoDataTypes");
    expect(out).toHaveProperty("sheets"); // other keys preserved
  });

  it("writes sources into a snapshot clone", () => {
    const snap = { sheets: {} };
    const model: CocoLinkedDataTypes = { sources: [makeSource()] };
    const out = writeLinkedDataTypes(snap, model);
    expect((out._cocoDataTypes as CocoLinkedDataTypes).sources).toHaveLength(1);
    // Must not mutate the input
    expect(snap).not.toHaveProperty("_cocoDataTypes");
  });
});

describe("snapshot round-trip", () => {
  it("survives write → read with sources intact", () => {
    const model: CocoLinkedDataTypes = { sources: [makeSource()] };
    const snap = writeLinkedDataTypes({}, model);
    const recovered = readLinkedDataTypes(snap);
    expect(recovered.sources).toHaveLength(1);
    expect(recovered.sources[0].id).toBe("src-1");
    expect(recovered.sources[0].columns).toEqual(["Ticker", "Price", "Industry"]);
  });
});

// ---------------------------------------------------------------------------
// lookupInSource tests
// ---------------------------------------------------------------------------

describe("lookupInSource", () => {
  const source = makeSource();

  it("finds an exact-case match", () => {
    const result = lookupInSource(SAMPLE_CSV_DATA, "MSFT", source);
    expect(result).not.toBeNull();
    expect(result?.Industry).toBe("Technology");
  });

  it("is case-insensitive (lowercase input)", () => {
    const result = lookupInSource(SAMPLE_CSV_DATA, "msft", source);
    expect(result).not.toBeNull();
    expect(result?.Price).toBe("420");
  });

  it("is case-insensitive (mixed case)", () => {
    const result = lookupInSource(SAMPLE_CSV_DATA, "toyota", source);
    expect(result).not.toBeNull();
    expect(result?.Industry).toBe("Automotive");
  });

  it("returns null for a miss", () => {
    const result = lookupInSource(SAMPLE_CSV_DATA, "GOOG", source);
    expect(result).toBeNull();
  });

  it("returns null for an empty key value", () => {
    const result = lookupInSource(SAMPLE_CSV_DATA, "  ", source);
    expect(result).toBeNull();
  });

  it("returns all columns in the matched row", () => {
    const result = lookupInSource(SAMPLE_CSV_DATA, "AAPL", source);
    expect(result).toMatchObject({ Ticker: "AAPL", Price: "185", Industry: "Technology" });
  });
});

// ---------------------------------------------------------------------------
// #310 — SQLite source kind tests
// ---------------------------------------------------------------------------

describe("normalizeSource", () => {
  it("adds kind='csv' to a legacy source that has no kind field", () => {
    const legacy = makeSource();
    // Simulate a pre-#310 snapshot entry by omitting the kind field.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { kind: _omit, ...legacyRest } = legacy;
    const legacyNoKind = legacyRest as unknown as LinkedDataTypeSource;
    expect(legacyNoKind.kind).toBeUndefined();

    const normalized = normalizeSource(legacyNoKind);
    expect(normalized.kind).toBe("csv");
    // Other fields must be preserved.
    expect(normalized.id).toBe("src-1");
    expect(normalized.keyColumn).toBe("Ticker");
  });

  it("does not change kind when already set to 'csv'", () => {
    const src = makeSource({ kind: "csv" });
    expect(normalizeSource(src).kind).toBe("csv");
  });

  it("does not change kind when set to 'sqlite'", () => {
    const src = makeSqliteSource();
    const normalized = normalizeSource(src);
    expect(normalized.kind).toBe("sqlite");
    expect(normalized.sqliteTable).toBe("stocks");
  });
});

describe("SQLite source — isValidSource via readLinkedDataTypes", () => {
  it("accepts a valid sqlite source in a snapshot", () => {
    const snap = {
      _cocoDataTypes: { sources: [makeSqliteSource()] },
    };
    const model = readLinkedDataTypes(snap);
    expect(model.sources).toHaveLength(1);
    const src = model.sources[0];
    expect(src.kind).toBe("sqlite");
    expect(src.sqliteTable).toBe("stocks");
  });

  it("rejects a sqlite source with invalid kind value", () => {
    const snap = {
      _cocoDataTypes: {
        sources: [makeSqliteSource({ kind: "excel" as unknown as "sqlite" })],
      },
    };
    const model = readLinkedDataTypes(snap);
    expect(model.sources).toHaveLength(0);
  });

  it("rejects a sqlite source with non-string sqliteTable", () => {
    const snap = {
      _cocoDataTypes: {
        sources: [makeSqliteSource({ sqliteTable: 42 as unknown as string })],
      },
    };
    const model = readLinkedDataTypes(snap);
    expect(model.sources).toHaveLength(0);
  });

  it("survives write → read round-trip for a sqlite source", () => {
    const src = makeSqliteSource();
    const model: CocoLinkedDataTypes = { sources: [src] };
    const snap = writeLinkedDataTypes({}, model);
    const recovered = readLinkedDataTypes(snap);
    expect(recovered.sources).toHaveLength(1);
    expect(recovered.sources[0].kind).toBe("sqlite");
    expect(recovered.sources[0].sqliteTable).toBe("stocks");
  });

  it("legacy source (no kind) passes isValidSource and can be normalized", () => {
    const legacyRaw = {
      id: "legacy-1",
      name: "旧ソース",
      sourcePath: "/old/data.csv",
      keyColumn: "ID",
      columns: ["ID", "Name"],
      updatedAt: "2025-01-01T00:00:00.000Z",
      // no kind field
    };
    const snap = { _cocoDataTypes: { sources: [legacyRaw] } };
    const model = readLinkedDataTypes(snap);
    expect(model.sources).toHaveLength(1);
    // Apply normalize.
    const normalized = normalizeSource(model.sources[0]);
    expect(normalized.kind).toBe("csv");
  });
});

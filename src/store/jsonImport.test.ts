import { describe, it, expect } from "vitest";
import {
  parseJson,
  parseJsonLines,
  parseAuto,
  buildSnapshotFromJson,
} from "./jsonImport";

describe("parseJson", () => {
  it("parses an array of objects", () => {
    const r = parseJson(JSON.stringify([{ name: "x", qty: 1 }, { name: "y", qty: 2 }]));
    expect(r.headers).toEqual(["name", "qty"]);
    expect(r.rows).toHaveLength(2);
    expect(r.warnings).toEqual([]);
  });

  it("unions headers across objects in first-seen order", () => {
    const r = parseJson(JSON.stringify([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }]));
    expect(r.headers).toEqual(["a", "b", "c"]);
  });

  it("warns when non-object entries appear", () => {
    const r = parseJson(JSON.stringify([{ a: 1 }, 42, { a: 2 }]));
    expect(r.rows).toHaveLength(2);
    expect(r.warnings).toHaveLength(1);
  });

  it("rejects non-array root JSON", () => {
    const r = parseJson(JSON.stringify({ foo: "bar" }));
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("surfaces a single parse error for malformed JSON", () => {
    const r = parseJson("not json");
    expect(r.rows).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
  });
});

describe("parseJsonLines", () => {
  it("parses one object per line", () => {
    const input = '{"a":1}\n{"a":2}\n{"a":3}\n';
    const r = parseJsonLines(input);
    expect(r.rows).toHaveLength(3);
    expect(r.headers).toEqual(["a"]);
  });

  it("skips blank lines", () => {
    const input = '{"a":1}\n\n\n{"a":2}\n';
    const r = parseJsonLines(input);
    expect(r.rows).toHaveLength(2);
  });

  it("warns on individual malformed lines but keeps parsing", () => {
    const input = '{"a":1}\nnot json\n{"a":2}\n';
    const r = parseJsonLines(input);
    expect(r.rows).toHaveLength(2);
    expect(r.warnings).toHaveLength(1);
  });

  it("handles CRLF line endings", () => {
    const input = '{"a":1}\r\n{"a":2}\r\n';
    const r = parseJsonLines(input);
    expect(r.rows).toHaveLength(2);
  });
});

describe("parseAuto", () => {
  it("routes leading [ to JSON array parser", () => {
    const r = parseAuto(JSON.stringify([{ a: 1 }]));
    expect(r.rows).toHaveLength(1);
  });

  it("routes leading { to JSONL parser", () => {
    const r = parseAuto('{"a":1}\n{"a":2}');
    expect(r.rows).toHaveLength(2);
  });
});

describe("buildSnapshotFromJson", () => {
  it("creates a snapshot with header row + data rows", () => {
    const r = parseJson(JSON.stringify([{ name: "x", qty: 1 }, { name: "y", qty: 2 }]));
    const snap = buildSnapshotFromJson(r);
    expect(snap.sheetOrder).toEqual(["sheet-1"]);
    const sheet = snap.sheets["sheet-1"];
    expect(sheet.cellData["0"]["0"].v).toBe("name");
    expect(sheet.cellData["0"]["1"].v).toBe("qty");
    expect(sheet.cellData["1"]["0"].v).toBe("x");
    expect(sheet.cellData["1"]["1"].v).toBe(1);
    expect(sheet.cellData["2"]["0"].v).toBe("y");
    expect(sheet.cellData["2"]["1"].v).toBe(2);
  });

  it("stringifies nested objects/arrays", () => {
    const r = parseJson(JSON.stringify([{ a: { foo: "bar" }, b: [1, 2] }]));
    const snap = buildSnapshotFromJson(r);
    const sheet = snap.sheets["sheet-1"];
    expect(sheet.cellData["1"]["0"].v).toBe('{"foo":"bar"}');
    expect(sheet.cellData["1"]["1"].v).toBe("[1,2]");
  });

  it("omits cells for null/undefined values", () => {
    const r = parseJson(JSON.stringify([{ a: 1, b: null }]));
    const snap = buildSnapshotFromJson(r);
    const row1 = snap.sheets["sheet-1"].cellData["1"];
    expect(row1["0"]).toBeDefined();
    expect(row1["1"]).toBeUndefined();
  });

  it("respects the optional sheetName option", () => {
    const r = parseJson(JSON.stringify([{ a: 1 }]));
    const snap = buildSnapshotFromJson(r, { sheetName: "API レスポンス" });
    expect(snap.sheets["sheet-1"].name).toBe("API レスポンス");
  });

  it("sizes the sheet to fit the data", () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ idx: i }));
    const r = parseJson(JSON.stringify(rows));
    const snap = buildSnapshotFromJson(r);
    expect(snap.sheets["sheet-1"].rowCount).toBeGreaterThanOrEqual(1550);
  });
});

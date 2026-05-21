// Unit tests for the checkbox snapshot helpers (#150). We verify the pure
// mutators produce the expected snapshot shape and that the toggle / read
// helpers handle the realistic edge cases: missing entries, malformed A1,
// boolean coercion from xlsx round-trip shapes, idempotency.

import { describe, it, expect } from "vitest";
import {
  addCheckbox,
  hasCheckbox,
  listAllCheckboxes,
  parseA1,
  readCheckboxValue,
  removeCheckbox,
  toA1,
  toggleCheckbox,
} from "./checkbox";

describe("parseA1 / toA1", () => {
  it("round-trips single-letter columns", () => {
    expect(parseA1("A1")).toEqual({ row: 0, col: 0 });
    expect(toA1(0, 0)).toBe("A1");
    expect(parseA1("Z100")).toEqual({ row: 99, col: 25 });
    expect(toA1(99, 25)).toBe("Z100");
  });
  it("round-trips multi-letter columns", () => {
    expect(parseA1("AA1")).toEqual({ row: 0, col: 26 });
    expect(toA1(0, 26)).toBe("AA1");
    expect(parseA1("AZ2")).toEqual({ row: 1, col: 51 });
    expect(toA1(1, 51)).toBe("AZ2");
  });
  it("rejects malformed input", () => {
    expect(parseA1("")).toBeNull();
    expect(parseA1("1A")).toBeNull();
    expect(parseA1("A0")).toBeNull();
    expect(parseA1("A1:B2")).toBeNull();
  });
});

describe("addCheckbox", () => {
  it("appends a _checkboxes entry and normalizes value to boolean", () => {
    const snap = { sheets: { s1: {} } };
    const out = addCheckbox(snap, "s1", "A1");
    expect(out.sheets!.s1!._checkboxes).toEqual([{ cell: "A1" }]);
    // New cell defaults to FALSE.
    expect(out.sheets!.s1!.cellData!["0"]!["0"]).toEqual({ v: false });
  });

  it("preserves an existing boolean value when decorating", () => {
    const snap = { sheets: { s1: { cellData: { "0": { "0": { v: true } } } } } };
    const out = addCheckbox(snap, "s1", "A1");
    expect(out.sheets!.s1!.cellData!["0"]!["0"]).toEqual({ v: true });
  });

  it("coerces xlsx round-trip shapes (number 1, string 'TRUE') to boolean", () => {
    const num = addCheckbox({ sheets: { s1: { cellData: { "0": { "0": { v: 1 } } } } } }, "s1", "A1");
    expect(num.sheets!.s1!.cellData!["0"]!["0"]).toEqual({ v: true });
    const str = addCheckbox({ sheets: { s1: { cellData: { "0": { "0": { v: "FALSE" } } } } } }, "s1", "A1");
    expect(str.sheets!.s1!.cellData!["0"]!["0"]).toEqual({ v: false });
  });

  it("is idempotent — adding the same cell twice keeps a single entry", () => {
    const snap = { sheets: { s1: {} } };
    const once = addCheckbox(snap, "s1", "A1");
    const twice = addCheckbox(once, "s1", "A1");
    expect(twice.sheets!.s1!._checkboxes).toHaveLength(1);
  });

  it("ignores malformed cell refs (no-op)", () => {
    const snap = { sheets: { s1: {} } };
    const out = addCheckbox(snap, "s1", "not-a-ref");
    expect(out.sheets!.s1!._checkboxes).toBeUndefined();
  });

  it("does not mutate the input snapshot", () => {
    const snap = { sheets: { s1: {} } };
    addCheckbox(snap, "s1", "A1");
    expect(snap.sheets.s1).toEqual({});
  });
});

describe("removeCheckbox", () => {
  it("strips the entry but leaves the boolean value in place", () => {
    const snap = addCheckbox({ sheets: { s1: {} } }, "s1", "A1");
    const out = removeCheckbox(snap, "s1", "A1");
    expect(out.sheets!.s1!._checkboxes).toEqual([]);
    expect(out.sheets!.s1!.cellData!["0"]!["0"]).toEqual({ v: false });
  });

  it("is a no-op when the cell isn't decorated", () => {
    const snap = { sheets: { s1: { _checkboxes: [{ cell: "B2" }] } } };
    const out = removeCheckbox(snap, "s1", "A1");
    expect(out.sheets!.s1!._checkboxes).toEqual([{ cell: "B2" }]);
  });
});

describe("toggleCheckbox", () => {
  it("flips false → true on a decorated cell", () => {
    const snap = addCheckbox({ sheets: { s1: {} } }, "s1", "A1");
    const result = toggleCheckbox(snap, "s1", 0, 0);
    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe(true);
    expect(result.snapshot.sheets!.s1!.cellData!["0"]!["0"]).toEqual({ v: true });
  });

  it("flips true → false on a decorated cell", () => {
    let snap = addCheckbox({ sheets: { s1: {} } }, "s1", "A1");
    snap = toggleCheckbox(snap, "s1", 0, 0).snapshot;
    const result = toggleCheckbox(snap, "s1", 0, 0);
    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe(false);
  });

  it("is a no-op on an undecorated cell", () => {
    const snap = { sheets: { s1: { cellData: { "0": { "0": { v: true } } } } } };
    const result = toggleCheckbox(snap, "s1", 0, 0);
    expect(result.changed).toBe(false);
  });

  it("handles a JSON-string snapshot input", () => {
    const snap = JSON.stringify(addCheckbox({ sheets: { s1: {} } }, "s1", "A1"));
    const result = toggleCheckbox(snap, "s1", 0, 0);
    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe(true);
  });

  it("tolerates malformed JSON (no-op)", () => {
    const result = toggleCheckbox("{not json", "s1", 0, 0);
    expect(result.changed).toBe(false);
  });
});

describe("hasCheckbox / readCheckboxValue", () => {
  it("locates a decorated cell across sheets", () => {
    const snap = addCheckbox({ sheets: { s1: {}, s2: {} } }, "s2", "C3");
    expect(hasCheckbox(snap, "s2", 2, 2)).toBe(true);
    expect(hasCheckbox(snap, "s1", 2, 2)).toBe(false);
    expect(hasCheckbox(snap, "s2", 0, 0)).toBe(false);
  });

  it("reads the boolean value (default false on empty)", () => {
    const snap = addCheckbox({ sheets: { s1: {} } }, "s1", "A1");
    expect(readCheckboxValue(snap, "s1", 0, 0)).toBe(false);
    const toggled = toggleCheckbox(snap, "s1", 0, 0).snapshot;
    expect(readCheckboxValue(toggled, "s1", 0, 0)).toBe(true);
  });
});

describe("listAllCheckboxes", () => {
  it("walks every sheet and reports each entry with its current value", () => {
    let snap = addCheckbox({ sheets: { s1: {}, s2: {} } }, "s1", "A1");
    snap = addCheckbox(snap, "s2", "B2");
    snap = toggleCheckbox(snap, "s2", 1, 1).snapshot;
    const list = listAllCheckboxes(snap);
    expect(list).toHaveLength(2);
    expect(list).toContainEqual({ sheetId: "s1", cellRef: "A1", row: 0, col: 0, value: false });
    expect(list).toContainEqual({ sheetId: "s2", cellRef: "B2", row: 1, col: 1, value: true });
  });

  it("returns [] on malformed input", () => {
    expect(listAllCheckboxes(null)).toEqual([]);
    expect(listAllCheckboxes("{not json")).toEqual([]);
    expect(listAllCheckboxes({ sheets: { s1: { _checkboxes: "not-an-array" as unknown as never } } })).toEqual([]);
  });
});

describe("xlsx round-trip preservation", () => {
  it("retains _checkboxes metadata through a JSON.stringify / JSON.parse pass", () => {
    let snap = addCheckbox({ sheets: { s1: {} } }, "s1", "A1");
    snap = toggleCheckbox(snap, "s1", 0, 0).snapshot;
    const wire = JSON.stringify(snap);
    const parsed = JSON.parse(wire);
    expect(parsed.sheets.s1._checkboxes).toEqual([{ cell: "A1" }]);
    // Cell value is the raw boolean — exactly what xlsx <c t="b"><v>1</v></c> round-trips.
    expect(parsed.sheets.s1.cellData["0"]["0"]).toEqual({ v: true });
  });
});

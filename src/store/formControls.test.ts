// Unit tests for the form-control snapshot helpers (#183). We verify the pure
// mutators produce the expected snapshot shape and that the radio / spin /
// scroll logic handles the realistic edge cases: group selection, clamp +
// step snapping, idempotency, malformed input, and xlsx round-trip shape.

import { describe, it, expect } from "vitest";
import {
  addFormControl,
  clampToStep,
  coerceNumber,
  getFormControlAt,
  hasFormControl,
  isCellOccupied,
  isRadioSelected,
  linkedCellOf,
  listAllFormControls,
  readControlValue,
  removeFormControl,
  selectRadio,
  setControlValue,
  stepControl,
} from "./formControls";

describe("clampToStep", () => {
  it("clamps into [min, max]", () => {
    expect(clampToStep(150, 0, 100, 1)).toBe(100);
    expect(clampToStep(-5, 0, 100, 1)).toBe(0);
    expect(clampToStep(50, 0, 100, 1)).toBe(50);
  });
  it("snaps to the nearest step boundary from min", () => {
    expect(clampToStep(7, 0, 100, 5)).toBe(5);
    expect(clampToStep(8, 0, 100, 5)).toBe(10);
    expect(clampToStep(13, 1, 100, 4)).toBe(13); // 1 + 3*4
  });
  it("tolerates inverted min/max and zero step", () => {
    expect(clampToStep(50, 100, 0, 1)).toBe(50);
    expect(clampToStep(50, 0, 100, 0)).toBe(50);
  });
  it("trims floating-point noise", () => {
    expect(clampToStep(0.3, 0, 1, 0.1)).toBe(0.3);
  });
});

describe("coerceNumber", () => {
  it("handles number / boolean / numeric-string / junk", () => {
    expect(coerceNumber(42)).toBe(42);
    expect(coerceNumber(true)).toBe(1);
    expect(coerceNumber(false)).toBe(0);
    expect(coerceNumber("17")).toBe(17);
    expect(coerceNumber("nope")).toBeNull();
    expect(coerceNumber(null)).toBeNull();
    expect(coerceNumber(Number.NaN)).toBeNull();
  });
});

describe("addFormControl", () => {
  it("appends a _formControls entry with normalized refs", () => {
    const out = addFormControl({ sheets: { s1: {} } }, "s1", "b2", {
      kind: "radio",
      group: "g",
      optionValue: 1,
    });
    const list = out.sheets!.s1!._formControls!;
    expect(list).toHaveLength(1);
    expect(list[0].cell).toBe("B2");
    expect(list[0].linkedCell).toBe("B2"); // defaults to host cell
    expect(list[0].kind).toBe("radio");
  });

  it("initializes the linked cell to min for spin controls", () => {
    const out = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
      linkedCell: "B1",
      min: 10,
      max: 50,
      step: 5,
    });
    expect(out.sheets!.s1!.cellData!["0"]!["1"]).toEqual({ v: 10 });
  });

  it("initializes the linked cell to min for scroll controls", () => {
    const out = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "scroll",
      linkedCell: "B1",
      min: 0,
      max: 200,
      step: 10,
      page: 50,
    });
    expect(out.sheets!.s1!.cellData!["0"]!["1"]).toEqual({ v: 0 });
  });

  it("does not overwrite an existing linked-cell value", () => {
    const snap = { sheets: { s1: { cellData: { "0": { "1": { v: 33 } } } } } };
    const out = addFormControl(snap, "s1", "A1", {
      kind: "spin",
      linkedCell: "B1",
      min: 0,
      max: 100,
      step: 1,
    });
    expect(out.sheets!.s1!.cellData!["0"]!["1"]).toEqual({ v: 33 });
  });

  it("is idempotent on the host cell — re-adding replaces", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
    });
    snap = addFormControl(snap, "s1", "A1", { kind: "scroll" });
    expect(snap.sheets!.s1!._formControls).toHaveLength(1);
    expect(snap.sheets!.s1!._formControls![0].kind).toBe("scroll");
  });

  it("ignores malformed refs (no-op)", () => {
    const out = addFormControl({ sheets: { s1: {} } }, "s1", "not-a-ref", {
      kind: "spin",
    });
    expect(out.sheets!.s1!._formControls).toBeUndefined();
  });

  it("does not mutate the input snapshot", () => {
    const snap = { sheets: { s1: {} } };
    addFormControl(snap, "s1", "A1", { kind: "radio" });
    expect(snap.sheets.s1).toEqual({});
  });
});

describe("removeFormControl", () => {
  it("strips the entry but leaves the linked cell value", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
      linkedCell: "B1",
      min: 5,
      max: 10,
      step: 1,
    });
    const out = removeFormControl(snap, "s1", "A1");
    expect(out.sheets!.s1!._formControls).toEqual([]);
    expect(out.sheets!.s1!.cellData!["0"]!["1"]).toEqual({ v: 5 });
  });

  it("is a no-op when the cell hosts no control", () => {
    const snap = { sheets: { s1: { _formControls: [] } } };
    const out = removeFormControl(snap, "s1", "A1");
    expect(out.sheets!.s1!._formControls).toEqual([]);
  });
});

describe("radio buttons", () => {
  it("selectRadio writes the option value to the shared linked cell", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: "alpha",
    });
    snap = addFormControl(snap, "s1", "A2", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: "beta",
    });
    const result = selectRadio(snap, "s1", 1, 0); // select A2
    expect(result.changed).toBe(true);
    expect(result.nextValue).toBe("beta");
    expect(result.snapshot.sheets!.s1!.cellData!["0"]!["2"]).toEqual({
      v: "beta",
    });
  });

  it("single selection — only the chosen option reads as selected", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: 1,
    });
    snap = addFormControl(snap, "s1", "A2", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: 2,
    });
    snap = selectRadio(snap, "s1", 0, 0).snapshot; // select option 1
    expect(isRadioSelected(snap, "s1", 0, 0)).toBe(true);
    expect(isRadioSelected(snap, "s1", 1, 0)).toBe(false);
    snap = selectRadio(snap, "s1", 1, 0).snapshot; // switch to option 2
    expect(isRadioSelected(snap, "s1", 0, 0)).toBe(false);
    expect(isRadioSelected(snap, "s1", 1, 0)).toBe(true);
  });

  it("selectRadio is a no-op on a non-radio cell", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
    });
    expect(selectRadio(snap, "s1", 0, 0).changed).toBe(false);
  });

  it("re-clicking the already-selected radio reports changed=false (m-5)", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: "alpha",
    });
    // First click selects.
    const first = selectRadio(snap, "s1", 0, 0);
    expect(first.changed).toBe(true);
    snap = first.snapshot;
    // Second click on the same option is a no-op — no undo-stack churn.
    const second = selectRadio(snap, "s1", 0, 0);
    expect(second.changed).toBe(false);
    expect(second.nextValue).toBe("alpha");
    expect(second.snapshot).toStrictEqual(snap);
  });

  it("re-selecting an already-selected radio matches across number/string", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: 1,
    });
    snap = selectRadio(snap, "s1", 0, 0).snapshot;
    // linkedCell now holds the number 1; re-click still reads as unchanged.
    expect(selectRadio(snap, "s1", 0, 0).changed).toBe(false);
  });
});

describe("spin button", () => {
  it("steps up and down by step, clamped at bounds", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
      linkedCell: "B1",
      min: 0,
      max: 10,
      step: 2,
    });
    // starts at min (0)
    expect(readControlValue(snap, "s1", 0, 0)).toBe(0);
    snap = stepControl(snap, "s1", 0, 0, 1).snapshot;
    expect(readControlValue(snap, "s1", 0, 0)).toBe(2);
    snap = stepControl(snap, "s1", 0, 0, 1).snapshot;
    expect(readControlValue(snap, "s1", 0, 0)).toBe(4);
    snap = stepControl(snap, "s1", 0, 0, -1).snapshot;
    expect(readControlValue(snap, "s1", 0, 0)).toBe(2);
  });

  it("does not step past max — reports changed=false at the bound", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
      linkedCell: "B1",
      min: 0,
      max: 4,
      step: 2,
    });
    snap = stepControl(snap, "s1", 0, 0, 1).snapshot; // 2
    snap = stepControl(snap, "s1", 0, 0, 1).snapshot; // 4 (max)
    const atMax = stepControl(snap, "s1", 0, 0, 1);
    expect(atMax.changed).toBe(false);
    expect(atMax.nextValue).toBe(4);
  });

  it("setControlValue clamps + snaps an absolute value", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
      linkedCell: "B1",
      min: 0,
      max: 100,
      step: 5,
    });
    const r = setControlValue(snap, "s1", 0, 0, 47);
    expect(r.nextValue).toBe(45);
    expect(r.changed).toBe(true);
  });
});

describe("scroll bar", () => {
  it("steps by step on a normal step, by page on a large step", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "scroll",
      linkedCell: "B1",
      min: 0,
      max: 100,
      step: 1,
      page: 25,
    });
    expect(readControlValue(snap, "s1", 0, 0)).toBe(0);
    snap = stepControl(snap, "s1", 0, 0, 1, false).snapshot;
    expect(readControlValue(snap, "s1", 0, 0)).toBe(1);
    snap = stepControl(snap, "s1", 0, 0, 1, true).snapshot; // +page
    expect(readControlValue(snap, "s1", 0, 0)).toBe(26);
    snap = stepControl(snap, "s1", 0, 0, -1, true).snapshot; // -page
    expect(readControlValue(snap, "s1", 0, 0)).toBe(1);
  });

  it("uses default min/max/step/page when omitted", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "scroll",
      linkedCell: "B1",
    });
    // default min is 0
    expect(readControlValue(snap, "s1", 0, 0)).toBe(0);
    const r = stepControl(snap, "s1", 0, 0, 1, true); // default page 10
    expect(r.nextValue).toBe(10);
  });
});

describe("getFormControlAt / hasFormControl / linkedCellOf", () => {
  it("locates a control across sheets", () => {
    const snap = addFormControl({ sheets: { s1: {}, s2: {} } }, "s2", "C3", {
      kind: "spin",
    });
    expect(hasFormControl(snap, "s2", 2, 2)).toBe(true);
    expect(hasFormControl(snap, "s1", 2, 2)).toBe(false);
    expect(getFormControlAt(snap, "s2", 2, 2)?.kind).toBe("spin");
  });

  it("linkedCellOf falls back to the host cell", () => {
    expect(linkedCellOf({ cell: "A1", kind: "spin" })).toBe("A1");
    expect(
      linkedCellOf({ cell: "A1", kind: "spin", linkedCell: "Z9" }),
    ).toBe("Z9");
  });
});

describe("isCellOccupied (M-1 cell-occupancy guard)", () => {
  it("reports a cell occupied by a form control", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "B2", {
      kind: "spin",
    });
    expect(isCellOccupied(snap, "s1", 1, 1)).toBe(true);
    expect(isCellOccupied(snap, "s1", 0, 0)).toBe(false);
  });

  it("reports a cell occupied by a checkbox", () => {
    const snap = { sheets: { s1: { _checkboxes: [{ cell: "C3" }] } } };
    expect(isCellOccupied(snap, "s1", 2, 2)).toBe(true);
    expect(isCellOccupied(snap, "s1", 1, 1)).toBe(false);
  });

  it("reports a cell occupied by a sparkline", () => {
    const snap = {
      sheets: { s1: { _sparklines: [{ cell: "D4", sourceRange: "A1:A3" }] } },
    };
    expect(isCellOccupied(snap, "s1", 3, 3)).toBe(true);
    expect(isCellOccupied(snap, "s1", 0, 0)).toBe(false);
  });

  it("returns false for an empty / unknown sheet and malformed input", () => {
    expect(isCellOccupied({ sheets: { s1: {} } }, "s1", 0, 0)).toBe(false);
    expect(isCellOccupied({ sheets: {} }, "missing", 0, 0)).toBe(false);
    expect(isCellOccupied(null, "s1", 0, 0)).toBe(false);
    expect(isCellOccupied("{not json", "s1", 0, 0)).toBe(false);
  });

  it("ignores non-array feature buckets and entries without a cell ref", () => {
    const snap = {
      sheets: {
        s1: {
          _sparklines: "nope" as unknown as never,
          _formControls: [{ kind: "spin" }] as unknown as never,
        },
      },
    };
    expect(isCellOccupied(snap, "s1", 0, 0)).toBe(false);
  });

  it("accepts a stringified snapshot", () => {
    const snap = JSON.stringify(
      addFormControl({ sheets: { s1: {} } }, "s1", "A1", { kind: "radio" }),
    );
    expect(isCellOccupied(snap, "s1", 0, 0)).toBe(true);
  });
});

describe("listAllFormControls", () => {
  it("walks every sheet and reports each control with coords", () => {
    let snap = addFormControl({ sheets: { s1: {}, s2: {} } }, "s1", "A1", {
      kind: "radio",
    });
    snap = addFormControl(snap, "s2", "B2", { kind: "spin" });
    const list = listAllFormControls(snap);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.sheetId === "s1")).toMatchObject({
      cell: "A1",
      row: 0,
      col: 0,
      kind: "radio",
    });
    expect(list.find((e) => e.sheetId === "s2")).toMatchObject({
      cell: "B2",
      row: 1,
      col: 1,
      kind: "spin",
    });
  });

  it("returns [] on malformed input", () => {
    expect(listAllFormControls(null)).toEqual([]);
    expect(listAllFormControls("{not json")).toEqual([]);
  });
});

describe("xlsx round-trip preservation", () => {
  it("retains _formControls metadata through a JSON stringify / parse pass", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "scroll",
      linkedCell: "B1",
      min: 0,
      max: 100,
      step: 1,
      page: 10,
    });
    snap = stepControl(snap, "s1", 0, 0, 1, true).snapshot;
    const wire = JSON.stringify(snap);
    const parsed = JSON.parse(wire);
    expect(parsed.sheets.s1._formControls[0]).toMatchObject({
      cell: "A1",
      kind: "scroll",
      linkedCell: "B1",
      min: 0,
      max: 100,
      step: 1,
      page: 10,
    });
    // The control value lives in a plain cell — round-trips as a number.
    expect(parsed.sheets.s1.cellData["0"]["1"]).toEqual({ v: 10 });
  });

  it("tolerates a JSON-string snapshot input on every mutator", () => {
    const snap = JSON.stringify({ sheets: { s1: {} } });
    const out = addFormControl(snap, "s1", "A1", { kind: "spin" });
    expect(out.sheets!.s1!._formControls).toHaveLength(1);
    const stepped = stepControl(JSON.stringify(out), "s1", 0, 0, 1);
    expect(stepped.changed).toBe(true);
  });
});

// Unit tests for the form-control render patcher (#183). Verifies that each
// control kind produces the expected display glyph in the host cell's `p`
// rich-text paragraph, that the host cell's `.v` is left untouched, and that
// the patch is pure / idempotent.

import { describe, it, expect } from "vitest";
import {
  patchFormControlRenders,
  RADIO_SELECTED,
  RADIO_UNSELECTED,
  SPIN_GLYPH,
  SCROLL_GLYPH,
} from "./formControlRender";
import { addFormControl, selectRadio, stepControl } from "../store/formControls";

function dataStream(snap: unknown, sid: string, row: string, col: string): string {
  const cell = (snap as {
    sheets: Record<string, { cellData: Record<string, Record<string, { p?: { body?: { dataStream?: string } } }>> }>;
  }).sheets[sid].cellData[row][col];
  return cell.p?.body?.dataStream ?? "";
}

describe("patchFormControlRenders — radio", () => {
  it("renders unselected glyph + label by default", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: 1,
      label: "Option A",
    });
    const patched = patchFormControlRenders(snap);
    expect(dataStream(patched, "s1", "0", "0")).toBe(
      `${RADIO_UNSELECTED} Option A\r\n`,
    );
  });

  it("renders selected glyph once the linked cell holds the option value", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "radio",
      group: "g",
      linkedCell: "C1",
      optionValue: 1,
      label: "Option A",
    });
    snap = selectRadio(snap, "s1", 0, 0).snapshot;
    const patched = patchFormControlRenders(snap);
    expect(dataStream(patched, "s1", "0", "0")).toBe(
      `${RADIO_SELECTED} Option A\r\n`,
    );
  });
});

describe("patchFormControlRenders — spin / scroll", () => {
  it("renders the spin glyph + current linked value", () => {
    let snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
      linkedCell: "B1",
      min: 0,
      max: 10,
      step: 1,
    });
    snap = stepControl(snap, "s1", 0, 0, 1).snapshot; // → 1
    const patched = patchFormControlRenders(snap);
    expect(dataStream(patched, "s1", "0", "0")).toBe(`${SPIN_GLYPH} 1\r\n`);
  });

  it("renders the scroll glyph + current linked value", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "scroll",
      linkedCell: "B1",
      min: 0,
      max: 100,
      step: 1,
      page: 10,
    });
    const patched = patchFormControlRenders(snap);
    expect(dataStream(patched, "s1", "0", "0")).toBe(`${SCROLL_GLYPH} 0\r\n`);
  });
});

describe("patchFormControlRenders — purity", () => {
  it("does not mutate the input snapshot", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "spin",
    });
    const before = JSON.stringify(snap);
    patchFormControlRenders(snap);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it("is idempotent — patching twice yields the same display", () => {
    const snap = addFormControl({ sheets: { s1: {} } }, "s1", "A1", {
      kind: "radio",
      label: "X",
    });
    const once = patchFormControlRenders(snap);
    const twice = patchFormControlRenders(once);
    expect(dataStream(twice, "s1", "0", "0")).toBe(
      dataStream(once, "s1", "0", "0"),
    );
  });

  it("leaves the host cell's underlying .v untouched", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: "hello" } } },
          _formControls: [{ cell: "A1", kind: "spin" as const, linkedCell: "B1" }],
        },
      },
    };
    const patched = patchFormControlRenders(snap) as typeof snap;
    expect(patched.sheets.s1.cellData["0"]["0"].v).toBe("hello");
  });

  it("ignores malformed entries / refs without throwing", () => {
    const snap = {
      sheets: {
        s1: {
          _formControls: [
            { cell: "not-a-ref", kind: "spin" as const },
            { cell: "A1", kind: "bogus" as unknown as "spin" },
          ],
        },
      },
    };
    expect(() => patchFormControlRenders(snap)).not.toThrow();
  });
});

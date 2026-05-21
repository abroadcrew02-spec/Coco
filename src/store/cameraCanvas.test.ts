// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { paintLayoutToDataUrl, renderRangeToDataUrl } from "./cameraCanvas";
import type { RangeLayout } from "./cameraRender";

// happy-dom's <canvas> 2D context is either absent or a stub: getContext may
// return null, or toDataURL may throw / return a non-PNG string. The painter
// is contractually allowed to return null in that case — these tests assert
// it degrades gracefully rather than throwing. (A real PNG round-trip is an
// e2e / browser concern.)

function makeLayout(): RangeLayout {
  return {
    width: 192,
    height: 48,
    cols: 2,
    rows: 2,
    colWidths: [96, 96],
    rowHeights: [24, 24],
    cells: [
      [
        {
          text: "A",
          bg: "#ffff00",
          color: "#000000",
          bold: true,
          italic: false,
          fontSize: 11,
          align: "left",
        },
        {
          text: "B",
          bg: null,
          color: null,
          bold: false,
          italic: true,
          fontSize: null,
          align: "right",
        },
      ],
      [
        {
          text: "",
          bg: null,
          color: null,
          bold: false,
          italic: false,
          fontSize: null,
          align: "center",
        },
        {
          text: "long text that overflows",
          bg: null,
          color: null,
          bold: false,
          italic: false,
          fontSize: null,
          align: "left",
        },
      ],
    ],
  };
}

describe("paintLayoutToDataUrl", () => {
  it("does not throw and returns a string or null", () => {
    const out = paintLayoutToDataUrl(makeLayout());
    expect(out === null || typeof out === "string").toBe(true);
    if (typeof out === "string") {
      expect(out.startsWith("data:")).toBe(true);
    }
  });

  it("returns null for a zero-area layout", () => {
    const empty: RangeLayout = {
      width: 0,
      height: 0,
      cols: 0,
      rows: 0,
      colWidths: [],
      rowHeights: [],
      cells: [],
    };
    expect(paintLayoutToDataUrl(empty)).toBe(null);
  });
});

describe("renderRangeToDataUrl", () => {
  const snapshotJson = JSON.stringify({
    sheets: { s1: { cellData: { "0": { "0": { v: "X" } } } } },
  });

  it("returns null for a malformed / missing snapshot", () => {
    expect(renderRangeToDataUrl(null, "s1", { r1: 0, c1: 0, r2: 0, c2: 0 })).toBe(
      null,
    );
    expect(
      renderRangeToDataUrl("bad json", "s1", { r1: 0, c1: 0, r2: 0, c2: 0 }),
    ).toBe(null);
  });

  it("returns null when the sheet is missing", () => {
    expect(
      renderRangeToDataUrl(snapshotJson, "nope", { r1: 0, c1: 0, r2: 0, c2: 0 }),
    ).toBe(null);
  });

  it("does not throw for a valid range", () => {
    const out = renderRangeToDataUrl(snapshotJson, "s1", {
      r1: 0,
      c1: 0,
      r2: 0,
      c2: 0,
    });
    expect(out === null || typeof out === "string").toBe(true);
  });
});

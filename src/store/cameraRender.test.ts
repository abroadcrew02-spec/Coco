import { describe, it, expect } from "vitest";
import {
  CAMERA_DEFAULT_COL_WIDTH,
  CAMERA_DEFAULT_ROW_HEIGHT,
  CAMERA_MAX_CELLS,
  normalizeRect,
  rectCellCount,
  rectToA1,
  normalizeColor,
  cellValueToText,
  resolveCell,
  buildRangeLayout,
} from "./cameraRender";

describe("normalizeRect", () => {
  it("orders r1<=r2 and c1<=c2", () => {
    expect(normalizeRect({ r1: 5, c1: 3, r2: 1, c2: 0 })).toEqual({
      r1: 1,
      c1: 0,
      r2: 5,
      c2: 3,
    });
  });

  it("rejects negative / non-integer input", () => {
    expect(normalizeRect({ r1: -1, c1: 0, r2: 0, c2: 0 })).toBe(null);
    expect(normalizeRect({ r1: 0.5, c1: 0, r2: 0, c2: 0 })).toBe(null);
    expect(normalizeRect({ r1: NaN, c1: 0, r2: 0, c2: 0 })).toBe(null);
  });
});

describe("rectCellCount", () => {
  it("counts inclusive cells", () => {
    expect(rectCellCount({ r1: 0, c1: 0, r2: 2, c2: 1 })).toBe(6);
    expect(rectCellCount({ r1: 3, c1: 3, r2: 3, c2: 3 })).toBe(1);
  });
});

describe("rectToA1", () => {
  it("renders a single cell without a colon", () => {
    expect(rectToA1({ r1: 0, c1: 0, r2: 0, c2: 0 })).toBe("A1");
    expect(rectToA1({ r1: 9, c1: 26, r2: 9, c2: 26 })).toBe("AA10");
  });

  it("renders a multi-cell range with a colon", () => {
    expect(rectToA1({ r1: 0, c1: 0, r2: 2, c2: 1 })).toBe("A1:B3");
  });
});

describe("normalizeColor", () => {
  it("accepts { rgb } objects and bare strings", () => {
    expect(normalizeColor({ rgb: "#FF0000" })).toBe("#ff0000");
    expect(normalizeColor("00FF00")).toBe("#00ff00");
  });

  it("expands #rgb shorthand", () => {
    expect(normalizeColor("#f00")).toBe("#ff0000");
  });

  it("truncates #rrggbbaa to #rrggbb", () => {
    expect(normalizeColor("#11223344")).toBe("#112233");
  });

  it("returns null for junk", () => {
    expect(normalizeColor(null)).toBe(null);
    expect(normalizeColor("not-a-color")).toBe(null);
    expect(normalizeColor({})).toBe(null);
  });
});

describe("cellValueToText", () => {
  it("stringifies primitives", () => {
    expect(cellValueToText("hi")).toBe("hi");
    expect(cellValueToText(42)).toBe("42");
    expect(cellValueToText(true)).toBe("TRUE");
    expect(cellValueToText(null)).toBe("");
    expect(cellValueToText(undefined)).toBe("");
  });

  it("unwraps a nested { v } value object", () => {
    expect(cellValueToText({ v: "nested" })).toBe("nested");
  });
});

describe("resolveCell", () => {
  const snapshot = {
    styles: {
      styleA: { bg: { rgb: "#FFFF00" }, bl: 1, ht: 2 },
    },
    sheets: {
      s1: {
        cellData: {
          "0": {
            "0": { v: "Hello", s: { cl: { rgb: "#0000FF" }, it: 1, fs: 14 } },
            "1": { v: 7, s: "styleA" },
          },
        },
      },
    },
  };

  it("reads an inline style object", () => {
    const cell = resolveCell(snapshot, "s1", 0, 0);
    expect(cell.text).toBe("Hello");
    expect(cell.color).toBe("#0000ff");
    expect(cell.italic).toBe(true);
    expect(cell.fontSize).toBe(14);
  });

  it("resolves a style-id reference through workbook.styles", () => {
    const cell = resolveCell(snapshot, "s1", 0, 1);
    expect(cell.text).toBe("7");
    expect(cell.bg).toBe("#ffff00");
    expect(cell.bold).toBe(true);
    expect(cell.align).toBe("center");
  });

  it("returns a blank cell for a missing cell", () => {
    const cell = resolveCell(snapshot, "s1", 5, 5);
    expect(cell.text).toBe("");
    expect(cell.bg).toBe(null);
    expect(cell.bold).toBe(false);
  });
});

describe("buildRangeLayout", () => {
  const snapshotJson = JSON.stringify({
    sheets: {
      s1: {
        cellData: {
          "0": { "0": { v: "A" }, "1": { v: "B" } },
          "1": { "0": { v: "C" } },
        },
      },
    },
  });

  it("builds a fixed grid for a 2x2 range", () => {
    const layout = buildRangeLayout(snapshotJson, "s1", {
      r1: 0,
      c1: 0,
      r2: 1,
      c2: 1,
    });
    expect(layout).not.toBe(null);
    expect(layout!.rows).toBe(2);
    expect(layout!.cols).toBe(2);
    expect(layout!.width).toBe(2 * CAMERA_DEFAULT_COL_WIDTH);
    expect(layout!.height).toBe(2 * CAMERA_DEFAULT_ROW_HEIGHT);
    expect(layout!.cells[0][0].text).toBe("A");
    expect(layout!.cells[0][1].text).toBe("B");
    expect(layout!.cells[1][0].text).toBe("C");
    expect(layout!.cells[1][1].text).toBe(""); // blank cell
  });

  it("returns null for a malformed snapshot", () => {
    expect(buildRangeLayout("not json", "s1", { r1: 0, c1: 0, r2: 0, c2: 0 })).toBe(
      null,
    );
    expect(buildRangeLayout(null, "s1", { r1: 0, c1: 0, r2: 0, c2: 0 })).toBe(null);
  });

  it("returns null when the sheet is missing", () => {
    expect(
      buildRangeLayout(snapshotJson, "missing", { r1: 0, c1: 0, r2: 0, c2: 0 }),
    ).toBe(null);
  });

  it("returns null when the range exceeds the cell cap", () => {
    const huge = { r1: 0, c1: 0, r2: CAMERA_MAX_CELLS, c2: 1 };
    expect(buildRangeLayout(snapshotJson, "s1", huge)).toBe(null);
  });
});

import { describe, it, expect } from "vitest";
import { carryForwardRootExtensions, COCO_ROOT_EXTENSION_KEYS } from "./snapshotSync";

// #184 C-1 regression: `FWorkbook.save()` reconstructs the snapshot from
// Univer's internal models and drops Coco's workbook-root extension keys
// (`_cameraLinks`, `_scenarios`). The MUTATION-driven `syncSnapshot` overwrites
// the store with that output on every cell edit — without carry-forward the
// user's camera links / scenarios vanish on the next keystroke.

const link = {
  id: "camera-1",
  sourceSheetId: "s1",
  sourceRange: { r1: 0, c1: 0, r2: 1, c2: 1 },
  dstSheetId: "s1",
  dstAnchor: { row: 0, col: 4 },
  dataUrl: "data:image/png;base64,AAA",
  broken: false,
  generatedAt: "2026-05-20T00:00:00.000Z",
};

describe("carryForwardRootExtensions", () => {
  it("re-grafts _cameraLinks dropped by workbook.save()", () => {
    const prev = JSON.stringify({ sheets: {}, _cameraLinks: [link] });
    const fresh = JSON.stringify({ sheets: { s1: { cellData: {} } } });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._cameraLinks).toEqual([link]);
    // The fresh sheet data is preserved.
    expect(merged.sheets.s1).toEqual({ cellData: {} });
  });

  it("re-grafts _scenarios too", () => {
    const scenario = {
      name: "Best case",
      changingCells: ["Sheet1!B2"],
      values: { "Sheet1!B2": 100 },
      createdAt: "2026-05-20T00:00:00.000Z",
    };
    const prev = JSON.stringify({ sheets: {}, _scenarios: [scenario] });
    const fresh = JSON.stringify({ sheets: {} });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._scenarios).toEqual([scenario]);
  });

  it("does not overwrite a key Univer's snapshot already carries", () => {
    const prev = JSON.stringify({ _cameraLinks: [link] });
    const fresh = JSON.stringify({ _cameraLinks: [] });
    expect(carryForwardRootExtensions(fresh, prev)).toBe(fresh);
  });

  it("returns the fresh json unchanged when nothing needs grafting", () => {
    const prev = JSON.stringify({ sheets: {} });
    const fresh = JSON.stringify({ sheets: { s1: {} } });
    expect(carryForwardRootExtensions(fresh, prev)).toBe(fresh);
  });

  it("returns the fresh json unchanged when there is no prior snapshot", () => {
    const fresh = JSON.stringify({ sheets: {} });
    expect(carryForwardRootExtensions(fresh, null)).toBe(fresh);
  });

  it("passes malformed input through without throwing", () => {
    expect(carryForwardRootExtensions("not-json", "{}")).toBe("not-json");
    expect(carryForwardRootExtensions("{}", "not-json")).toBe("{}");
  });

  it("survives a multi-edit sequence (capture → edit → edit)", () => {
    // Capture writes _cameraLinks into the store snapshot.
    let store = JSON.stringify({ sheets: { s1: {} }, _cameraLinks: [link] });
    // Each cell edit fires syncSnapshot with fresh workbook.save() output.
    for (let i = 0; i < 5; i++) {
      const univerSave = JSON.stringify({ sheets: { s1: { cellData: { [i]: {} } } } });
      store = carryForwardRootExtensions(univerSave, store);
    }
    expect(JSON.parse(store)._cameraLinks).toEqual([link]);
  });

  it("exports the extension key list for the xlsx round-trip to mirror", () => {
    expect(COCO_ROOT_EXTENSION_KEYS).toContain("_cameraLinks");
    expect(COCO_ROOT_EXTENSION_KEYS).toContain("_scenarios");
    // Phase 4d: image/textbox inserts write into _preservedParts and must
    // survive the next syncSnapshot or the drawing parts vanish on the next
    // cell edit.
    expect(COCO_ROOT_EXTENSION_KEYS).toContain("_preservedParts");
  });

  it("re-grafts _preservedParts dropped by workbook.save() (Phase 4d)", () => {
    const preserved = {
      parts: { "xl/media/image1.png": "AAAA" },
      sheetRefs: [{ drawingRid: "rId1", drawingTarget: "../drawings/drawing1.xml" }],
    };
    const prev = JSON.stringify({ sheets: {}, _preservedParts: preserved });
    const fresh = JSON.stringify({ sheets: { s1: { cellData: {} } } });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._preservedParts).toEqual(preserved);
  });
});

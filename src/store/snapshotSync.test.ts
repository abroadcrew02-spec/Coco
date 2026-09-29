import { describe, it, expect, vi } from "vitest";
import {
  carryForwardRootExtensions,
  mirrorRootExtensionsInto,
  NICEL_ROOT_EXTENSION_KEYS,
} from "./snapshotSync";

// #184 C-1 regression: `FWorkbook.save()` reconstructs the snapshot from
// Univer's internal models and drops Nicel's workbook-root extension keys
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

  it("the store's value wins over the copy save() returns (#356 D3)", () => {
    const prev = JSON.stringify({ _cameraLinks: [link] });
    const fresh = JSON.stringify({ _cameraLinks: [] });
    expect(JSON.parse(carryForwardRootExtensions(fresh, prev))._cameraLinks).toEqual([link]);
  });

  it("a newer _scripts in the store beats the older one save() still carries (#356 D3)", () => {
    const opened = [{ id: "s1", name: "n", source: "api.log('old')", lastModified: 1 }];
    const edited = [{ id: "s1", name: "n", source: "api.log('new')", lastModified: 2 }];
    const prev = JSON.stringify({ sheets: { s1: {} }, _scripts: edited });
    // Univer returns the createUnit-time root keys, i.e. the opened scripts.
    const fresh = JSON.stringify({ sheets: { s1: { cellData: { 0: {} } } }, _scripts: opened });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._scripts).toEqual(edited);
    expect(merged.sheets.s1).toEqual({ cellData: { 0: {} } });
  });

  it("an emptied list in the store stays empty (all scripts deleted)", () => {
    const prev = JSON.stringify({ _scripts: [], _connections: [] });
    const fresh = JSON.stringify({
      _scripts: [{ id: "s1", name: "n", source: "x", lastModified: 1 }],
      _connections: [{ id: "c1" }],
    });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._scripts).toEqual([]);
    expect(merged._connections).toEqual([]);
  });

  it("keeps save()'s value when the store has no such key", () => {
    const prev = JSON.stringify({ sheets: {} });
    const fresh = JSON.stringify({ sheets: {}, _scenarios: [{ name: "x" }] });
    expect(carryForwardRootExtensions(fresh, prev)).toBe(fresh);
  });

  it("returns the fresh json unchanged when the values already match", () => {
    const scripts = [{ id: "s1", name: "n", source: "x", lastModified: 1 }];
    const prev = JSON.stringify({ a: 1, _scripts: scripts });
    const fresh = JSON.stringify({ a: 2, _scripts: scripts });
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
    expect(NICEL_ROOT_EXTENSION_KEYS).toContain("_cameraLinks");
    expect(NICEL_ROOT_EXTENSION_KEYS).toContain("_scenarios");
    // Phase 4d: image/textbox inserts write into _preservedParts and must
    // survive the next syncSnapshot or the drawing parts vanish on the next
    // cell edit.
    expect(NICEL_ROOT_EXTENSION_KEYS).toContain("_preservedParts");
  });

  it("re-grafts _scripts and _connections dropped by workbook.save() (#356)", () => {
    expect(NICEL_ROOT_EXTENSION_KEYS).toContain("_scripts");
    expect(NICEL_ROOT_EXTENSION_KEYS).toContain("_connections");
    const scripts = [{ id: "s1", name: "n", source: "api.log(1)", lastModified: 1 }];
    const connections = [
      { id: "c1", name: "c", type: "csv", sourcePath: "/d.csv", targetSheetId: null,
        targetSheetName: "d", lastRefreshedAt: null, schedule: { onOpen: true, intervalMinutes: 0 } },
    ];
    const prev = JSON.stringify({ sheets: {}, _scripts: scripts, _connections: connections });
    const fresh = JSON.stringify({ sheets: { s1: { cellData: {} } } });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._scripts).toEqual(scripts);
    expect(merged._connections).toEqual(connections);
  });

  it("keeps a script added after open across several edits (#356)", () => {
    let store = JSON.stringify({ sheets: { s1: {} } });
    // A script is added in the app (writeScripts → updateSnapshot).
    const parsed = JSON.parse(store);
    parsed._scripts = [{ id: "s1", name: "n", source: "x", lastModified: 2 }];
    store = JSON.stringify(parsed);
    for (let i = 0; i < 3; i++) {
      const univerSave = JSON.stringify({ sheets: { s1: { cellData: { [i]: {} } } } });
      store = carryForwardRootExtensions(univerSave, store);
    }
    expect(JSON.parse(store)._scripts).toEqual([
      { id: "s1", name: "n", source: "x", lastModified: 2 },
    ]);
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

describe("mirrorRootExtensionsInto (#356)", () => {
  it("copies the store's keys into Univer's snapshot and removes the ones the store dropped", () => {
    const target: Record<string, unknown> = {
      id: "wb",
      sheets: { s1: {} },
      _scripts: [{ id: "old" }],
      _cocoQueries: [{ id: "q" }],
    };
    const store = JSON.stringify({ sheets: { s1: { cellData: {} } }, _scripts: [{ id: "new" }], _cameraLinks: [link] });
    expect(mirrorRootExtensionsInto(target, store)).toBe(true);
    expect(target._scripts).toEqual([{ id: "new" }]);
    expect(target._cameraLinks).toEqual([link]);
    expect("_cocoQueries" in target).toBe(false);
    // Univer's own keys are not touched.
    expect(target.sheets).toEqual({ s1: {} });
    expect(target.id).toBe("wb");
  });

  it("does nothing for missing / unparsable input", () => {
    const target: Record<string, unknown> = { _scripts: [1] };
    expect(mirrorRootExtensionsInto(null, "{}")).toBe(false);
    expect(mirrorRootExtensionsInto(target, null)).toBe(false);
    expect(mirrorRootExtensionsInto(target, "{not json")).toBe(false);
    expect(mirrorRootExtensionsInto(target, "[1]")).toBe(false);
    expect(target._scripts).toEqual([1]);
  });

  it("skips the parse when neither side has any extension key", () => {
    const parse = vi.spyOn(JSON, "parse");
    const target: Record<string, unknown> = { sheets: {} };
    expect(mirrorRootExtensionsInto(target, JSON.stringify({ sheets: { s1: {} } }))).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("keeps save()-based writers from rolling back or reviving store changes", () => {
    // A stand-in for Univer's Workbook: save() deep-clones the snapshot it was
    // created with (plus whatever was mirrored into it).
    const opened = { sheets: { s1: {} }, _scripts: [{ id: "s1", source: "old" }], _cocoQueries: [{ id: "q" }] };
    const model = { snapshot: JSON.parse(JSON.stringify(opened)) as Record<string, unknown> };
    const save = () => JSON.parse(JSON.stringify(model.snapshot)) as Record<string, unknown>;
    let store = JSON.stringify(opened);
    const setStore = (json: string) => {
      store = json;
      mirrorRootExtensionsInto(model.snapshot, json);
    };

    // In-app edits: a script changes, the last query is removed (key deleted).
    const edited = JSON.parse(store);
    edited._scripts = [{ id: "s1", source: "new" }];
    delete edited._cocoQueries;
    setStore(JSON.stringify(edited));

    // An apply-style handler that writes a snapshot built from save().
    const fromSave = save();
    (fromSave.sheets as Record<string, unknown>).s1 = { frozen: true };
    setStore(JSON.stringify(fromSave));
    expect(JSON.parse(store)._scripts).toEqual([{ id: "s1", source: "new" }]);
    expect("_cocoQueries" in JSON.parse(store)).toBe(false);

    // The cell-edit sync path.
    setStore(carryForwardRootExtensions(JSON.stringify(save()), store));
    expect(JSON.parse(store)._scripts).toEqual([{ id: "s1", source: "new" }]);
    expect("_cocoQueries" in JSON.parse(store)).toBe(false);
  });
});

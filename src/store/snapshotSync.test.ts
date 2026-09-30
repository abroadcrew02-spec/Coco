import { describe, it, expect, vi } from "vitest";
import { create } from "zustand";
import {
  carryForwardRootExtensions,
  createRootExtensionMirror,
  isNicelRootKey,
  mirrorRootExtensionsInto,
  NICEL_ROOT_EXTENSION_KEYS,
  type RootMirrorStoreState,
} from "./snapshotSync";

// #184 C-1 / #356: `FWorkbook.save()` returns a deep copy of the snapshot the
// unit was created with, so for Nicel's workbook-root extension keys
// (`_cameraLinks`, `_scenarios`, `_scripts`, ...) it returns the createUnit-time
// copy (or nothing, if the key was added later), never the store's current
// value. The MUTATION-driven `syncSnapshot` overwrites the store with that
// output on every cell edit, so without carry-forward and the mirror an
// in-app change to those keys is lost or rolled back on the next keystroke.
// (The real Univer behaviour is pinned in snapshotSync.univerContract.test.ts.)

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

  it("the store's value wins over the copy save() returns (#356)", () => {
    const prev = JSON.stringify({ _cameraLinks: [link] });
    const fresh = JSON.stringify({ _cameraLinks: [] });
    expect(JSON.parse(carryForwardRootExtensions(fresh, prev))._cameraLinks).toEqual([link]);
  });

  it("a newer _scripts in the store beats the older one save() still carries (#356)", () => {
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

  it("drops save()'s value when the store has no such key (#356: the store owns the key)", () => {
    const prev = JSON.stringify({ sheets: {} });
    const fresh = JSON.stringify({ sheets: {}, _scenarios: [{ name: "x" }] });
    expect("_scenarios" in JSON.parse(carryForwardRootExtensions(fresh, prev))).toBe(false);
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

  it("lists the known root extension keys (for readers and tests; ownership is by the _ prefix)", () => {
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
    const json = JSON.stringify({ sheets: { s1: {} } });
    const parse = vi.spyOn(JSON, "parse");
    try {
      const target: Record<string, unknown> = { sheets: {} };
      expect(mirrorRootExtensionsInto(target, json)).toBe(false);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
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

// ---------- ownership rule and symmetric carry-forward (#356) -------------

describe("root key ownership", () => {
  it("treats every root key starting with _ as Nicel's, except __proto__", () => {
    expect(isNicelRootKey("_scripts")).toBe(true);
    expect(isNicelRootKey("_anythingNew")).toBe(true);
    expect(isNicelRootKey("sheets")).toBe(false);
    expect(isNicelRootKey("_")).toBe(false);
    expect(isNicelRootKey("__proto__")).toBe(false);
    for (const key of NICEL_ROOT_EXTENSION_KEYS) expect(isNicelRootKey(key)).toBe(true);
  });

  it("removes an owned key from save()'s output when the store does not have it (#356)", () => {
    const prev = JSON.stringify({ sheets: {} });
    const fresh = JSON.stringify({ sheets: {}, _scenarios: [{ name: "x" }], _cocoQueries: [] });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect("_scenarios" in merged).toBe(false);
    expect("_cocoQueries" in merged).toBe(false);
  });

  it("passes save()'s output through when the store snapshot is unusable (no owner value to apply)", () => {
    const fresh = JSON.stringify({ sheets: {}, _scripts: [{ id: "keep" }] });
    expect(carryForwardRootExtensions(fresh, null)).toBe(fresh);
    expect(carryForwardRootExtensions(fresh, "")).toBe(fresh);
    expect(carryForwardRootExtensions(fresh, "{broken")).toBe(fresh);
    expect(carryForwardRootExtensions(fresh, "[1,2]")).toBe(fresh);
    expect(carryForwardRootExtensions(fresh, "null")).toBe(fresh);
    expect(carryForwardRootExtensions(fresh, '"text"')).toBe(fresh);
  });

  it("covers keys that are not in the known list", () => {
    const prev = JSON.stringify({ _futureKey: { v: 2 } });
    const fresh = JSON.stringify({ sheets: {}, _futureKey: { v: 1 }, _staleKey: true, name: "wb" });
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._futureKey).toEqual({ v: 2 });
    expect("_staleKey" in merged).toBe(false);
    expect(merged.name).toBe("wb");
    expect(merged.sheets).toEqual({});
  });

  it("ignores a __proto__ key in either snapshot", () => {
    const prev = '{"__proto__":{"polluted":true},"_scripts":[]}';
    const fresh = '{"sheets":{},"__proto__":{"x":1}}';
    const merged = JSON.parse(carryForwardRootExtensions(fresh, prev));
    expect(merged._scripts).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const target: Record<string, unknown> = {};
    mirrorRootExtensionsInto(target, prev);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target._scripts).toEqual([]);
  });

  it("mirrors keys that are not in the known list, and only owned keys", () => {
    const target: Record<string, unknown> = { id: "wb", sheets: { s1: {} }, _old: 1 };
    mirrorRootExtensionsInto(target, JSON.stringify({ id: "other", sheets: {}, _futureKey: [1] }));
    expect(target).toEqual({ id: "wb", sheets: { s1: {} }, _futureKey: [1] });
  });
});

// ---------- createRootExtensionMirror (#356) --------------------------------

/** A workbook store and a stand-in for Univer's Workbook model. */
function setup(opened: Record<string, unknown>) {
  const store = create<RootMirrorStoreState>(() => ({
    currentSnapshotJson: JSON.stringify(opened),
    editorRevision: 1,
  }));
  const model = { snapshot: JSON.parse(JSON.stringify(opened)) as Record<string, unknown> };
  const save = () => JSON.parse(JSON.stringify(model.snapshot)) as Record<string, unknown>;
  const errors: unknown[] = [];
  const mirror = createRootExtensionMirror(() => model.snapshot, (e) => errors.push(e));
  mirror.mirror(store.getState().currentSnapshotJson);
  const unsubscribe = store.subscribe(mirror.onStoreChange);
  const setJson = (json: string) => store.setState({ currentSnapshotJson: json });
  /** What EditorScreen.syncSnapshot does after a cell edit. */
  const syncCellEdit = (cell: number) => {
    const fresh = save();
    (fresh.sheets as Record<string, unknown>).s1 = { cellData: { [cell]: {} } };
    const merged = carryForwardRootExtensions(
      JSON.stringify(fresh),
      store.getState().currentSnapshotJson,
    );
    mirror.writeOwn(merged, setJson);
  };
  const current = () => JSON.parse(store.getState().currentSnapshotJson!) as Record<string, unknown>;
  return { store, model, save, mirror, setJson, syncCellEdit, current, errors, unsubscribe };
}

describe("createRootExtensionMirror", () => {
  it("a store update back to the last sync output is still mirrored (#356: a removed measure stays removed)", () => {
    const t = setup({ sheets: { s1: {} } });
    t.syncCellEdit(1); // store = M1 (no _cocoDataModel)
    const m1 = t.store.getState().currentSnapshotJson!;

    // Add a measure: the data model is written on the store snapshot.
    const withModel = JSON.parse(m1);
    withModel._cocoDataModel = { measures: [{ name: "Total" }] };
    t.setJson(JSON.stringify(withModel));
    expect(t.model.snapshot._cocoDataModel).toEqual({ measures: [{ name: "Total" }] });

    // Remove it again: the key is deleted and the string is byte-identical to M1.
    const without = JSON.parse(JSON.stringify(withModel));
    delete without._cocoDataModel;
    expect(JSON.stringify(without)).toBe(m1);
    t.setJson(JSON.stringify(without));
    expect("_cocoDataModel" in t.model.snapshot).toBe(false);

    // Next cell edit / save / autosave: the measure must not come back.
    t.syncCellEdit(2);
    expect("_cocoDataModel" in t.current()).toBe(false);
    t.unsubscribe();
  });

  it("skips exactly its own write, and clears the marker even when the write throws", () => {
    const t = setup({ sheets: { s1: {} }, _scripts: [{ id: "a" }] });
    const own = JSON.stringify({ sheets: { s1: {} }, _scripts: [{ id: "own" }] });
    t.mirror.writeOwn(own, t.setJson);
    // Not mirrored: its keys are taken to be the store's already.
    expect(t.model.snapshot._scripts).toEqual([{ id: "a" }]);

    expect(() =>
      t.mirror.writeOwn("{}", () => {
        throw new Error("write failed");
      }),
    ).toThrow("write failed");
    // A later ordinary update with the same string as the own write is mirrored.
    t.setJson(JSON.stringify({ sheets: {} }));
    t.setJson(own);
    expect(t.model.snapshot._scripts).toEqual([{ id: "own" }]);
    t.unsubscribe();
  });

  it("does not mirror while another document is mounting", () => {
    const t = setup({ sheets: {}, _scripts: [{ id: "a" }] });
    t.store.setState({
      currentSnapshotJson: JSON.stringify({ sheets: {}, _scripts: [{ id: "other-doc" }] }),
      editorRevision: 2,
    });
    expect(t.model.snapshot._scripts).toEqual([{ id: "a" }]);
    t.unsubscribe();
  });

  it("reports target failures without breaking the store update", () => {
    const store = create<RootMirrorStoreState>(() => ({ currentSnapshotJson: "{}", editorRevision: 1 }));
    const errors: unknown[] = [];
    const mirror = createRootExtensionMirror(
      () => {
        throw new Error("no workbook");
      },
      (e) => errors.push(e),
    );
    const unsubscribe = store.subscribe(mirror.onStoreChange);
    store.setState({ currentSnapshotJson: JSON.stringify({ _scripts: [] }) });
    expect(errors).toHaveLength(1);
    expect(store.getState().currentSnapshotJson).toBe(JSON.stringify({ _scripts: [] }));
    unsubscribe();
  });

  it("keeps the first shape when a second one is added from save() (#356 _textBoxes)", () => {
    expect(NICEL_ROOT_EXTENSION_KEYS).toContain("_textBoxes");
    const t = setup({ sheets: { s1: {} } });
    // applyShape: builds on save(), appends, writes to the store.
    const addShape = (id: string) => {
      const snap = t.save();
      const list = Array.isArray(snap._textBoxes) ? (snap._textBoxes as unknown[]) : [];
      t.setJson(JSON.stringify({ ...snap, _textBoxes: [...list, { id }] }));
    };
    addShape("tb-1");
    addShape("tb-2");
    expect(t.current()._textBoxes).toEqual([{ id: "tb-1" }, { id: "tb-2" }]);
    t.syncCellEdit(3);
    expect(t.current()._textBoxes).toEqual([{ id: "tb-1" }, { id: "tb-2" }]);
    t.unsubscribe();
  });

  it("keeps linked data types across a cell edit and does not revive removed ones (#356 _cocoDataTypes)", () => {
    expect(NICEL_ROOT_EXTENSION_KEYS).toContain("_cocoDataTypes");
    const t = setup({ sheets: { s1: {} } });
    const added = t.current();
    added._cocoDataTypes = { sources: [{ id: "src" }] };
    t.setJson(JSON.stringify(added));
    t.syncCellEdit(4);
    expect(t.current()._cocoDataTypes).toEqual({ sources: [{ id: "src" }] });

    const removed = t.current();
    delete removed._cocoDataTypes; // writeLinkedDataTypes deletes the key
    t.setJson(JSON.stringify(removed));
    t.syncCellEdit(5);
    expect("_cocoDataTypes" in t.current()).toBe(false);
    t.unsubscribe();
  });
});

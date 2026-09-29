// @vitest-environment node
//
// #356 — the snapshot mirror relies on how Univer stores a workbook's
// snapshot and what `FWorkbook.save()` returns. `FWorkbook.save()` is
// `IResourceLoaderService.saveUnit(unitId)`, so these tests create a real
// unit through `Univer.createUnit` and call the real `saveUnit`. A Univer
// upgrade that changes the contract (for example rebuilding the output from
// the model, or returning the live object instead of a copy) fails here
// instead of silently bringing stale workbook-root keys back.
import { afterEach, describe, it, expect } from "vitest";
import {
  IResourceLoaderService,
  Univer,
  UniverInstanceType,
  type IWorkbookData,
  type Workbook,
} from "@univerjs/core";
import { carryForwardRootExtensions, isNicelRootKey, mirrorRootExtensionsInto } from "./snapshotSync";

const UNIT_ID = "wb-contract";
const opened: Univer[] = [];

afterEach(() => {
  for (const univer of opened.splice(0)) univer.dispose();
});

/** A real sheet unit plus the real saveUnit behind FWorkbook.save(). */
function openWorkbook(extra: Record<string, unknown> = {}) {
  const univer = new Univer();
  opened.push(univer);
  const data = {
    id: UNIT_ID,
    name: "contract",
    sheetOrder: ["s1"],
    sheets: { s1: { id: "s1", name: "Sheet1", cellData: { 0: { 0: { v: 1 } } } } },
    ...extra,
  } as unknown as Partial<IWorkbookData>;
  const workbook = univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, data);
  const loader = univer.__getInjector().get(IResourceLoaderService);
  /** The live snapshot object the mirror writes into. */
  const live = () => workbook.getSnapshot() as unknown as Record<string, unknown>;
  /** What FWorkbook.save() returns. */
  const saveUnit = () => {
    const out = loader.saveUnit(UNIT_ID) as unknown as Record<string, unknown> | null;
    if (!out) throw new Error("saveUnit returned null");
    return out;
  };
  return { workbook, live, saveUnit };
}

describe("snapshot mirror — Univer contract (Univer.createUnit + IResourceLoaderService.saveUnit)", () => {
  it("returns the createUnit-time root keys from saveUnit (the #356 premise)", () => {
    const { saveUnit } = openWorkbook({ _scripts: [{ id: "opened" }] });
    expect(saveUnit()._scripts).toEqual([{ id: "opened" }]);
  });

  it("getSnapshot() is the live object; saveUnit returns a copy of it", () => {
    const { live, saveUnit } = openWorkbook();
    expect(live()).toBe(live());
    const copy = saveUnit();
    expect(copy).not.toBe(live());
    copy._scripts = ["changed only in the copy"];
    expect("_scripts" in live()).toBe(false);
    expect("_scripts" in saveUnit()).toBe(false);
  });

  it("mirror writes into getSnapshot() show up in saveUnit, and removed keys disappear", () => {
    const { live, saveUnit } = openWorkbook({
      _scripts: [{ id: "opened" }],
      _cocoQueries: [{ id: "q" }],
    });
    mirrorRootExtensionsInto(live(), JSON.stringify({ _scripts: [{ id: "edited" }] }));
    const out = saveUnit();
    expect(out._scripts).toEqual([{ id: "edited" }]);
    expect("_cocoQueries" in out).toBe(false);
    // Univer's own data is untouched.
    expect(out.id).toBe(UNIT_ID);
    expect(out.sheetOrder).toEqual(["s1"]);
  });

  it("Univer adds no root key of its own that Nicel would treat as owned", () => {
    const { live, saveUnit } = openWorkbook();
    expect(Object.keys(live()).filter(isNicelRootKey)).toEqual([]);
    const out = saveUnit();
    // saveUnit puts `resources` at the root; it is Univer's, not an owned key.
    expect("resources" in out).toBe(true);
    expect(isNicelRootKey("resources")).toBe(false);
    expect(Object.keys(out).filter(isNicelRootKey)).toEqual([]);
  });

  it("with the mirror, a cell-edit sync keeps the store's root keys end to end", () => {
    const { live, saveUnit } = openWorkbook({ _scripts: [{ id: "opened" }] });
    const store = JSON.stringify({ ...saveUnit(), _scripts: [{ id: "edited" }] });
    mirrorRootExtensionsInto(live(), store);
    const merged = JSON.parse(carryForwardRootExtensions(JSON.stringify(saveUnit()), store));
    expect(merged._scripts).toEqual([{ id: "edited" }]);
  });
});

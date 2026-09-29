// @vitest-environment node
//
// #356 — the snapshot mirror relies on how Univer's Workbook model stores
// and returns its snapshot. These tests pin that contract against the real
// @univerjs/core Workbook, so a Univer upgrade that changes it fails here
// instead of silently bringing stale workbook-root keys back.
import { describe, it, expect } from "vitest";
import { Tools, Workbook } from "@univerjs/core";
import { carryForwardRootExtensions, isNicelRootKey, mirrorRootExtensionsInto } from "./snapshotSync";

type LogService = ConstructorParameters<typeof Workbook>[1];
const silentLog = {
  debug() {},
  log() {},
  warn() {},
  error() {},
  deprecate() {},
} as unknown as LogService;

function workbookData(extra: Record<string, unknown> = {}) {
  return {
    id: "wb-contract",
    name: "contract",
    sheetOrder: ["s1"],
    sheets: { s1: { id: "s1", name: "Sheet1", cellData: { 0: { 0: { v: 1 } } } } },
    ...extra,
  } as unknown as ConstructorParameters<typeof Workbook>[0];
}

const rootOf = (wb: Workbook) => wb.getSnapshot() as unknown as Record<string, unknown>;
const saved = (wb: Workbook) => wb.save() as unknown as Record<string, unknown>;
/** What ResourceLoaderService.saveUnit does (FWorkbook.save()): deep-clone getSnapshot(). */
const savedUnit = (wb: Workbook) =>
  Tools.deepClone(wb.getSnapshot()) as unknown as Record<string, unknown>;

describe("snapshot mirror — Univer contract (@univerjs/core Workbook)", () => {
  it("keeps the createUnit-time root keys and returns them from save() (the #356 premise)", () => {
    const wb = new Workbook(workbookData({ _scripts: [{ id: "opened" }] }), silentLog);
    expect(saved(wb)._scripts).toEqual([{ id: "opened" }]);
  });

  it("getSnapshot() returns the live object; save() returns a copy", () => {
    const wb = new Workbook(workbookData(), silentLog);
    expect(wb.getSnapshot()).toBe(wb.getSnapshot());
    const copy = saved(wb);
    expect(copy).not.toBe(wb.getSnapshot());
    copy._scripts = ["changed only in the copy"];
    expect("_scripts" in rootOf(wb)).toBe(false);
  });

  it("mirror writes into getSnapshot() show up in save() and in the saveUnit clone", () => {
    const wb = new Workbook(workbookData({ _scripts: [{ id: "opened" }], _cocoQueries: [{ id: "q" }] }), silentLog);
    mirrorRootExtensionsInto(rootOf(wb), JSON.stringify({ _scripts: [{ id: "edited" }] }));
    expect(saved(wb)._scripts).toEqual([{ id: "edited" }]);
    expect(savedUnit(wb)._scripts).toEqual([{ id: "edited" }]);
    // A key the store removed is gone from both as well.
    expect("_cocoQueries" in saved(wb)).toBe(false);
    expect("_cocoQueries" in savedUnit(wb)).toBe(false);
    // Univer's own data is untouched.
    expect(saved(wb).sheetOrder).toEqual(["s1"]);
    expect(saved(wb).id).toBe("wb-contract");
  });

  it("Univer adds no root key of its own that Nicel would treat as owned", () => {
    const wb = new Workbook(workbookData(), silentLog);
    const owned = Object.keys(rootOf(wb)).filter(isNicelRootKey);
    expect(owned).toEqual([]);
    expect(Object.keys(savedUnit(wb)).filter(isNicelRootKey)).toEqual([]);
  });

  it("with the mirror, a cell-edit sync keeps the store's root keys end to end", () => {
    const wb = new Workbook(workbookData({ _scripts: [{ id: "opened" }] }), silentLog);
    const store = JSON.stringify({ ...saved(wb), _scripts: [{ id: "edited" }] });
    mirrorRootExtensionsInto(rootOf(wb), store);
    const merged = JSON.parse(carryForwardRootExtensions(JSON.stringify(savedUnit(wb)), store));
    expect(merged._scripts).toEqual([{ id: "edited" }]);
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

import {
  __resetLaunchOpenForTests,
  openLaunchedPath,
  startLaunchOpen,
} from "./useLaunchOpen";
import { useWorkbookStore } from "../store/useWorkbookStore";

// The store's real newWorkbook, captured before any test replaces actions.
const realNewWorkbook = useWorkbookStore.getState().newWorkbook;

const importXlsx = vi.fn();
const importCsv = vi.fn();
const openNicel = vi.fn();
const loadCsvImportEncoding = vi.fn();
const loadSuppressCsvPocWarning = vi.fn();

let warn: ReturnType<typeof vi.spyOn>;

function resetStore() {
  useWorkbookStore.setState({
    screen: "home",
    currentHandle: null,
    saveStatus: "saved",
    blockingImport: null,
    lastError: null,
    importXlsx,
    importCsv,
    openNicel,
    loadCsvImportEncoding,
    loadSuppressCsvPocWarning,
  });
}

/** A promise that settles when the test says so. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  for (const m of [importXlsx, importCsv, openNicel, loadCsvImportEncoding, loadSuppressCsvPocWarning]) {
    m.mockReset();
    m.mockResolvedValue(undefined);
  }
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetLaunchOpenForTests();
  resetStore();
});

afterEach(() => {
  warn.mockRestore();
});

function nothingOpened() {
  expect(importXlsx).not.toHaveBeenCalled();
  expect(importCsv).not.toHaveBeenCalled();
  expect(openNicel).not.toHaveBeenCalled();
}

describe("startLaunchOpen", () => {
  it("waits for both settings loads before asking for the launch paths", async () => {
    const enc = deferred();
    const poc = deferred();
    loadCsvImportEncoding.mockReturnValue(enc.promise);
    loadSuppressCsvPocWarning.mockReturnValue(poc.promise);

    const started = startLaunchOpen();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();

    enc.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();

    poc.resolve();
    await started;
    expect(invokeMock).toHaveBeenCalledWith("take_launch_paths");
  });

  it("still asks for the launch paths when one settings load rejects", async () => {
    loadCsvImportEncoding.mockRejectedValue(new Error("db busy"));
    await startLaunchOpen();
    expect(invokeMock).toHaveBeenCalledWith("take_launch_paths");
  });

  it("opens only the first path", async () => {
    invokeMock.mockResolvedValue(["C:/a/b.xlsx", "C:/a/c.csv"]);
    await startLaunchOpen();
    expect(importXlsx).toHaveBeenCalledTimes(1);
    expect(importXlsx).toHaveBeenCalledWith("C:/a/b.xlsx");
    expect(importCsv).not.toHaveBeenCalled();
  });

  it("opens a launched .xls workbook through importXlsx", async () => {
    const path = "C:/Users/テスト/売上.XLS";
    invokeMock.mockResolvedValue([path]);
    await startLaunchOpen();
    expect(importXlsx).toHaveBeenCalledWith(path);
    expect(importCsv).not.toHaveBeenCalled();
    expect(openNicel).not.toHaveBeenCalled();
  });

  it("does nothing when the launch list is empty", async () => {
    invokeMock.mockResolvedValue([]);
    await startLaunchOpen();
    nothingOpened();
  });

  it("runs once per JS context (StrictMode runs effects twice)", async () => {
    invokeMock.mockResolvedValue(["C:/a/b.xlsx"]);
    const first = startLaunchOpen();
    const second = startLaunchOpen();
    expect(second).toBe(first);
    await first;
    await startLaunchOpen();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(importXlsx).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing take_launch_paths", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await expect(startLaunchOpen()).resolves.toBeUndefined();
    nothingOpened();
    expect(useWorkbookStore.getState().lastError).toBeNull();
  });

  it("does not open when the editor is already showing", async () => {
    const hold = deferred<string[]>();
    invokeMock.mockReturnValue(hold.promise);
    const started = startLaunchOpen();
    await Promise.resolve();
    useWorkbookStore.setState({ screen: "editor" });
    hold.resolve(["C:/a/b.xlsx"]);
    await started;
    nothingOpened();
  });

  it("does not open while a blocking import dialog is showing", async () => {
    useWorkbookStore.setState({
      blockingImport: [{ code: "X", severity: "blocking", message: "m" } as never],
    });
    invokeMock.mockResolvedValue(["C:/a/b.xlsx"]);
    await startLaunchOpen();
    nothingOpened();
  });

  it("does not open when the user started a new workbook while the paths were pending", async () => {
    const newWorkbookInvoke = deferred<unknown>();
    const paths = deferred<string[]>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "take_launch_paths" ? paths.promise : newWorkbookInvoke.promise,
    );
    // Real newWorkbook bumps the open counter before its first await.
    useWorkbookStore.setState({ newWorkbook: realNewWorkbook });

    const started = startLaunchOpen();
    await Promise.resolve();
    const pendingNew = useWorkbookStore.getState().newWorkbook();
    paths.resolve(["C:/a/b.xlsx"]);
    await started;
    nothingOpened();

    newWorkbookInvoke.resolve({
      workbookId: "w",
      path: null,
      sourceType: "xlsx",
      snapshotJson: "{}",
    });
    await pendingNew;
  });

  it("does not open after a failed open either (the counter has moved on)", async () => {
    const paths = deferred<string[]>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "take_launch_paths" ? paths.promise : Promise.reject(new Error("nope")),
    );
    useWorkbookStore.setState({ newWorkbook: realNewWorkbook });

    const started = startLaunchOpen();
    await Promise.resolve();
    await useWorkbookStore.getState().newWorkbook();
    expect(useWorkbookStore.getState().lastError).not.toBeNull();
    paths.resolve(["C:/a/b.xlsx"]);
    await started;
    nothingOpened();
  });
});

describe("openLaunchedPath", () => {
  // The seq is irrelevant to routing; use the current one so the guard passes.
  async function open(path: string) {
    const { getOpenSeq } = await import("../store/useWorkbookStore");
    await openLaunchedPath(path, getOpenSeq());
  }

  it("routes .csv and .tsv to importCsv", async () => {
    await open("C:/a/b.csv");
    await open("C:/a/c.TSV");
    expect(importCsv).toHaveBeenCalledWith("C:/a/b.csv");
    expect(importCsv).toHaveBeenCalledWith("C:/a/c.TSV");
    expect(importXlsx).not.toHaveBeenCalled();
  });

  it("routes .xlsx and .xlsm to importXlsx", async () => {
    await open("C:/a/b.xlsx");
    await open("C:/a/c.xlsm");
    expect(importXlsx).toHaveBeenCalledTimes(2);
    expect(importCsv).not.toHaveBeenCalled();
  });

  it("routes .coco to openNicel", async () => {
    await open("C:/a/b.coco");
    expect(openNicel).toHaveBeenCalledWith("C:/a/b.coco");
  });

  it("ignores an unsupported extension without setting an error", async () => {
    await open("C:/a/b.txt");
    nothingOpened();
    expect(useWorkbookStore.getState().lastError).toBeNull();
  });
});

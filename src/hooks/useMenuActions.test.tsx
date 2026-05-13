// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

const { invokeMock, openMock, listenMock, destroyMock, unlistenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
  listenMock: vi.fn(),
  destroyMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock, save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: listenMock, close: destroyMock }),
}));

import { useMenuActions } from "./useMenuActions";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { onHelpRequested, onSettingsRequested } from "./useGlobalShortcuts";

let lastHandler: ((event: { payload: string }) => void | Promise<void>) | null = null;

function Probe() {
  useMenuActions();
  return null;
}

function resetStore() {
  useWorkbookStore.setState({
    screen: "home",
    currentHandle: null,
    saveStatus: "saved",
    importWarnings: [],
    recentFiles: [],
    recoveryCandidates: [],
    currentSnapshotJson: null,
    isExporting: false,
    exportWarnings: [],
    blockingImport: null,
    lastError: null,
    lastSavedAt: null,
    autoSaveIntervalMs: 30_000,
    csvExportEncoding: "utf8-bom",
    csvImportEncoding: "auto",
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  openMock.mockReset();
  listenMock.mockReset();
  destroyMock.mockReset();
  unlistenMock.mockReset();
  lastHandler = null;
  listenMock.mockImplementation((_eventName, fn) => {
    lastHandler = fn;
    return Promise.resolve(unlistenMock);
  });
  resetStore();
  window.confirm = vi.fn().mockReturnValue(true);
});

afterEach(() => cleanup());

async function fireMenu(id: string) {
  await waitFor(() => expect(lastHandler).not.toBeNull());
  await act(async () => {
    await lastHandler!({ payload: id });
  });
}

describe("useMenuActions", () => {
  describe("listener registration", () => {
    it("subscribes to the 'menu-action' window event", async () => {
      render(<Probe />);
      await waitFor(() => expect(listenMock).toHaveBeenCalled());
      expect(listenMock.mock.calls[0][0]).toBe("menu-action");
    });

    it("calls the unlisten function on unmount", async () => {
      const { unmount } = render(<Probe />);
      await waitFor(() => expect(lastHandler).not.toBeNull());
      unmount();
      expect(unlistenMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("file actions", () => {
    it("'new' invokes workbook_new", async () => {
      invokeMock.mockResolvedValue({
        workbookId: "wb",
        path: null,
        sourceType: "new",
        snapshotJson: "{}",
      });
      render(<Probe />);
      await fireMenu("new");
      expect(invokeMock).toHaveBeenCalledWith("workbook_new");
    });

    it("'new' prompts to discard when the editor is dirty", async () => {
      useWorkbookStore.setState({ screen: "editor", saveStatus: "unsaved" });
      window.confirm = vi.fn().mockReturnValue(false);
      render(<Probe />);
      await fireMenu("new");
      expect(window.confirm).toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("workbook_new");
    });

    it("'open' opens dialog and routes .xlsx to workbook_import_xlsx", async () => {
      openMock.mockResolvedValue("/tmp/book.xlsx");
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/book.xlsx", sourceType: "xlsx", snapshotJson: "{}" },
        warnings: [],
      });
      render(<Probe />);
      await fireMenu("open");
      expect(openMock).toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith("workbook_import_xlsx", { path: "/tmp/book.xlsx" });
    });

    it("'open' routes .csv to workbook_import_csv with current encoding", async () => {
      useWorkbookStore.setState({ csvImportEncoding: "utf8" });
      openMock.mockResolvedValue("/tmp/data.csv");
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/data.csv", sourceType: "xlsx", snapshotJson: "{}" },
        warnings: [],
      });
      render(<Probe />);
      await fireMenu("open");
      expect(invokeMock).toHaveBeenCalledWith("workbook_import_csv", {
        path: "/tmp/data.csv",
        encoding: "utf8",
      });
    });

    it("'open' routes .coco to workbook_open_coco", async () => {
      openMock.mockResolvedValue("/tmp/wb.coco");
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/wb.coco", sourceType: "coco", snapshotJson: "{}" },
        warnings: [],
      });
      render(<Probe />);
      await fireMenu("open");
      expect(invokeMock).toHaveBeenCalledWith("workbook_open_coco", { path: "/tmp/wb.coco" });
    });

    it("'open' is a no-op when the user cancels the dialog", async () => {
      openMock.mockResolvedValue(null);
      render(<Probe />);
      await fireMenu("open");
      const importCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
      );
      expect(importCalls).toHaveLength(0);
    });
  });

  describe("save actions", () => {
    it("'save' calls the store save action", async () => {
      const saveSpy = vi.fn();
      useWorkbookStore.setState({ save: saveSpy });
      render(<Probe />);
      await fireMenu("save");
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it("'save-as' calls the store promptSaveAs action", async () => {
      const promptSaveAsSpy = vi.fn();
      useWorkbookStore.setState({ promptSaveAs: promptSaveAsSpy });
      render(<Probe />);
      await fireMenu("save-as");
      expect(promptSaveAsSpy).toHaveBeenCalledTimes(1);
    });

    it("'export-xlsx' calls the store exportXlsx action", async () => {
      const exportSpy = vi.fn();
      useWorkbookStore.setState({ exportXlsx: exportSpy });
      render(<Probe />);
      await fireMenu("export-xlsx");
      expect(exportSpy).toHaveBeenCalledTimes(1);
    });

    it("'export-csv' dispatches a coco:menu-csv-export window event", async () => {
      const listener = vi.fn();
      window.addEventListener("coco:menu-csv-export", listener);
      render(<Probe />);
      await fireMenu("export-csv");
      expect(listener).toHaveBeenCalledTimes(1);
      window.removeEventListener("coco:menu-csv-export", listener);
    });
  });

  describe("dialog emitters", () => {
    it("'settings' fires the settings emitter", async () => {
      const listener = vi.fn();
      const unsub = onSettingsRequested(listener);
      render(<Probe />);
      await fireMenu("settings");
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it("'help' fires the help emitter", async () => {
      const listener = vi.fn();
      const unsub = onHelpRequested(listener);
      render(<Probe />);
      await fireMenu("help");
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });
  });

  describe("close action", () => {
    it("'close' calls getCurrentWindow().close()", async () => {
      render(<Probe />);
      await fireMenu("close");
      expect(destroyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("unknown action", () => {
    it("ignores an unknown id without crashing", async () => {
      render(<Probe />);
      await fireMenu("does-not-exist");
      // No assertions on side effects; just verify the test doesn't throw.
      expect(true).toBe(true);
    });
  });
});

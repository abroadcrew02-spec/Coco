// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

const { invokeMock, onDragDropEventMock, unlistenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  onDragDropEventMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onDragDropEvent: onDragDropEventMock }),
}));

import { useFileDrop } from "./useFileDrop";
import { useWorkbookStore } from "../store/useWorkbookStore";

// Last handler registered with the (mocked) window.onDragDropEvent.
type DragPayload =
  | { type: "enter"; paths: string[] }
  | { type: "over"; paths: string[] }
  | { type: "leave" }
  | { type: "drop"; paths: string[] };

let lastHandler: ((event: { payload: DragPayload }) => void) | null = null;

function Probe() {
  const r = useFileDrop();
  // Surface isHovering via data attribute so tests can inspect it.
  return <div data-hovering={String(r.isHovering)} />;
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
  invokeMock.mockResolvedValue({
    handle: { workbookId: "wb", path: null, sourceType: "xlsx", snapshotJson: "{}" },
    warnings: [],
  });
  onDragDropEventMock.mockReset();
  unlistenMock.mockReset();
  lastHandler = null;
  // Capture the handler the hook registers and resolve with our unlistener.
  onDragDropEventMock.mockImplementation((fn) => {
    lastHandler = fn;
    return Promise.resolve(unlistenMock);
  });
  resetStore();
  window.confirm = vi.fn().mockReturnValue(true);
});

afterEach(() => cleanup());

async function fireDrop(path: string) {
  // Hook registers the listener async via .then; wait until our handler is set.
  await waitFor(() => expect(lastHandler).not.toBeNull());
  await act(async () => {
    lastHandler!({ payload: { type: "drop", paths: [path] } });
    // Give the inner async dispatch a microtask to run.
    await Promise.resolve();
  });
}

describe("useFileDrop", () => {
  describe("extension dispatch", () => {
    it("routes .xlsx to workbook_import_xlsx", async () => {
      render(<Probe />);
      await fireDrop("/tmp/book.xlsx");
      expect(invokeMock).toHaveBeenCalledWith("workbook_import_xlsx", { path: "/tmp/book.xlsx" });
    });

    it("routes .xlsm to workbook_import_xlsx (AD-02b)", async () => {
      render(<Probe />);
      await fireDrop("/tmp/macros.xlsm");
      expect(invokeMock).toHaveBeenCalledWith("workbook_import_xlsx", { path: "/tmp/macros.xlsm" });
    });

    it("routes .coco to workbook_open_coco", async () => {
      render(<Probe />);
      await fireDrop("/tmp/wb.coco");
      expect(invokeMock).toHaveBeenCalledWith("workbook_open_coco", { path: "/tmp/wb.coco" });
    });

    it("routes .csv to workbook_import_csv with the current encoding", async () => {
      useWorkbookStore.setState({ csvImportEncoding: "shift_jis" });
      render(<Probe />);
      await fireDrop("/tmp/data.csv");
      expect(invokeMock).toHaveBeenCalledWith("workbook_import_csv", {
        path: "/tmp/data.csv",
        encoding: "shift_jis",
      });
    });

    it("silently ignores unsupported extensions (.png)", async () => {
      render(<Probe />);
      await fireDrop("/tmp/photo.png");
      const importCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
      );
      expect(importCalls).toHaveLength(0);
    });
  });

  describe("unsaved-discard guard", () => {
    it("does NOT prompt for unsupported extensions even when unsaved (regression)", async () => {
      // Previously: the discard prompt fired before extension check, asking the
      // user to discard their work just to silently ignore a .png drop.
      useWorkbookStore.setState({ screen: "editor", saveStatus: "unsaved" });
      render(<Probe />);
      await fireDrop("/tmp/random.png");
      expect(window.confirm).not.toHaveBeenCalled();
    });

    it("prompts and proceeds when the user accepts discard", async () => {
      useWorkbookStore.setState({ screen: "editor", saveStatus: "unsaved" });
      window.confirm = vi.fn().mockReturnValue(true);
      render(<Probe />);
      await fireDrop("/tmp/replace.xlsx");
      expect(window.confirm).toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith("workbook_import_xlsx", { path: "/tmp/replace.xlsx" });
    });

    it("prompts and aborts when the user cancels discard", async () => {
      useWorkbookStore.setState({ screen: "editor", saveStatus: "unsaved" });
      window.confirm = vi.fn().mockReturnValue(false);
      render(<Probe />);
      await fireDrop("/tmp/replace.xlsx");
      expect(window.confirm).toHaveBeenCalled();
      const importCalls = invokeMock.mock.calls.filter((c) => c[0] === "workbook_import_xlsx");
      expect(importCalls).toHaveLength(0);
    });

    it("does not prompt when the editor is clean (saved)", async () => {
      useWorkbookStore.setState({ screen: "editor", saveStatus: "saved" });
      render(<Probe />);
      await fireDrop("/tmp/replace.xlsx");
      expect(window.confirm).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith("workbook_import_xlsx", { path: "/tmp/replace.xlsx" });
    });
  });

  describe("multi-file drop", () => {
    it("uses only the first path when multiple files are dropped", async () => {
      render(<Probe />);
      await waitFor(() => expect(lastHandler).not.toBeNull());
      await act(async () => {
        lastHandler!({
          payload: { type: "drop", paths: ["/tmp/first.xlsx", "/tmp/second.xlsx"] },
        });
        await Promise.resolve();
      });
      const importCalls = invokeMock.mock.calls.filter((c) => c[0] === "workbook_import_xlsx");
      expect(importCalls).toHaveLength(1);
      expect(importCalls[0][1]).toEqual({ path: "/tmp/first.xlsx" });
    });

    it("does nothing when the drop event arrives with an empty path list", async () => {
      render(<Probe />);
      await waitFor(() => expect(lastHandler).not.toBeNull());
      await act(async () => {
        lastHandler!({ payload: { type: "drop", paths: [] } });
        await Promise.resolve();
      });
      const importCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
      );
      expect(importCalls).toHaveLength(0);
    });
  });

  describe("hover state", () => {
    it("sets isHovering true on enter and over, false on leave", async () => {
      const { container } = render(<Probe />);
      await waitFor(() => expect(lastHandler).not.toBeNull());
      await act(async () => {
        lastHandler!({ payload: { type: "enter", paths: [] } });
      });
      expect(container.querySelector("[data-hovering]")?.getAttribute("data-hovering")).toBe("true");
      await act(async () => {
        lastHandler!({ payload: { type: "leave" } });
      });
      expect(container.querySelector("[data-hovering]")?.getAttribute("data-hovering")).toBe("false");
    });

    it("clears isHovering on drop", async () => {
      const { container } = render(<Probe />);
      await waitFor(() => expect(lastHandler).not.toBeNull());
      await act(async () => {
        lastHandler!({ payload: { type: "enter", paths: [] } });
      });
      expect(container.querySelector("[data-hovering]")?.getAttribute("data-hovering")).toBe("true");
      await act(async () => {
        lastHandler!({ payload: { type: "drop", paths: ["/tmp/wb.xlsx"] } });
        await Promise.resolve();
      });
      expect(container.querySelector("[data-hovering]")?.getAttribute("data-hovering")).toBe("false");
    });
  });

  describe("listener cleanup", () => {
    it("calls the unlisten function on unmount", async () => {
      const { unmount } = render(<Probe />);
      await waitFor(() => expect(lastHandler).not.toBeNull());
      unmount();
      expect(unlistenMock).toHaveBeenCalledTimes(1);
    });
  });
});

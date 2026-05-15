// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const { invokeMock, onCloseMock, destroyMock, unlistenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  onCloseMock: vi.fn(),
  destroyMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: onCloseMock,
    destroy: destroyMock,
  }),
}));

import { useCloseGuard, onCloseRequest } from "./useCloseGuard";
import { useWorkbookStore } from "../store/useWorkbookStore";

// Captured handler the hook registers with the (mocked) window.onCloseRequested.
let lastHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null = null;

function Probe() {
  useCloseGuard();
  return null;
}

function resetStore() {
  useWorkbookStore.setState({
    screen: "editor",
    currentHandle: {
      workbookId: "wb",
      path: "/tmp/wb.coco",
      sourceType: "coco",
      snapshotJson: "{}",
      requiresSaveAsOnFirstSave: false,
    },
    saveStatus: "saved",
    importWarnings: [],
    recentFiles: [],
    recoveryCandidates: [],
    currentSnapshotJson: "{}",
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
  invokeMock.mockResolvedValue({ success: true, path: "/tmp/wb.coco" });
  onCloseMock.mockReset();
  destroyMock.mockReset();
  unlistenMock.mockReset();
  lastHandler = null;
  onCloseMock.mockImplementation((fn) => {
    lastHandler = fn;
    return Promise.resolve(unlistenMock);
  });
  resetStore();
  // happy-dom does ship window.confirm; reset to a known default.
  window.confirm = vi.fn().mockReturnValue(true);
});

afterEach(() => cleanup());

// Trigger the captured close handler WITHOUT waiting for its completion. The
// dialog flow inside the handler awaits a Promise we resolve from the test
// body; awaiting the handler synchronously would deadlock since the test
// can't run resolveDialog!() while we're stuck awaiting the handler.
async function startClose(): Promise<{
  event: { preventDefault: ReturnType<typeof vi.fn> };
  done: Promise<void>;
}> {
  await waitFor(() => expect(lastHandler).not.toBeNull());
  const event = { preventDefault: vi.fn() };
  const done = Promise.resolve(lastHandler!(event)).then(() => undefined);
  return { event, done };
}

// For tests where the handler is synchronous (clean editor, no dialog),
// awaiting the handler immediately is safe and concise.
async function fireClose(): Promise<{ preventDefault: ReturnType<typeof vi.fn> }> {
  const { event, done } = await startClose();
  await done;
  return event;
}

describe("useCloseGuard", () => {
  describe("clean editor", () => {
    it("allows close without preventDefault when saveStatus is 'saved'", async () => {
      useWorkbookStore.setState({ saveStatus: "saved" });
      render(<Probe />);
      const event = await fireClose();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("allows close when saveStatus is 'auto_saved'", async () => {
      useWorkbookStore.setState({ saveStatus: "auto_saved" });
      render(<Probe />);
      const event = await fireClose();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("dirty editor — dialog mounted", () => {
    let resolveDialog: ((choice: "save" | "discard" | "cancel") => void) | null = null;
    let unsubDialog: (() => void) | null = null;

    beforeEach(() => {
      // Mount a fake dialog listener that captures the resolve fn so each test
      // can choose the outcome.
      resolveDialog = null;
      unsubDialog = onCloseRequest((resolve) => {
        resolveDialog = resolve;
      });
      useWorkbookStore.setState({ saveStatus: "unsaved" });
    });

    afterEach(() => {
      if (unsubDialog) unsubDialog();
    });

    it("preventDefaults the close and asks the registered dialog", async () => {
      render(<Probe />);
      const { event, done } = await startClose();
      await waitFor(() => expect(resolveDialog).not.toBeNull());
      expect(event.preventDefault).toHaveBeenCalled();
      resolveDialog!("cancel");
      await done;
    });

    it("treats save_failed as dirty and asks the registered dialog", async () => {
      useWorkbookStore.setState({ saveStatus: "save_failed" });
      render(<Probe />);
      const { event, done } = await startClose();
      await waitFor(() => expect(resolveDialog).not.toBeNull());
      expect(event.preventDefault).toHaveBeenCalled();
      resolveDialog!("cancel");
      await done;
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("'cancel' keeps the window open (no destroy)", async () => {
      render(<Probe />);
      const { done } = await startClose();
      await waitFor(() => expect(resolveDialog).not.toBeNull());
      resolveDialog!("cancel");
      await done;
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("'discard' destroys the window without saving", async () => {
      render(<Probe />);
      const { done } = await startClose();
      await waitFor(() => expect(resolveDialog).not.toBeNull());
      resolveDialog!("discard");
      await done;
      expect(destroyMock).toHaveBeenCalledTimes(1);
      const saveCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_save", "workbook_export_xlsx"].includes(c[0] as string)
      );
      expect(saveCalls).toHaveLength(0);
    });

    it("'save' runs the save action then destroys on success", async () => {
      // Replace the store's save action with a spy BEFORE render so the hook
      // captures it. (Zustand selectors give the hook the action by reference;
      // late spying doesn't reach the closure.)
      const saveSpy = vi.fn().mockImplementation(async () => {
        useWorkbookStore.setState({ saveStatus: "saved" });
      });
      useWorkbookStore.setState({ save: saveSpy });

      render(<Probe />);
      const { done } = await startClose();
      await waitFor(() => expect(resolveDialog).not.toBeNull());
      resolveDialog!("save");
      await done;

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(destroyMock).toHaveBeenCalledTimes(1);
    });

    it("'save' that fails (save_failed) keeps the window open", async () => {
      const saveSpy = vi.fn().mockImplementation(async () => {
        useWorkbookStore.setState({ saveStatus: "save_failed" });
      });
      useWorkbookStore.setState({ save: saveSpy });

      render(<Probe />);
      const { done } = await startClose();
      await waitFor(() => expect(resolveDialog).not.toBeNull());
      resolveDialog!("save");
      await done;

      expect(saveSpy).toHaveBeenCalled();
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("'save' that lands as 'unsaved' (user cancelled Save As) keeps the window open", async () => {
      const saveSpy = vi.fn().mockImplementation(async () => {
        useWorkbookStore.setState({ saveStatus: "unsaved" });
      });
      useWorkbookStore.setState({ save: saveSpy });

      render(<Probe />);
      const { done } = await startClose();
      await waitFor(() => expect(resolveDialog).not.toBeNull());
      resolveDialog!("save");
      await done;

      expect(destroyMock).not.toHaveBeenCalled();
    });
  });

  describe("dirty editor — fail-safe (no dialog mounted)", () => {
    beforeEach(() => {
      useWorkbookStore.setState({ saveStatus: "unsaved" });
    });

    it("falls back to window.confirm and discards on accept", async () => {
      window.confirm = vi.fn().mockReturnValue(true);
      render(<Probe />);
      await fireClose();
      expect(window.confirm).toHaveBeenCalled();
      expect(destroyMock).toHaveBeenCalledTimes(1);
    });

    it("treats save_failed as dirty and falls back to window.confirm", async () => {
      useWorkbookStore.setState({ saveStatus: "save_failed" });
      window.confirm = vi.fn().mockReturnValue(false);
      render(<Probe />);
      const event = await fireClose();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(window.confirm).toHaveBeenCalled();
      expect(destroyMock).not.toHaveBeenCalled();
    });

    it("falls back to window.confirm and cancels on reject", async () => {
      window.confirm = vi.fn().mockReturnValue(false);
      render(<Probe />);
      await fireClose();
      expect(window.confirm).toHaveBeenCalled();
      expect(destroyMock).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("calls the unlisten function on unmount", async () => {
      const { unmount } = render(<Probe />);
      await waitFor(() => expect(lastHandler).not.toBeNull());
      unmount();
      expect(unlistenMock).toHaveBeenCalledTimes(1);
    });
  });
});

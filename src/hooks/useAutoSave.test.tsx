// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import { useAutoSave } from "./useAutoSave";
import { useWorkbookStore } from "../store/useWorkbookStore";

function Probe() {
  useAutoSave();
  return null;
}

function makeHandle(path: string | null = "/tmp/wb.coco") {
  return {
    workbookId: "wb",
    path,
    sourceType: "coco" as const,
    snapshotJson: "{}",
    requiresSaveAsOnFirstSave: false,
  };
}

function resetStore() {
  useWorkbookStore.setState({
    screen: "editor",
    currentHandle: makeHandle(),
    saveStatus: "saved",
    importWarnings: [],
    recentFiles: [],
    recoveryCandidates: [],
    currentSnapshotJson: "{}",
    dirtyRevision: 0,
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
  resetStore();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("useAutoSave", () => {
  it("does not schedule a timer when intervalMs is 0 (disabled)", () => {
    useWorkbookStore.setState({ autoSaveIntervalMs: 0 });
    render(<Probe />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not autosave when the workbook has never been dirtied", () => {
    render(<Probe />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // saveStatus started as "saved" — dirtyRef stays false → no save.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("autosaves once after the interval when the workbook becomes unsaved", async () => {
    render(<Probe />);
    act(() => {
      useWorkbookStore.setState({ saveStatus: "unsaved" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_autosave_coco");
    expect(call).toBeTruthy();
  });

  it("autosaves to the temp path when current path is not .coco (xlsx)", async () => {
    useWorkbookStore.setState({ currentHandle: makeHandle("/tmp/book.xlsx") });
    render(<Probe />);
    act(() => useWorkbookStore.setState({ saveStatus: "unsaved" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // xlsx path → autosave_temp (not autosave_coco)
    expect(invokeMock.mock.calls.find((c) => c[0] === "workbook_autosave_temp")).toBeTruthy();
    expect(invokeMock.mock.calls.find((c) => c[0] === "workbook_autosave_coco")).toBeFalsy();
    expect(useWorkbookStore.getState().saveStatus).toBe("unsaved");
  });

  it("re-arms xlsx temp autosave when a new edit arrives while still unsaved", async () => {
    useWorkbookStore.setState({ currentHandle: makeHandle("/tmp/book.xlsx") });
    render(<Probe />);
    act(() => useWorkbookStore.setState({ saveStatus: "unsaved" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const callsAfterFirst = invokeMock.mock.calls.filter((c) =>
      String(c[0]).startsWith("workbook_autosave")
    ).length;

    act(() => useWorkbookStore.getState().markDirty());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const callsAfterSecond = invokeMock.mock.calls.filter((c) =>
      String(c[0]).startsWith("workbook_autosave")
    ).length;
    expect(callsAfterSecond).toBe(callsAfterFirst + 1);
  });

  it("does not autosave twice in a row when no new edits arrive", async () => {
    render(<Probe />);
    act(() => useWorkbookStore.setState({ saveStatus: "unsaved" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // After the first tick, the store transitions saved → auto_saved → dirtyRef
    // is cleared. Advance another interval — should NOT fire again.
    const callsAfterFirst = invokeMock.mock.calls.filter((c) =>
      String(c[0]).startsWith("workbook_autosave")
    ).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const callsAfterSecond = invokeMock.mock.calls.filter((c) =>
      String(c[0]).startsWith("workbook_autosave")
    ).length;
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it("re-arms after a manual save → edit cycle (no redundant tick)", async () => {
    render(<Probe />);
    // First dirty + autosave.
    act(() => useWorkbookStore.setState({ saveStatus: "unsaved" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const callsAfterAutosave = invokeMock.mock.calls.length;

    // User hits Ctrl+S → manual save lands → status becomes "saved" (dirtyRef → false).
    act(() => useWorkbookStore.setState({ saveStatus: "saved" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // No new autosave fires because dirtyRef was cleared on the saved transition.
    expect(invokeMock.mock.calls.length).toBe(callsAfterAutosave);

    // Now user edits again.
    act(() => useWorkbookStore.setState({ saveStatus: "unsaved" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(invokeMock.mock.calls.length).toBeGreaterThan(callsAfterAutosave);
  });

  it("respects a new interval when the store changes it (e.g. user opens Settings)", async () => {
    render(<Probe />);
    act(() => useWorkbookStore.setState({ saveStatus: "unsaved" }));
    // Change interval before the original 30s elapses — old timer must be cleared.
    act(() => useWorkbookStore.setState({ autoSaveIntervalMs: 15_000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    // Should have fired at the new 15s mark.
    const calls = invokeMock.mock.calls.filter((c) =>
      String(c[0]).startsWith("workbook_autosave")
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it("clears the interval on unmount (no leaked timer)", async () => {
    const { unmount } = render(<Probe />);
    act(() => useWorkbookStore.setState({ saveStatus: "unsaved" }));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // After unmount, no autosave commands should fire.
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

const { invokeMock, openDialogMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openDialogMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));

import {
  useGlobalShortcuts,
  onHelpRequested,
  onSettingsRequested,
} from "./useGlobalShortcuts";
import { useWorkbookStore } from "../store/useWorkbookStore";

function Probe() {
  useGlobalShortcuts();
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
    pinnedPaths: [],
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  openDialogMock.mockReset();
  resetStore();
});

afterEach(() => cleanup());

describe("useGlobalShortcuts keyboard handler", () => {
  it("F1 fires the help emitter regardless of modifiers", () => {
    const helpListener = vi.fn();
    const unsub = onHelpRequested(helpListener);
    render(<Probe />);
    fireEvent.keyDown(window, { key: "F1" });
    expect(helpListener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("Ctrl+/ fires the help emitter", () => {
    const helpListener = vi.fn();
    const unsub = onHelpRequested(helpListener);
    render(<Probe />);
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    expect(helpListener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("Cmd+/ fires the help emitter (macOS)", () => {
    const helpListener = vi.fn();
    const unsub = onHelpRequested(helpListener);
    render(<Probe />);
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    expect(helpListener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("Ctrl+, fires the settings emitter", () => {
    const settingsListener = vi.fn();
    const unsub = onSettingsRequested(settingsListener);
    render(<Probe />);
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(settingsListener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("Cmd+, fires the settings emitter (macOS)", () => {
    const settingsListener = vi.fn();
    const unsub = onSettingsRequested(settingsListener);
    render(<Probe />);
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(settingsListener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("ignores Ctrl+/ with Shift modifier (avoid stealing user combos)", () => {
    const helpListener = vi.fn();
    const unsub = onHelpRequested(helpListener);
    render(<Probe />);
    fireEvent.keyDown(window, { key: "/", ctrlKey: true, shiftKey: true });
    expect(helpListener).not.toHaveBeenCalled();
    unsub();
  });

  it("Ctrl+N invokes workbook_new", () => {
    invokeMock.mockResolvedValue({
      workbookId: "wb",
      path: null,
      sourceType: "new",
      snapshotJson: "{}",
    });
    render(<Probe />);
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(invokeMock).toHaveBeenCalledWith("workbook_new");
  });

  it("unmounting cleans up the keydown listener", () => {
    const helpListener = vi.fn();
    const unsub = onHelpRequested(helpListener);
    const { unmount } = render(<Probe />);
    unmount();
    fireEvent.keyDown(window, { key: "F1" });
    expect(helpListener).not.toHaveBeenCalled();
    unsub();
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const { setTitleMock } = vi.hoisted(() => ({ setTitleMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle: setTitleMock }),
}));

import { useWindowTitle } from "./useWindowTitle";
import { useWorkbookStore } from "../store/useWorkbookStore";

function Probe() {
  useWindowTitle();
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

function lastTitle(): string | null {
  const calls = setTitleMock.mock.calls;
  return calls.length === 0 ? null : (calls[calls.length - 1][0] as string);
}

beforeEach(() => {
  setTitleMock.mockClear();
  resetStore();
});

afterEach(() => cleanup());

describe("useWindowTitle", () => {
  it("sets just 'Coco' on the home screen", () => {
    render(<Probe />);
    expect(lastTitle()).toBe("Coco");
  });

  it("uses 'Untitled' when in the editor with no path", () => {
    useWorkbookStore.setState({
      screen: "editor",
      currentHandle: { workbookId: "wb", path: null, sourceType: "new", snapshotJson: "{}" },
    });
    render(<Probe />);
    expect(lastTitle()).toBe("Coco — Untitled");
  });

  it("extracts the base name on Unix paths", () => {
    useWorkbookStore.setState({
      screen: "editor",
      currentHandle: {
        workbookId: "wb",
        path: "/home/user/Documents/quarterly.xlsx",
        sourceType: "xlsx",
        snapshotJson: "{}",
      },
    });
    render(<Probe />);
    expect(lastTitle()).toBe("Coco — quarterly.xlsx");
  });

  it("extracts the base name on Windows paths", () => {
    useWorkbookStore.setState({
      screen: "editor",
      currentHandle: {
        workbookId: "wb",
        path: "C:\\Users\\Foo\\Reports\\book.xlsx",
        sourceType: "xlsx",
        snapshotJson: "{}",
      },
    });
    render(<Probe />);
    expect(lastTitle()).toBe("Coco — book.xlsx");
  });

  it("appends • when saveStatus is 'unsaved'", () => {
    useWorkbookStore.setState({
      screen: "editor",
      currentHandle: {
        workbookId: "wb",
        path: "/tmp/book.xlsx",
        sourceType: "xlsx",
        snapshotJson: "{}",
      },
      saveStatus: "unsaved",
    });
    render(<Probe />);
    expect(lastTitle()).toBe("Coco — book.xlsx •");
  });

  it("removes the • when status transitions back to 'saved'", () => {
    useWorkbookStore.setState({
      screen: "editor",
      currentHandle: {
        workbookId: "wb",
        path: "/tmp/book.xlsx",
        sourceType: "xlsx",
        snapshotJson: "{}",
      },
      saveStatus: "unsaved",
    });
    render(<Probe />);
    expect(lastTitle()).toBe("Coco — book.xlsx •");
    act(() => useWorkbookStore.setState({ saveStatus: "saved" }));
    expect(lastTitle()).toBe("Coco — book.xlsx");
  });

  it("does NOT append • for in-progress 'saving' state", () => {
    useWorkbookStore.setState({
      screen: "editor",
      currentHandle: {
        workbookId: "wb",
        path: "/tmp/book.xlsx",
        sourceType: "xlsx",
        snapshotJson: "{}",
      },
      saveStatus: "saving",
    });
    render(<Probe />);
    expect(lastTitle()).toBe("Coco — book.xlsx");
  });

  it("reverts to 'Coco' when the user navigates back to home", () => {
    useWorkbookStore.setState({
      screen: "editor",
      currentHandle: {
        workbookId: "wb",
        path: "/tmp/book.xlsx",
        sourceType: "xlsx",
        snapshotJson: "{}",
      },
    });
    render(<Probe />);
    expect(lastTitle()).toBe("Coco — book.xlsx");
    act(() => useWorkbookStore.setState({ screen: "home", currentHandle: null }));
    expect(lastTitle()).toBe("Coco");
  });

  it("does not throw when setTitle rejects (missing permission, etc.)", () => {
    setTitleMock.mockRejectedValueOnce(new Error("denied"));
    expect(() => render(<Probe />)).not.toThrow();
  });
});

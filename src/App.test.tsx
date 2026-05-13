// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { invokeMock, openMock, listenMock, onDragDropEventMock, onCloseRequestedMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
  listenMock: vi.fn(),
  onDragDropEventMock: vi.fn(),
  onCloseRequestedMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock, save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: listenMock,
    onDragDropEvent: onDragDropEventMock,
    onCloseRequested: onCloseRequestedMock,
    setTitle: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.1.0") }));
// Stub the heavy lazy chunk so the test doesn't pull in Univer.
vi.mock("./components/EditorScreen", () => ({
  default: () => <div data-testid="editor-screen-stub">EditorScreen stub</div>,
}));
// useEditorPreload registers requestIdleCallback work that does nothing in tests.
vi.mock("./hooks/useEditorPreload", () => ({ useEditorPreload: () => {} }));

import App from "./App";
import { useWorkbookStore } from "./store/useWorkbookStore";
import { requestHelp, requestSettings } from "./hooks/useGlobalShortcuts";

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
  // Route by command name so list commands return [] (the store stores the
  // response verbatim; a null would break iteration in HomeScreen).
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "workbook_list_recent" || cmd === "workbook_list_recovery") {
      return Promise.resolve([]);
    }
    if (cmd === "get_setting") return Promise.resolve(null);
    return Promise.resolve(null);
  });
  openMock.mockReset();
  listenMock.mockReset();
  onDragDropEventMock.mockReset();
  onCloseRequestedMock.mockReset();
  listenMock.mockResolvedValue(() => undefined);
  onDragDropEventMock.mockResolvedValue(() => undefined);
  onCloseRequestedMock.mockResolvedValue(() => undefined);
  resetStore();
});

afterEach(() => cleanup());

describe("App", () => {
  describe("screen routing", () => {
    it("renders HomeScreen when screen=home", () => {
      render(<App />);
      // HomeScreen contains the 新規ワークブック CTA.
      expect(screen.getByText("新規ワークブック")).toBeTruthy();
      expect(screen.queryByTestId("editor-screen-stub")).toBeNull();
    });

    it("renders EditorScreen (lazy-loaded) when screen=editor", async () => {
      useWorkbookStore.setState({
        screen: "editor",
        currentHandle: {
          workbookId: "wb",
          path: "/tmp/wb.coco",
          sourceType: "coco",
          snapshotJson: "{}",
        },
        currentSnapshotJson: "{}",
      });
      render(<App />);
      // EditorScreen is React.lazy() — wait for the chunk to resolve.
      await waitFor(() => {
        expect(screen.getByTestId("editor-screen-stub")).toBeTruthy();
      });
    });
  });

  describe("dialog emitters", () => {
    it("requestHelp opens HelpDialog", async () => {
      render(<App />);
      requestHelp();
      await waitFor(() => {
        expect(screen.getByText("Coco — ヘルプ")).toBeTruthy();
      });
    });

    it("requestSettings opens SettingsDialog", async () => {
      render(<App />);
      requestSettings();
      await waitFor(() => {
        expect(screen.getByText("自動保存の頻度")).toBeTruthy();
      });
    });

    it("HelpDialog × closes the dialog", async () => {
      render(<App />);
      requestHelp();
      await waitFor(() => screen.getByText("Coco — ヘルプ"));
      // The × header button in HelpDialog has aria-label="閉じる".
      const closers = screen.getAllByLabelText("閉じる");
      fireEvent.click(closers[0]);
      await waitFor(() => {
        expect(screen.queryByText("Coco — ヘルプ")).toBeNull();
      });
    });
  });

  describe("blocking import dialog", () => {
    it("renders SecurityBlockDialog when blockingImport is set", () => {
      useWorkbookStore.setState({
        blockingImport: [
          { severity: "blocking", code: "XLSX_TOO_LARGE", message: "ファイル超過" },
        ],
      });
      render(<App />);
      expect(screen.getByText("ファイルを開けません")).toBeTruthy();
    });
  });

  describe("startup loads", () => {
    it("fires the persisted-state loaders on mount (recent / recovery / settings)", async () => {
      render(<App />);
      await waitFor(() => {
        const cmds = invokeMock.mock.calls.map((c) => c[0]);
        expect(cmds).toContain("workbook_list_recent");
        expect(cmds).toContain("workbook_list_recovery");
        // Settings keys go through get_setting.
        expect(cmds).toContain("get_setting");
      });
    });
  });
});

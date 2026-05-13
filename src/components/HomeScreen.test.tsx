// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
// useEditorPreload schedules requestIdleCallback work that we don't care about
// here. Stub it so the test doesn't leak idle callbacks across cases.
vi.mock("../hooks/useEditorPreload", () => ({ useEditorPreload: () => {} }));

import HomeScreen from "./HomeScreen";
import { useWorkbookStore } from "../store/useWorkbookStore";

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
  invokeMock.mockResolvedValue(undefined);
  openMock.mockReset();
  resetStore();
  // Install a default-true confirm stub so the すべて削除 prompt resolves.
  window.confirm = vi.fn().mockReturnValue(true);
});

afterEach(() => cleanup());

describe("HomeScreen", () => {
  describe("empty state", () => {
    it("renders the empty hint when no recents or recovery candidates exist", () => {
      render(<HomeScreen />);
      expect(screen.getByText("最近使ったファイルはありません")).toBeTruthy();
    });

    it("does not render the 前回のファイルを続ける button when no recents", () => {
      render(<HomeScreen />);
      expect(screen.queryByText("前回のファイルを続ける")).toBeNull();
    });
  });

  describe("primary actions", () => {
    it("clicking 新規ワークブック dispatches workbook_new", async () => {
      const user = userEvent.setup();
      invokeMock.mockResolvedValue({
        workbookId: "wb",
        path: null,
        sourceType: "new",
        snapshotJson: "{}",
      });
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /新規ワークブック/ }));
      expect(invokeMock).toHaveBeenCalledWith("workbook_new");
    });

    it("clicking ファイルを開く + selecting a .xlsx dispatches workbook_import_xlsx", async () => {
      const user = userEvent.setup();
      openMock.mockResolvedValue("/tmp/book.xlsx");
      invokeMock.mockResolvedValue({
        handle: {
          workbookId: "wb",
          path: "/tmp/book.xlsx",
          sourceType: "xlsx",
          snapshotJson: "{}",
        },
        warnings: [],
      });
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /ファイルを開く/ }));
      expect(openMock).toHaveBeenCalledTimes(1);
      const importCall = invokeMock.mock.calls.find((c) => c[0] === "workbook_import_xlsx");
      expect(importCall).toBeTruthy();
      expect(importCall![1]).toEqual({ path: "/tmp/book.xlsx" });
    });

    it("clicking ファイルを開く + selecting a .csv dispatches workbook_import_csv", async () => {
      const user = userEvent.setup();
      openMock.mockResolvedValue("/tmp/data.csv");
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/data.csv", sourceType: "xlsx", snapshotJson: "{}" },
        warnings: [],
      });
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /ファイルを開く/ }));
      const importCall = invokeMock.mock.calls.find((c) => c[0] === "workbook_import_csv");
      expect(importCall).toBeTruthy();
    });

    it("clicking ファイルを開く + selecting a .coco dispatches workbook_open_coco", async () => {
      const user = userEvent.setup();
      openMock.mockResolvedValue("/tmp/wb.coco");
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/wb.coco", sourceType: "coco", snapshotJson: "{}" },
        warnings: [],
      });
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /ファイルを開く/ }));
      const openCall = invokeMock.mock.calls.find((c) => c[0] === "workbook_open_coco");
      expect(openCall).toBeTruthy();
    });

    it("cancelling the open dialog does not invoke any import command", async () => {
      const user = userEvent.setup();
      openMock.mockResolvedValue(null);
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /ファイルを開く/ }));
      const importCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
      );
      expect(importCalls).toHaveLength(0);
    });
  });

  describe("recent files", () => {
    beforeEach(() => {
      useWorkbookStore.setState({
        recentFiles: [
          { path: "/tmp/a.xlsx", name: "a.xlsx", lastOpened: "2026-05-13T10:00:00Z", exists: true },
          { path: "/tmp/b.csv", name: "b.csv", lastOpened: "2026-05-12T10:00:00Z", exists: true },
          { path: "/tmp/c.coco", name: "c.coco", lastOpened: "2026-05-11T10:00:00Z", exists: false },
        ],
      });
    });

    it("renders one entry per recent file with name + path", () => {
      const { container } = render(<HomeScreen />);
      const items = container.querySelectorAll(".recent-list .recent-item");
      expect(items).toHaveLength(3);
      // Paths are unique to the recent list; names also appear in the "continue" button.
      expect(screen.getByText("/tmp/a.xlsx")).toBeTruthy();
      expect(screen.getByText("/tmp/b.csv")).toBeTruthy();
      expect(screen.getByText("/tmp/c.coco")).toBeTruthy();
    });

    it("flags missing files with 見つかりません badge", () => {
      render(<HomeScreen />);
      expect(screen.getByText("見つかりません")).toBeTruthy();
    });

    it("shows 前回のファイルを続ける when the first recent exists", () => {
      render(<HomeScreen />);
      expect(screen.getByText("前回のファイルを続ける")).toBeTruthy();
    });

    it("hides 前回のファイルを続ける when the first recent is missing", () => {
      useWorkbookStore.setState({
        recentFiles: [
          { path: "/tmp/x.xlsx", name: "x.xlsx", lastOpened: "2026-05-13", exists: false },
        ],
      });
      render(<HomeScreen />);
      expect(screen.queryByText("前回のファイルを続ける")).toBeNull();
    });

    it("clicking a .xlsx recent dispatches workbook_import_xlsx", async () => {
      const user = userEvent.setup();
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/a.xlsx", sourceType: "xlsx", snapshotJson: "{}" },
        warnings: [],
      });
      const { container } = render(<HomeScreen />);
      // Path text is unique to the recent-list <li>; click the parent <li>.
      const li = container.querySelector(".recent-list .recent-item")!;
      await user.click(li);
      const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_import_xlsx");
      expect(call?.[1]).toEqual({ path: "/tmp/a.xlsx" });
    });

    it("clicking a .csv recent dispatches workbook_import_csv with the import encoding", async () => {
      const user = userEvent.setup();
      useWorkbookStore.setState({ csvImportEncoding: "shift_jis" });
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/b.csv", sourceType: "xlsx", snapshotJson: "{}" },
        warnings: [],
      });
      const { container } = render(<HomeScreen />);
      // 2nd recent <li> is b.csv.
      const items = container.querySelectorAll(".recent-list .recent-item");
      await user.click(items[1]);
      const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_import_csv");
      expect(call?.[1]).toEqual({ path: "/tmp/b.csv", encoding: "shift_jis" });
    });

    it("clicking a missing recent does not invoke any command", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByText("c.coco"));
      const importCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
      );
      expect(importCalls).toHaveLength(0);
    });

    it("the × remove button calls workbook_remove_recent without opening the file", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      const removeButtons = screen.getAllByLabelText("この項目を削除");
      await user.click(removeButtons[0]);
      expect(invokeMock).toHaveBeenCalledWith("workbook_remove_recent", { path: "/tmp/a.xlsx" });
      // Should not have triggered an open as a side effect (stopPropagation).
      const importCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
      );
      expect(importCalls).toHaveLength(0);
    });

    it("すべて削除 confirms then calls workbook_clear_recent", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByText("すべて削除"));
      expect(window.confirm).toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith("workbook_clear_recent");
    });

    it("すべて削除 skips the call when the user cancels the prompt", async () => {
      window.confirm = vi.fn().mockReturnValue(false);
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByText("すべて削除"));
      expect(invokeMock).not.toHaveBeenCalledWith("workbook_clear_recent");
    });
  });

  describe("recovery candidates", () => {
    beforeEach(() => {
      useWorkbookStore.setState({
        recoveryCandidates: [
          {
            candidateId: "r1",
            originalPath: "/tmp/lost.xlsx",
            savedAt: "2026-05-13T10:00:00Z",
            reason: "auto_save",
          },
          {
            candidateId: "r2",
            originalPath: null,
            savedAt: "2026-05-12T09:00:00Z",
            reason: "manual_save",
          },
        ],
      });
    });

    it("renders the section header and each candidate", () => {
      render(<HomeScreen />);
      expect(screen.getByText("復元候補")).toBeTruthy();
      expect(screen.getByText("/tmp/lost.xlsx")).toBeTruthy();
      expect(screen.getByText("無題のワークブック")).toBeTruthy();
    });

    it("renders the recovery reason in Japanese (auto_save → 自動保存)", () => {
      render(<HomeScreen />);
      // The "·" plus the date are concatenated into the same span.
      expect(screen.getByText(/自動保存/)).toBeTruthy();
      expect(screen.getByText(/手動保存/)).toBeTruthy();
    });

    it("clicking 復元 invokes workbook_restore_backup", async () => {
      const user = userEvent.setup();
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/lost.xlsx", sourceType: "coco", snapshotJson: "{}" },
        warnings: [],
      });
      render(<HomeScreen />);
      const restoreButtons = screen.getAllByText("復元");
      await user.click(restoreButtons[0]);
      const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_restore_backup");
      expect(call?.[1]).toEqual({ candidateId: "r1" });
    });

    it("clicking 破棄 invokes workbook_clear_recovery", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      const dismissButtons = screen.getAllByText("破棄");
      await user.click(dismissButtons[1]);
      const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_clear_recovery");
      expect(call?.[1]).toEqual({ candidateId: "r2" });
    });
  });

  describe("error banner", () => {
    it("renders lastError with a dismiss button", async () => {
      useWorkbookStore.setState({ lastError: "保存に失敗しました" });
      const user = userEvent.setup();
      const { container } = render(<HomeScreen />);
      expect(screen.getByText("保存に失敗しました")).toBeTruthy();
      await user.click(container.querySelector(".home-error__dismiss")!);
      expect(useWorkbookStore.getState().lastError).toBeNull();
    });

    it("renders importWarnings alongside lastError", () => {
      useWorkbookStore.setState({
        lastError: null,
        importWarnings: [
          { severity: "warning", code: "XLSX_FORMULA_UNSUPPORTED", message: "数式が未対応です" },
        ],
      });
      render(<HomeScreen />);
      expect(screen.getByText("数式が未対応です")).toBeTruthy();
    });
  });

  describe("header buttons", () => {
    it("renders help and settings icon buttons", () => {
      render(<HomeScreen />);
      expect(screen.getByLabelText("ヘルプ")).toBeTruthy();
      expect(screen.getByLabelText("設定")).toBeTruthy();
    });
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import SnapshotHistoryDialog from "./SnapshotHistoryDialog";
import { useWorkbookStore } from "../store/useWorkbookStore";

let onClose: ReturnType<typeof vi.fn<() => void>>;

function resetStore() {
  useWorkbookStore.setState({
    screen: "editor",
    currentHandle: {
      workbookId: "wb",
      path: "/tmp/wb.coco",
      sourceType: "coco",
      snapshotJson: "{}",
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
    pinnedPaths: [],
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  // Default for unmatched calls: resolve to []. Specific tests use
  // mockResolvedValueOnce to override per-call ordering. The dialog calls
  // both workbook_list_snapshots and workbook_diagnostic_info on mount, so
  // tests that mock specific responses need to account for both.
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "workbook_diagnostic_info") {
      return Promise.resolve({
        path: "/tmp/wb.coco",
        sizeBytes: 4096,
        snapshotCount: 0,
        schemaVersion: 1,
        lastSavedAt: null,
      });
    }
    return Promise.resolve([]);
  });
  resetStore();
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("SnapshotHistoryDialog", () => {
  describe("rendering", () => {
    it("renders the title and hint while loading", () => {
      // Pending promise → loading state.
      invokeMock.mockReturnValue(new Promise(() => {}));
      render(<SnapshotHistoryDialog onClose={onClose} />);
      expect(screen.getByText("スナップショット履歴")).toBeTruthy();
      expect(screen.getByText("読み込み中...")).toBeTruthy();
    });

    it("renders empty hint when there are no snapshots", async () => {
      invokeMock.mockResolvedValue([]);
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => {
        expect(screen.getByText("スナップショットがありません。")).toBeTruthy();
      });
    });

    it("renders one row per snapshot with reason label and 開くボタン", async () => {
      invokeMock.mockResolvedValue([
        { snapshotId: 3, createdAt: "2026-05-13T10:00:00Z", reason: "manual_save" },
        { snapshotId: 2, createdAt: "2026-05-13T09:00:00Z", reason: "auto_save" },
        { snapshotId: 1, createdAt: "2026-05-12T10:00:00Z", reason: "manual_save" },
      ]);
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => {
        const buttons = screen.getAllByText("このバージョンを開く");
        expect(buttons).toHaveLength(3);
      });
      // Reason translation should be visible.
      expect(screen.getAllByText("手動保存")).toHaveLength(2);
      expect(screen.getByText("自動保存")).toBeTruthy();
      // First row gets the "(最新)" indicator.
      expect(screen.getByText(/最新/)).toBeTruthy();
    });
  });

  describe("interaction", () => {
    it("clicking 'このバージョンを開く' calls workbook_open_snapshot and closes", async () => {
      const user = userEvent.setup();
      invokeMock.mockResolvedValueOnce([
        { snapshotId: 7, createdAt: "2026-05-13T10:00:00Z", reason: "manual_save" },
      ]);
      // The second invocation is workbook_open_snapshot:
      invokeMock.mockResolvedValueOnce({
        handle: { workbookId: "wb", path: "/tmp/wb.coco", sourceType: "coco", snapshotJson: "{}" },
        warnings: [],
      });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("このバージョンを開く"));
      await user.click(screen.getByText("このバージョンを開く"));
      const openCall = invokeMock.mock.calls.find((c) => c[0] === "workbook_open_snapshot");
      expect(openCall?.[1]).toEqual({ path: "/tmp/wb.coco", snapshotId: 7 });
      expect(onClose).toHaveBeenCalled();
    });

    it("Escape closes the dialog", () => {
      render(<SnapshotHistoryDialog onClose={onClose} />);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking × closes the dialog", async () => {
      const user = userEvent.setup();
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("閉じる"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking the backdrop closes the dialog", () => {
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      fireEvent.click(container.querySelector(".snapshot-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking inside the modal body does not close", () => {
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      fireEvent.click(container.querySelector(".snapshot-modal")!);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("unmounting cleans up the keydown listener", () => {
      const { unmount } = render(<SnapshotHistoryDialog onClose={onClose} />);
      unmount();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("keyboard navigation", () => {
    beforeEach(() => {
      invokeMock.mockResolvedValueOnce([
        { snapshotId: 3, createdAt: "2026-05-13T10:00:00Z", reason: "manual_save" },
        { snapshotId: 2, createdAt: "2026-05-13T09:00:00Z", reason: "auto_save" },
        { snapshotId: 1, createdAt: "2026-05-12T10:00:00Z", reason: "manual_save" },
      ]);
    });

    it("first row is selected by default", async () => {
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getAllByText("このバージョンを開く"));
      const selected = container.querySelector(".snapshot-item--selected");
      expect(selected).toBeTruthy();
      expect(selected?.textContent).toContain("最新");
    });

    it("ArrowDown moves selection to the next row", async () => {
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getAllByText("このバージョンを開く"));
      fireEvent.keyDown(window, { key: "ArrowDown" });
      const selected = container.querySelectorAll(".snapshot-item--selected");
      expect(selected.length).toBe(1);
      // Index 1 should now be selected; check it's NOT the first row.
      const items = container.querySelectorAll(".snapshot-item");
      expect(items[1].className).toContain("snapshot-item--selected");
      expect(items[0].className).not.toContain("snapshot-item--selected");
    });

    it("ArrowUp from the first row is a no-op (no underflow)", async () => {
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getAllByText("このバージョンを開く"));
      fireEvent.keyDown(window, { key: "ArrowUp" });
      const items = container.querySelectorAll(".snapshot-item");
      expect(items[0].className).toContain("snapshot-item--selected");
    });

    it("ArrowDown past the last row stays at the last (no overflow)", async () => {
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getAllByText("このバージョンを開く"));
      fireEvent.keyDown(window, { key: "ArrowDown" });
      fireEvent.keyDown(window, { key: "ArrowDown" });
      fireEvent.keyDown(window, { key: "ArrowDown" }); // attempt overflow
      const items = container.querySelectorAll(".snapshot-item");
      expect(items[2].className).toContain("snapshot-item--selected");
    });

    it("Enter opens the currently-selected snapshot", async () => {
      invokeMock.mockResolvedValueOnce({
        handle: { workbookId: "wb", path: "/tmp/wb.coco", sourceType: "coco", snapshotJson: "{}" },
        warnings: [],
      });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getAllByText("このバージョンを開く"));
      // Move selection to index 1 (snapshotId=2) then press Enter.
      fireEvent.keyDown(window, { key: "ArrowDown" });
      fireEvent.keyDown(window, { key: "Enter" });
      await waitFor(() => {
        const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_open_snapshot");
        expect(call?.[1]).toEqual({ path: "/tmp/wb.coco", snapshotId: 2 });
      });
    });

    it("hovering an item updates the selection (mouse follows keyboard)", async () => {
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getAllByText("このバージョンを開く"));
      const items = container.querySelectorAll(".snapshot-item");
      fireEvent.mouseEnter(items[2]);
      expect(items[2].className).toContain("snapshot-item--selected");
    });
  });

  describe("error handling", () => {
    it("renders empty state when listSnapshots rejects (covers connection failure)", async () => {
      invokeMock.mockRejectedValue("File not found: /tmp/wb.coco");
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => {
        expect(screen.getByText("スナップショットがありません。")).toBeTruthy();
      });
    });
  });

  // Helper for vacuum / integrity tests: switch invokeMock to a command-aware
  // dispatcher so test order doesn't depend on the dialog's effect call order.
  function setInvokeRouter(routes: Record<string, unknown>) {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd in routes) {
        const v = routes[cmd];
        if (v && typeof v === "object" && "__reject" in (v as object)) {
          return Promise.reject((v as { __reject: unknown }).__reject);
        }
        return Promise.resolve(v);
      }
      // Default: empty snapshot list, harmless diag info.
      if (cmd === "workbook_list_snapshots") return Promise.resolve([]);
      if (cmd === "workbook_diagnostic_info") {
        return Promise.resolve({
          path: "/tmp/wb.coco",
          sizeBytes: 4096,
          snapshotCount: 0,
          schemaVersion: 1,
          lastSavedAt: null,
        });
      }
      return Promise.resolve(undefined);
    });
  }

  describe("vacuum", () => {
    it("clicking ファイルを最適化 invokes workbook_vacuum and shows the byte savings", async () => {
      const user = userEvent.setup();
      setInvokeRouter({ workbook_vacuum: { beforeBytes: 10240, afterBytes: 6144 } });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("ファイルを最適化"));
      await user.click(screen.getByText("ファイルを最適化"));
      const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_vacuum");
      expect(call?.[1]).toEqual({ path: "/tmp/wb.coco" });
      await waitFor(() => {
        const status = screen.getByText(/解放しました/);
        expect(status.textContent).toContain("4.0 KB");
      });
    });

    it("vacuum on an already-compact file shows the 'already optimized' message", async () => {
      const user = userEvent.setup();
      setInvokeRouter({ workbook_vacuum: { beforeBytes: 4096, afterBytes: 4096 } });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("ファイルを最適化"));
      await user.click(screen.getByText("ファイルを最適化"));
      await waitFor(() => {
        expect(screen.getByText(/既に最適化されています/)).toBeTruthy();
      });
    });

    it("vacuum failure shows the 'optimization failed' message", async () => {
      const user = userEvent.setup();
      setInvokeRouter({ workbook_vacuum: { __reject: "disk full" } });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("ファイルを最適化"));
      await user.click(screen.getByText("ファイルを最適化"));
      await waitFor(() => {
        expect(screen.getByText(/最適化に失敗しました/)).toBeTruthy();
      });
    });
  });

  describe("integrity check", () => {
    it("clicking 整合性チェック invokes workbook_check_integrity and shows OK", async () => {
      const user = userEvent.setup();
      setInvokeRouter({ workbook_check_integrity: { ok: true, issues: [] } });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("整合性チェック"));
      await user.click(screen.getByText("整合性チェック"));
      const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_check_integrity");
      expect(call?.[1]).toEqual({ path: "/tmp/wb.coco" });
      await waitFor(() => {
        expect(screen.getByText(/問題ありません/)).toBeTruthy();
      });
    });

    it("shows the issue list when ok=false", async () => {
      const user = userEvent.setup();
      setInvokeRouter({
        workbook_check_integrity: {
          ok: false,
          issues: ["page 5 corrupt", "missing index", "row size mismatch"],
        },
      });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("整合性チェック"));
      await user.click(screen.getByText("整合性チェック"));
      await waitFor(() => {
        const status = screen.getByText(/問題が検出されました/);
        expect(status.textContent).toContain("page 5 corrupt");
        expect(status.textContent).toContain("missing index");
        // Third issue is folded into "他 1 件".
        expect(status.textContent).toContain("他 1 件");
      });
    });

    it("integrity-check failure shows the failure hint", async () => {
      const user = userEvent.setup();
      setInvokeRouter({ workbook_check_integrity: { __reject: "File not found: /tmp/wb.coco" } });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("整合性チェック"));
      await user.click(screen.getByText("整合性チェック"));
      await waitFor(() => {
        expect(screen.getByText(/整合性チェックに失敗しました/)).toBeTruthy();
      });
    });

    it("vacuum status is cleared when integrity check runs", async () => {
      const user = userEvent.setup();
      setInvokeRouter({
        workbook_vacuum: { beforeBytes: 10000, afterBytes: 5000 },
        workbook_check_integrity: { ok: true, issues: [] },
      });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByText("ファイルを最適化"));
      await user.click(screen.getByText("ファイルを最適化"));
      await waitFor(() => screen.getByText(/解放しました/));
      await user.click(screen.getByText("整合性チェック"));
      await waitFor(() => screen.getByText(/問題ありません/));
      expect(screen.queryByText(/解放しました/)).toBeNull();
    });
  });

  describe("diagnostic info", () => {
    it("renders file size + snapshot count when diagnostic call resolves", async () => {
      setInvokeRouter({
        workbook_diagnostic_info: {
          path: "/tmp/wb.coco",
          sizeBytes: 1_048_576,
          snapshotCount: 3,
          schemaVersion: 1,
          lastSavedAt: "2026-05-13T10:00:00Z",
        },
      });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => {
        const node = screen.getByText(/サイズ:/);
        expect(node.textContent).toContain("1.00 MB");
      });
      expect(screen.getByText(/スナップショット: 3 件/)).toBeTruthy();
      expect(screen.getByText(/スキーマ v1/)).toBeTruthy();
    });

    it("omits the diagnostic line when the command rejects", async () => {
      setInvokeRouter({ workbook_diagnostic_info: { __reject: "broken" } });
      const { container } = render(<SnapshotHistoryDialog onClose={onClose} />);
      // Give the effect a tick to settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(container.querySelector(".snapshot-diag")).toBeNull();
    });

    it("クリップボードにコピーボタンが診断情報を書き込む", async () => {
      const user = userEvent.setup();
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: writeTextMock },
        configurable: true,
      });
      setInvokeRouter({
        workbook_diagnostic_info: {
          path: "/tmp/wb.coco",
          sizeBytes: 2048,
          snapshotCount: 4,
          schemaVersion: 1,
          lastSavedAt: "2026-05-13T10:00:00Z",
        },
      });
      render(<SnapshotHistoryDialog onClose={onClose} />);
      await waitFor(() => screen.getByLabelText("診断情報をコピー"));
      await user.click(screen.getByLabelText("診断情報をコピー"));
      expect(writeTextMock).toHaveBeenCalledTimes(1);
      const payload = writeTextMock.mock.calls[0][0] as string;
      expect(payload).toContain("/tmp/wb.coco");
      expect(payload).toContain("2048");
      expect(payload).toContain("snapshots: 4");
      expect(payload).toContain("v1");
      expect(payload).toContain("2026-05-13T10:00:00Z");
    });
  });
});

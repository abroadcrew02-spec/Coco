// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
    pinnedPaths: [],
    suppressCsvPocWarning: false,
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

    it("renders a kind badge per file (xlsx / csv / coco)", () => {
      const { container } = render(<HomeScreen />);
      // Three recents seeded in beforeEach: a.xlsx, b.csv, c.coco (missing)
      const badges = container.querySelectorAll(".recent-kind");
      expect(badges).toHaveLength(3);
      expect(badges[0].textContent).toBe("xlsx");
      expect(badges[1].textContent).toBe("csv");
      expect(badges[2].textContent).toBe("coco");
    });

    it("flags missing files with 見つかりません badge", () => {
      render(<HomeScreen />);
      expect(screen.getByText("見つかりません")).toBeTruthy();
    });

    it("renders a relative-time label for each existing recent (via .recent-when)", () => {
      const { container } = render(<HomeScreen />);
      // Both a.xlsx and b.csv exist; c.coco is missing and shows the badge instead.
      const whens = container.querySelectorAll(".recent-when");
      expect(whens.length).toBeGreaterThanOrEqual(2);
      // Each label should be non-empty (the exact value depends on system clock).
      whens.forEach((el) => expect(el.textContent?.trim().length).toBeGreaterThan(0));
    });

    describe("inline filter", () => {
      beforeEach(() => {
        // Threshold is 6 — seed enough recents to surface the filter.
        useWorkbookStore.setState({
          recentFiles: [
            { path: "/tmp/budget.xlsx", name: "budget.xlsx", lastOpened: "2026-05-13T10:00:00Z", exists: true },
            { path: "/tmp/sales.xlsx", name: "sales.xlsx", lastOpened: "2026-05-12T10:00:00Z", exists: true },
            { path: "/tmp/forecast.coco", name: "forecast.coco", lastOpened: "2026-05-11T10:00:00Z", exists: true },
            { path: "/tmp/q1.csv", name: "q1.csv", lastOpened: "2026-05-10T10:00:00Z", exists: true },
            { path: "/tmp/q2.csv", name: "q2.csv", lastOpened: "2026-05-09T10:00:00Z", exists: true },
            { path: "/tmp/q3.csv", name: "q3.csv", lastOpened: "2026-05-08T10:00:00Z", exists: true },
            { path: "/tmp/q4.csv", name: "q4.csv", lastOpened: "2026-05-07T10:00:00Z", exists: true },
          ],
        });
      });

      it("renders the filter input when recents reach the threshold (6)", () => {
        render(<HomeScreen />);
        expect(screen.getByLabelText("最近使ったファイルを絞り込む")).toBeTruthy();
      });

      it("filters by name substring", async () => {
        const user = userEvent.setup();
        const { container } = render(<HomeScreen />);
        const input = screen.getByLabelText("最近使ったファイルを絞り込む");
        await user.type(input, "csv");
        const visible = container.querySelectorAll(".recent-list .recent-item");
        // 4 csv entries
        expect(visible).toHaveLength(4);
      });

      it("filters by path substring", async () => {
        const user = userEvent.setup();
        const { container } = render(<HomeScreen />);
        await user.type(screen.getByLabelText("最近使ったファイルを絞り込む"), "/tmp/budget");
        const visible = container.querySelectorAll(".recent-list .recent-item");
        expect(visible).toHaveLength(1);
      });

      it("is case-insensitive", async () => {
        const user = userEvent.setup();
        const { container } = render(<HomeScreen />);
        await user.type(screen.getByLabelText("最近使ったファイルを絞り込む"), "BUDGET");
        const visible = container.querySelectorAll(".recent-list .recent-item");
        expect(visible).toHaveLength(1);
      });

      it("shows an empty-state hint when no match", async () => {
        const user = userEvent.setup();
        render(<HomeScreen />);
        await user.type(screen.getByLabelText("最近使ったファイルを絞り込む"), "no-such-file");
        expect(screen.getByText("該当するファイルがありません")).toBeTruthy();
      });

      it("shows match count when filter has matches", async () => {
        const user = userEvent.setup();
        render(<HomeScreen />);
        await user.type(screen.getByLabelText("最近使ったファイルを絞り込む"), "csv");
        expect(screen.getByText("4 / 7 件一致")).toBeTruthy();
      });

      it("does not show match count when no filter is active", () => {
        const { container } = render(<HomeScreen />);
        expect(container.querySelector(".recent-filter-count")).toBeNull();
      });

      it("clearing the input restores the full list", async () => {
        const user = userEvent.setup();
        const { container } = render(<HomeScreen />);
        const input = screen.getByLabelText("最近使ったファイルを絞り込む");
        await user.type(input, "csv");
        await user.clear(input);
        const visible = container.querySelectorAll(".recent-list .recent-item");
        expect(visible).toHaveLength(7);
      });

      it("Ctrl+F focuses the filter input", () => {
        render(<HomeScreen />);
        const input = screen.getByLabelText("最近使ったファイルを絞り込む") as HTMLInputElement;
        // Make sure we start from a known not-focused state.
        (document.activeElement as HTMLElement | null)?.blur?.();
        expect(document.activeElement).not.toBe(input);
        fireEvent.keyDown(window, { key: "f", ctrlKey: true });
        expect(document.activeElement).toBe(input);
      });

      it("Cmd+F also focuses the filter (macOS)", () => {
        render(<HomeScreen />);
        const input = screen.getByLabelText("最近使ったファイルを絞り込む") as HTMLInputElement;
        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: "f", metaKey: true });
        expect(document.activeElement).toBe(input);
      });

      it("Escape inside the filter clears the query", () => {
        render(<HomeScreen />);
        const input = screen.getByLabelText("最近使ったファイルを絞り込む") as HTMLInputElement;
        // Use fireEvent.change so the controlled value lands synchronously.
        fireEvent.change(input, { target: { value: "budget" } });
        expect(input.value).toBe("budget");
        fireEvent.keyDown(input, { key: "Escape" });
        expect(input.value).toBe("");
      });
    });

    describe("keyboard navigation", () => {
      it("ArrowDown moves focus to the first row, then second", () => {
        const { container } = render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        const items = container.querySelectorAll(".recent-list .recent-item");
        expect(items[0].className).toContain("recent-item--focused");
        fireEvent.keyDown(window, { key: "ArrowDown" });
        expect(items[1].className).toContain("recent-item--focused");
        expect(items[0].className).not.toContain("recent-item--focused");
      });

      it("ArrowUp from the first row stays at row 0 (no underflow)", () => {
        const { container } = render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "ArrowUp" });
        const items = container.querySelectorAll(".recent-list .recent-item");
        expect(items[0].className).toContain("recent-item--focused");
      });

      it("Enter on a focused row opens that file", async () => {
        invokeMock.mockResolvedValue({
          handle: { workbookId: "wb", path: "/tmp/a.xlsx", sourceType: "xlsx", snapshotJson: "{}" },
          warnings: [],
        });
        render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "Enter" });
        // a.xlsx is row 0.
        const call = invokeMock.mock.calls.find((c) => c[0] === "workbook_import_xlsx");
        expect(call?.[1]).toEqual({ path: "/tmp/a.xlsx" });
      });

      it("Delete on a focused row removes that recent without opening it", () => {
        // a.xlsx is the first row, c.coco the third (missing).
        const { container } = render(<HomeScreen />);
        // Move focus to row 1 (b.csv).
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "Delete" });
        expect(invokeMock).toHaveBeenCalledWith("workbook_remove_recent", {
          path: "/tmp/b.csv",
        });
        // Should not have triggered an open.
        const opens = invokeMock.mock.calls.filter((c) =>
          [
            "workbook_import_xlsx",
            "workbook_import_csv",
            "workbook_open_coco",
          ].includes(c[0] as string)
        );
        expect(opens).toHaveLength(0);
        // Sanity: nothing thrown.
        expect(container).toBeTruthy();
      });

      it("Backspace works the same as Delete", () => {
        render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "Backspace" });
        expect(invokeMock).toHaveBeenCalledWith("workbook_remove_recent", {
          path: "/tmp/a.xlsx",
        });
      });

      it("Escape clears the row focus", () => {
        const { container } = render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        const items = container.querySelectorAll(".recent-list .recent-item");
        expect(items[0].className).toContain("recent-item--focused");
        fireEvent.keyDown(window, { key: "Escape" });
        expect(container.querySelector(".recent-item--focused")).toBeNull();
      });

      it("Arrow keys are ignored when focus is inside an input (filter caret behavior)", () => {
        useWorkbookStore.setState({
          recentFiles: [
            { path: "/tmp/a.xlsx", name: "a.xlsx", lastOpened: "2026-05-13T10:00:00Z", exists: true },
            { path: "/tmp/b.csv", name: "b.csv", lastOpened: "2026-05-12T10:00:00Z", exists: true },
            { path: "/tmp/c.xlsx", name: "c.xlsx", lastOpened: "2026-05-11T10:00:00Z", exists: true },
            { path: "/tmp/d.xlsx", name: "d.xlsx", lastOpened: "2026-05-10T10:00:00Z", exists: true },
            { path: "/tmp/e.xlsx", name: "e.xlsx", lastOpened: "2026-05-09T10:00:00Z", exists: true },
            { path: "/tmp/f.xlsx", name: "f.xlsx", lastOpened: "2026-05-08T10:00:00Z", exists: true },
          ],
        });
        const { container } = render(<HomeScreen />);
        const input = screen.getByLabelText("最近使ったファイルを絞り込む");
        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(container.querySelector(".recent-item--focused")).toBeNull();
      });
    });

    it("does not render the filter input below the threshold", () => {
      // Default beforeEach above seeds 3 recents — below the threshold (6).
      render(<HomeScreen />);
      expect(screen.queryByLabelText("最近使ったファイルを絞り込む")).toBeNull();
    });

    it("does not crash on an unparseable lastOpened value (defensive)", () => {
      useWorkbookStore.setState({
        recentFiles: [
          { path: "/tmp/odd.xlsx", name: "odd.xlsx", lastOpened: "not-a-date", exists: true },
        ],
      });
      expect(() => render(<HomeScreen />)).not.toThrow();
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

    it("clicking ファイルの場所を開く invokes reveal_in_file_manager without opening the file", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      const reveal = screen.getAllByLabelText("ファイルの場所を開く")[0];
      await user.click(reveal);
      expect(invokeMock).toHaveBeenCalledWith("reveal_in_file_manager", { path: "/tmp/a.xlsx" });
      const importCalls = invokeMock.mock.calls.filter((c) =>
        ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
      );
      expect(importCalls).toHaveLength(0);
    });

    describe("pin/unpin", () => {
      it("renders a pin button for each recent", () => {
        render(<HomeScreen />);
        const pins = screen.getAllByLabelText(/ピン留め/);
        expect(pins.length).toBeGreaterThanOrEqual(3);
      });

      it("clicking pin invokes set_setting with the path added", async () => {
        const user = userEvent.setup();
        render(<HomeScreen />);
        // First entry is a.xlsx.
        const firstPin = screen.getAllByLabelText("ピン留めする")[0];
        await user.click(firstPin);
        const setCalls = invokeMock.mock.calls.filter(
          (c) => c[0] === "set_setting" && (c[1] as { key: string }).key === "recents.pinned_paths"
        );
        expect(setCalls).toHaveLength(1);
        expect(JSON.parse((setCalls[0][1] as { value: string }).value)).toContain("/tmp/a.xlsx");
      });

      it("pinned items appear before unpinned ones in the list", () => {
        // /tmp/c.coco is the last (and missing) entry; pinning it should move it to top.
        useWorkbookStore.setState({ pinnedPaths: ["/tmp/c.coco"] });
        const { container } = render(<HomeScreen />);
        const items = Array.from(container.querySelectorAll(".recent-list .recent-item"));
        // First item should now be c.coco.
        expect(items[0].textContent).toContain("c.coco");
      });

      it("renders a section separator between pinned and unpinned recents", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx"], // first item is pinned, others are not
        });
        const { container } = render(<HomeScreen />);
        const separator = container.querySelector(".recent-separator");
        expect(separator).toBeTruthy();
        expect(separator?.textContent).toBe("最近開いたファイル");
      });

      it("omits the separator when there are no pinned items", () => {
        // pinnedPaths empty by default in beforeEach.
        const { container } = render(<HomeScreen />);
        expect(container.querySelector(".recent-separator")).toBeNull();
      });

      it("omits the separator when every recent is pinned", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv", "/tmp/c.coco"],
        });
        const { container } = render(<HomeScreen />);
        expect(container.querySelector(".recent-separator")).toBeNull();
      });

      it("pinned items render the 📌 indicator next to the name", () => {
        useWorkbookStore.setState({ pinnedPaths: ["/tmp/a.xlsx"] });
        const { container } = render(<HomeScreen />);
        const indicator = container.querySelector(".recent-pin-indicator");
        expect(indicator).toBeTruthy();
        expect(indicator?.textContent).toBe("📌");
      });

      it("clicking the recent item does not toggle the pin (stopPropagation on pin button)", async () => {
        const user = userEvent.setup();
        invokeMock.mockResolvedValue({
          handle: { workbookId: "wb", path: "/tmp/a.xlsx", sourceType: "xlsx", snapshotJson: "{}" },
          warnings: [],
        });
        render(<HomeScreen />);
        const pin = screen.getAllByLabelText("ピン留めする")[0];
        await user.click(pin);
        // Pin click should NOT have triggered an open as a side effect.
        const importCalls = invokeMock.mock.calls.filter((c) =>
          ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(c[0] as string)
        );
        expect(importCalls).toHaveLength(0);
      });
    });

    it("the reveal button is disabled for missing files", () => {
      render(<HomeScreen />);
      const reveals = screen.getAllByLabelText("ファイルの場所を開く") as HTMLButtonElement[];
      // 3rd item is c.coco with exists=false.
      expect(reveals[2].disabled).toBe(true);
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

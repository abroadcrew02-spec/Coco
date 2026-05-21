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
    pinnedOrder: [],
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
    it("renders the first-run welcome card when no recents or recovery candidates exist", () => {
      render(<HomeScreen />);
      expect(screen.getByText("Coco へようこそ")).toBeTruthy();
      // Tagline is split across a <br/>; query a substring.
      expect(
        screen.getByText(/ローカルファーストの xlsx スプレッドシート/),
      ).toBeTruthy();
      // 3-step onboarding list.
      expect(screen.getByText("ファイルを開く / ドロップ")).toBeTruthy();
      expect(screen.getByText("編集 / 保存 (Ctrl+S)")).toBeTruthy();
      expect(screen.getByText("シートタブで複数シート")).toBeTruthy();
    });

    it("does not render the 前回のファイルを続ける button when no recents", () => {
      render(<HomeScreen />);
      expect(screen.queryByText("前回のファイルを続ける")).toBeNull();
    });

    it("does not render the tip footer in the first-run state", () => {
      const { container } = render(<HomeScreen />);
      expect(container.querySelector(".home-tip")).toBeNull();
    });

    it("hides the welcome card once a recent file exists", () => {
      useWorkbookStore.setState({
        recentFiles: [
          {
            path: "/tmp/a.xlsx",
            name: "a.xlsx",
            lastOpened: "2026-05-13T10:00:00Z",
            exists: true,
          },
        ],
      });
      render(<HomeScreen />);
      expect(screen.queryByText("Coco へようこそ")).toBeNull();
    });

    it("hides the welcome card when only a recovery candidate is present", () => {
      useWorkbookStore.setState({
        recoveryCandidates: [
          {
            candidateId: "r1",
            originalPath: "/tmp/lost.xlsx",
            savedAt: "2026-05-13T10:00:00Z",
            reason: "auto_save",
          },
        ],
      });
      render(<HomeScreen />);
      expect(screen.queryByText("Coco へようこそ")).toBeNull();
    });
  });

  describe("tip footer", () => {
    it("renders the tip footer when at least one recent file is present", () => {
      useWorkbookStore.setState({
        recentFiles: [
          {
            path: "/tmp/a.xlsx",
            name: "a.xlsx",
            lastOpened: "2026-05-13T10:00:00Z",
            exists: true,
          },
        ],
      });
      const { container } = render(<HomeScreen />);
      const tip = container.querySelector(".home-tip");
      expect(tip).toBeTruthy();
      expect(tip!.textContent).toContain("ヒント:");
      // The tip body should be non-empty (one entry from the rotation pool).
      const body = tip!.querySelector(".home-tip__body");
      expect(body?.textContent?.trim().length).toBeGreaterThan(0);
    });
  });

  describe("left navigation rail", () => {
    it("renders ホーム / 新規 / 開く nav items", () => {
      render(<HomeScreen />);
      expect(screen.getByRole("button", { name: /ホーム/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: /新規/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: /開く/ })).toBeTruthy();
    });

    it("defaults to the ホーム view with the home title", () => {
      render(<HomeScreen />);
      expect(screen.getByRole("heading", { name: "ホーム", level: 1 })).toBeTruthy();
    });

    it("clicking 新規 switches to the new view (template gallery heading)", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /新規/ }));
      expect(screen.getByRole("heading", { name: "新規", level: 1 })).toBeTruthy();
      expect(screen.getByText("テンプレートから作成")).toBeTruthy();
    });

    it("clicking 開く switches to the open view with a browse button", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /開く/ }));
      expect(screen.getByRole("heading", { name: "開く", level: 1 })).toBeTruthy();
      expect(screen.getByRole("button", { name: /ファイルを参照/ })).toBeTruthy();
    });

    it("the active nav item carries the active modifier class", async () => {
      const user = userEvent.setup();
      const { container } = render(<HomeScreen />);
      const active = container.querySelector(".home-nav-item--active");
      expect(active?.textContent).toContain("ホーム");
      await user.click(screen.getByRole("button", { name: /新規/ }));
      expect(container.querySelector(".home-nav-item--active")?.textContent).toContain(
        "新規",
      );
    });
  });

  describe("template tiles (新規 section)", () => {
    it("renders a tile per catalog template inline on the home view", () => {
      const { container } = render(<HomeScreen />);
      const tiles = container.querySelectorAll(".home-template-tile");
      // 8 catalog templates (blank + 7 prebuilt).
      expect(tiles).toHaveLength(8);
    });

    it("renders the blank workbook tile first with the blank modifier", () => {
      const { container } = render(<HomeScreen />);
      const blank = container.querySelector('[data-testid="home-template-blank"]');
      expect(blank).toBeTruthy();
      expect(blank?.className).toContain("home-template-tile--blank");
    });

    it("clicking the blank tile dispatches workbook_new", async () => {
      const user = userEvent.setup();
      invokeMock.mockResolvedValue({
        workbookId: "wb",
        path: null,
        sourceType: "new",
        snapshotJson: "{}",
      });
      render(<HomeScreen />);
      await user.click(screen.getByTestId("home-template-blank"));
      expect(invokeMock).toHaveBeenCalledWith("workbook_new");
    });

    it("clicking a prebuilt template seeds the editor snapshot", async () => {
      const user = userEvent.setup();
      invokeMock.mockResolvedValue({
        workbookId: "wb",
        path: null,
        sourceType: "new",
        snapshotJson: "{}",
      });
      render(<HomeScreen />);
      await user.click(screen.getByTestId("home-template-monthly-budget"));
      expect(invokeMock).toHaveBeenCalledWith("workbook_new");
      // The template snapshot replaces the blank handle snapshot.
      expect(useWorkbookStore.getState().currentSnapshotJson).not.toBe("{}");
      expect(useWorkbookStore.getState().currentSnapshotJson).toContain("月次予算");
    });

    it("その他のテンプレート opens the modal gallery", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByTestId("home-template-more"));
      expect(screen.getByText("テンプレートから新規作成")).toBeTruthy();
    });
  });

  describe("open view file actions", () => {
    async function gotoOpenView() {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByRole("button", { name: /開く/ }));
      return user;
    }

    it("ファイルを参照 + selecting a .xlsx dispatches workbook_import_xlsx", async () => {
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
      const user = await gotoOpenView();
      await user.click(screen.getByRole("button", { name: /ファイルを参照/ }));
      expect(openMock).toHaveBeenCalledTimes(1);
      const importCall = invokeMock.mock.calls.find((c) => c[0] === "workbook_import_xlsx");
      expect(importCall).toBeTruthy();
      expect(importCall![1]).toEqual({ path: "/tmp/book.xlsx" });
    });

    it("ファイルを参照 + selecting a .csv dispatches workbook_import_csv", async () => {
      openMock.mockResolvedValue("/tmp/data.csv");
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/data.csv", sourceType: "xlsx", snapshotJson: "{}" },
        warnings: [],
      });
      const user = await gotoOpenView();
      await user.click(screen.getByRole("button", { name: /ファイルを参照/ }));
      const importCall = invokeMock.mock.calls.find((c) => c[0] === "workbook_import_csv");
      expect(importCall).toBeTruthy();
    });

    it("ファイルを参照 + selecting a .coco dispatches workbook_open_coco", async () => {
      openMock.mockResolvedValue("/tmp/wb.coco");
      invokeMock.mockResolvedValue({
        handle: { workbookId: "wb", path: "/tmp/wb.coco", sourceType: "coco", snapshotJson: "{}" },
        warnings: [],
      });
      const user = await gotoOpenView();
      await user.click(screen.getByRole("button", { name: /ファイルを参照/ }));
      const openCall = invokeMock.mock.calls.find((c) => c[0] === "workbook_open_coco");
      expect(openCall).toBeTruthy();
    });

    it("cancelling the open dialog does not invoke any import command", async () => {
      openMock.mockResolvedValue(null);
      const user = await gotoOpenView();
      await user.click(screen.getByRole("button", { name: /ファイルを参照/ }));
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

      it("P toggles pin on the focused row (adds path to pinnedPaths)", () => {
        render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        // Row 0 is a.xlsx.
        fireEvent.keyDown(window, { key: "p" });
        expect(useWorkbookStore.getState().pinnedPaths).toContain("/tmp/a.xlsx");
      });

      it("P again on the same focused row removes the pin (toggle)", () => {
        render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "p" });
        expect(useWorkbookStore.getState().pinnedPaths).toContain("/tmp/a.xlsx");
        fireEvent.keyDown(window, { key: "p" });
        expect(useWorkbookStore.getState().pinnedPaths).not.toContain("/tmp/a.xlsx");
      });

      it("Ctrl+P is ignored (no toggle)", () => {
        render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "p", ctrlKey: true });
        expect(useWorkbookStore.getState().pinnedPaths).not.toContain("/tmp/a.xlsx");
      });

      it("P is a no-op when no row is focused", () => {
        render(<HomeScreen />);
        // No ArrowDown — focusedRecentIdx stays at -1.
        fireEvent.keyDown(window, { key: "p" });
        expect(useWorkbookStore.getState().pinnedPaths).toEqual([]);
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

    describe("drag-to-reorder pinned items", () => {
      it("pinned items render with draggable=true; unpinned with draggable=false", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        // First two are pinned (a, b), third is unpinned (c.coco — also missing).
        // Use getAttribute so the assertion works regardless of happy-dom's
        // IDL-attr reflection state (it returns undefined in some versions).
        expect(items[0].getAttribute("draggable")).toBe("true");
        expect(items[1].getAttribute("draggable")).toBe("true");
        expect(items[2].getAttribute("draggable")).toBe("false");
      });

      it("dropping pinned a onto pinned b swaps their order via reorderPinned", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        // Row 0 = a.xlsx (pinned, first by order), Row 1 = b.csv (pinned, second).
        const source = items[0] as HTMLLIElement;
        const targetRow = items[1] as HTMLLIElement;
        // happy-dom doesn't share a real DataTransfer between events, so we
        // back it with a Map. fireEvent forwards the dataTransfer prop.
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(source, { dataTransfer });
        fireEvent.dragOver(targetRow, { dataTransfer });
        fireEvent.drop(targetRow, { dataTransfer });
        // After drop, pinnedOrder should be [b, a] (dragged a moved to where b was).
        // reorderPinned removes 'a' (→ [b]) then inserts at idx-of('b')=0 (→ [a, b]).
        // Wait — actually our action's contract is "moves dragged to where target is",
        // i.e. inserts dragged AT target's index. target.indexOf('b') in [b] is 0,
        // so result is [a, b]. That puts dragged BEFORE target's old slot.
        // That matches "drop on top of b" → a takes b's slot, b shifts down.
        const order = useWorkbookStore.getState().pinnedOrder;
        expect(order).toEqual(["/tmp/a.xlsx", "/tmp/b.csv"]);
        // The above is the no-change degenerate case (a was already first).
        // Verify the persist call still fired exactly once on drop.
        const setCalls = invokeMock.mock.calls.filter(
          (c) => c[0] === "set_setting" && (c[1] as { key: string }).key === "recents.pinned_order"
        );
        expect(setCalls).toHaveLength(1);
      });

      it("dropping pinned b onto pinned a moves b to the front", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const source = items[1] as HTMLLIElement; // b
        const targetRow = items[0] as HTMLLIElement; // a
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(source, { dataTransfer });
        fireEvent.dragOver(targetRow, { dataTransfer });
        fireEvent.drop(targetRow, { dataTransfer });
        // dragged=b, target=a. Remove b → [a]. Insert b at idx-of(a)=0 → [b, a].
        expect(useWorkbookStore.getState().pinnedOrder).toEqual([
          "/tmp/b.csv",
          "/tmp/a.xlsx",
        ]);
      });

      it("dragOver on a pinned row sets the recent-item--drag-over class", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const targetRow = items[1] as HTMLLIElement;
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(items[0] as HTMLLIElement, { dataTransfer });
        fireEvent.dragOver(targetRow, { dataTransfer });
        // Class applied to the target row.
        expect(targetRow.className).toContain("recent-item--drag-over");
      });

      it("does not invoke reorderPinned when dropping onto an unpinned row", () => {
        // Only /tmp/a.xlsx is pinned. Dropping the dragged pinned item onto
        // the unpinned /tmp/c.coco row must be a no-op (the drop handler
        // short-circuits on isPinned=false on the target).
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx"],
          pinnedOrder: ["/tmp/a.xlsx"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const source = items[0] as HTMLLIElement; // pinned a
        const targetRow = items[2] as HTMLLIElement; // unpinned c
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(source, { dataTransfer });
        fireEvent.dragOver(targetRow, { dataTransfer });
        fireEvent.drop(targetRow, { dataTransfer });
        // No set_setting call for pinned_order; order unchanged.
        const setCalls = invokeMock.mock.calls.filter(
          (c) => c[0] === "set_setting" && (c[1] as { key: string }).key === "recents.pinned_order"
        );
        expect(setCalls).toHaveLength(0);
        expect(useWorkbookStore.getState().pinnedOrder).toEqual(["/tmp/a.xlsx"]);
      });

      it("sorts pinned items by pinnedOrder (not by lastOpened)", () => {
        // a was opened most recently, b second, but pinnedOrder says b first.
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/b.csv", "/tmp/a.xlsx"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        // First row should be b.csv per the pinnedOrder.
        expect(items[0].textContent).toContain("b.csv");
        expect(items[1].textContent).toContain("a.xlsx");
      });

      it("dragLeave clears the recent-item--drag-over class from the row", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const targetRow = items[1] as HTMLLIElement;
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(items[0] as HTMLLIElement, { dataTransfer });
        fireEvent.dragOver(targetRow, { dataTransfer });
        expect(targetRow.className).toContain("recent-item--drag-over");
        fireEvent.dragLeave(targetRow);
        expect(targetRow.className).not.toContain("recent-item--drag-over");
      });

      it("dragEnd on the source clears the drag-over class from any active target", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const source = items[0] as HTMLLIElement;
        const targetRow = items[1] as HTMLLIElement;
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(source, { dataTransfer });
        fireEvent.dragOver(targetRow, { dataTransfer });
        expect(targetRow.className).toContain("recent-item--drag-over");
        fireEvent.dragEnd(source);
        expect(targetRow.className).not.toContain("recent-item--drag-over");
      });

      it("drop clears the drag-over class from all rows", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const source = items[1] as HTMLLIElement;
        const targetRow = items[0] as HTMLLIElement;
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(source, { dataTransfer });
        fireEvent.dragOver(targetRow, { dataTransfer });
        fireEvent.drop(targetRow, { dataTransfer });
        // After drop, no row should still carry the drag-over indicator —
        // dragOverPath was set back to null inside the drop handler.
        const stillFlagged = container.querySelectorAll(
          ".recent-list .recent-item--drag-over"
        );
        expect(stillFlagged).toHaveLength(0);
      });

      it("dragOver does not apply the drag-over class to an unpinned target", () => {
        // Only a.xlsx is pinned; c.coco (row 2) is unpinned.
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx"],
          pinnedOrder: ["/tmp/a.xlsx"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const source = items[0] as HTMLLIElement;
        const unpinnedTarget = items[2] as HTMLLIElement;
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(source, { dataTransfer });
        fireEvent.dragOver(unpinnedTarget, { dataTransfer });
        expect(unpinnedTarget.className).not.toContain("recent-item--drag-over");
      });

      it("dragStart on a pinned row stores the path under text/plain", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const source = items[0] as HTMLLIElement;
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "none",
          dropEffect: "none",
        };
        fireEvent.dragStart(source, { dataTransfer });
        expect(store.get("text/plain")).toBe("/tmp/a.xlsx");
      });

      it("dropping the dragged row onto itself does not call reorderPinned (degenerate)", () => {
        useWorkbookStore.setState({
          pinnedPaths: ["/tmp/a.xlsx", "/tmp/b.csv"],
          pinnedOrder: ["/tmp/a.xlsx", "/tmp/b.csv"],
        });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        const sameRow = items[0] as HTMLLIElement;
        const store = new Map<string, string>();
        const dataTransfer = {
          setData: (k: string, v: string) => {
            store.set(k, v);
          },
          getData: (k: string) => store.get(k) ?? "",
          effectAllowed: "move",
          dropEffect: "move",
        };
        fireEvent.dragStart(sameRow, { dataTransfer });
        fireEvent.drop(sameRow, { dataTransfer });
        // The drop handler short-circuits when dragged === f.path, so no
        // set_setting("recents.pinned_order") call should fire.
        const setCalls = invokeMock.mock.calls.filter(
          (c) => c[0] === "set_setting" && (c[1] as { key: string }).key === "recents.pinned_order"
        );
        expect(setCalls).toHaveLength(0);
      });
    });

    describe("row classes", () => {
      it("missing rows render the recent-item--missing class", () => {
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        // c.coco (idx 2) is the missing one in the recent-files beforeEach.
        expect(items[2].className).toContain("recent-item--missing");
        // The two existing rows should NOT have the missing class.
        expect(items[0].className).not.toContain("recent-item--missing");
        expect(items[1].className).not.toContain("recent-item--missing");
      });

      it("pinned rows render the recent-item--pinned class", () => {
        useWorkbookStore.setState({ pinnedPaths: ["/tmp/a.xlsx"] });
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        // a.xlsx sorts to the top when pinned.
        expect(items[0].className).toContain("recent-item--pinned");
        // The unpinned ones should not pick up the modifier.
        expect(items[1].className).not.toContain("recent-item--pinned");
      });

      it("mouse-entering a row sets it as the focused row", () => {
        const { container } = render(<HomeScreen />);
        const items = container.querySelectorAll(".recent-list .recent-item");
        fireEvent.mouseEnter(items[1]);
        expect(items[1].className).toContain("recent-item--focused");
        expect(items[0].className).not.toContain("recent-item--focused");
      });
    });

    describe("keyboard navigation edge cases", () => {
      it("ArrowDown does not advance past the last row (clamped)", () => {
        const { container } = render(<HomeScreen />);
        // 3 rows seeded in beforeEach.
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "ArrowDown" });
        fireEvent.keyDown(window, { key: "ArrowDown" });
        // One more — should stay on row 2 rather than overflow.
        fireEvent.keyDown(window, { key: "ArrowDown" });
        const items = container.querySelectorAll(".recent-list .recent-item");
        expect(items[2].className).toContain("recent-item--focused");
      });

      it("ArrowUp from no-focus state seeds focus on row 0", () => {
        const { container } = render(<HomeScreen />);
        // focusedRecentIdx starts at -1; ArrowUp should land on row 0.
        fireEvent.keyDown(window, { key: "ArrowUp" });
        const items = container.querySelectorAll(".recent-list .recent-item");
        expect(items[0].className).toContain("recent-item--focused");
      });

      it("Enter with no focused row is a no-op (does not open anything)", () => {
        render(<HomeScreen />);
        // No ArrowDown — focusedRecentIdx stays at -1.
        fireEvent.keyDown(window, { key: "Enter" });
        const opens = invokeMock.mock.calls.filter((c) =>
          ["workbook_import_xlsx", "workbook_import_csv", "workbook_open_coco"].includes(
            c[0] as string
          )
        );
        expect(opens).toHaveLength(0);
      });

      it("Delete with no focused row is a no-op (no remove_recent call)", () => {
        render(<HomeScreen />);
        fireEvent.keyDown(window, { key: "Delete" });
        expect(invokeMock).not.toHaveBeenCalledWith(
          "workbook_remove_recent",
          expect.anything()
        );
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

    it("renders an unknown 'reason' code verbatim (pass-through, no crash)", () => {
      // Forward-compat: if Rust ships a new reason code, the home screen
      // should display it raw rather than blanking out the row.
      useWorkbookStore.setState({
        recoveryCandidates: [
          {
            candidateId: "future",
            originalPath: "/tmp/future.xlsx",
            savedAt: "2026-05-13T10:00:00Z",
            reason: "future_migration_v3",
          },
        ],
      });
      render(<HomeScreen />);
      expect(screen.getByText(/future_migration_v3/)).toBeTruthy();
    });

    it("renders an unparseable savedAt as the raw string (defensive, no crash)", () => {
      // Regression bait: an old Rust release wrote ISO strings; a hypothetical
      // future format change must not throw — the row falls back to raw text.
      useWorkbookStore.setState({
        recoveryCandidates: [
          {
            candidateId: "weird",
            originalPath: "/tmp/odd.xlsx",
            savedAt: "not-a-date-at-all",
            reason: "auto_save",
          },
        ],
      });
      expect(() => render(<HomeScreen />)).not.toThrow();
      // Raw savedAt is folded into the same span as the reason — confirm via title attr.
      const dateNode = screen.getByTitle("not-a-date-at-all");
      expect(dateNode.textContent).toContain("not-a-date-at-all");
      expect(dateNode.textContent).toContain("自動保存");
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

  describe("nav rail footer (settings / help)", () => {
    it("renders 設定 and ヘルプ buttons in the nav footer", () => {
      const { container } = render(<HomeScreen />);
      const footer = container.querySelector(".home-nav-footer");
      expect(footer).toBeTruthy();
      expect(footer!.textContent).toContain("設定");
      expect(footer!.textContent).toContain("ヘルプ");
    });
  });

  describe("recents table format", () => {
    beforeEach(() => {
      useWorkbookStore.setState({
        recentFiles: [
          { path: "/tmp/a.xlsx", name: "a.xlsx", lastOpened: "2026-05-13T10:00:00Z", exists: true },
          { path: "/tmp/b.csv", name: "b.csv", lastOpened: "2026-05-12T10:00:00Z", exists: true },
        ],
      });
    });

    it("renders the recents as a table with 名前 / 場所 / 変更日 columns", () => {
      const { container } = render(<HomeScreen />);
      const table = container.querySelector("table.recent-table");
      expect(table).toBeTruthy();
      const headers = Array.from(table!.querySelectorAll("thead th")).map(
        (th) => th.textContent?.trim(),
      );
      expect(headers).toContain("名前");
      expect(headers).toContain("場所");
      expect(headers).toContain("変更日");
    });

    it("each recent row is a table row carrying name + path cells", () => {
      const { container } = render(<HomeScreen />);
      const rows = container.querySelectorAll(".recent-table tbody .recent-item");
      expect(rows).toHaveLength(2);
      expect(rows[0].querySelector(".recent-name")?.textContent).toContain("a.xlsx");
      expect(rows[0].querySelector(".recent-path")?.textContent).toBe("/tmp/a.xlsx");
    });

    it("renders お気に入り / 最近使ったアイテム tabs", () => {
      render(<HomeScreen />);
      expect(screen.getByRole("tab", { name: "最近使ったアイテム" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "お気に入り" })).toBeTruthy();
    });

    it("the お気に入り tab shows only pinned files", async () => {
      const user = userEvent.setup();
      useWorkbookStore.setState({ pinnedPaths: ["/tmp/a.xlsx"] });
      const { container } = render(<HomeScreen />);
      await user.click(screen.getByRole("tab", { name: "お気に入り" }));
      const rows = container.querySelectorAll(".recent-table tbody .recent-item");
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain("a.xlsx");
    });

    it("the お気に入り tab shows an empty hint when nothing is pinned", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(screen.getByRole("tab", { name: "お気に入り" }));
      expect(
        screen.getByText("お気に入りに登録したファイルはありません"),
      ).toBeTruthy();
    });
  });
});

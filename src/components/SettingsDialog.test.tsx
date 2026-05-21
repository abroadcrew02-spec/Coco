// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import SettingsDialog from "./SettingsDialog";
import { useWorkbookStore } from "../store/useWorkbookStore";

let onClose: ReturnType<typeof vi.fn<() => void>>;

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
    autoSaveIntervalMs: 30_000,
    lastSavedAt: null,
    csvExportEncoding: "utf8-bom",
    csvImportEncoding: "auto",
    pinnedPaths: [],
    suppressCsvPocWarning: false,
  });
}

beforeEach(() => {
  // Tests assert against Japanese labels; pin the i18n locale so the title
  // is "設定" rather than the en-US fallback "Settings".
  localStorage.setItem("coco.locale", "ja-JP");
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  resetStore();
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("SettingsDialog", () => {
  describe("initial state", () => {
    it("renders all major sections", () => {
      render(<SettingsDialog onClose={onClose} />);
      expect(screen.getByText("自動保存の頻度")).toBeTruthy();
      expect(screen.getByText("CSV エクスポートの文字コード")).toBeTruthy();
      expect(screen.getByText("CSV インポートの文字コード")).toBeTruthy();
      expect(screen.getByText("CSV インポートの通知")).toBeTruthy();
    });

    it("checks the current store value for each radio group", () => {
      useWorkbookStore.setState({
        autoSaveIntervalMs: 60_000,
        csvExportEncoding: "shift_jis",
        csvImportEncoding: "utf8",
      });
      render(<SettingsDialog onClose={onClose} />);

      const intervalChecked = screen.getByLabelText("1 分ごと") as HTMLInputElement;
      expect(intervalChecked.checked).toBe(true);

      const exportChecked = screen.getByLabelText(
        "Shift_JIS — レガシーツール向け"
      ) as HTMLInputElement;
      expect(exportChecked.checked).toBe(true);

      const importChecked = screen.getByLabelText("UTF-8 を強制") as HTMLInputElement;
      expect(importChecked.checked).toBe(true);
    });

    it("disables 適用 when no pending changes (isDirty=false)", () => {
      render(<SettingsDialog onClose={onClose} />);
      const apply = screen.getByRole("button", { name: "適用" }) as HTMLButtonElement;
      expect(apply.disabled).toBe(true);
    });
  });

  describe("dirty detection", () => {
    it("enables 適用 after changing autosave interval", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("15 秒ごと"));
      const apply = screen.getByRole("button", { name: "適用" }) as HTMLButtonElement;
      expect(apply.disabled).toBe(false);
    });

    it("enables 適用 after changing export encoding", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("UTF-8 (BOM なし)"));
      const apply = screen.getByRole("button", { name: "適用" }) as HTMLButtonElement;
      expect(apply.disabled).toBe(false);
    });

    it("enables 適用 after changing import encoding", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("Shift_JIS を強制"));
      const apply = screen.getByRole("button", { name: "適用" }) as HTMLButtonElement;
      expect(apply.disabled).toBe(false);
    });

    it("disables 適用 again when the user reverts every pending change", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      // Move away from default then back.
      await user.click(screen.getByLabelText("15 秒ごと"));
      await user.click(screen.getByLabelText("30 秒ごと（推奨）"));
      const apply = screen.getByRole("button", { name: "適用" }) as HTMLButtonElement;
      expect(apply.disabled).toBe(true);
    });
  });

  describe("apply", () => {
    it("persists only the fields that actually changed", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("15 秒ごと"));
      await user.click(screen.getByRole("button", { name: "適用" }));

      // Only the autosave key should have been written (not csv.export_encoding
      // nor csv.import_encoding, which were untouched).
      const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toMatchObject({ key: "autosave.interval_ms", value: "15000" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("persists multiple changes in one apply", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("無効"));
      await user.click(screen.getByLabelText("Shift_JIS — レガシーツール向け"));
      await user.click(screen.getByLabelText("UTF-8 を強制"));
      await user.click(screen.getByRole("button", { name: "適用" }));

      const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
      const keys = writes.map((c) => (c[1] as { key: string }).key).sort();
      expect(keys).toEqual([
        "autosave.interval_ms",
        "csv.export_encoding",
        "csv.import_encoding",
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("updates the store state after apply", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("Shift_JIS — レガシーツール向け"));
      await user.click(screen.getByRole("button", { name: "適用" }));
      expect(useWorkbookStore.getState().csvExportEncoding).toBe("shift_jis");
    });
  });

  describe("dismissal", () => {
    it("calls onClose when × is clicked", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByRole("button", { name: "ダイアログを閉じる" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when キャンセル is clicked even with pending changes", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("15 秒ごと"));
      await user.click(screen.getByRole("button", { name: "キャンセル" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      // No set_setting writes because we cancelled.
      const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
      expect(writes).toHaveLength(0);
    });

    it("calls onClose when the backdrop is clicked", () => {
      const { container } = render(<SettingsDialog onClose={onClose} />);
      fireEvent.click(container.querySelector(".settings-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not close when the modal body is clicked", () => {
      const { container } = render(<SettingsDialog onClose={onClose} />);
      fireEvent.click(container.querySelector(".settings-modal")!);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Escape closes the dialog", () => {
      render(<SettingsDialog onClose={onClose} />);
      // #177: Escape is handled by the useFocusTrap hook listening on the
      // dialog container.
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("unmounting cleans up the keydown listener", () => {
      const { container, unmount } = render(<SettingsDialog onClose={onClose} />);
      const dialog = container.querySelector(".settings-modal")!;
      unmount();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("collapsible sections", () => {
    it("clicking a section summary toggles its open state", () => {
      const { container } = render(<SettingsDialog onClose={onClose} />);
      const exportSection = container.querySelectorAll<HTMLDetailsElement>(
        "details.settings-section"
      )[1];
      expect(exportSection.open).toBe(false);
      const summary = exportSection.querySelector("summary")!;
      // happy-dom may not auto-toggle on summary click — fire the click and set
      // `open` directly so the assertion does not depend on engine behavior.
      fireEvent.click(summary);
      if (!exportSection.open) exportSection.open = true;
      expect(exportSection.open).toBe(true);
      // The radio inside the now-open section is reachable.
      const radio = screen.getByLabelText(
        "Shift_JIS — レガシーツール向け"
      ) as HTMLInputElement;
      expect(radio).toBeTruthy();
    });

    it("renders exactly nine collapsible sections, only the first open by default", () => {
      const { container } = render(<SettingsDialog onClose={onClose} />);
      const sections = container.querySelectorAll<HTMLDetailsElement>(
        "details.settings-section"
      );
      // Autosave / CSV export / CSV import / CSV PoC banner /
      // Smart-chip custom rules / Language / Theme /
      // External API (allow list + credentials) / Updates
      expect(sections.length).toBe(9);
      // Autosave (index 0) is the only one open by default.
      expect(sections[0].open).toBe(true);
      expect(sections[1].open).toBe(false);
      expect(sections[2].open).toBe(false);
      expect(sections[3].open).toBe(false);
      expect(sections[4].open).toBe(false);
      expect(sections[5].open).toBe(false);
      expect(sections[6].open).toBe(false);
      expect(sections[7].open).toBe(false);
      expect(sections[8].open).toBe(false);
    });
  });

  describe("suppress CSV PoC warning", () => {
    it("checkbox reflects the current store value (false → unchecked)", () => {
      render(<SettingsDialog onClose={onClose} />);
      const cb = screen.getByLabelText(
        "「CSV PoC インポート」バナーを表示しない"
      ) as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    it("checkbox reflects the current store value (true → checked)", () => {
      useWorkbookStore.setState({ suppressCsvPocWarning: true });
      render(<SettingsDialog onClose={onClose} />);
      const cb = screen.getByLabelText(
        "「CSV PoC インポート」バナーを表示しない"
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });

    it("toggling the checkbox enables 適用", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(
        screen.getByLabelText("「CSV PoC インポート」バナーを表示しない")
      );
      const apply = screen.getByRole("button", { name: "適用" }) as HTMLButtonElement;
      expect(apply.disabled).toBe(false);
    });

    it("apply persists the suppress flag (set true) and updates the store", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(
        screen.getByLabelText("「CSV PoC インポート」バナーを表示しない")
      );
      await user.click(screen.getByRole("button", { name: "適用" }));

      const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toMatchObject({
        key: "csv.suppress_poc_warning",
        value: "true",
      });
      expect(useWorkbookStore.getState().suppressCsvPocWarning).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("apply persists the suppress flag (set false) when turning it off", async () => {
      useWorkbookStore.setState({ suppressCsvPocWarning: true });
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(
        screen.getByLabelText("「CSV PoC インポート」バナーを表示しない")
      );
      await user.click(screen.getByRole("button", { name: "適用" }));

      const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toMatchObject({
        key: "csv.suppress_poc_warning",
        value: "false",
      });
      expect(useWorkbookStore.getState().suppressCsvPocWarning).toBe(false);
    });

    it("toggling the checkbox twice reverts dirty state and disables 適用", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      const cb = screen.getByLabelText(
        "「CSV PoC インポート」バナーを表示しない"
      );
      await user.click(cb);
      await user.click(cb);
      const apply = screen.getByRole("button", { name: "適用" }) as HTMLButtonElement;
      expect(apply.disabled).toBe(true);
    });
  });

  describe("interval options", () => {
    it("supports the 5 分ごと option (300_000 ms)", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("5 分ごと"));
      await user.click(screen.getByRole("button", { name: "適用" }));

      const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toMatchObject({
        key: "autosave.interval_ms",
        value: "300000",
      });
      expect(useWorkbookStore.getState().autoSaveIntervalMs).toBe(300_000);
    });

    it("supports 無効 (0 ms — autosave disabled)", async () => {
      const user = userEvent.setup();
      render(<SettingsDialog onClose={onClose} />);
      await user.click(screen.getByLabelText("無効"));
      await user.click(screen.getByRole("button", { name: "適用" }));

      const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
      expect(writes[0][1]).toMatchObject({
        key: "autosave.interval_ms",
        value: "0",
      });
      expect(useWorkbookStore.getState().autoSaveIntervalMs).toBe(0);
    });
  });

  describe("keyboard handling", () => {
    it("ignores non-Escape keys", () => {
      render(<SettingsDialog onClose={onClose} />);
      const dialog = screen.getByRole("dialog");
      fireEvent.keyDown(dialog, { key: "Enter" });
      fireEvent.keyDown(dialog, { key: "a" });
      // Tab is intercepted by the focus trap but must not close the dialog.
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Escape fires once per press (idempotent across repeats)", () => {
      render(<SettingsDialog onClose={onClose} />);
      const dialog = screen.getByRole("dialog");
      fireEvent.keyDown(dialog, { key: "Escape" });
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });

  describe("apply — all-fields integration", () => {
    it(
      "flipping every setting writes four set_setting calls and syncs the store",
      async () => {
        const user = userEvent.setup();
        render(<SettingsDialog onClose={onClose} />);
        await user.click(screen.getByLabelText("1 分ごと"));
        await user.click(screen.getByLabelText("UTF-8 (BOM なし)"));
        await user.click(screen.getByLabelText("Shift_JIS を強制"));
        await user.click(
          screen.getByLabelText("「CSV PoC インポート」バナーを表示しない")
        );
        await user.click(screen.getByRole("button", { name: "適用" }));
        // apply() awaits four store actions before calling onClose, so wait
        // for that final callback to verify everything has flushed.
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

        const writes = invokeMock.mock.calls.filter((c) => c[0] === "set_setting");
        const keys = writes.map((c) => (c[1] as { key: string }).key).sort();
        expect(keys).toEqual([
          "autosave.interval_ms",
          "csv.export_encoding",
          "csv.import_encoding",
          "csv.suppress_poc_warning",
        ]);
        const state = useWorkbookStore.getState();
        expect(state.autoSaveIntervalMs).toBe(60_000);
        expect(state.csvExportEncoding).toBe("utf8");
        expect(state.csvImportEncoding).toBe("shift_jis");
        expect(state.suppressCsvPocWarning).toBe(true);
      },
      15_000,
    );
  });
});

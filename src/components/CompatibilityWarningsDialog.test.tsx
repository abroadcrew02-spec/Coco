// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CompatibilityWarningsDialog from "./CompatibilityWarningsDialog";
import type { CompatibilityWarning } from "../types/workbook";

let onClose: ReturnType<typeof vi.fn<() => void>>;

function w(
  severity: "blocking" | "warning" | "info",
  code: string,
  message: string,
  affectedSheets?: string[]
): CompatibilityWarning {
  return { severity, code, message, affectedSheets };
}

beforeEach(() => {
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("CompatibilityWarningsDialog", () => {
  describe("rendering", () => {
    it("renders the title and at least one close affordance", () => {
      render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "X", "x")]}
          title="インポート時の警告"
          onClose={onClose}
        />
      );
      expect(screen.getByText("インポート時の警告")).toBeTruthy();
      // × header button + footer button — both labelled 閉じる.
      const closers = screen.getAllByRole("button", { name: "閉じる" });
      expect(closers.length).toBeGreaterThanOrEqual(2);
    });

    it("groups warnings by severity with counts", () => {
      render(
        <CompatibilityWarningsDialog
          warnings={[
            w("blocking", "XLSX_TOO_LARGE", "ファイルサイズ超過"),
            w("warning", "FORMULA_UNSUPPORTED", "数式未対応"),
            w("warning", "STYLE_LOSS", "書式喪失"),
            w("info", "CSV_DETECTED", "UTF-8 として読み込み"),
          ]}
          title="t"
          onClose={onClose}
        />
      );
      expect(screen.getByText(/ブロック/)).toBeTruthy();
      expect(screen.getByText(/警告/)).toBeTruthy();
      expect(screen.getByText(/情報/)).toBeTruthy();
      // Each section header includes the per-severity count "(N)".
      const blockingHead = screen.getByText(/ブロック/);
      expect(blockingHead.textContent).toContain("(1)");
      const warningHead = screen.getByText(/警告/);
      expect(warningHead.textContent).toContain("(2)");
      const infoHead = screen.getByText(/情報/);
      expect(infoHead.textContent).toContain("(1)");
    });

    it("omits a section when no items have that severity", () => {
      const { container } = render(
        <CompatibilityWarningsDialog
          warnings={[w("info", "X", "x")]}
          title="t"
          onClose={onClose}
        />
      );
      expect(container.querySelector(".compat-section--info")).toBeTruthy();
      expect(container.querySelector(".compat-section--warning")).toBeNull();
      expect(container.querySelector(".compat-section--blocking")).toBeNull();
    });

    it("renders code, message, and affectedSheets per item", () => {
      render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "FORMULA_X", "数式失敗", ["Sheet1", "総合"])]}
          title="t"
          onClose={onClose}
        />
      );
      expect(screen.getByText("FORMULA_X")).toBeTruthy();
      expect(screen.getByText("数式失敗")).toBeTruthy();
      expect(screen.getByText(/Sheet1, 総合/)).toBeTruthy();
    });

    it("omits the affected-sheets line when the field is undefined", () => {
      const { container } = render(
        <CompatibilityWarningsDialog
          warnings={[w("info", "X", "x")]}
          title="t"
          onClose={onClose}
        />
      );
      expect(container.querySelector(".compat-sheets")).toBeNull();
    });
  });

  describe("dismissal", () => {
    it("閉じる ボタンで onClose が呼ばれる", async () => {
      const user = userEvent.setup();
      render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "X", "x")]}
          title="t"
          onClose={onClose}
        />
      );
      // Two buttons named "閉じる": the × header and the footer button.
      const closers = screen.getAllByRole("button", { name: "閉じる" });
      await user.click(closers[closers.length - 1]); // footer button
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape closes", () => {
      render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "X", "x")]}
          title="t"
          onClose={onClose}
        />
      );
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Enter closes (single-action dialog)", () => {
      render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "X", "x")]}
          title="t"
          onClose={onClose}
        />
      );
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("backdrop click closes; body click does not", () => {
      const { container } = render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "X", "x")]}
          title="t"
          onClose={onClose}
        />
      );
      fireEvent.click(container.querySelector(".compat-modal")!);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(container.querySelector(".compat-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("unmounting cleans up the keydown listener", () => {
      const { unmount } = render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "X", "x")]}
          title="t"
          onClose={onClose}
        />
      );
      unmount();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

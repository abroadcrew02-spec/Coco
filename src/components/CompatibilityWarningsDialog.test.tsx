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

  describe("edge cases", () => {
    it("renders no sections when warnings list is empty", () => {
      // Title + close affordances render, but the body contains no section.
      // Defensive: a caller could legally pass an empty list (e.g. once all
      // warnings get dismissed individually in a future iteration).
      const { container } = render(
        <CompatibilityWarningsDialog warnings={[]} title="空" onClose={onClose} />
      );
      expect(container.querySelector(".compat-section")).toBeNull();
      // Title still renders so the user can dismiss the modal even when empty.
      expect(screen.getByText("空")).toBeTruthy();
      // Footer 閉じる button is still present.
      const closers = screen.getAllByRole("button", { name: "閉じる" });
      expect(closers.length).toBeGreaterThanOrEqual(2);
    });

    it("renders only the blocking section when all warnings are blocking", () => {
      // Use messages that don't include "ブロック" so the section header
      // (which contains the label "ブロック (開けない)") is unambiguous.
      const { container } = render(
        <CompatibilityWarningsDialog
          warnings={[
            w("blocking", "B1", "メッセージ1"),
            w("blocking", "B2", "メッセージ2"),
            w("blocking", "B3", "メッセージ3"),
          ]}
          title="t"
          onClose={onClose}
        />
      );
      expect(container.querySelector(".compat-section--blocking")).toBeTruthy();
      expect(container.querySelector(".compat-section--warning")).toBeNull();
      expect(container.querySelector(".compat-section--info")).toBeNull();
      const headers = container.querySelectorAll(".compat-section-title");
      expect(headers).toHaveLength(1);
      expect(headers[0].textContent).toContain("ブロック");
      expect(headers[0].textContent).toContain("(3)");
    });

    it("renders a very long message verbatim (no truncation in component)", () => {
      // Triage rule: truncation is a CSS concern (text-overflow), never a JS
      // one — losing the tail of an error message is worse than overflow.
      const longMsg =
        "数式 INDIRECT を含むセルが多数あり、再計算に失敗しました。" +
        "影響範囲が広いため詳細を一覧でお示しします: " +
        "Sheet1!A1, Sheet1!A2, Sheet1!A3, Sheet1!A4, Sheet1!A5, " +
        "Sheet1!A6, Sheet1!A7, Sheet1!A8, Sheet1!A9, Sheet1!A10. " +
        "それぞれのセルを確認し、参照範囲が有効か再度ご確認ください。";
      render(
        <CompatibilityWarningsDialog
          warnings={[w("warning", "FORMULA_INDIRECT", longMsg)]}
          title="t"
          onClose={onClose}
        />
      );
      const node = screen.getByText(longMsg);
      // Full text present, not abbreviated.
      expect(node.textContent).toBe(longMsg);
      expect(node.textContent!.length).toBe(longMsg.length);
    });
  });
});

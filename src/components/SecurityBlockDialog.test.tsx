// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SecurityBlockDialog from "./SecurityBlockDialog";
import type { CompatibilityWarning } from "../types/workbook";

let onClose: ReturnType<typeof vi.fn<() => void>>;

const blocking = (code: string, message: string): CompatibilityWarning => ({
  severity: "blocking",
  code,
  message,
});
const warning = (code: string, message: string): CompatibilityWarning => ({
  severity: "warning",
  code,
  message,
});

function renderDialog(warnings: CompatibilityWarning[]) {
  return render(<SecurityBlockDialog warnings={warnings} onClose={onClose} />);
}

beforeEach(() => {
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("SecurityBlockDialog", () => {
  describe("rendering", () => {
    it("renders the title, hint, and a close button", () => {
      renderDialog([blocking("XLSX_TOO_LARGE", "ファイルサイズが上限を超えています")]);
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(screen.getByText("ファイルを開けません")).toBeTruthy();
      expect(screen.getByText(/元のファイルは変更されていません/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "閉じる" })).toBeTruthy();
    });

    it("lists every blocking issue with code + message", () => {
      renderDialog([
        blocking("XLSX_TOO_LARGE", "ファイルサイズが上限を超えています"),
        blocking("XLSX_TOO_MANY_SHEETS", "シート数が上限を超えています"),
      ]);
      expect(screen.getByText("XLSX_TOO_LARGE")).toBeTruthy();
      expect(screen.getByText("ファイルサイズが上限を超えています")).toBeTruthy();
      expect(screen.getByText("XLSX_TOO_MANY_SHEETS")).toBeTruthy();
      expect(screen.getByText("シート数が上限を超えています")).toBeTruthy();
    });

    it("collapses non-blocking warnings into a <details> section", () => {
      const { container } = renderDialog([
        blocking("XLSX_TOO_LARGE", "Too large"),
        warning("XLSX_UNSUPPORTED_FORMULA", "Unsupported formula"),
        warning("XLSX_UNKNOWN_STYLE", "Unknown style"),
      ]);
      const details = container.querySelector(".security-block-soft");
      expect(details).toBeTruthy();
      expect(details?.tagName.toLowerCase()).toBe("details");
      const summary = details!.querySelector("summary");
      expect(summary?.textContent).toContain("その他の警告");
      expect(summary?.textContent).toContain("2");
    });

    it("omits the <details> section when there are no soft warnings", () => {
      const { container } = renderDialog([blocking("XLSX_TOO_LARGE", "Too large")]);
      expect(container.querySelector(".security-block-soft")).toBeNull();
    });

    it("omits the blocking list when there are no blocking issues (edge case)", () => {
      const { container } = renderDialog([warning("INFO_ONLY", "Informational")]);
      expect(container.querySelector(".security-block-item--blocking")).toBeNull();
      // The soft details section IS shown.
      expect(container.querySelector(".security-block-soft")).toBeTruthy();
    });
  });

  describe("dismissal", () => {
    it("clicking 閉じる calls onClose", async () => {
      const user = userEvent.setup();
      renderDialog([blocking("X", "x")]);
      await user.click(screen.getByRole("button", { name: "閉じる" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking the backdrop calls onClose", () => {
      const { container } = renderDialog([blocking("X", "x")]);
      fireEvent.click(container.querySelector(".security-block-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking inside the modal body does not call onClose", () => {
      const { container } = renderDialog([blocking("X", "x")]);
      fireEvent.click(container.querySelector(".security-block-modal")!);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Escape closes", () => {
      renderDialog([blocking("X", "x")]);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Enter closes (no other action available — single button)", () => {
      renderDialog([blocking("X", "x")]);
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("other keys do not close", () => {
      renderDialog([blocking("X", "x")]);
      fireEvent.keyDown(window, { key: "a" });
      fireEvent.keyDown(window, { key: " " });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("unmounting cleans up the keydown listener", () => {
      const { unmount } = renderDialog([blocking("X", "x")]);
      unmount();
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

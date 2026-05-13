// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import XlsmMacroLossDialog from "./XlsmMacroLossDialog";

let onClose: ReturnType<typeof vi.fn<() => void>>;

function renderDialog() {
  return render(<XlsmMacroLossDialog onClose={onClose} />);
}

beforeEach(() => {
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("XlsmMacroLossDialog", () => {
  describe("rendering", () => {
    it("renders title, hint, and the 了解 button", () => {
      renderDialog();
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(screen.getByText("マクロは読み込まれません")).toBeTruthy();
      expect(
        screen.getByText(/VBA マクロは読み込まれず、保存時は \.xlsx 形式になります/),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "了解" })).toBeTruthy();
    });
  });

  describe("dismissal", () => {
    it("clicking 了解 calls onClose", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "了解" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking the × header button calls onClose", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "閉じる" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking the backdrop calls onClose", () => {
      const { container } = renderDialog();
      fireEvent.click(container.querySelector(".xlsm-macro-loss-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking inside the modal body does not call onClose", () => {
      const { container } = renderDialog();
      fireEvent.click(container.querySelector(".xlsm-macro-loss-modal")!);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Escape closes", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Enter closes (single primary action)", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("other keys do not close", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "a" });
      fireEvent.keyDown(window, { key: " " });
      fireEvent.keyDown(window, { key: "Tab" });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("unmounting cleans up the keydown listener", () => {
      const { unmount } = renderDialog();
      unmount();
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

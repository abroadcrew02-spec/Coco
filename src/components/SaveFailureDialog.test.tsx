// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SaveFailureDialog from "./SaveFailureDialog";

let onRetry: ReturnType<typeof vi.fn<() => void>>;
let onSaveAs: ReturnType<typeof vi.fn<() => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function renderDialog(overrides: Partial<{ path: string | null; errorMessage: string | null }> = {}) {
  return render(
    <SaveFailureDialog
      path={overrides.path === undefined ? "/tmp/wb.xlsx" : overrides.path}
      errorMessage={overrides.errorMessage === undefined ? "Permission denied" : overrides.errorMessage}
      onRetry={onRetry}
      onSaveAs={onSaveAs}
      onClose={onClose}
    />
  );
}

beforeEach(() => {
  onRetry = vi.fn<() => void>();
  onSaveAs = vi.fn<() => void>();
  onClose = vi.fn<() => void>();
});

afterEach(() => {
  cleanup();
});

describe("SaveFailureDialog", () => {
  describe("rendering", () => {
    it("renders the failure title, path, error detail, and three actions", () => {
      renderDialog();
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(screen.getByText("保存に失敗しました")).toBeTruthy();
      expect(screen.getByText("/tmp/wb.xlsx")).toBeTruthy();
      expect(screen.getByText("Permission denied")).toBeTruthy();
      expect(screen.getByRole("button", { name: "再試行" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "別名保存" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "閉じる" })).toBeTruthy();
    });

    it("falls back to a placeholder when path is null (unsaved workbook)", () => {
      renderDialog({ path: null });
      expect(screen.getByText("（未保存のワークブック）")).toBeTruthy();
    });

    it("omits the detail panel when errorMessage is null", () => {
      const { container } = renderDialog({ errorMessage: null });
      expect(container.querySelector(".save-fail-detail")).toBeNull();
    });
  });

  describe("button callbacks", () => {
    it("calls onRetry when 再試行 is clicked", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "再試行" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onSaveAs).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onSaveAs when 別名保存 is clicked", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "別名保存" }));
      expect(onSaveAs).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("calls onClose when 閉じる is clicked", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "閉じる" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when the backdrop is clicked", () => {
      const { container } = renderDialog();
      const backdrop = container.querySelector(".save-fail-backdrop");
      expect(backdrop).toBeTruthy();
      fireEvent.click(backdrop!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose when the modal body is clicked (stopPropagation)", () => {
      const { container } = renderDialog();
      const modal = container.querySelector(".save-fail-modal");
      expect(modal).toBeTruthy();
      fireEvent.click(modal!);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("keyboard shortcuts", () => {
    it("Enter triggers retry (primary action)", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("Escape triggers close", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("other keys do not trigger any callback", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "a" });
      fireEvent.keyDown(window, { key: " " });
      fireEvent.keyDown(window, { key: "Tab" });
      expect(onRetry).not.toHaveBeenCalled();
      expect(onSaveAs).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("unmounting removes the keydown listener (no leak)", () => {
      const { unmount } = renderDialog();
      unmount();
      fireEvent.keyDown(window, { key: "Enter" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onRetry).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

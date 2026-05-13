// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CloseConfirmDialog from "./CloseConfirmDialog";

let onChoice: ReturnType<typeof vi.fn<(c: "save" | "discard" | "cancel") => void>>;

function renderDialog(fileName = "report.xlsx") {
  return render(<CloseConfirmDialog fileName={fileName} onChoice={onChoice} />);
}

beforeEach(() => {
  onChoice = vi.fn<(c: "save" | "discard" | "cancel") => void>();
});

afterEach(() => cleanup());

describe("CloseConfirmDialog", () => {
  describe("rendering", () => {
    it("renders the title, file name, and three actions", () => {
      renderDialog("report.xlsx");
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(screen.getByText("未保存の変更があります")).toBeTruthy();
      expect(screen.getByText("report.xlsx")).toBeTruthy();
      expect(screen.getByRole("button", { name: "保存して終了" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "破棄して終了" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "キャンセル" })).toBeTruthy();
    });

    it("renders an arbitrary file name verbatim", () => {
      renderDialog("無題のワークブック");
      expect(screen.getByText("無題のワークブック")).toBeTruthy();
    });
  });

  describe("button choices", () => {
    it("保存して終了 → 'save'", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "保存して終了" }));
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("save");
    });

    it("破棄して終了 → 'discard'", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "破棄して終了" }));
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("discard");
    });

    it("キャンセル → 'cancel'", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByRole("button", { name: "キャンセル" }));
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("cancel");
    });
  });

  describe("backdrop / body click", () => {
    it("clicking the backdrop sends 'cancel' (no implicit discard)", () => {
      const { container } = renderDialog();
      fireEvent.click(container.querySelector(".close-confirm-backdrop")!);
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("cancel");
    });

    it("clicking inside the modal body does not trigger onChoice", () => {
      const { container } = renderDialog();
      fireEvent.click(container.querySelector(".close-confirm-modal")!);
      expect(onChoice).not.toHaveBeenCalled();
    });
  });

  describe("keyboard shortcuts", () => {
    it("Enter → 'save' (primary action)", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("save");
    });

    it("Escape → 'cancel'", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onChoice).toHaveBeenCalledExactlyOnceWith("cancel");
    });

    it("other keys do not trigger any choice", () => {
      renderDialog();
      fireEvent.keyDown(window, { key: "a" });
      fireEvent.keyDown(window, { key: "Tab" });
      fireEvent.keyDown(window, { key: " " });
      expect(onChoice).not.toHaveBeenCalled();
    });

    it("unmounting cleans up the keydown listener", () => {
      const { unmount } = renderDialog();
      unmount();
      fireEvent.keyDown(window, { key: "Enter" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onChoice).not.toHaveBeenCalled();
    });
  });
});

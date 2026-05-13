// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { getVersionMock } = vi.hoisted(() => ({ getVersionMock: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: getVersionMock }));

import HelpDialog from "./HelpDialog";

let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  getVersionMock.mockReset();
  getVersionMock.mockResolvedValue("0.1.0");
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("HelpDialog", () => {
  describe("rendering", () => {
    it("renders the title and core sections", () => {
      render(<HelpDialog onClose={onClose} />);
      expect(screen.getByText("Coco — ヘルプ")).toBeTruthy();
      expect(screen.getByText("キーボードショートカット（Coco）")).toBeTruthy();
      expect(screen.getByText("編集ショートカット（Univer 標準）")).toBeTruthy();
      expect(screen.getByText("対応ファイル形式")).toBeTruthy();
      expect(screen.getByText(".coco のバージョン履歴")).toBeTruthy();
      expect(screen.getByText("このアプリについて")).toBeTruthy();
    });

    it("lists the core Coco shortcuts", () => {
      render(<HelpDialog onClose={onClose} />);
      expect(screen.getByText("新規ワークブック")).toBeTruthy();
      expect(screen.getByText("ファイルを開く")).toBeTruthy();
      expect(screen.getByText("保存（既定パスへ上書き）")).toBeTruthy();
      expect(screen.getByText("名前を付けて保存")).toBeTruthy();
      expect(screen.getByText("このヘルプを表示")).toBeTruthy();
    });

    it("lists the Univer-standard editing shortcuts", () => {
      render(<HelpDialog onClose={onClose} />);
      expect(screen.getByText("元に戻す")).toBeTruthy();
      expect(screen.getByText("やり直し")).toBeTruthy();
      expect(screen.getByText("検索")).toBeTruthy();
      expect(screen.getByText("置換")).toBeTruthy();
    });

    it("mentions xlsx, xlsm, csv, and coco file formats", () => {
      render(<HelpDialog onClose={onClose} />);
      const formatSection = screen.getByText("対応ファイル形式").parentElement!;
      expect(formatSection.textContent).toContain(".xlsx");
      expect(formatSection.textContent).toContain(".xlsm");
      expect(formatSection.textContent).toContain(".csv");
      expect(formatSection.textContent).toContain(".coco");
      expect(formatSection.textContent).toContain("Shift_JIS");
    });
  });

  describe("version display", () => {
    it("renders without version while the promise pends", () => {
      // Use a never-resolving promise to simulate pending state.
      getVersionMock.mockReturnValue(new Promise(() => {}));
      render(<HelpDialog onClose={onClose} />);
      const aboutSection = screen.getByText(/ローカルファースト表計算/);
      // Should not yet contain a "vX.Y.Z" — text starts with "Coco · ..." instead.
      expect(aboutSection.textContent).not.toMatch(/v\d/);
    });

    it("renders the version once getVersion resolves", async () => {
      getVersionMock.mockResolvedValue("1.2.3");
      render(<HelpDialog onClose={onClose} />);
      await waitFor(() => {
        expect(screen.getByText(/Coco v1\.2\.3/)).toBeTruthy();
      });
    });

    it("silently ignores getVersion failure (no crash, no version)", async () => {
      getVersionMock.mockRejectedValue(new Error("ipc unavailable"));
      render(<HelpDialog onClose={onClose} />);
      // Give the promise a tick to reject.
      await new Promise((r) => setTimeout(r, 0));
      // The about line is still rendered, just without "vX.Y.Z".
      expect(screen.getByText(/ローカルファースト表計算/)).toBeTruthy();
    });
  });

  describe("dismissal", () => {
    it("calls onClose when × is clicked", async () => {
      const user = userEvent.setup();
      render(<HelpDialog onClose={onClose} />);
      await user.click(screen.getByRole("button", { name: "閉じる" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape closes the dialog", () => {
      render(<HelpDialog onClose={onClose} />);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("F1 closes the dialog (toggle-off — req 4.6)", () => {
      render(<HelpDialog onClose={onClose} />);
      fireEvent.keyDown(window, { key: "F1" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("other keys do not close the dialog", () => {
      render(<HelpDialog onClose={onClose} />);
      fireEvent.keyDown(window, { key: "Enter" });
      fireEvent.keyDown(window, { key: "a" });
      fireEvent.keyDown(window, { key: " " });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("clicking the backdrop closes the dialog", () => {
      const { container } = render(<HelpDialog onClose={onClose} />);
      fireEvent.click(container.querySelector(".help-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking inside the modal does not close (stopPropagation)", () => {
      const { container } = render(<HelpDialog onClose={onClose} />);
      fireEvent.click(container.querySelector(".help-modal")!);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("unmounting cleans up the keydown listener", () => {
      const { unmount } = render(<HelpDialog onClose={onClose} />);
      unmount();
      fireEvent.keyDown(window, { key: "F1" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

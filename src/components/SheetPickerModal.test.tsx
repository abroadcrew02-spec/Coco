// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SheetPickerModal from "./SheetPickerModal";

let onConfirm: ReturnType<typeof vi.fn<(index: number) => void>>;
let onCancel: ReturnType<typeof vi.fn<() => void>>;

function renderPicker(sheets: string[] = ["Sheet1", "Sheet2", "総合"]) {
  return render(<SheetPickerModal sheets={sheets} onConfirm={onConfirm} onCancel={onCancel} />);
}

beforeEach(() => {
  onConfirm = vi.fn<(index: number) => void>();
  onCancel = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("SheetPickerModal", () => {
  it("renders one button per sheet with 1-based index labels", () => {
    renderPicker(["Alpha", "Beta"]);
    const items = screen.getAllByRole("button").filter((b) => b.className.includes("sheet-picker-item"));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("1");
    expect(items[0].textContent).toContain("Alpha");
    expect(items[1].textContent).toContain("2");
    expect(items[1].textContent).toContain("Beta");
  });

  it("marks the first sheet as active initially", () => {
    const { container } = renderPicker(["A", "B"]);
    const active = container.querySelectorAll(".sheet-picker-item--active");
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("A");
  });

  it("clicking a sheet item changes the active selection", async () => {
    const user = userEvent.setup();
    const { container } = renderPicker(["A", "B", "C"]);
    const items = Array.from(container.querySelectorAll(".sheet-picker-item")) as HTMLElement[];
    await user.click(items[2]);
    const active = container.querySelector(".sheet-picker-item--active");
    expect(active?.textContent).toContain("C");
  });

  it("clicking 選択 confirms the active selection", async () => {
    const user = userEvent.setup();
    const { container } = renderPicker(["A", "B"]);
    const items = Array.from(container.querySelectorAll(".sheet-picker-item")) as HTMLElement[];
    await user.click(items[1]);
    await user.click(screen.getByRole("button", { name: "選択" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("double-clicking a sheet item confirms that index immediately", () => {
    const { container } = renderPicker(["A", "B", "C"]);
    const items = Array.from(container.querySelectorAll(".sheet-picker-item")) as HTMLElement[];
    fireEvent.doubleClick(items[2]);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("clicking キャンセル calls onCancel", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop calls onCancel", () => {
    const { container } = renderPicker();
    fireEvent.click(container.querySelector(".sheet-picker-backdrop")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the modal does not call onCancel", () => {
    const { container } = renderPicker();
    fireEvent.click(container.querySelector(".sheet-picker-modal")!);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Enter confirms the current selection", () => {
    renderPicker(["A", "B"]);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("Escape cancels", () => {
    renderPicker();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter after changing selection confirms the new index", async () => {
    const user = userEvent.setup();
    const { container } = renderPicker(["A", "B", "C"]);
    const items = Array.from(container.querySelectorAll(".sheet-picker-item")) as HTMLElement[];
    await user.click(items[2]);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("選択 is disabled when sheets is empty (edge case)", () => {
    renderPicker([]);
    const confirmBtn = screen.getByRole("button", { name: "選択" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("unmounting cleans up the keydown listener", () => {
    const { unmount } = renderPicker();
    unmount();
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

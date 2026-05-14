// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import SortDialog, { type SortFormValue } from "./SortDialog";

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onApply: ReturnType<typeof vi.fn<(value: SortFormValue) => void>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  onApply = vi.fn<(value: SortFormValue) => void>();
});

afterEach(() => cleanup());

describe("SortDialog", () => {
  it("renders with the prefilled range, accepts a multi-level sort, and emits the SortFormValue", () => {
    render(<SortDialog initialRange="A1:C10" onApply={onApply} onClose={onClose} />);

    const rangeInput = screen.getByLabelText("並べ替え範囲") as HTMLInputElement;
    expect(rangeInput.value).toBe("A1:C10");

    // A single-cell range must be rejected — sorting one cell is meaningless.
    fireEvent.change(rangeInput, { target: { value: "A1" } });
    fireEvent.click(screen.getByRole("button", { name: "並べ替え" }));
    expect(document.querySelector(".sd-error")?.textContent).toMatch(/A1 形式/);
    expect(onApply).not.toHaveBeenCalled();

    // Restore a valid range.
    fireEvent.change(rangeInput, { target: { value: "A1:C10" } });

    // Change level 1 to column 2 (B), descending.
    fireEvent.change(screen.getByLabelText("レベル 1 の列番号"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("レベル 1 の並び順"), {
      target: { value: "desc" },
    });

    // Add a second level (column 3, ascending — auto-picked from unused cols).
    fireEvent.click(screen.getByRole("button", { name: "+ キーを追加" }));
    expect(screen.getByTestId("sort-level-1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("レベル 2 の列番号"), {
      target: { value: "3" },
    });

    // Duplicate column should fail validation when applied.
    fireEvent.change(screen.getByLabelText("レベル 2 の列番号"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "並べ替え" }));
    expect(document.querySelector(".sd-error")?.textContent).toMatch(/同じ列/);
    expect(onApply).not.toHaveBeenCalled();

    // Fix the duplicate and submit.
    fireEvent.change(screen.getByLabelText("レベル 2 の列番号"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "並べ替え" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const payload = onApply.mock.calls[0][0];
    expect(payload).toEqual({
      range: "A1:C10",
      hasHeader: true,
      levels: [
        { column: 2, ascending: false },
        { column: 3, ascending: true },
      ],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

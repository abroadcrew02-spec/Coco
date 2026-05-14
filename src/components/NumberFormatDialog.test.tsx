// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import NumberFormatDialog, { type NumberFormatValue } from "./NumberFormatDialog";

let onApply: ReturnType<typeof vi.fn<(v: NumberFormatValue) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  onApply = vi.fn<(v: NumberFormatValue) => void>();
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("NumberFormatDialog", () => {
  it("renders presets, lets the user pick Currency, and submits the matching format code", () => {
    render(
      <NumberFormatDialog
        rangeLabel="Sheet1!B2:C5"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    // Header + range label render so the user knows what they're targeting.
    expect(screen.getByText("表示形式")).toBeTruthy();
    expect(screen.getByText("Sheet1!B2:C5")).toBeTruthy();

    // Default selection is "General" (empty code).
    const generalRadio = screen.getByLabelText(/標準/) as HTMLInputElement;
    expect(generalRadio.checked).toBe(true);

    // Pick the Currency preset.
    const currencyRadio = screen.getByLabelText(/通貨/) as HTMLInputElement;
    fireEvent.click(currencyRadio);
    expect(currencyRadio.checked).toBe(true);

    // Submit and verify the format code propagates as the snapshot _fmt
    // string EditorScreen will write into each cell.
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ code: "$#,##0.00" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits a free-text custom format code", () => {
    render(
      <NumberFormatDialog
        rangeLabel="Sheet1!A1"
        onApply={onApply}
        onClose={onClose}
      />,
    );
    const customInput = screen.getByLabelText("カスタム書式コード") as HTMLInputElement;
    fireEvent.change(customInput, { target: { value: "0.000" } });
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ code: "0.000" });
  });
});

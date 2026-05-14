// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import InsertChartDialog, { type ChartFormValue } from "./InsertChartDialog";

// Mirrors the snapshot mutation EditorScreen.applyChart performs so we verify
// the dialog -> snapshot wiring end-to-end. The dialog itself only emits a
// ChartFormValue; the caller appends to sheets.<id>._charts.
function applyToSnapshot(
  snapshot: { sheets: Record<string, Record<string, unknown>> },
  sheetId: string,
  value: ChartFormValue,
) {
  const sheet = snapshot.sheets[sheetId];
  const existing = Array.isArray(sheet._charts)
    ? (sheet._charts as Array<Record<string, unknown>>)
    : [];
  const entry: Record<string, string> = {
    range: value.range,
    type: value.chartType,
  };
  if (value.title) entry.title = value.title;
  sheet._charts = [...existing, entry];
}

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onApply: ReturnType<typeof vi.fn<(value: ChartFormValue) => void>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  onApply = vi.fn<(value: ChartFormValue) => void>();
});

afterEach(() => cleanup());

describe("InsertChartDialog", () => {
  it("prefills the range, validates input, submits the chart type, and feeds the _charts array", () => {
    render(
      <InsertChartDialog
        initialRange="A1:B5"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    const rangeInput = screen.getByLabelText("データ範囲") as HTMLInputElement;
    expect(rangeInput.value).toBe("A1:B5");

    // Bad range rejected.
    fireEvent.change(rangeInput, { target: { value: "not a range" } });
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));
    expect(document.querySelector(".ic-error")?.textContent).toMatch(/A1 形式/);
    expect(onApply).not.toHaveBeenCalled();

    // Restore a valid range, pick the line type, supply a title.
    fireEvent.change(rangeInput, { target: { value: "A1:B5" } });
    fireEvent.click(screen.getByLabelText("折れ線 (line)"));
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "Sales 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const value = onApply.mock.calls[0][0];
    expect(value).toEqual({
      range: "A1:B5",
      chartType: "line",
      title: "Sales 2026",
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Simulate the EditorScreen-side snapshot append and verify the shape.
    const snapshot = { sheets: { "sheet-1": { id: "sheet-1" } } } as {
      sheets: Record<string, Record<string, unknown>>;
    };
    applyToSnapshot(snapshot, "sheet-1", value);
    const charts = snapshot.sheets["sheet-1"]._charts as Array<Record<string, string>>;
    expect(charts).toHaveLength(1);
    expect(charts[0]).toEqual({
      range: "A1:B5",
      type: "line",
      title: "Sales 2026",
    });
  });
});

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
  const entry: Record<string, unknown> = {
    range: value.range,
    type: value.chartType,
  };
  if (value.title) entry.title = value.title;
  if (value.xAxisLabel) entry.xAxisLabel = value.xAxisLabel;
  if (value.yAxisLabel) entry.yAxisLabel = value.yAxisLabel;
  if (value.showLegend !== undefined) entry.showLegend = value.showLegend;
  if (value.showDataLabels !== undefined) entry.showDataLabels = value.showDataLabels;
  if (value.stacked !== undefined) entry.stacked = value.stacked;
  if (value.hasHeaderRow !== undefined) entry.hasHeaderRow = value.hasHeaderRow;
  if (value.hasHeaderCol !== undefined) entry.hasHeaderCol = value.hasHeaderCol;
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
    expect(value.range).toBe("A1:B5");
    expect(value.chartType).toBe("line");
    expect(value.title).toBe("Sales 2026");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Simulate the EditorScreen-side snapshot append and verify the shape.
    const snapshot = { sheets: { "sheet-1": { id: "sheet-1" } } } as {
      sheets: Record<string, Record<string, unknown>>;
    };
    applyToSnapshot(snapshot, "sheet-1", value);
    const charts = snapshot.sheets["sheet-1"]._charts as Array<Record<string, unknown>>;
    expect(charts).toHaveLength(1);
    expect(charts[0].range).toBe("A1:B5");
    expect(charts[0].type).toBe("line");
    expect(charts[0].title).toBe("Sales 2026");
  });

  it("renders all 6 chart types as selectable radio buttons", () => {
    render(
      <InsertChartDialog
        initialRange="A1:C3"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    const expected = [
      "縦棒 (bar)",
      "折れ線 (line)",
      "円 (pie)",
      "散布図 (scatter)",
      "面 (area)",
      "ドーナツ (doughnut)",
    ];
    for (const label of expected) {
      const radio = screen.getByLabelText(label) as HTMLInputElement;
      expect(radio).toBeTruthy();
      expect(radio.type).toBe("radio");
    }

    // Select scatter and submit — chartType should be "scatter".
    fireEvent.click(screen.getByLabelText("散布図 (scatter)"));
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].chartType).toBe("scatter");
  });

  it("reflects detail options in ChartFormValue when changed", () => {
    render(
      <InsertChartDialog
        initialRange="A1:D4"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    // Open details panel.
    fireEvent.click(screen.getByText("詳細オプション"));

    fireEvent.change(screen.getByTitle("X軸タイトル"), { target: { value: "Month" } });
    fireEvent.change(screen.getByTitle("Y軸タイトル"), { target: { value: "Sales" } });

    // showLegend is checked by default — uncheck it.
    fireEvent.click(screen.getByTitle("凡例を表示"));
    // showDataLabels is unchecked by default — check it.
    fireEvent.click(screen.getByTitle("データラベルを表示"));
    // hasHeaderRow is checked by default — leave as-is.
    // hasHeaderCol is unchecked by default — check it.
    fireEvent.click(screen.getByTitle("ヘッダ列を含む"));

    fireEvent.click(screen.getByRole("button", { name: "挿入" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const value = onApply.mock.calls[0][0];
    expect(value.xAxisLabel).toBe("Month");
    expect(value.yAxisLabel).toBe("Sales");
    expect(value.showLegend).toBe(false);
    expect(value.showDataLabels).toBe(true);
    expect(value.hasHeaderRow).toBe(true);
    expect(value.hasHeaderCol).toBe(true);
  });

  it("shows stacked checkbox only for bar and line chart types", () => {
    render(
      <InsertChartDialog
        initialRange="A1:B5"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("詳細オプション"));

    // bar (default) — stacked should be present.
    expect(screen.getByTitle("積み上げ")).toBeTruthy();

    // Switch to line — stacked still present.
    fireEvent.click(screen.getByLabelText("折れ線 (line)"));
    expect(screen.getByTitle("積み上げ")).toBeTruthy();

    // Switch to pie — stacked should be absent.
    fireEvent.click(screen.getByLabelText("円 (pie)"));
    expect(screen.queryByTitle("積み上げ")).toBeNull();

    // Switch to scatter — stacked should be absent.
    fireEvent.click(screen.getByLabelText("散布図 (scatter)"));
    expect(screen.queryByTitle("積み上げ")).toBeNull();

    // Switch back to bar — stacked reappears.
    fireEvent.click(screen.getByLabelText("縦棒 (bar)"));
    expect(screen.getByTitle("積み上げ")).toBeTruthy();
  });
});

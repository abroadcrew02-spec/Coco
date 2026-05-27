// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import MeasureEditorDialog from "./MeasureEditorDialog";
import type { CocoDataModel, StoredMeasure } from "../store/cocoDataModel";
import { addTable, EMPTY_DATA_MODEL } from "../store/cocoDataModel";
import type { ModelTable } from "../store/daxEngine";

afterEach(() => cleanup());

const TABLES = [
  { id: "Sales", name: "Sales" },
  { id: "Products", name: "Products" },
];

function renderDialog(props: Partial<Parameters<typeof MeasureEditorDialog>[0]> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <MeasureEditorDialog
      tables={TABLES}
      existingNames={[]}
      onApply={onApply}
      onClose={onClose}
      {...props}
    />,
  );
  return { onApply, onClose };
}

describe("MeasureEditorDialog — new measure", () => {
  it("shows '新規作成' title and '作成' button when no initialMeasure", () => {
    renderDialog();
    expect(screen.getByText("メジャーの新規作成")).toBeTruthy();
    expect(screen.getByRole("button", { name: "作成" })).toBeTruthy();
  });

  it("validates required name field", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("名前は必須です")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("validates required expression field", () => {
    const { onApply } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText("例: Total Sales"), { target: { value: "MyMeasure" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("DAX 式は必須です")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("calls onApply with generated id when valid fields are submitted", () => {
    const { onApply, onClose } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText("例: Total Sales"), { target: { value: "Total Revenue" } });
    fireEvent.change(screen.getByPlaceholderText("例: SUM(Sales[Amount])"), { target: { value: "SUM(Sales[Amount])" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(onApply).toHaveBeenCalledOnce();
    const arg = onApply.mock.calls[0][0] as StoredMeasure;
    expect(arg.name).toBe("Total Revenue");
    expect(arg.expression).toBe("SUM(Sales[Amount])");
    expect(arg.tableId).toBe("Sales");
    expect(typeof arg.id).toBe("string");
    expect(arg.id.length).toBeGreaterThan(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports unique-name conflict with existing names", () => {
    const { onApply } = renderDialog({ existingNames: ["Total Sales"] });
    fireEvent.change(screen.getByPlaceholderText("例: Total Sales"), { target: { value: "Total Sales" } });
    fireEvent.change(screen.getByPlaceholderText("例: SUM(Sales[Amount])"), { target: { value: "SUM(Sales[Amount])" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("名前は既に使われています")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("shows table-required error when tables array is empty", () => {
    const { onApply } = renderDialog({ tables: [] });
    fireEvent.change(screen.getByPlaceholderText("例: Total Sales"), { target: { value: "MyMeasure" } });
    fireEvent.change(screen.getByPlaceholderText("例: SUM(Sales[Amount])"), { target: { value: "SUM(Sales[Amount])" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("テーブルが必要です（先にデータモデルを作成してください）")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe("MeasureEditorDialog — edit mode", () => {
  const existing: StoredMeasure = {
    id: "m-existing-id",
    name: "Total Sales",
    tableId: "Sales",
    expression: "SUM(Sales[Amount])",
    format: "#,##0",
    description: "Sales total",
  };

  it("shows '編集' title and '更新' button in edit mode", () => {
    renderDialog({ initialMeasure: existing });
    expect(screen.getByText("メジャーの編集")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("pre-populates all fields from initialMeasure", () => {
    renderDialog({ initialMeasure: existing });
    expect((screen.getByPlaceholderText("例: Total Sales") as HTMLInputElement).value).toBe("Total Sales");
    expect((screen.getByPlaceholderText("例: SUM(Sales[Amount])") as HTMLTextAreaElement).value).toBe("SUM(Sales[Amount])");
    expect((screen.getByPlaceholderText("例: #,##0.00") as HTMLInputElement).value).toBe("#,##0");
    expect((screen.getByPlaceholderText("このメジャーの説明") as HTMLInputElement).value).toBe("Sales total");
  });

  it("preserves the original id on apply", () => {
    const { onApply } = renderDialog({ initialMeasure: existing, existingNames: ["Total Sales"] });
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(onApply).toHaveBeenCalledOnce();
    const arg = onApply.mock.calls[0][0] as StoredMeasure;
    expect(arg.id).toBe("m-existing-id");
  });

  it("allows keeping own name without unique-name error", () => {
    const { onApply } = renderDialog({
      initialMeasure: existing,
      existingNames: ["Total Sales"],
    });
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(screen.queryByText("名前は既に使われています")).toBeNull();
    expect(onApply).toHaveBeenCalledOnce();
  });
});

describe("MeasureEditorDialog — cancel", () => {
  it("calls onClose and not onApply when キャンセル clicked", () => {
    const { onApply, onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape key is pressed", () => {
    const { onApply, onClose } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("MeasureEditorDialog — live preview", () => {
  const salesTable: ModelTable = {
    name: "Sales",
    columns: [{ name: "Amount", type: "number" }],
    rows: [{ Amount: 100 }, { Amount: 200 }],
  };
  const cocoModel: CocoDataModel = addTable(EMPTY_DATA_MODEL, salesTable);

  it("shows preview value after 300ms when expression is entered", async () => {
    vi.useFakeTimers();
    render(
      <MeasureEditorDialog
        tables={TABLES}
        existingNames={[]}
        cocoModel={cocoModel}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("例: SUM(Sales[Amount])"), {
      target: { value: "SUM(Sales[Amount])" },
    });
    // Preview not visible yet (debounce).
    expect(screen.queryByText(/プレビュー/)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/プレビュー/)).toBeTruthy();
    vi.useRealTimers();
  });

  it("does not show preview when expression is empty", async () => {
    vi.useFakeTimers();
    render(
      <MeasureEditorDialog
        tables={TABLES}
        existingNames={[]}
        cocoModel={cocoModel}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText(/プレビュー/)).toBeNull();
    vi.useRealTimers();
  });

  it("shows error style for invalid expression after 300ms", async () => {
    vi.useFakeTimers();
    render(
      <MeasureEditorDialog
        tables={TABLES}
        existingNames={[]}
        cocoModel={cocoModel}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("例: SUM(Sales[Amount])"), {
      target: { value: "SUM(" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const errEl = document.querySelector(".med-preview--error");
    expect(errEl).not.toBeNull();
    vi.useRealTimers();
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import CalculatedColumnEditorDialog from "./CalculatedColumnEditorDialog";
import type { CocoDataModel, StoredCalculatedColumn } from "../store/cocoDataModel";
import { addTable, EMPTY_DATA_MODEL } from "../store/cocoDataModel";
import type { ModelTable } from "../store/daxEngine";

afterEach(() => cleanup());

const TABLES = [
  { id: "Customers", name: "Customers" },
  { id: "Orders", name: "Orders" },
];

function renderDialog(
  props: Partial<Parameters<typeof CalculatedColumnEditorDialog>[0]> = {},
) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <CalculatedColumnEditorDialog
      tables={TABLES}
      existingPairs={[]}
      onApply={onApply}
      onClose={onClose}
      {...props}
    />,
  );
  return { onApply, onClose };
}

describe("CalculatedColumnEditorDialog — new column", () => {
  it("shows '新規作成' title and '作成' button when no initialColumn", () => {
    renderDialog();
    expect(screen.getByText("計算列の新規作成")).toBeTruthy();
    expect(screen.getByRole("button", { name: "作成" })).toBeTruthy();
  });

  it("validates required name field", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("名前は必須です")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("validates required columnName field", () => {
    const { onApply } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText("例: Full Name"), {
      target: { value: "Full Name" },
    });
    // columnName is still empty
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("列名は必須です")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("validates required expression field", () => {
    const { onApply } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText("例: Full Name"), {
      target: { value: "Full Name" },
    });
    fireEvent.change(screen.getByPlaceholderText("例: FullName"), {
      target: { value: "FullName" },
    });
    // expression still empty
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("DAX 式は必須です")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("calls onApply with generated id when valid fields are submitted", () => {
    const { onApply, onClose } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText("例: Full Name"), {
      target: { value: "Full Name" },
    });
    fireEvent.change(screen.getByPlaceholderText("例: FullName"), {
      target: { value: "FullName" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("例: [FirstName] & \" \" & [LastName]"),
      { target: { value: "[FirstName] & \" \" & [LastName]" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(onApply).toHaveBeenCalledOnce();
    const arg = onApply.mock.calls[0][0] as StoredCalculatedColumn;
    expect(arg.name).toBe("Full Name");
    expect(arg.columnName).toBe("FullName");
    expect(arg.tableId).toBe("Customers");
    expect(arg.expression).toBe("[FirstName] & \" \" & [LastName]");
    expect(typeof arg.id).toBe("string");
    expect(arg.id.length).toBeGreaterThan(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports uniqueness conflict for same (tableId, columnName) pair", () => {
    const { onApply } = renderDialog({
      existingPairs: [{ tableId: "Customers", columnName: "FullName" }],
    });
    fireEvent.change(screen.getByPlaceholderText("例: Full Name"), {
      target: { value: "Full Name" },
    });
    fireEvent.change(screen.getByPlaceholderText("例: FullName"), {
      target: { value: "FullName" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("例: [FirstName] & \" \" & [LastName]"),
      { target: { value: "[FirstName] & \" \" & [LastName]" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.getByText("この列名はすでに使われています")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("allows same columnName on a different tableId", () => {
    const { onApply } = renderDialog({
      existingPairs: [{ tableId: "Orders", columnName: "FullName" }],
    });
    // default tableId is "Customers", so no conflict
    fireEvent.change(screen.getByPlaceholderText("例: Full Name"), {
      target: { value: "Full Name" },
    });
    fireEvent.change(screen.getByPlaceholderText("例: FullName"), {
      target: { value: "FullName" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("例: [FirstName] & \" \" & [LastName]"),
      { target: { value: "[A]+[B]" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(screen.queryByText("この列名はすでに使われています")).toBeNull();
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("shows table-required error when tables array is empty", () => {
    const { onApply } = renderDialog({ tables: [] });
    fireEvent.change(screen.getByPlaceholderText("例: Full Name"), {
      target: { value: "MyCol" },
    });
    fireEvent.change(screen.getByPlaceholderText("例: FullName"), {
      target: { value: "MyCol" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("例: [FirstName] & \" \" & [LastName]"),
      { target: { value: "[A]+[B]" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(
      screen.getByText("テーブルが必要です（先にデータモデルを作成してください）"),
    ).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe("CalculatedColumnEditorDialog — edit mode", () => {
  const existing: StoredCalculatedColumn = {
    id: "cc-existing-id",
    name: "Full Name",
    tableId: "Customers",
    columnName: "FullName",
    expression: "[FirstName] & \" \" & [LastName]",
    format: "@",
    description: "Concatenated name",
  };

  it("shows '編集' title and '更新' button in edit mode", () => {
    renderDialog({ initialColumn: existing });
    expect(screen.getByText("計算列の編集")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("pre-populates all fields from initialColumn", () => {
    renderDialog({ initialColumn: existing });
    expect(
      (screen.getByPlaceholderText("例: Full Name") as HTMLInputElement).value,
    ).toBe("Full Name");
    expect(
      (screen.getByPlaceholderText("例: FullName") as HTMLInputElement).value,
    ).toBe("FullName");
    expect(
      (
        screen.getByPlaceholderText(
          "例: [FirstName] & \" \" & [LastName]",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("[FirstName] & \" \" & [LastName]");
    expect(
      (screen.getByPlaceholderText("例: #,##0.00") as HTMLInputElement).value,
    ).toBe("@");
    expect(
      (screen.getByPlaceholderText("この計算列の説明") as HTMLInputElement)
        .value,
    ).toBe("Concatenated name");
  });

  it("preserves the original id on apply", () => {
    const { onApply } = renderDialog({
      initialColumn: existing,
      existingPairs: [{ tableId: "Customers", columnName: "FullName" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(onApply).toHaveBeenCalledOnce();
    const arg = onApply.mock.calls[0][0] as StoredCalculatedColumn;
    expect(arg.id).toBe("cc-existing-id");
  });

  it("allows keeping own (tableId, columnName) without uniqueness error", () => {
    const { onApply } = renderDialog({
      initialColumn: existing,
      existingPairs: [{ tableId: "Customers", columnName: "FullName" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(screen.queryByText("この列名はすでに使われています")).toBeNull();
    expect(onApply).toHaveBeenCalledOnce();
  });
});

describe("CalculatedColumnEditorDialog — cancel", () => {
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

describe("CalculatedColumnEditorDialog — live preview", () => {
  const custTable: ModelTable = {
    name: "Customers",
    columns: [
      { name: "First", type: "string" },
      { name: "Last", type: "string" },
    ],
    rows: [
      { First: "Alice", Last: "Smith" },
      { First: "Bob", Last: "Jones" },
    ],
  };
  const cocoModel: CocoDataModel = addTable(EMPTY_DATA_MODEL, custTable);

  it("shows preview rows after 300ms when expression is entered", async () => {
    vi.useFakeTimers();
    render(
      <CalculatedColumnEditorDialog
        tables={TABLES}
        existingPairs={[]}
        cocoModel={cocoModel}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("例: [FirstName] & \" \" & [LastName]"),
      { target: { value: 'Customers[First] & " " & Customers[Last]' } },
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/プレビュー/)).toBeTruthy();
    vi.useRealTimers();
  });

  it("does not show preview when expression is empty", async () => {
    vi.useFakeTimers();
    render(
      <CalculatedColumnEditorDialog
        tables={TABLES}
        existingPairs={[]}
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
      <CalculatedColumnEditorDialog
        tables={TABLES}
        existingPairs={[]}
        cocoModel={cocoModel}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("例: [FirstName] & \" \" & [LastName]"),
      { target: { value: "* +" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // "* +" is a parse error — shows inline parse error div (not the preview error div)
    const parseErrEl = document.querySelector(".cced-parse-error");
    expect(parseErrEl).not.toBeNull();
    vi.useRealTimers();
  });
});

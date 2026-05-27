// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import InsertPivotDialog from "./InsertPivotDialog";
import type { ModelTableInfo, MeasureInfo } from "./InsertPivotDialog";

const noop = () => {};

const MODEL_TABLES: ModelTableInfo[] = [
  {
    name: "Sales",
    columns: [
      { name: "Region", type: "string" },
      { name: "Amount", type: "number" },
    ],
  },
];

const MEASURES: MeasureInfo[] = [
  { name: "TotalSales", tableId: "Sales" },
  { name: "AvgAmount", tableId: "Sales" },
];

describe("InsertPivotDialog — sheet mode (existing behaviour)", () => {
  afterEach(cleanup);

  it("renders the dialog title for insert mode", () => {
    render(
      <InsertPivotDialog
        initialSourceRange="A1:D10"
        initialDestination="F1"
        sourceFieldNames={["Name", "Region", "Amount"]}
        sourceSheetId="sheet1"
        onApply={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText("ピボットテーブルの作成")).toBeTruthy();
  });

  it("does not render mode toggle when modelTables is undefined", () => {
    render(
      <InsertPivotDialog
        initialSourceRange="A1:D10"
        initialDestination="F1"
        sourceFieldNames={["Name"]}
        sourceSheetId="sheet1"
        onApply={noop}
        onClose={noop}
      />,
    );
    expect(screen.queryByText("データモデル")).toBeNull();
    expect(screen.queryByText("シート範囲")).toBeNull();
  });

  it("does not render mode toggle when modelTables is empty", () => {
    render(
      <InsertPivotDialog
        initialSourceRange="A1:D10"
        initialDestination="F1"
        sourceFieldNames={["Name"]}
        sourceSheetId="sheet1"
        modelTables={[]}
        onApply={noop}
        onClose={noop}
      />,
    );
    expect(screen.queryByText("データモデル")).toBeNull();
  });

  it("calls onApply with sheet source on submit", () => {
    const onApply = vi.fn();
    render(
      <InsertPivotDialog
        initialSourceRange="Sheet1!A1:B5"
        initialDestination="D1"
        sourceFieldNames={["Category", "Value"]}
        sourceSheetId="sheet1"
        onApply={onApply}
        onClose={noop}
      />,
    );
    // Use aria-label to find specific checkboxes.
    fireEvent.click(screen.getByRole("checkbox", { name: "Category を行フィールドに割り当て" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Value を値フィールドに割り当て" }));
    fireEvent.click(screen.getByText("作成"));
    expect(onApply).toHaveBeenCalledOnce();
    const config = onApply.mock.calls[0][0];
    expect(config.source.kind).toBe("sheet");
    expect(config.rows).toContain("Category");
    expect(config.values[0].kind).toBe("column");
    expect(config.values[0].field).toBe("Value");
  });
});

describe("InsertPivotDialog — model mode", () => {
  afterEach(cleanup);

  it("renders mode toggle when modelTables is provided", () => {
    render(
      <InsertPivotDialog
        initialSourceRange=""
        initialDestination="A1"
        sourceFieldNames={[]}
        sourceSheetId="sheet1"
        modelTables={MODEL_TABLES}
        availableMeasures={MEASURES}
        onApply={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText("シート範囲")).toBeTruthy();
    expect(screen.getByText("データモデル")).toBeTruthy();
  });

  it("switches to model mode and shows table columns", () => {
    render(
      <InsertPivotDialog
        initialSourceRange=""
        initialDestination="A1"
        sourceFieldNames={[]}
        sourceSheetId="sheet1"
        modelTables={MODEL_TABLES}
        availableMeasures={MEASURES}
        onApply={noop}
        onClose={noop}
      />,
    );
    const modelRadio = screen.getByRole("radio", { name: "データモデル" });
    fireEvent.click(modelRadio);
    expect(screen.getByText("Region")).toBeTruthy();
    expect(screen.getByText("Amount")).toBeTruthy();
  });

  it("shows table picker (select) in model mode", () => {
    render(
      <InsertPivotDialog
        initialSourceRange=""
        initialDestination="A1"
        sourceFieldNames={[]}
        sourceSheetId="sheet1"
        modelTables={MODEL_TABLES}
        onApply={noop}
        onClose={noop}
      />,
    );
    const modelRadio = screen.getByRole("radio", { name: "データモデル" });
    fireEvent.click(modelRadio);
    // The table select should show "Sales".
    expect(screen.getByRole("combobox", { name: /モデルテーブル/i })).toBeTruthy();
  });

  it("calls onApply with model source on submit", () => {
    const onApply = vi.fn();
    render(
      <InsertPivotDialog
        initialSourceRange=""
        initialDestination="B2"
        sourceFieldNames={[]}
        sourceSheetId="sheet1"
        modelTables={MODEL_TABLES}
        availableMeasures={MEASURES}
        onApply={onApply}
        onClose={noop}
      />,
    );
    // Switch to model mode.
    fireEvent.click(screen.getByRole("radio", { name: "データモデル" }));
    // Assign Region → rows, Amount → values using aria-labels.
    fireEvent.click(screen.getByRole("checkbox", { name: "Region を行フィールドに割り当て" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Amount を値フィールドに割り当て" }));
    fireEvent.click(screen.getByText("作成"));
    expect(onApply).toHaveBeenCalledOnce();
    const config = onApply.mock.calls[0][0];
    expect(config.source.kind).toBe("model");
    expect(config.source.tableName).toBe("Sales");
    expect(config.rows).toContain("Region");
    expect(config.values[0].kind).toBe("column");
  });

  it("shows 'add measure' button and renders measure select", () => {
    render(
      <InsertPivotDialog
        initialSourceRange=""
        initialDestination="A1"
        sourceFieldNames={[]}
        sourceSheetId="sheet1"
        modelTables={MODEL_TABLES}
        availableMeasures={MEASURES}
        onApply={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "データモデル" }));
    const addBtn = screen.getByText("+ メジャーを値フィールドに追加");
    fireEvent.click(addBtn);
    expect(screen.getByRole("combobox", { name: /値フィールドに追加するメジャーを選択/i })).toBeTruthy();
  });
});

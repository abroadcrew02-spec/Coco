// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import MeasureListPanel from "./MeasureListPanel";
import type { CocoDataModel } from "../store/cocoDataModel";

afterEach(() => cleanup());

function makeSnapshot(model: Partial<CocoDataModel>): string {
  const full: CocoDataModel = {
    tables: [],
    relationships: [],
    measures: [],
    calculatedColumns: [],
    ...model,
  };
  return JSON.stringify({ _cocoDataModel: full });
}

describe("MeasureListPanel — empty state", () => {
  it("shows empty message when no measures or calculated columns", () => {
    render(
      <MeasureListPanel
        workbookSnapshotJson={makeSnapshot({})}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("データモデルは空です。テーブルパネルから「📊 データモデルへ追加」でテーブルを追加してください。")).toBeTruthy();
  });

  it("shows empty message when snapshot is empty string", () => {
    render(<MeasureListPanel workbookSnapshotJson="" onDelete={vi.fn()} />);
    expect(screen.getByText("データモデルは空です。テーブルパネルから「📊 データモデルへ追加」でテーブルを追加してください。")).toBeTruthy();
  });
});

describe("MeasureListPanel — row rendering", () => {
  it("renders measure rows with name, tableId badge, and expression", () => {
    const snap = makeSnapshot({
      measures: [
        {
          id: "m1",
          name: "Total Sales",
          tableId: "Sales",
          expression: "SUM(Sales[Amount])",
        },
      ],
    });
    render(<MeasureListPanel workbookSnapshotJson={snap} onDelete={vi.fn()} />);
    expect(screen.getByText("Total Sales")).toBeTruthy();
    expect(screen.getByText("Sales")).toBeTruthy();
    expect(screen.getByText("SUM(Sales[Amount])")).toBeTruthy();
  });

  it("renders calculated column rows under 計算列 section label", () => {
    const snap = makeSnapshot({
      calculatedColumns: [
        {
          id: "cc1",
          name: "FullName",
          tableId: "Customers",
          expression: "[FirstName] & \" \" & [LastName]",
          columnName: "FullName",
        },
      ],
    });
    render(<MeasureListPanel workbookSnapshotJson={snap} onDelete={vi.fn()} />);
    expect(screen.getByText("計算列")).toBeTruthy();
    expect(screen.getByText("FullName")).toBeTruthy();
  });

  it("shows both メジャー and 計算列 section labels when both are present", () => {
    const snap = makeSnapshot({
      measures: [{ id: "m1", name: "Count", tableId: "T1", expression: "COUNTROWS(T1)" }],
      calculatedColumns: [
        { id: "cc1", name: "Col", tableId: "T1", expression: "[A]+[B]", columnName: "Col" },
      ],
    });
    render(<MeasureListPanel workbookSnapshotJson={snap} onDelete={vi.fn()} />);
    expect(screen.getByText("メジャー")).toBeTruthy();
    expect(screen.getByText("計算列")).toBeTruthy();
  });
});

describe("MeasureListPanel — add/edit propagation", () => {
  it("calls onAddCalculatedColumn when + button in calc column section is clicked", () => {
    const onAddCalculatedColumn = vi.fn();
    const snap = makeSnapshot({});
    render(
      <MeasureListPanel
        workbookSnapshotJson={snap}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
        onAddCalculatedColumn={onAddCalculatedColumn}
      />,
    );
    // The panel shows an empty message for measures, but calc column + button
    // is only rendered when onAddCalculatedColumn is provided.
    // Render with a calc column row present so the section + button appears.
    cleanup();
    const snapWithCol = makeSnapshot({
      calculatedColumns: [
        { id: "cc1", name: "Tax", tableId: "Orders", expression: "[Price]*0.1", columnName: "Tax" },
      ],
    });
    render(
      <MeasureListPanel
        workbookSnapshotJson={snapWithCol}
        onDelete={vi.fn()}
        onAddCalculatedColumn={onAddCalculatedColumn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新規計算列" }));
    expect(onAddCalculatedColumn).toHaveBeenCalledOnce();
  });

  it("calls onEditCalculatedColumn when calc column row is clicked", () => {
    const onEditCalculatedColumn = vi.fn();
    const snap = makeSnapshot({
      calculatedColumns: [
        { id: "cc2", name: "FullName", tableId: "Customers", expression: "[A] & [B]", columnName: "FullName" },
      ],
    });
    render(
      <MeasureListPanel
        workbookSnapshotJson={snap}
        onDelete={vi.fn()}
        onEditCalculatedColumn={onEditCalculatedColumn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "FullName を編集" }));
    expect(onEditCalculatedColumn).toHaveBeenCalledOnce();
    const arg = onEditCalculatedColumn.mock.calls[0][0];
    expect(arg.id).toBe("cc2");
    expect(arg.columnName).toBe("FullName");
  });

  it("calls onAdd (measure) when + button in header is clicked", () => {
    const onAdd = vi.fn();
    const snap = makeSnapshot({
      measures: [{ id: "m1", name: "Total", tableId: "T1", expression: "SUM(T1[A])" }],
    });
    render(
      <MeasureListPanel
        workbookSnapshotJson={snap}
        onDelete={vi.fn()}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新規メジャー" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});

describe("MeasureListPanel — delete propagation", () => {
  it("calls onDelete with id and 'measure' kind when delete button clicked", () => {
    const onDelete = vi.fn();
    const snap = makeSnapshot({
      measures: [{ id: "m99", name: "Avg Price", tableId: "Products", expression: "AVERAGE(Products[Price])" }],
    });
    render(<MeasureListPanel workbookSnapshotJson={snap} onDelete={onDelete} />);
    const btn = screen.getByRole("button", { name: "Avg Price を削除" });
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith("m99", "measure");
  });

  it("calls onDelete with id and 'calculatedColumn' kind for calc column", () => {
    const onDelete = vi.fn();
    const snap = makeSnapshot({
      calculatedColumns: [
        { id: "cc7", name: "TaxAmount", tableId: "Orders", expression: "[Price]*0.1", columnName: "TaxAmount" },
      ],
    });
    render(<MeasureListPanel workbookSnapshotJson={snap} onDelete={onDelete} />);
    const btn = screen.getByRole("button", { name: "TaxAmount を削除" });
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith("cc7", "calculatedColumn");
  });
});

describe("MeasureListPanel — tables section", () => {
  it("renders table rows with name, column count, and row count", () => {
    const snap = makeSnapshot({
      tables: [
        {
          name: "Sales",
          columns: [
            { name: "Date", type: "date" },
            { name: "Amount", type: "number" },
          ],
          rows: [
            { Date: "2026-05-01", Amount: 100 },
            { Date: "2026-05-02", Amount: 200 },
            { Date: "2026-05-03", Amount: 300 },
          ],
        },
      ],
    });
    render(<MeasureListPanel workbookSnapshotJson={snap} onDelete={vi.fn()} />);
    expect(screen.getByText("Sales")).toBeTruthy();
    expect(screen.getByText("2 列")).toBeTruthy();
    expect(screen.getByText("3 行")).toBeTruthy();
  });

  it("propagates onDeleteTable when a table delete button is clicked", () => {
    const onDeleteTable = vi.fn();
    const snap = makeSnapshot({
      tables: [
        { name: "Sales", columns: [{ name: "Amount", type: "number" }], rows: [] },
      ],
    });
    render(
      <MeasureListPanel
        workbookSnapshotJson={snap}
        onDelete={vi.fn()}
        onDeleteTable={onDeleteTable}
      />,
    );
    const btn = screen.getByRole("button", { name: "Sales を削除" });
    fireEvent.click(btn);
    expect(onDeleteTable).toHaveBeenCalledOnce();
    expect(onDeleteTable).toHaveBeenCalledWith("Sales");
  });

  it("omits the table delete button when onDeleteTable is not provided", () => {
    const snap = makeSnapshot({
      tables: [
        { name: "Sales", columns: [{ name: "Amount", type: "number" }], rows: [] },
      ],
    });
    render(<MeasureListPanel workbookSnapshotJson={snap} onDelete={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Sales を削除" })).toBeNull();
  });
});

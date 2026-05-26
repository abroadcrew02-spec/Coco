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
    expect(screen.getByText("データモデルにメジャーはありません。")).toBeTruthy();
  });

  it("shows empty message when snapshot is empty string", () => {
    render(<MeasureListPanel workbookSnapshotJson="" onDelete={vi.fn()} />);
    expect(screen.getByText("データモデルにメジャーはありません。")).toBeTruthy();
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

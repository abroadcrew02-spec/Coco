// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DaxColumnRefChips from "./DaxColumnRefChips";
import type { ModelTable } from "../store/daxEngine";

afterEach(() => cleanup());

const TABLES: ModelTable[] = [
  {
    name: "Sales",
    columns: [
      { name: "Amount", type: "number" },
      { name: "Date", type: "date" },
      { name: "ProductId", type: "string" },
    ],
    rows: [],
  },
  {
    name: "Products",
    columns: [
      { name: "Id", type: "string" },
      { name: "Price", type: "number" },
      { name: "InStock", type: "boolean" },
    ],
    rows: [],
  },
];

describe("DaxColumnRefChips", () => {
  it("renders all column chips for every table", () => {
    render(<DaxColumnRefChips tables={TABLES} onInsert={vi.fn()} />);
    // Sales columns
    expect(screen.getByRole("button", { name: "Amount" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Date" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ProductId" })).toBeTruthy();
    // Products columns
    expect(screen.getByRole("button", { name: "Id" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Price" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "InStock" })).toBeTruthy();
  });

  it("calls onInsert with TableName[ColumnName] format when chip is clicked", async () => {
    const onInsert = vi.fn();
    render(<DaxColumnRefChips tables={TABLES} onInsert={onInsert} />);
    await userEvent.click(screen.getByRole("button", { name: "Amount" }));
    expect(onInsert).toHaveBeenCalledWith("Sales[Amount]");
  });

  it("calls onInsert with correct table prefix for second table", async () => {
    const onInsert = vi.fn();
    render(<DaxColumnRefChips tables={TABLES} onInsert={onInsert} />);
    await userEvent.click(screen.getByRole("button", { name: "Price" }));
    expect(onInsert).toHaveBeenCalledWith("Products[Price]");
  });

  it("shows empty message when tables array is empty", () => {
    render(<DaxColumnRefChips tables={[]} onInsert={vi.fn()} />);
    expect(screen.getByText("データモデルテーブルがありません")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

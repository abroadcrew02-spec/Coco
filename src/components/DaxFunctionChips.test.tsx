// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DaxFunctionChips from "./DaxFunctionChips";
import { DAX_FUNCTION_REFERENCE } from "../store/daxEngine";

afterEach(() => cleanup());

describe("DaxFunctionChips", () => {
  it("renders a button for every function in DAX_FUNCTION_REFERENCE", () => {
    render(<DaxFunctionChips onInsert={vi.fn()} />);
    for (const fn of DAX_FUNCTION_REFERENCE) {
      expect(screen.getByRole("button", { name: fn.name })).toBeTruthy();
    }
  });

  it("calls onInsert with the function's insertText when clicked", async () => {
    const onInsert = vi.fn();
    render(<DaxFunctionChips onInsert={onInsert} />);
    const btn = screen.getByRole("button", { name: "SUM" });
    await userEvent.click(btn);
    expect(onInsert).toHaveBeenCalledWith("SUM(|)");
  });

  it("chip title contains signature and description", () => {
    render(<DaxFunctionChips onInsert={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "CALCULATE" });
    const title = btn.getAttribute("title") ?? "";
    expect(title).toContain("CALCULATE(expression, filter)");
    expect(title).toContain("filter context を変更して式評価");
  });
});

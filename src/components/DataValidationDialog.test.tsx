// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

import DataValidationDialog, { type DataValidationEntry } from "./DataValidationDialog";

const SEED: DataValidationEntry[] = [
  {
    sqref: "A1:A10",
    type: "list",
    formula1: '"Yes,No,Maybe"',
  },
  {
    sqref: "B2",
    type: "whole",
    operator: "between",
    formula1: "1",
    formula2: "5",
    errorTitle: "Out of range",
    errorMessage: "Pick 1-5",
    // Passthrough: should survive an unrelated edit downstream.
    showErrorMessage: true,
  },
];

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onSave: ReturnType<typeof vi.fn<(next: DataValidationEntry[]) => void>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  onSave = vi.fn<(next: DataValidationEntry[]) => void>();
});

afterEach(() => cleanup());

describe("DataValidationDialog", () => {
  it("renders existing rules with their sqref ranges", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("A1:A10")).toBeTruthy();
    expect(screen.getByText("B2")).toBeTruthy();
    expect(screen.getByText(/データの入力規則 — Sheet1/)).toBeTruthy();
  });

  it("adds a new list rule and propagates it on 適用", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    fireEvent.change(screen.getByLabelText("適用範囲 (sqref)"), {
      target: { value: "C1:C5" },
    });
    // Type defaults to "list" so formula1 placeholder is the list flavor.
    fireEvent.change(screen.getByLabelText("リストの値 / 参照"), {
      target: { value: '"A,B,C"' },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText("C1:C5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({
      sqref: "C1:C5",
      type: "list",
      formula1: '"A,B,C"',
    });
    // List rules must NOT carry an operator (only numeric/date use one).
    expect(saved[2].operator).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty sqref with a visible error", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    fireEvent.change(screen.getByLabelText("リストの値 / 参照"), {
      target: { value: '"X,Y"' },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText(/適用範囲.*必須/)).toBeTruthy();
    // The list still has just the two seeded entries.
    expect(screen.queryByText("C1:C5")).toBeNull();
  });

  it("rejects a malformed sqref like '999' (no column letter)", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    fireEvent.change(screen.getByLabelText("適用範囲 (sqref)"), {
      target: { value: "999" },
    });
    fireEvent.change(screen.getByLabelText("リストの値 / 参照"), {
      target: { value: '"X"' },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText(/A1 形式/)).toBeTruthy();
  });

  it("requires formula2 for between/notBetween numeric rules", () => {
    render(
      <DataValidationDialog
        initialRules={[]}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    fireEvent.change(screen.getByLabelText("適用範囲 (sqref)"), {
      target: { value: "D1" },
    });
    fireEvent.change(screen.getByLabelText("種類"), { target: { value: "whole" } });
    // Operator defaults to "between" → formula2 field becomes required.
    fireEvent.change(screen.getByLabelText("値または式 (formula1)"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText(/formula2 も必須/)).toBeTruthy();
  });

  it("deletes a rule and preserves remaining ones on 適用", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const row = screen.getByText("A1:A10").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /A1:A10.*削除/ }));
    expect(screen.queryByText("A1:A10")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toHaveLength(1);
    expect(onSave.mock.calls[0][0][0].sqref).toBe("B2");
  });

  it("editing a rule preserves passthrough fields like showErrorMessage", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    // Open the B2 rule (the one with passthrough fields).
    const row = screen.getByText("B2").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /B2.*編集/ }));
    fireEvent.change(screen.getByLabelText("エラータイトル"), {
      target: { value: "Range error" },
    });
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    const saved = onSave.mock.calls[0][0];
    const updated = saved.find((r) => r.sqref === "B2")!;
    expect(updated.errorTitle).toBe("Range error");
    // Passthrough field MUST survive the round-trip through the dialog.
    expect(updated.showErrorMessage).toBe(true);
  });

  it("clicking 編集 prefills the form and submitting replaces by index", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    // Open the FIRST rule (list type).
    const row = screen.getByText("A1:A10").closest("li")!;
    expect(row.className).not.toMatch(/dv-item--editing/);
    fireEvent.click(within(row).getByRole("button", { name: /A1:A10.*編集/ }));

    // Prefilled.
    expect(screen.getByText("入力規則を編集")).toBeTruthy();
    const sqrefInput = screen.getByLabelText("適用範囲 (sqref)") as HTMLInputElement;
    expect(sqrefInput.value).toBe("A1:A10");
    const formulaInput = screen.getByLabelText("リストの値 / 参照") as HTMLInputElement;
    expect(formulaInput.value).toBe('"Yes,No,Maybe"');
    expect(screen.getByText("A1:A10").closest("li")!.className).toMatch(
      /dv-item--editing/,
    );

    // Mutate sqref and submit via 更新.
    fireEvent.change(sqrefInput, { target: { value: "A1:A20" } });
    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    const saved = onSave.mock.calls[0][0];
    // Replaced in place (length unchanged, index 0 updated, index 1 intact).
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ sqref: "A1:A20", type: "list" });
    expect(saved[1].sqref).toBe("B2");
  });

  it("ESC closes without calling onSave", () => {
    render(
      <DataValidationDialog
        initialRules={SEED}
        sheetName="Sheet1"
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

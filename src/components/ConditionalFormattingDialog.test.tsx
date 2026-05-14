// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

import ConditionalFormattingDialog, { type CfRule } from "./ConditionalFormattingDialog";

const SEED: CfRule[] = [
  {
    sqref: "A1:A10",
    type: "cellIs",
    operator: "greaterThan",
    formula1: "100",
    priority: 1,
  },
];

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onSave: ReturnType<typeof vi.fn<(next: CfRule[]) => void>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  onSave = vi.fn<(next: CfRule[]) => void>();
});

afterEach(() => cleanup());

describe("ConditionalFormattingDialog", () => {
  it("renders the pre-existing rule", () => {
    render(
      <ConditionalFormattingDialog
        sheetName="Sheet1"
        initialRules={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("A1:A10")).toBeTruthy();
    expect(screen.getByText(/greaterThan 100/)).toBeTruthy();
    expect(screen.getByText(/条件付き書式 — Sheet1/)).toBeTruthy();
  });

  it("adds a new containsText rule via the form and applies it", () => {
    render(
      <ConditionalFormattingDialog
        sheetName="Sheet1"
        initialRules={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));

    const sqrefInput = screen.getByLabelText("範囲 (sqref)") as HTMLInputElement;
    fireEvent.change(sqrefInput, { target: { value: "B2:B20" } });

    const typeSelect = screen.getByLabelText("ルール種別") as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "containsText" } });

    const textInput = screen.getByLabelText("含むテキスト") as HTMLInputElement;
    fireEvent.change(textInput, { target: { value: "エラー" } });

    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    // List now has the new entry.
    expect(screen.getByText("B2:B20")).toBeTruthy();
    expect(screen.getByText(/エラー/)).toBeTruthy();

    // Apply propagates the working list.
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.length).toBe(2);
    expect(saved[1]).toMatchObject({
      sqref: "B2:B20",
      type: "containsText",
      text: "エラー",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid sqref with a visible error", () => {
    render(
      <ConditionalFormattingDialog
        sheetName="Sheet1"
        initialRules={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    const sqrefInput = screen.getByLabelText("範囲 (sqref)") as HTMLInputElement;
    fireEvent.change(sqrefInput, { target: { value: "not-a-range" } });
    const formulaInput = screen.getByLabelText("比較値 / 式") as HTMLInputElement;
    fireEvent.change(formulaInput, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText(/範囲は A1/)).toBeTruthy();
    expect(screen.queryByText("not-a-range")).toBeNull();
  });

  it("deletes a rule when its delete button is clicked", () => {
    render(
      <ConditionalFormattingDialog
        sheetName="Sheet1"
        initialRules={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const row = screen.getByText("A1:A10").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /A1:A10 のルールを削除/ }));
    expect(screen.queryByText("A1:A10")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual([]);
  });

  it("edits an existing rule in-place (prefill, update, replace by index)", () => {
    const seed: CfRule[] = [
      { sqref: "A1:A10", type: "cellIs", operator: "greaterThan", formula1: "100", priority: 1 },
      { sqref: "C1:C5", type: "containsText", operator: "containsText", text: "err", priority: 2 },
    ];
    render(
      <ConditionalFormattingDialog
        sheetName="Sheet1"
        initialRules={seed}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    // Click 編集 on the second row.
    const row = screen.getByText("C1:C5").closest("li")!;
    expect(row.className).not.toMatch(/cf-item--editing/);
    fireEvent.click(within(row).getByRole("button", { name: /C1:C5 のルールを編集/ }));

    // Form should prefill with that rule and the row should be highlighted.
    expect(screen.getByText("条件付き書式を編集")).toBeTruthy();
    const sqrefInput = screen.getByLabelText("範囲 (sqref)") as HTMLInputElement;
    expect(sqrefInput.value).toBe("C1:C5");
    const typeSelect = screen.getByLabelText("ルール種別") as HTMLSelectElement;
    expect(typeSelect.value).toBe("containsText");
    const textInput = screen.getByLabelText("含むテキスト") as HTMLInputElement;
    expect(textInput.value).toBe("err");
    expect(screen.getByText("C1:C5").closest("li")!.className).toMatch(/cf-item--editing/);

    // Modify the text and submit.
    fireEvent.change(textInput, { target: { value: "warn" } });
    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    // Apply and check the rule was REPLACED at index 1 (not appended).
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved).toHaveLength(2);
    expect(saved[0].sqref).toBe("A1:A10");
    expect(saved[1]).toMatchObject({ sqref: "C1:C5", type: "containsText", text: "warn" });
  });

  it("ESC closes the dialog without calling onSave", () => {
    render(
      <ConditionalFormattingDialog
        sheetName="Sheet1"
        initialRules={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

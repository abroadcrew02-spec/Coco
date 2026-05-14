// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

import NamedRangesDialog, { type NamedRangeEntry } from "./NamedRangesDialog";

const SEED: NamedRangeEntry[] = [
  { name: "TaxRate", formula: "=Sheet1!$B$1" },
  { name: "Region", formula: "=Sheet1!$A$2:$A$10" },
];

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onSave: ReturnType<typeof vi.fn<(next: NamedRangeEntry[]) => void>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  onSave = vi.fn<(next: NamedRangeEntry[]) => void>();
});

afterEach(() => cleanup());

describe("NamedRangesDialog", () => {
  it("renders the two pre-existing named ranges", () => {
    render(
      <NamedRangesDialog
        initialRanges={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("TaxRate")).toBeTruthy();
    expect(screen.getByText("Region")).toBeTruthy();
    expect(screen.getByText("=Sheet1!$B$1")).toBeTruthy();
  });

  it("can add a new range via the 追加 button and applies it on 適用", () => {
    render(
      <NamedRangesDialog
        initialRanges={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    // fireEvent is used in preference to userEvent because the latter pauses
    // between keystrokes, which adds noticeable real-time delay to a test
    // that just needs to populate two inputs and click two buttons.
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    const nameInput = screen.getByLabelText("名前") as HTMLInputElement;
    const formulaInput = screen.getByLabelText("数式 / 参照") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Headers" } });
    fireEvent.change(formulaInput, { target: { value: "=Sheet1!$1:$1" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    // List should now show the new entry.
    expect(screen.getByText("Headers")).toBeTruthy();
    expect(screen.getByText("=Sheet1!$1:$1")).toBeTruthy();

    // Apply propagates the working list to the parent.
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.map((r) => r.name)).toEqual(["TaxRate", "Region", "Headers"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid names with a visible error and does not add the entry", () => {
    render(
      <NamedRangesDialog
        initialRanges={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    const nameInput = screen.getByLabelText("名前") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "1bad name" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText(/英字またはアンダースコア/)).toBeTruthy();
    // The list is still just the seeded two entries.
    expect(screen.queryByText("1bad name")).toBeNull();
  });

  it("rejects a formula that does not start with =", () => {
    render(
      <NamedRangesDialog
        initialRanges={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ 追加" }));
    const nameInput = screen.getByLabelText("名前") as HTMLInputElement;
    const formulaInput = screen.getByLabelText("数式 / 参照") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Good" } });
    fireEvent.change(formulaInput, { target: { value: "A1" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByText(/= で始める/)).toBeTruthy();
  });

  it("deletes a range when its delete button is clicked", () => {
    render(
      <NamedRangesDialog
        initialRanges={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    const taxRow = screen.getByText("TaxRate").closest("li")!;
    fireEvent.click(within(taxRow).getByRole("button", { name: /TaxRate を削除/ }));
    expect(screen.queryByText("TaxRate")).toBeNull();
    // 適用 still propagates the deletion to the parent.
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].map((r) => r.name)).toEqual(["Region"]);
  });

  it("ESC closes the dialog without calling onSave", () => {
    render(
      <NamedRangesDialog
        initialRanges={SEED}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

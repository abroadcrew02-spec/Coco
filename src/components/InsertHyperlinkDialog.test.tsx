// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import InsertHyperlinkDialog, { type HyperlinkFormValue } from "./InsertHyperlinkDialog";

// Simulate the snapshot mutation path EditorScreen.applyHyperlink does, so we
// verify the dialog -> snapshot wiring end-to-end. The dialog itself only
// emits a HyperlinkFormValue; the caller appends to sheets.<id>._hyperlinks.
function applyToSnapshot(
  snapshot: { sheets: Record<string, Record<string, unknown>> },
  sheetId: string,
  value: HyperlinkFormValue,
) {
  const sheet = snapshot.sheets[sheetId];
  const existing = Array.isArray(sheet._hyperlinks)
    ? (sheet._hyperlinks as Array<Record<string, unknown>>)
    : [];
  const filtered = existing.filter((e) => e.cell !== value.cell);
  const entry: Record<string, string> = { cell: value.cell, target: value.target };
  if (value.display) entry.display = value.display;
  if (value.tooltip) entry.tooltip = value.tooltip;
  sheet._hyperlinks = [...filtered, entry];
}

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onApply: ReturnType<typeof vi.fn<(value: HyperlinkFormValue) => void>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  onApply = vi.fn<(value: HyperlinkFormValue) => void>();
});

afterEach(() => cleanup());

describe("InsertHyperlinkDialog", () => {
  it("prefills the active cell, validates the URL, and feeds the snapshot _hyperlinks array on apply", () => {
    render(
      <InsertHyperlinkDialog
        initialCell="B3"
        initialDisplay="Old text"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    // Cell input is prefilled with the active-cell anchor.
    const cellInput = screen.getByLabelText("セル") as HTMLInputElement;
    expect(cellInput.value).toBe("B3");

    const targetInput = screen.getByLabelText("リンク先") as HTMLInputElement;
    const displayInput = screen.getByLabelText("表示テキスト") as HTMLInputElement;
    const tooltipInput = screen.getByLabelText("ヒント") as HTMLInputElement;

    // Bad scheme rejected. The error text and the footer hint both mention
    // the valid schemes, so we scope the assertion to the dialog's error class
    // to avoid the multiple-match ambiguity.
    fireEvent.change(targetInput, { target: { value: "ftp://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));
    const errorEl = document.querySelector(".ih-error");
    expect(errorEl?.textContent).toMatch(/http:\/\/, https:\/\/, mailto:/);
    expect(onApply).not.toHaveBeenCalled();

    // Good URL passes; display field already has the prefilled text.
    fireEvent.change(targetInput, { target: { value: "https://example.com" } });
    fireEvent.change(displayInput, { target: { value: "Example" } });
    fireEvent.change(tooltipInput, { target: { value: "click me" } });
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const value = onApply.mock.calls[0][0];
    expect(value).toEqual({
      cell: "B3",
      target: "https://example.com",
      display: "Example",
      tooltip: "click me",
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Simulate the EditorScreen-side snapshot append and verify the shape
    // matches the _hyperlinks contract documented in xlsx_io.rs.
    const snapshot = { sheets: { "sheet-1": { id: "sheet-1" } } } as {
      sheets: Record<string, Record<string, unknown>>;
    };
    applyToSnapshot(snapshot, "sheet-1", value);
    const links = snapshot.sheets["sheet-1"]._hyperlinks as Array<Record<string, string>>;
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      cell: "B3",
      target: "https://example.com",
      display: "Example",
      tooltip: "click me",
    });
  });

  it("accepts internal '#Sheet2!A1' targets without a scheme", () => {
    render(
      <InsertHyperlinkDialog
        initialCell="A1"
        onApply={onApply}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("リンク先"), {
      target: { value: "#Sheet2!A1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].target).toBe("#Sheet2!A1");
    // Display defaults to the target when the user leaves the display field empty.
    expect(onApply.mock.calls[0][0].display).toBe("#Sheet2!A1");
  });

  it("ESC closes without applying", () => {
    render(
      <InsertHyperlinkDialog
        initialCell="A1"
        onApply={onApply}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});

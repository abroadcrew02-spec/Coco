// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import SheetTabColorDialog from "./SheetTabColorDialog";

// Simulate the EditorScreen.applyTabColor snapshot mutation so we verify the
// dialog -> snapshot wiring end-to-end. Mirrors the InsertHyperlinkDialog
// test pattern: the dialog only emits a color; the caller writes _tabColor.
function applyToSnapshot(
  snapshot: { sheets: Record<string, Record<string, unknown>> },
  sheetId: string,
  color: string | null,
) {
  const sheet = snapshot.sheets[sheetId];
  if (color === null) {
    delete sheet._tabColor;
  } else {
    sheet._tabColor = color;
  }
}

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onApply: ReturnType<typeof vi.fn<(color: string | null) => void>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  onApply = vi.fn<(color: string | null) => void>();
});

afterEach(() => cleanup());

describe("SheetTabColorDialog", () => {
  it("applies a palette swatch as upper-case #RRGGBB into the snapshot", () => {
    render(
      <SheetTabColorDialog
        sheetName="Sheet1"
        initialColor={null}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    // Pick the "赤" swatch (FF0000) from the palette.
    const redSwatch = screen.getByRole("radio", { name: "赤" });
    fireEvent.click(redSwatch);
    fireEvent.click(screen.getByTestId("stc-apply"));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toBe("#FF0000");
    expect(onClose).toHaveBeenCalledTimes(1);

    const snapshot = { sheets: { "sheet-1": { id: "sheet-1" } } } as {
      sheets: Record<string, Record<string, unknown>>;
    };
    applyToSnapshot(snapshot, "sheet-1", onApply.mock.calls[0][0]);
    expect(snapshot.sheets["sheet-1"]._tabColor).toBe("#FF0000");
  });

  it("normalizes a lower-case custom hex without leading #", () => {
    render(
      <SheetTabColorDialog
        sheetName="Sheet1"
        initialColor={null}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    const custom = screen.getByLabelText("カスタム (#RRGGBB)") as HTMLInputElement;
    fireEvent.change(custom, { target: { value: "217346" } });
    fireEvent.click(screen.getByTestId("stc-apply"));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toBe("#217346");
  });

  it("rejects a malformed hex and keeps the dialog open", () => {
    render(
      <SheetTabColorDialog
        sheetName="Sheet1"
        initialColor={null}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    const custom = screen.getByLabelText("カスタム (#RRGGBB)") as HTMLInputElement;
    fireEvent.change(custom, { target: { value: "not-a-color" } });
    fireEvent.click(screen.getByTestId("stc-apply"));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const errorEl = document.querySelector(".stc-error");
    expect(errorEl?.textContent).toMatch(/#RRGGBB/);
  });

  it("the remove-color button emits null and drops the _tabColor key from the snapshot", () => {
    render(
      <SheetTabColorDialog
        sheetName="Sheet1"
        initialColor="#FF0000"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("stc-remove"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);

    const snapshot = {
      sheets: { "sheet-1": { id: "sheet-1", _tabColor: "#FF0000" } },
    } as { sheets: Record<string, Record<string, unknown>> };
    applyToSnapshot(snapshot, "sheet-1", onApply.mock.calls[0][0]);
    expect(snapshot.sheets["sheet-1"]._tabColor).toBeUndefined();
  });

  it("preselects the initialColor swatch and ESC closes without applying", () => {
    render(
      <SheetTabColorDialog
        sheetName="売上"
        initialColor="#00b050"
        onApply={onApply}
        onClose={onClose}
      />,
    );

    // Header reflects the sheet name.
    expect(screen.getByText(/タブの色: 売上/)).toBeTruthy();
    // The "緑" swatch (#00B050) is the selected radio after case-normalization.
    const green = screen.getByRole("radio", { name: "緑" });
    expect(green.getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});

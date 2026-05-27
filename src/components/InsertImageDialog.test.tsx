// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import InsertImageDialog, {
  type ImageFormValue,
  type ImagePickResult,
} from "./InsertImageDialog";

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onApply: ReturnType<typeof vi.fn<(value: ImageFormValue) => string | null>>;

beforeEach(() => {
  onClose = vi.fn<() => void>();
  // Default success: onApply returns null so the dialog closes after submit.
  // Tests that want the rejection path can override with mockReturnValue("…").
  onApply = vi
    .fn<(value: ImageFormValue) => string | null>()
    .mockReturnValue(null);
});

afterEach(() => cleanup());

describe("InsertImageDialog", () => {
  it("picks a file via the injected picker and emits the right apply payload", async () => {
    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zy3DOoAAAAASUVORK5CYII=";
    const pickFile = vi.fn<() => Promise<ImagePickResult | null>>().mockResolvedValue({
      ext: "png",
      base64: fakeBase64,
      name: "pixel.png",
    });

    render(
      <InsertImageDialog
        initialCell="C4"
        pickFile={pickFile}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    // The anchor cell input is prefilled with the active-cell anchor.
    const cellInput = screen.getByLabelText("アンカーセル") as HTMLInputElement;
    expect(cellInput.value).toBe("C4");

    // Submit-before-picking is rejected.
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));
    expect(onApply).not.toHaveBeenCalled();
    // The Insert button is disabled until a file is picked; the dialog's
    // error state is set via the picker-required branch when clicked.
    // (Browsers ignore clicks on disabled buttons, so we don't assert the
    // error message here — the disabled state is the primary UX signal.)

    // Pick a file.
    fireEvent.click(screen.getByRole("button", { name: /ファイルを選択/ }));
    await waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      // Filename is displayed once the picker resolves.
      expect(screen.getByText(/pixel\.png/)).toBeTruthy();
    });

    // Now submit.
    fireEvent.click(screen.getByRole("button", { name: "挿入" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const value = onApply.mock.calls[0][0];
    expect(value).toEqual({
      cell: "C4",
      ext: "png",
      base64: fakeBase64,
      name: "pixel.png",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ESC closes without applying", () => {
    const pickFile = vi.fn<() => Promise<ImagePickResult | null>>().mockResolvedValue(null);
    render(
      <InsertImageDialog
        initialCell="A1"
        pickFile={pickFile}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});

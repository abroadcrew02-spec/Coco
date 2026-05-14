// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import InsertCommentDialog, { type CommentEntry } from "./InsertCommentDialog";

let onApply: ReturnType<typeof vi.fn<(e: CommentEntry) => void>>;
let onDelete: ReturnType<typeof vi.fn<() => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  onApply = vi.fn<(e: CommentEntry) => void>();
  onDelete = vi.fn<() => void>();
  onClose = vi.fn<() => void>();
});

afterEach(() => cleanup());

describe("InsertCommentDialog", () => {
  it("submits a new comment with the cell ref, edited text, and default author", () => {
    render(
      <InsertCommentDialog
        cellRef="B2"
        initialEntry={null}
        defaultAuthor="Yamada"
        onApply={onApply}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );

    // No existing entry → "削除" button is not rendered.
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();

    // The author field is pre-filled with the OS-derived default.
    const authorInput = screen.getByLabelText("作成者") as HTMLInputElement;
    expect(authorInput.value).toBe("Yamada");

    // Fill in the comment text. Author is left untouched so the default
    // propagates through to the apply payload.
    const textInput = screen.getByLabelText("コメント") as HTMLTextAreaElement;
    fireEvent.change(textInput, { target: { value: "Quarterly target" } });

    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({
      cell: "B2",
      author: "Yamada",
      text: "Quarterly target",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });
});

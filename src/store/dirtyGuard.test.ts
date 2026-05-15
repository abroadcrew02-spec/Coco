// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import { confirmDiscardIfUnsaved } from "./dirtyGuard";
import { useWorkbookStore } from "./useWorkbookStore";

let confirmFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useWorkbookStore.setState({
    screen: "home",
    currentHandle: null,
    saveStatus: "saved",
    importWarnings: [],
    exportWarnings: [],
    blockingImport: null,
    currentSnapshotJson: null,
    lastError: null,
  });
  // happy-dom doesn't provide window.confirm — install our own mock.
  confirmFn = vi.fn();
  // @ts-expect-error - overriding the DOM stub for testing
  window.confirm = confirmFn;
});

describe("confirmDiscardIfUnsaved", () => {
  it("returns true on home screen without prompting", () => {
    useWorkbookStore.setState({ screen: "home", saveStatus: "unsaved" });
    expect(confirmDiscardIfUnsaved()).toBe(true);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it("returns true in editor when saveStatus is not 'unsaved'", () => {
    useWorkbookStore.setState({ screen: "editor", saveStatus: "saved" });
    expect(confirmDiscardIfUnsaved()).toBe(true);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it("prompts in editor with unsaved changes and returns the user's choice", () => {
    useWorkbookStore.setState({ screen: "editor", saveStatus: "unsaved" });
    confirmFn.mockReturnValue(true);
    expect(confirmDiscardIfUnsaved()).toBe(true);
    expect(confirmFn).toHaveBeenCalledTimes(1);

    confirmFn.mockReturnValue(false);
    expect(confirmDiscardIfUnsaved()).toBe(false);
    expect(confirmFn).toHaveBeenCalledTimes(2);
  });

  it("prompts in editor after a save failure", () => {
    useWorkbookStore.setState({ screen: "editor", saveStatus: "save_failed" });
    confirmFn.mockReturnValue(false);
    expect(confirmDiscardIfUnsaved()).toBe(false);
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });

  it("uses the custom message when provided", () => {
    useWorkbookStore.setState({ screen: "editor", saveStatus: "unsaved" });
    confirmFn.mockReturnValue(true);
    confirmDiscardIfUnsaved("カスタムメッセージ");
    expect(confirmFn).toHaveBeenCalledWith("カスタムメッセージ");
  });

  it("uses the default message when none provided", () => {
    useWorkbookStore.setState({ screen: "editor", saveStatus: "unsaved" });
    confirmFn.mockReturnValue(false);
    confirmDiscardIfUnsaved();
    const arg = confirmFn.mock.calls[0][0] as string;
    expect(arg).toContain("未保存の変更");
  });
});

// @vitest-environment happy-dom
//
// Behavioral tests for the ribbon (#198): tab switching, keyboard navigation
// of the tab strip, and that buttons fire their declared action — editor
// commands via the `coco:editor-command` window event, Univer ops via the
// `onUniverAction` prop.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import Ribbon from "./Ribbon";

const emitMock = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ emit: emitMock }),
}));

let onUniverAction: ReturnType<typeof vi.fn>;
let onGoHome: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onUniverAction = vi.fn();
  onGoHome = vi.fn();
  emitMock.mockClear();
});

afterEach(() => cleanup());

function renderRibbon() {
  return render(
    <Ribbon
      onUniverAction={onUniverAction}
      onGoHome={onGoHome}
      fileLabel="Book1.xlsx"
    />,
  );
}

describe("Ribbon — tabs", () => {
  it("renders a tablist with the eight Excel tabs (File + Tools, #202)", () => {
    renderRibbon();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(8);
  });

  it("starts on the File tab with its panel visible (#202)", () => {
    renderRibbon();
    const file = screen.getByRole("tab", { name: /^file$|ファイル/i });
    expect(file.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("id")).toBe(
      "ribbon-panel-file",
    );
  });

  it("switches the panel when another tab is clicked", () => {
    renderRibbon();
    const insert = screen.getByRole("tab", { name: /insert|挿入/i });
    fireEvent.click(insert);
    expect(insert.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("id")).toBe(
      "ribbon-panel-insert",
    );
  });

  it("ArrowRight moves selection to the next tab", () => {
    renderRibbon();
    const file = screen.getByRole("tab", { name: /^file$|ファイル/i });
    fireEvent.keyDown(file, { key: "ArrowRight" });
    const home = screen.getByRole("tab", { name: /home|ホーム/i });
    expect(home.getAttribute("aria-selected")).toBe("true");
  });

  it("End jumps to the last tab, Home back to the first", () => {
    renderRibbon();
    const first = screen.getByRole("tab", { name: /^file$|ファイル/i });
    fireEvent.keyDown(first, { key: "End" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[tabs.length - 1], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("renders the Home button and file name in the tab strip (#202)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("button", { name: /home|ホーム/i }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Book1.xlsx")).toBeTruthy();
  });
});

describe("Ribbon — button actions", () => {
  it("editorCommand button dispatches coco:editor-command", () => {
    const handler = vi.fn();
    window.addEventListener("coco:editor-command", handler);
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    // Format Painter on the Home tab is an editorCommand button.
    fireEvent.click(screen.getByRole("button", { name: /format painter|書式のコピー/i }));
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.detail).toBe("format-painter");
    window.removeEventListener("coco:editor-command", handler);
  });

  it("univer button invokes onUniverAction with its op id", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    fireEvent.click(screen.getByRole("button", { name: /^bold$|太字/i }));
    expect(onUniverAction).toHaveBeenCalledWith("bold");
  });

  it("menuAction button emits the menu-action window event (#202)", () => {
    renderRibbon();
    // The File tab is active by default; "Save" is a menuAction button.
    fireEvent.click(screen.getByRole("button", { name: /^save$|^保存$/i }));
    expect(emitMock).toHaveBeenCalledWith("menu-action", "save");
  });

  it("only the active tab's buttons are rendered", () => {
    renderRibbon();
    // PivotTable lives on the Insert tab — absent while File is active.
    expect(
      screen.queryByRole("button", { name: /pivottable|ピボットテーブル/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /insert|挿入/i }));
    expect(
      screen.getByRole("button", { name: /pivottable|ピボットテーブル/i }),
    ).toBeTruthy();
  });
});

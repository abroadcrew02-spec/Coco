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
    // #202 Phase 3: the op carries an optional color arg, `undefined` for a
    // plain (non-palette) button like Bold.
    expect(onUniverAction).toHaveBeenCalledWith("bold", undefined);
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

  it("File tab exposes the Exit (close) button (#202)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("button", { name: /^exit$|^終了$/i }));
    expect(emitMock).toHaveBeenCalledWith("menu-action", "close");
  });
});

describe("Ribbon — dropdown buttons (#202 Phase 3)", () => {
  function fontColorButton() {
    return screen.getByRole("button", { name: /font color|フォントの色/i });
  }

  it("a dropdown button does not fire its action on a plain click — it opens", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    const btn = fontColorButton();
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(onUniverAction).not.toHaveBeenCalled();
    // The color palette popover is now open.
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("a color-palette swatch fires the univer op with the chosen color", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    fireEvent.click(fontColorButton());
    // #203 m1: swatches are plain `menuitem`s (action triggers, not radios).
    const swatches = screen
      .getAllByRole("menuitem")
      .filter((el) => el.classList.contains("ribbon-dropdown__swatch"));
    expect(swatches.length).toBeGreaterThan(0);
    fireEvent.click(swatches[1]);
    expect(onUniverAction).toHaveBeenCalledTimes(1);
    const [op, color] = onUniverAction.mock.calls[0];
    expect(op).toBe("fontColor");
    expect(typeof color).toBe("string");
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("selecting a swatch closes the popover", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    fireEvent.click(fontColorButton());
    const swatch = screen
      .getAllByRole("menuitem")
      .find((el) => el.classList.contains("ribbon-dropdown__swatch"))!;
    fireEvent.click(swatch);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(fontColorButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the popover", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    fireEvent.click(fontColorButton());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a menu dropdown item fires an editor command and closes", () => {
    const handler = vi.fn();
    window.addEventListener("coco:editor-command", handler);
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    // The Number Format button owns a menu dropdown.
    fireEvent.click(
      screen.getByRole("button", { name: /number format|表示形式/i }),
    );
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBeGreaterThan(0);
    fireEvent.click(items[2]); // 通貨 / Currency → format-currency
    expect(handler).toHaveBeenCalled();
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.detail).toBe("format-currency");
    expect(screen.queryByRole("menu")).toBeNull();
    window.removeEventListener("coco:editor-command", handler);
  });
});

describe("Ribbon — dropdown bug fixes (#203)", () => {
  function fontColorButton() {
    return screen.getByRole("button", { name: /font color|フォントの色/i });
  }

  // #203 C1: re-clicking the trigger of an open dropdown must close it. The
  // outside-pointerdown listener must treat the trigger as "not outside" so it
  // doesn't close-then-reopen on the following click.
  it("re-clicking the trigger of an open dropdown closes it (C1)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    const btn = fontColorButton();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
    // Re-click: the real browser sequence is pointerdown (capture) then click.
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // #203 M1: an outside click closes the popover but must NOT yank focus back
  // to the trigger — focus should land wherever the user clicked.
  it("an outside click closes the popover without restoring trigger focus (M1)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    const btn = fontColorButton();
    fireEvent.click(btn);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(btn);
  });

  // #203 M1 (counterpart): Escape DOES restore focus to the trigger.
  it("Escape closes the popover and restores trigger focus (M1)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    const btn = fontColorButton();
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  // #203 M2: the color palette must not nest a non-menuitem inside role="menu".
  // The native <input type=color> is replaced by a `menuitem` button.
  it("the 'more colors' control is a menuitem, not a raw color input (M2)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    fireEvent.click(fontColorButton());
    const more = screen.getByRole("menuitem", {
      name: /more colors|その他の色/i,
    });
    expect(more.tagName).toBe("BUTTON");
    // No raw color input participates in the menu's accessibility tree.
    const menu = screen.getByRole("menu");
    expect(menu.querySelectorAll('input[type="color"]:not([aria-hidden])'))
      .toHaveLength(0);
  });

  // #203 M3: Tab closes the dropdown so it isn't left orphaned-open.
  it("Tab closes the dropdown (M3)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    fireEvent.click(fontColorButton());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // #203 m1/m2: swatches are `menuitem` (not `menuitemradio`) and grouped.
  it("color swatches are menuitems wrapped in a role=group (m1/m2)", () => {
    renderRibbon();
    fireEvent.click(screen.getByRole("tab", { name: /home|ホーム/i }));
    fireEvent.click(fontColorButton());
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    const swatches = screen
      .getAllByRole("menuitem")
      .filter((el) => el.classList.contains("ribbon-dropdown__swatch"));
    expect(swatches.length).toBeGreaterThan(0);
    expect(swatches[0].getAttribute("aria-checked")).toBeNull();
    // The swatch grid itself carries role=group inside the menu.
    expect(swatches[0].closest('[role="group"]')).not.toBeNull();
  });
});

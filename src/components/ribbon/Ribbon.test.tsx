// @vitest-environment happy-dom
//
// Behavioral tests for the ribbon (#198): tab switching, keyboard navigation
// of the tab strip, and that buttons fire their declared action — editor
// commands via the `coco:editor-command` window event, Univer ops via the
// `onUniverAction` prop.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import Ribbon from "./Ribbon";

let onUniverAction: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onUniverAction = vi.fn();
});

afterEach(() => cleanup());

describe("Ribbon — tabs", () => {
  it("renders a tablist with the six Excel tabs", () => {
    render(<Ribbon onUniverAction={onUniverAction} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
  });

  it("starts on the Home tab with its panel visible", () => {
    render(<Ribbon onUniverAction={onUniverAction} />);
    const home = screen.getByRole("tab", { name: /home|ホーム/i });
    expect(home.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("id")).toBe(
      "ribbon-panel-home",
    );
  });

  it("switches the panel when another tab is clicked", () => {
    render(<Ribbon onUniverAction={onUniverAction} />);
    const insert = screen.getByRole("tab", { name: /insert|挿入/i });
    fireEvent.click(insert);
    expect(insert.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("id")).toBe(
      "ribbon-panel-insert",
    );
  });

  it("ArrowRight moves selection to the next tab", () => {
    render(<Ribbon onUniverAction={onUniverAction} />);
    const home = screen.getByRole("tab", { name: /home|ホーム/i });
    fireEvent.keyDown(home, { key: "ArrowRight" });
    const insert = screen.getByRole("tab", { name: /insert|挿入/i });
    expect(insert.getAttribute("aria-selected")).toBe("true");
  });

  it("End jumps to the last tab, Home back to the first", () => {
    render(<Ribbon onUniverAction={onUniverAction} />);
    const first = screen.getByRole("tab", { name: /home|ホーム/i });
    fireEvent.keyDown(first, { key: "End" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[tabs.length - 1], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });
});

describe("Ribbon — button actions", () => {
  it("editorCommand button dispatches coco:editor-command", () => {
    const handler = vi.fn();
    window.addEventListener("coco:editor-command", handler);
    render(<Ribbon onUniverAction={onUniverAction} />);
    // Format Painter on the Home tab is an editorCommand button.
    fireEvent.click(screen.getByRole("button", { name: /format painter|書式のコピー/i }));
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.detail).toBe("format-painter");
    window.removeEventListener("coco:editor-command", handler);
  });

  it("univer button invokes onUniverAction with its op id", () => {
    render(<Ribbon onUniverAction={onUniverAction} />);
    fireEvent.click(screen.getByRole("button", { name: /^bold$|太字/i }));
    expect(onUniverAction).toHaveBeenCalledWith("bold");
  });

  it("only the active tab's buttons are rendered", () => {
    render(<Ribbon onUniverAction={onUniverAction} />);
    // PivotTable lives on the Insert tab — absent while Home is active.
    expect(
      screen.queryByRole("button", { name: /pivottable|ピボットテーブル/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /insert|挿入/i }));
    expect(
      screen.getByRole("button", { name: /pivottable|ピボットテーブル/i }),
    ).toBeTruthy();
  });
});

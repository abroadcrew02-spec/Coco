// @vitest-environment happy-dom
// Tests for the modal focus-trap hook (#177).

import { describe, it, expect, afterEach, vi } from "vitest";
import { useRef, useState } from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useFocusTrap, getFocusableElements } from "./useFocusTrap";

// A minimal dialog harness exercising the hook.
function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true">
      <button type="button" data-testid="first">
        First
      </button>
      <input data-testid="middle" />
      <button type="button" data-testid="last">
        Last
      </button>
    </div>
  );
}

describe("getFocusableElements", () => {
  afterEach(cleanup);

  it("collects focusable descendants in DOM order", () => {
    const { container } = render(
      <div>
        <a href="#x">link</a>
        <button type="button">btn</button>
        <input />
        <button type="button" disabled>
          disabled
        </button>
        <span tabIndex={-1}>not focusable</span>
      </div>,
    );
    const els = getFocusableElements(container.firstChild as HTMLElement);
    // link, button, input — disabled button and tabindex=-1 span excluded.
    expect(els).toHaveLength(3);
    expect(els[0].tagName).toBe("A");
    expect(els[1].tagName).toBe("BUTTON");
    expect(els[2].tagName).toBe("INPUT");
  });
});

describe("useFocusTrap", () => {
  afterEach(cleanup);

  it("focuses the first focusable element on mount", () => {
    const { getByTestId } = render(<Dialog onClose={() => {}} />);
    expect(document.activeElement).toBe(getByTestId("first"));
  });

  it("invokes onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    const { getByRole } = render(<Dialog onClose={onClose} />);
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps focus from the last element to the first on Tab", () => {
    const { getByTestId, getByRole } = render(<Dialog onClose={() => {}} />);
    const last = getByTestId("last");
    last.focus();
    fireEvent.keyDown(getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(getByTestId("first"));
  });

  it("wraps focus from the first element to the last on Shift+Tab", () => {
    const { getByTestId, getByRole } = render(<Dialog onClose={() => {}} />);
    const first = getByTestId("first");
    first.focus();
    fireEvent.keyDown(getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByTestId("last"));
  });

  it("restores focus to the trigger element on unmount", () => {
    // A trigger button outside the dialog gets focus before the dialog opens.
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<Dialog onClose={() => {}} />);
    // The dialog stole focus on mount.
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    // ...and returns it to the trigger on close.
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });

  it("does not trap focus when disabled", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    function InertDialog() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, () => {}, false);
      return (
        <div ref={ref} role="dialog">
          <button type="button" data-testid="inert-btn">
            x
          </button>
        </div>
      );
    }
    render(<InertDialog />);
    // Disabled — focus stays on the trigger.
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});

// #177 review M1: nested dialogs live under independent backdrops (not DOM
// nested), so each trap registers on a module-level stack. Only the top-most
// trap handles Tab/Escape; closing it must reactivate the one below.
describe("useFocusTrap — nested dialogs", () => {
  afterEach(cleanup);

  // A standalone dialog under its own backdrop — mirrors how the real app
  // renders each modal (not nested inside the dialog that opened it).
  function NamedDialog({
    name,
    onClose,
  }: {
    name: string;
    onClose: () => void;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    useFocusTrap(ref, onClose);
    return (
      <div ref={ref} role="dialog" aria-label={name}>
        <button type="button" data-testid={`${name}-first`}>
          {name} first
        </button>
        <button type="button" data-testid={`${name}-last`}>
          {name} last
        </button>
      </div>
    );
  }

  it("only the top-most trap handles Escape", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const { getByLabelText } = render(
      <>
        <NamedDialog name="A" onClose={closeA} />
        <NamedDialog name="B" onClose={closeB} />
      </>,
    );
    // Escape on the lower dialog A is inert — A is not top-most.
    fireEvent.keyDown(getByLabelText("A"), { key: "Escape" });
    expect(closeA).not.toHaveBeenCalled();
    // Escape on the top-most dialog B closes B.
    fireEvent.keyDown(getByLabelText("B"), { key: "Escape" });
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("only the top-most trap handles Tab", () => {
    const { getByTestId, getByLabelText } = render(
      <>
        <NamedDialog name="A" onClose={() => {}} />
        <NamedDialog name="B" onClose={() => {}} />
      </>,
    );
    // Tab wrap inside the lower dialog A is inert — focus does not move.
    const aLast = getByTestId("A-last");
    aLast.focus();
    fireEvent.keyDown(getByLabelText("A"), { key: "Tab" });
    expect(document.activeElement).toBe(aLast);

    // Tab wrap inside the top-most dialog B works.
    const bLast = getByTestId("B-last");
    bLast.focus();
    fireEvent.keyDown(getByLabelText("B"), { key: "Tab" });
    expect(document.activeElement).toBe(getByTestId("B-first"));
  });

  it("reactivates the lower trap when the top dialog closes", () => {
    const closeA = vi.fn();

    function Nested() {
      const [bOpen, setBOpen] = useState(true);
      return (
        <>
          <NamedDialog name="A" onClose={closeA} />
          {bOpen && <NamedDialog name="B" onClose={() => setBOpen(false)} />}
        </>
      );
    }

    const { getByLabelText } = render(<Nested />);
    // Close B (top-most).
    fireEvent.keyDown(getByLabelText("B"), { key: "Escape" });

    // A is now top-most again — its Escape handler fires.
    fireEvent.keyDown(getByLabelText("A"), { key: "Escape" });
    expect(closeA).toHaveBeenCalledTimes(1);

    // ...and A's Tab handling is live again.
    const aLast = getByLabelText("A").querySelector(
      '[data-testid="A-last"]',
    ) as HTMLElement;
    aLast.focus();
    fireEvent.keyDown(getByLabelText("A"), { key: "Tab" });
    expect(
      (document.activeElement as HTMLElement).getAttribute("data-testid"),
    ).toBe("A-first");
  });
});

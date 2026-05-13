// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Stub the heavy dynamic import target so the test doesn't pull in Univer.
vi.mock("../components/EditorScreen", () => ({ default: () => null }));

import { useEditorPreload } from "./useEditorPreload";

function Probe() {
  useEditorPreload();
  return null;
}

interface IdleWindow {
  requestIdleCallback?: (cb: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
}

let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setTimeoutSpy = vi.spyOn(window, "setTimeout");
  clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
});

afterEach(() => {
  cleanup();
  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
  // Clean up the rIC stubs we may have installed.
  const w = window as unknown as IdleWindow;
  delete w.requestIdleCallback;
  delete w.cancelIdleCallback;
});

describe("useEditorPreload", () => {
  describe("with requestIdleCallback support", () => {
    it("registers an idle callback and a setTimeout fallback", () => {
      const ric = vi.fn().mockReturnValue(42);
      const cancel = vi.fn();
      const w = window as unknown as IdleWindow;
      w.requestIdleCallback = ric;
      w.cancelIdleCallback = cancel;

      render(<Probe />);
      expect(ric).toHaveBeenCalledTimes(1);
      // Fallback is registered with an ~800ms delay.
      expect(setTimeoutSpy).toHaveBeenCalled();
      const lastCall = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
      expect(lastCall[1]).toBe(800);
    });

    it("unmount cancels both the idle handle and the timeout fallback", () => {
      const ric = vi.fn().mockReturnValue(7);
      const cancel = vi.fn();
      const w = window as unknown as IdleWindow;
      w.requestIdleCallback = ric;
      w.cancelIdleCallback = cancel;

      const { unmount } = render(<Probe />);
      unmount();
      expect(cancel).toHaveBeenCalledWith(7);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe("without requestIdleCallback support", () => {
    it("still registers the setTimeout fallback", () => {
      // happy-dom doesn't ship rIC by default — confirm the fallback is set up.
      const w = window as unknown as IdleWindow;
      expect(w.requestIdleCallback).toBeUndefined();

      render(<Probe />);
      expect(setTimeoutSpy).toHaveBeenCalled();
      const lastCall = setTimeoutSpy.mock.calls[setTimeoutSpy.mock.calls.length - 1];
      expect(lastCall[1]).toBe(800);
    });

    it("unmount clears the fallback without trying to cancel an idle handle", () => {
      const w = window as unknown as IdleWindow;
      expect(w.cancelIdleCallback).toBeUndefined();

      const { unmount } = render(<Probe />);
      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalled();
      // No throw despite cancelIdleCallback being undefined.
    });
  });

  it("does not throw when EditorScreen import resolves later", async () => {
    // The hook fires the dynamic import but doesn't await it. Verify the
    // microtask queue can drain without unhandled rejections.
    render(<Probe />);
    await new Promise((r) => setTimeout(r, 0));
    // Nothing observable to assert beyond "doesn't crash"; the mocked module
    // returns successfully.
    expect(true).toBe(true);
  });
});

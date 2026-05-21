// @vitest-environment happy-dom
// Tests for the ARIA live region host (#177).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import LiveRegion from "./LiveRegion";
import { announce, announceError } from "../store/announce";

describe("LiveRegion", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a polite and an assertive live region", () => {
    render(<LiveRegion />);
    const polite = screen.getByTestId("live-region-polite");
    const assertive = screen.getByTestId("live-region-assertive");
    expect(polite.getAttribute("aria-live")).toBe("polite");
    expect(assertive.getAttribute("aria-live")).toBe("assertive");
    // aria-atomic ensures the whole message is re-read on change.
    expect(polite.getAttribute("aria-atomic")).toBe("true");
  });

  it("writes a polite announcement into the polite region", async () => {
    render(<LiveRegion />);
    announce("cell A1 selected");
    await waitFor(() => {
      expect(screen.getByTestId("live-region-polite").textContent).toBe(
        "cell A1 selected",
      );
    });
    // The assertive region stays empty.
    expect(screen.getByTestId("live-region-assertive").textContent).toBe("");
  });

  it("writes an assertive announcement into the assertive region", async () => {
    render(<LiveRegion />);
    announceError("save failed");
    await waitFor(() => {
      expect(screen.getByTestId("live-region-assertive").textContent).toBe(
        "save failed",
      );
    });
    expect(screen.getByTestId("live-region-polite").textContent).toBe("");
  });

  it("re-announces an identical repeated message (clear-then-set)", async () => {
    render(<LiveRegion />);
    announce("column A row 1");
    await waitFor(() => {
      expect(screen.getByTestId("live-region-polite").textContent).toBe(
        "column A row 1",
      );
    });
    // Same text again — the region must briefly clear so the SR re-reads it.
    announce("column A row 1");
    await waitFor(() => {
      expect(screen.getByTestId("live-region-polite").textContent).toBe(
        "column A row 1",
      );
    });
  });

  it("delivers a polite message even when assertive fires right after", async () => {
    // #177 review m1: polite and assertive use separate timers, so an
    // assertive announcement arriving before the polite write timer fires
    // must not cancel the pending polite write.
    render(<LiveRegion />);
    announce("polite message");
    announceError("assertive message");
    await waitFor(() => {
      expect(screen.getByTestId("live-region-polite").textContent).toBe(
        "polite message",
      );
      expect(screen.getByTestId("live-region-assertive").textContent).toBe(
        "assertive message",
      );
    });
  });

  it("uses the visually-hidden class so it stays in the a11y tree", () => {
    render(<LiveRegion />);
    expect(
      screen.getByTestId("live-region-polite").className,
    ).toContain("coco-visually-hidden");
  });
});

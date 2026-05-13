// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import BusyOverlay from "./BusyOverlay";

afterEach(() => cleanup());

describe("BusyOverlay", () => {
  it("renders the label inside an aria-live region", () => {
    render(<BusyOverlay label="読み込み中..." />);
    const status = screen.getByRole("status");
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toContain("読み込み中...");
  });

  it("defaults to blocking variant when prop omitted", () => {
    const { container } = render(<BusyOverlay label="待機中" />);
    const overlay = container.querySelector(".busy-overlay");
    expect(overlay?.className).toContain("busy-overlay--blocking");
    expect(overlay?.className).not.toContain("busy-overlay--passthrough");
  });

  it("renders passthrough variant when blocking=false", () => {
    const { container } = render(<BusyOverlay label="保存中..." blocking={false} />);
    const overlay = container.querySelector(".busy-overlay");
    expect(overlay?.className).toContain("busy-overlay--passthrough");
    expect(overlay?.className).not.toContain("busy-overlay--blocking");
  });

  it("renders blocking variant when blocking=true explicitly", () => {
    const { container } = render(<BusyOverlay label="loading" blocking={true} />);
    const overlay = container.querySelector(".busy-overlay");
    expect(overlay?.className).toContain("busy-overlay--blocking");
  });
});

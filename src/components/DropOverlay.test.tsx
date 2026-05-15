// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import DropOverlay from "./DropOverlay";

afterEach(() => cleanup());

describe("DropOverlay", () => {
  it("renders the drop hint and supported extensions", () => {
    const { container } = render(<DropOverlay />);
    expect(container.textContent).toContain("ここにファイルをドロップして開く");
    expect(container.textContent).toContain(".xlsx");
    expect(container.textContent).toContain(".xlsm");
    expect(container.textContent).toContain(".csv");
    // .coco is no longer advertised on user-visible surfaces (AD-02).
    expect(container.textContent).not.toContain(".coco");
  });

  it("is decorative (role=presentation, aria-hidden=true) — should not steal focus from a screenreader", () => {
    const { container } = render(<DropOverlay />);
    const root = container.querySelector(".drop-overlay");
    expect(root?.getAttribute("role")).toBe("presentation");
    expect(root?.getAttribute("aria-hidden")).toBe("true");
  });
});

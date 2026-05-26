// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import InGridChartLayer from "./InGridChartLayer";

afterEach(() => cleanup());

function makeSnapshot(sheetId: string, charts: unknown[]): string {
  return JSON.stringify({
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        name: "Sheet1",
        cellData: {
          "0": { "0": { v: "Q1" }, "1": { v: "Q2" } },
          "1": { "0": { v: 10 }, "1": { v: 20 } },
        },
        _charts: charts,
      },
    },
  });
}

// Step 3 compatibility: frame position/size are now CSS custom properties.
function getFrameVar(el: HTMLElement, name: string): string {
  return el.style.getPropertyValue(name).trim();
}

describe("InGridChartLayer — rendering", () => {
  it("renders chart frames for anchored entries", () => {
    const snap = makeSnapshot("s1", [
      {
        range: "A1:B2",
        type: "bar",
        anchorRow: 0,
        anchorCol: 0,
        widthPx: 480,
        heightPx: 300,
        hasHeaderRow: false,
        hasHeaderCol: false,
      },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId="s1" />,
    );
    const frames = container.querySelectorAll(".ingrid-chart-frame");
    expect(frames).toHaveLength(1);
    const frame = frames[0] as HTMLElement;
    expect(getFrameVar(frame, "--cf-width")).toBe("480px");
    expect(getFrameVar(frame, "--cf-height")).toBe("300px");
  });

  it("returns null when snapshot is null", () => {
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={null} activeSheetId="s1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when activeSheetId is null", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when the sheet has no anchor-complete charts", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "line" },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId="s1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("does not crash on invalid snapshot JSON", () => {
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson="{bad json" activeSheetId="s1" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("InGridChartLayer — Step 4: handles + drag", () => {
  it("renders 8 resize handles per chart frame", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId="s1" />,
    );
    const handles = container.querySelectorAll(".ingrid-chart-handle");
    expect(handles).toHaveLength(8);
  });

  it("each handle has a data-dir attribute for one of the 8 directions", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId="s1" />,
    );
    const dirs = new Set<string>();
    container.querySelectorAll(".ingrid-chart-handle").forEach((el) => {
      const d = (el as HTMLElement).dataset.dir;
      if (d) dirs.add(d);
    });
    expect(dirs).toEqual(new Set(["nw", "n", "ne", "e", "se", "s", "sw", "w"]));
  });

  it("renders a chart-body inside each frame", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId="s1" />,
    );
    expect(container.querySelectorAll(".ingrid-chart-body")).toHaveLength(1);
  });

  it("calls onChartChange after a body drag-move sequence", () => {
    const onChartChange = vi.fn();
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 2, anchorCol: 2, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer
        workbookSnapshotJson={snap}
        activeSheetId="s1"
        onChartChange={onChartChange}
      />,
    );

    const body = container.querySelector(".ingrid-chart-body") as HTMLElement;

    // Simulate: pointerdown → pointermove → pointerup
    fireEvent.pointerDown(body, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(body, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(body, { clientX: 200, clientY: 150, pointerId: 1 });

    expect(onChartChange).toHaveBeenCalledOnce();
    const [sheetId, chartIndex, updated] = onChartChange.mock.calls[0] as [string, number, Record<string, unknown>];
    expect(sheetId).toBe("s1");
    expect(chartIndex).toBe(0);
    // After move the anchor should be non-negative integers.
    expect(typeof updated.anchorRow).toBe("number");
    expect(typeof updated.anchorCol).toBe("number");
    expect((updated.anchorRow as number)).toBeGreaterThanOrEqual(0);
    expect((updated.anchorCol as number)).toBeGreaterThanOrEqual(0);
    // Width/height should be preserved from original entry.
    expect(updated.widthPx).toBe(480);
    expect(updated.heightPx).toBe(300);
  });

  it("calls onChartChange after a handle resize sequence (se handle)", () => {
    const onChartChange = vi.fn();
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer
        workbookSnapshotJson={snap}
        activeSheetId="s1"
        onChartChange={onChartChange}
      />,
    );

    const seHandle = container.querySelector<HTMLElement>('.ingrid-chart-handle[data-dir="se"]')!;

    fireEvent.pointerDown(seHandle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(seHandle, { clientX: 100, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(seHandle, { clientX: 100, clientY: 80, pointerId: 1 });

    expect(onChartChange).toHaveBeenCalledOnce();
    const [, , updated] = onChartChange.mock.calls[0] as [string, number, Record<string, unknown>];
    // se resize only grows: width and height should be >= original minimums.
    expect((updated.widthPx as number)).toBeGreaterThanOrEqual(60);
    expect((updated.heightPx as number)).toBeGreaterThanOrEqual(40);
  });

  it("does not call onChartChange when onChartChange is not provided", () => {
    // Just verify it doesn't throw.
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId="s1" />,
    );
    const body = container.querySelector(".ingrid-chart-body") as HTMLElement;
    expect(() => {
      fireEvent.pointerDown(body, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerMove(body, { clientX: 20, clientY: 20, pointerId: 1 });
      fireEvent.pointerUp(body, { clientX: 20, clientY: 20, pointerId: 1 });
    }).not.toThrow();
  });

  it("ignores non-primary button (right-click) on body", () => {
    const onChartChange = vi.fn();
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 480, heightPx: 300 },
    ]);
    const { container } = render(
      <InGridChartLayer
        workbookSnapshotJson={snap}
        activeSheetId="s1"
        onChartChange={onChartChange}
      />,
    );
    const body = container.querySelector(".ingrid-chart-body") as HTMLElement;
    fireEvent.pointerDown(body, { button: 2, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(body, { clientX: 20, clientY: 20, pointerId: 1 });
    expect(onChartChange).not.toHaveBeenCalled();
  });

  it("multiple charts: each gets 8 handles", () => {
    const snap = makeSnapshot("s1", [
      { range: "A1:B2", type: "bar", anchorRow: 0, anchorCol: 0, widthPx: 200, heightPx: 150 },
      { range: "C1:D2", type: "line", anchorRow: 0, anchorCol: 4, widthPx: 200, heightPx: 150 },
    ]);
    const { container } = render(
      <InGridChartLayer workbookSnapshotJson={snap} activeSheetId="s1" />,
    );
    expect(container.querySelectorAll(".ingrid-chart-frame")).toHaveLength(2);
    expect(container.querySelectorAll(".ingrid-chart-handle")).toHaveLength(16);
  });
});

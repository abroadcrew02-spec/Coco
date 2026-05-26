// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
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

describe("InGridChartLayer", () => {
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
    expect(frame.style.width).toBe("480px");
    expect(frame.style.height).toBe("300px");
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

// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import WorkbookInquireDialog from "./WorkbookInquireDialog";

const sampleSnap = JSON.stringify({
  sheetOrder: ["s1"],
  sheets: {
    s1: {
      name: "Sheet1",
      cellData: {
        "0": {
          "0": { v: 42 },
          "1": { f: "=SUM(A1:A10)" },
          "2": { f: "=IF(A1>0, 1, 0)" },
          "3": { v: "#REF!", f: "=Z99" },
        },
      },
      _comments: [{ cell: "A1", text: "x" }],
      _cfRules: [{ type: "cellIs" }],
    },
  },
  namedRanges: [{ name: "Tax", ref: "Sheet1!B1" }],
});

describe("WorkbookInquireDialog", () => {
  it("renders the report sections from a snapshot", () => {
    render(<WorkbookInquireDialog snapshotJson={sampleSnap} onClose={() => {}} />);
    expect(screen.getByText("ブック診断 (Inquire)")).toBeTruthy();
    expect(screen.getByText("概要")).toBeTruthy();
    expect(screen.getByText("オブジェクト")).toBeTruthy();
    // Top functions section appears
    expect(
      screen.getByText(/よく使われる関数/),
    ).toBeTruthy();
    // SUM and IF show up as function names
    expect(screen.getByText("SUM")).toBeTruthy();
    expect(screen.getByText("IF")).toBeTruthy();
    // The #REF! error row
    expect(screen.getByText("#REF!")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<WorkbookInquireDialog snapshotJson={sampleSnap} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    const { container } = render(
      <WorkbookInquireDialog snapshotJson={sampleSnap} onClose={onClose} />,
    );
    const backdrop = container.querySelector(".wid-backdrop");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import CommandPalette, { type PaletteCommand } from "./CommandPalette";

let onClose: ReturnType<typeof vi.fn<() => void>>;
let saveRun: ReturnType<typeof vi.fn<() => void>>;
let exportRun: ReturnType<typeof vi.fn<() => void>>;
let chartRun: ReturnType<typeof vi.fn<() => void>>;
let commands: PaletteCommand[];

beforeEach(() => {
  onClose = vi.fn<() => void>();
  saveRun = vi.fn<() => void>();
  exportRun = vi.fn<() => void>();
  chartRun = vi.fn<() => void>();
  commands = [
    { id: "save", label: "保存", shortcut: "Ctrl+S", run: saveRun },
    { id: "export", label: "xlsx としてエクスポート", run: exportRun },
    { id: "chart", label: "グラフを挿入", keywords: "chart", run: chartRun },
  ];
});

afterEach(() => cleanup());

describe("CommandPalette", () => {
  it("filters the list as the user types", () => {
    render(<CommandPalette commands={commands} onClose={onClose} />);
    // All three rows visible initially.
    expect(screen.getByTestId("cp-row-save")).toBeTruthy();
    expect(screen.getByTestId("cp-row-export")).toBeTruthy();
    expect(screen.getByTestId("cp-row-chart")).toBeTruthy();

    // Typing narrows the list — "保存" only matches the Save command.
    const input = screen.getByLabelText("コマンド検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "保存" } });

    expect(screen.getByTestId("cp-row-save")).toBeTruthy();
    expect(screen.queryByTestId("cp-row-export")).toBeNull();
    expect(screen.queryByTestId("cp-row-chart")).toBeNull();

    // The keywords field is searched too — "chart" only hits グラフ.
    fireEvent.change(input, { target: { value: "chart" } });
    expect(screen.queryByTestId("cp-row-save")).toBeNull();
    expect(screen.queryByTestId("cp-row-export")).toBeNull();
    expect(screen.getByTestId("cp-row-chart")).toBeTruthy();
  });

  it("Enter on the highlighted row fires its run() and closes the palette", () => {
    render(<CommandPalette commands={commands} onClose={onClose} />);
    const input = screen.getByLabelText("コマンド検索") as HTMLInputElement;
    // Narrow to the export command so the first (highlighted) row is "xlsx ...".
    fireEvent.change(input, { target: { value: "xlsx" } });

    // Modal owns the keydown handler — fire on the dialog element.
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(exportRun).toHaveBeenCalledTimes(1);
    expect(saveRun).not.toHaveBeenCalled();
    expect(chartRun).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

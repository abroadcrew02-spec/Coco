// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StatusBarStats from "./StatusBarStats";
import {
  type SelectionStats,
  SELECTION_STATS_STORAGE_KEY,
} from "../store/selectionStats";

const NUMERIC: SelectionStats = {
  sum: 21,
  average: 3.5,
  count: 6,
  numericCount: 6,
  min: 1,
  max: 6,
};

const TEXT_ONLY: SelectionStats = {
  sum: null,
  average: null,
  count: 3,
  numericCount: 0,
  min: null,
  max: null,
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("StatusBarStats", () => {
  it("renders nothing when stats is null", () => {
    const { container } = render(<StatusBarStats stats={null} />);
    expect(container.querySelector(".status-bar-stats")).toBeNull();
  });

  it("shows the default items (平均 / データの個数 / 合計) for a numeric selection", () => {
    render(<StatusBarStats stats={NUMERIC} />);
    expect(screen.getByText(/平均: 3.5/)).toBeTruthy();
    expect(screen.getByText(/データの個数: 6/)).toBeTruthy();
    expect(screen.getByText(/合計: 21/)).toBeTruthy();
    // Not in the default set.
    expect(screen.queryByText(/最小値/)).toBeNull();
  });

  it("only shows データの個数 for a text-only selection (numeric items are N/A)", () => {
    render(<StatusBarStats stats={TEXT_ONLY} />);
    expect(screen.getByText(/データの個数: 3/)).toBeTruthy();
    expect(screen.queryByText(/平均/)).toBeNull();
    expect(screen.queryByText(/合計/)).toBeNull();
  });

  it("opens the customize menu on click and toggles an item with persistence", async () => {
    const user = userEvent.setup();
    const { container } = render(<StatusBarStats stats={NUMERIC} />);
    await user.click(
      container.querySelector(".status-bar-stats__summary") as HTMLElement,
    );
    const menu = screen.getByRole("menu");
    expect(menu).toBeTruthy();

    // Enable 最小値 (off by default).
    await user.click(screen.getByRole("menuitemcheckbox", { name: /最小値/ }));
    expect(screen.getByText(/最小値: 1/)).toBeTruthy();

    const persisted = JSON.parse(
      window.localStorage.getItem(SELECTION_STATS_STORAGE_KEY) ?? "[]",
    );
    expect(persisted).toContain("min");
  });

  it("restores visible items from localStorage on mount", () => {
    window.localStorage.setItem(
      SELECTION_STATS_STORAGE_KEY,
      JSON.stringify(["max"]),
    );
    render(<StatusBarStats stats={NUMERIC} />);
    expect(screen.getByText(/最大値: 6/)).toBeTruthy();
    expect(screen.queryByText(/合計/)).toBeNull();
  });

  it("closes the menu on Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<StatusBarStats stats={NUMERIC} />);
    await user.click(
      container.querySelector(".status-bar-stats__summary") as HTMLElement,
    );
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

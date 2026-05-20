import { describe, it, expect } from "vitest";
import {
  DEFAULT_VISIBLE_STATS,
  SELECTION_STAT_ITEMS,
  computeSelectionStats,
  formatStatValue,
  parseVisibleStats,
} from "./selectionStats";

describe("computeSelectionStats", () => {
  it("returns zero counts / null aggregates for empty input", () => {
    const expected = {
      sum: null,
      average: null,
      count: 0,
      numericCount: 0,
      min: null,
      max: null,
    };
    expect(computeSelectionStats(null)).toEqual(expected);
    expect(computeSelectionStats(undefined)).toEqual(expected);
    expect(computeSelectionStats([])).toEqual(expected);
    expect(computeSelectionStats([[]])).toEqual(expected);
  });

  it("aggregates a block of numbers", () => {
    expect(
      computeSelectionStats([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toEqual({
      sum: 21,
      average: 3.5,
      count: 6,
      numericCount: 6,
      min: 1,
      max: 6,
    });
  });

  it("counts text/blank cells but excludes them from numeric aggregates", () => {
    // Excel parity: "データの個数" = non-blank cells (text + number),
    // "数値の個数" = numbers only.
    const stats = computeSelectionStats([
      [10, "apple", ""],
      [null, 20, "  "],
      [undefined, "30は文字列ではない", 40],
    ]);
    expect(stats.numericCount).toBe(3); // 10, 20, 40
    expect(stats.count).toBe(5); // 10, apple, 20, "30は..." text, 40
    expect(stats.sum).toBe(70);
    expect(stats.average).toBeCloseTo(70 / 3);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(40);
  });

  it("treats numeric-looking strings as numbers (Univer editor input)", () => {
    const stats = computeSelectionStats([["42", "3.14", " 8 "]]);
    expect(stats.numericCount).toBe(3);
    expect(stats.sum).toBeCloseTo(53.14);
    expect(stats.count).toBe(3);
  });

  it("hides numeric aggregates when the selection has no numbers", () => {
    const stats = computeSelectionStats([
      ["foo", "bar"],
      ["baz", ""],
    ]);
    expect(stats).toEqual({
      sum: null,
      average: null,
      count: 3,
      numericCount: 0,
      min: null,
      max: null,
    });
  });

  it("ignores booleans for numeric aggregates but counts them as non-blank", () => {
    const stats = computeSelectionStats([[true, false, 5]]);
    expect(stats.numericCount).toBe(1);
    expect(stats.count).toBe(3);
    expect(stats.sum).toBe(5);
  });

  it("excludes non-finite numbers (NaN / Infinity) from aggregates", () => {
    const stats = computeSelectionStats([[NaN, Infinity, -Infinity, 7]]);
    expect(stats.numericCount).toBe(1);
    expect(stats.sum).toBe(7);
    expect(stats.min).toBe(7);
    expect(stats.max).toBe(7);
  });

  it("handles negatives and zero in min/max", () => {
    const stats = computeSelectionStats([[-5, 0, -10, 3]]);
    expect(stats.min).toBe(-10);
    expect(stats.max).toBe(3);
    expect(stats.sum).toBe(-12);
  });

  it("tolerates a ragged 2D array without throwing", () => {
    const stats = computeSelectionStats([[1, 2], [3], []]);
    expect(stats.sum).toBe(6);
    expect(stats.numericCount).toBe(3);
  });

  it("unwraps Univer ICellData cell objects ({ v, t }) as well as primitives", () => {
    const stats = computeSelectionStats([
      [{ v: 10 }, { v: "20" }, { v: "text" }],
      [{ v: null }, {}, 5],
    ]);
    expect(stats.numericCount).toBe(3); // 10, "20", 5
    expect(stats.count).toBe(4); // 10, "20", "text", 5
    expect(stats.sum).toBe(35);
    expect(stats.min).toBe(5);
    expect(stats.max).toBe(20);
  });
});

describe("formatStatValue", () => {
  it("groups thousands with the Japanese locale", () => {
    expect(formatStatValue(12345)).toBe("12,345");
  });

  it("caps fractional digits at two", () => {
    expect(formatStatValue(3.14159)).toBe("3.14");
  });
});

describe("parseVisibleStats", () => {
  it("returns defaults for missing / malformed input", () => {
    expect(parseVisibleStats(null)).toEqual([...DEFAULT_VISIBLE_STATS]);
    expect(parseVisibleStats(undefined)).toEqual([...DEFAULT_VISIBLE_STATS]);
    expect(parseVisibleStats("")).toEqual([...DEFAULT_VISIBLE_STATS]);
    expect(parseVisibleStats("not json")).toEqual([...DEFAULT_VISIBLE_STATS]);
    expect(parseVisibleStats("{}")).toEqual([...DEFAULT_VISIBLE_STATS]);
  });

  it("returns defaults when the parsed list has no valid keys", () => {
    expect(parseVisibleStats(JSON.stringify([]))).toEqual([
      ...DEFAULT_VISIBLE_STATS,
    ]);
    expect(parseVisibleStats(JSON.stringify(["bogus", 1]))).toEqual([
      ...DEFAULT_VISIBLE_STATS,
    ]);
  });

  it("keeps only recognized keys from a persisted list", () => {
    expect(
      parseVisibleStats(JSON.stringify(["sum", "bogus", "min"])),
    ).toEqual(["sum", "min"]);
  });

  it("round-trips every supported key", () => {
    const all = SELECTION_STAT_ITEMS.map((i) => i.key);
    expect(parseVisibleStats(JSON.stringify(all))).toEqual(all);
  });
});

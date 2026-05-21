// Pure helpers for the status-bar selection summary (#192). Side-effect free
// so they can be unit-tested without standing up Univer.
//
// Given the values of the currently selected range — a 2D array straight from
// `FRange.getValues()` — compute Excel's status-bar aggregates: sum, average,
// count (non-blank cells), numeric count, min, max.
//
// Excel parity notes:
//   - "データの個数" (count) = number of non-blank cells (text + numbers).
//   - "数値の個数" (numericCount) = number of cells holding a number.
//   - sum / average / min / max are computed over numeric cells only and are
//     null when the selection contains no numbers (Excel hides them then).
//   - Numeric-looking strings (Univer often stores editor input as strings)
//     count as numbers, mirroring autoSum.ts's lenient detection.

export interface SelectionStats {
  /** Sum of numeric cells; null when there are no numbers. */
  sum: number | null;
  /** Mean of numeric cells; null when there are no numbers. */
  average: number | null;
  /** Non-blank cell count (text + numbers) — Excel's "データの個数". */
  count: number;
  /** Numeric cell count — Excel's "数値の個数". */
  numericCount: number;
  /** Minimum numeric value; null when there are no numbers. */
  min: number | null;
  /** Maximum numeric value; null when there are no numbers. */
  max: number | null;
}

/**
 * Coerce a single cell value to a finite number, or null when it isn't a
 * number. Booleans are intentionally ignored (Excel's status bar treats
 * TRUE/FALSE as non-numeric for sum/average).
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Whether a cell counts as non-blank for Excel's "データの個数". null,
 * undefined and empty/whitespace-only strings are blank; everything else
 * (numbers, text, booleans) counts.
 */
function isNonBlank(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * Unwrap a cell value that may arrive as a Univer `ICellData` object
 * (`{ v, f, t, ... }`) instead of a primitive. `FRange.getValues()` returns
 * primitives in this build, but the shape isn't guaranteed across Univer
 * 0.5.x patches, so we tolerate both forms. Spreadsheet cells never hold
 * plain objects as values, so any object is treated as an `ICellData`
 * wrapper — its value is `.v` (absent for a style-only / empty cell).
 */
function unwrapCellValue(cell: unknown): unknown {
  if (cell !== null && typeof cell === "object") {
    return (cell as { v?: unknown }).v;
  }
  return cell;
}

/**
 * Aggregate the values of a selected range into status-bar stats. Tolerates a
 * ragged or empty array (returns zero counts / null aggregates) so the status
 * bar never crashes the editor.
 */
export function computeSelectionStats(
  values: ReadonlyArray<ReadonlyArray<unknown>> | null | undefined,
): SelectionStats {
  let count = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  if (Array.isArray(values)) {
    for (const row of values) {
      if (!Array.isArray(row)) continue;
      for (const rawCell of row) {
        const cell = unwrapCellValue(rawCell);
        if (isNonBlank(cell)) count += 1;
        const n = toNumber(cell);
        if (n !== null) {
          numericCount += 1;
          sum += n;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
    }
  }

  if (numericCount === 0) {
    return { sum: null, average: null, count, numericCount: 0, min: null, max: null };
  }

  return {
    sum,
    average: sum / numericCount,
    count,
    numericCount,
    min,
    max,
  };
}

/** Identifier for each aggregate the status bar can show. */
export type SelectionStatKey =
  | "sum"
  | "average"
  | "count"
  | "numericCount"
  | "min"
  | "max";

/** Order + Japanese labels for the status-bar items (Excel ordering). */
export const SELECTION_STAT_ITEMS: ReadonlyArray<{
  key: SelectionStatKey;
  label: string;
}> = [
  { key: "average", label: "平均" },
  { key: "count", label: "データの個数" },
  { key: "numericCount", label: "数値の個数" },
  { key: "min", label: "最小値" },
  { key: "max", label: "最大値" },
  { key: "sum", label: "合計" },
];

/** Items shown by default before the user customizes the selection. */
export const DEFAULT_VISIBLE_STATS: ReadonlyArray<SelectionStatKey> = [
  "average",
  "count",
  "sum",
];

/** localStorage key for the persisted set of visible items. */
export const SELECTION_STATS_STORAGE_KEY = "coco.selectionStats.visible";

/**
 * Format a numeric aggregate for display. Uses Japanese locale grouping and
 * caps fractional digits so long averages don't blow out the status bar.
 */
export function formatStatValue(value: number): string {
  return value.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

/**
 * Parse the persisted visible-items list from a raw localStorage string.
 * Returns the default set for missing / malformed / empty input so the status
 * bar always has something sensible to show.
 */
export function parseVisibleStats(
  raw: string | null | undefined,
): SelectionStatKey[] {
  if (!raw) return [...DEFAULT_VISIBLE_STATS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_VISIBLE_STATS];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_VISIBLE_STATS];
  const valid = new Set<SelectionStatKey>(
    SELECTION_STAT_ITEMS.map((item) => item.key),
  );
  const filtered = parsed.filter(
    (k): k is SelectionStatKey =>
      typeof k === "string" && valid.has(k as SelectionStatKey),
  );
  return filtered.length > 0 ? filtered : [...DEFAULT_VISIBLE_STATS];
}

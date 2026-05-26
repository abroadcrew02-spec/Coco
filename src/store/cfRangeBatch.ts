// #241 Step 3 — range batching for CF apply plans.
//
// `computeCfApplyPlan` (Step 2) returns one CfPlanEntry per touched cell.
// For a CF rule with sqref "A:A" (whole column) this can be 1,048,576
// entries — issuing that many facade calls is unacceptable.
//
// This module groups same-style entries into rectangular regions so the
// caller can use a single `setRangeValues`-style facade call per region.
//
// Algorithm:
//   1. Bucket entries by `(action, styleKey)` where styleKey is a
//      deterministic stringification of finalStyle.
//   2. For each bucket, find a maximal-rectangle cover of the cells.
//      Greedy approach: pick the top-left-most uncovered cell, expand
//      right to the first hole in that row, then expand down while every
//      cell in the candidate row is uncovered. Mark the rectangle as
//      covered, repeat.
//   3. Emit one CfRangeBatch per rectangle.
//
// Pure / framework-free. The greedy algorithm is not optimal (may emit
// more rectangles than a min-cover solver) but runs in O(cells) and
// always produces a valid cover.

import type { CellStyleSlice } from "./cfSidecar";
import type { CfPlanEntry, CfPlanAction } from "./cfApplyPlan";

export interface CfRangeBatch {
  sheetId: string;
  action: CfPlanAction;
  /** Inclusive rectangle. */
  rect: { r1: number; c1: number; r2: number; c2: number };
  style: CellStyleSlice;
}

/** Deterministic string for a style — used as a bucket key. */
function styleKey(s: CellStyleSlice): string {
  // Stable JSON key order via explicit field listing.
  return JSON.stringify({
    bg: s.bg ?? null,
    cl: s.cl ?? null,
    bl: s.bl ?? null,
    it: s.it ?? null,
    ul: s.ul ?? null,
    iconValue: s.iconValue ?? null,
  });
}

/** Stable cell key inside a sheet's grid. */
function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

/**
 * Find a maximal rectangle starting at (r0, c0) within `cells` (a Set of
 * row:col keys). The rectangle expands right while the row stays unbroken,
 * then expands down while every row in the candidate width remains
 * unbroken. Returns the rectangle's bounds (inclusive).
 */
function findRectFrom(
  r0: number,
  c0: number,
  cells: Set<string>,
): { r1: number; c1: number; r2: number; c2: number } {
  let c1 = c0;
  while (cells.has(cellKey(r0, c1 + 1))) c1++;
  let r1 = r0;
  outer: while (true) {
    const nextRow = r1 + 1;
    for (let c = c0; c <= c1; c++) {
      if (!cells.has(cellKey(nextRow, c))) break outer;
    }
    r1 = nextRow;
  }
  return { r1: r0, r2: r1, c1: c0, c2: c1 };
}

/**
 * Greedy maximal-rectangle cover over a set of cells. Walks cells in
 * row-major order (smallest row, then column), finds the first uncovered
 * cell, computes the maximal rectangle anchored there, marks it covered,
 * repeats until all cells are covered.
 *
 * Returns a list of inclusive rectangles. The cover is correct (every
 * input cell is covered) but not necessarily minimal.
 */
function coverWithRects(
  cells: ReadonlyArray<{ row: number; col: number }>,
): Array<{ r1: number; c1: number; r2: number; c2: number }> {
  if (cells.length === 0) return [];
  const all = new Set<string>(cells.map((c) => cellKey(c.row, c.col)));
  const covered = new Set<string>();
  const ordered = cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
  const rects: Array<{ r1: number; c1: number; r2: number; c2: number }> = [];
  for (const c of ordered) {
    const key = cellKey(c.row, c.col);
    if (covered.has(key)) continue;
    // Find rectangle anchored at this cell, but only over still-uncovered cells.
    const available = new Set<string>(
      [...all].filter((k) => !covered.has(k)),
    );
    const rect = findRectFrom(c.row, c.col, available);
    rects.push(rect);
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let col = rect.c1; col <= rect.c2; col++) {
        covered.add(cellKey(r, col));
      }
    }
  }
  return rects;
}

/**
 * Group plan entries by (sheetId, action, styleKey), then compute a
 * rectangular cover per group. Returns one CfRangeBatch per rectangle.
 *
 * "noop" entries are dropped — they don't need facade writes.
 */
export function batchCfPlan(plan: ReadonlyArray<CfPlanEntry>): CfRangeBatch[] {
  // Bucket key: sheetId|action|styleKey
  type Bucket = {
    sheetId: string;
    action: CfPlanAction;
    style: CellStyleSlice;
    cells: Array<{ row: number; col: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const entry of plan) {
    if (entry.action === "noop") continue;
    const skey = styleKey(entry.finalStyle);
    const bkey = `${entry.sheetId}|${entry.action}|${skey}`;
    let bucket = buckets.get(bkey);
    if (!bucket) {
      bucket = {
        sheetId: entry.sheetId,
        action: entry.action,
        style: entry.finalStyle,
        cells: [],
      };
      buckets.set(bkey, bucket);
    }
    bucket.cells.push({ row: entry.row, col: entry.col });
  }

  const out: CfRangeBatch[] = [];
  for (const bucket of buckets.values()) {
    const rects = coverWithRects(bucket.cells);
    for (const rect of rects) {
      out.push({
        sheetId: bucket.sheetId,
        action: bucket.action,
        rect,
        style: bucket.style,
      });
    }
  }
  return out;
}

/**
 * Convert a rectangle to A1 notation. Useful for facade calls that take
 * a range string. e.g. (0,0,2,3) → "A1:D3".
 */
export function rectToA1(rect: {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}): string {
  return `${colToA1(rect.c1)}${rect.r1 + 1}:${colToA1(rect.c2)}${rect.r2 + 1}`;
}

function colToA1(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

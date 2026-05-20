// Pure helpers for Excel-style row/column outline grouping.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheets: {
//       <sheetId>: {
//         _outlineRows?: Array<{ start: number; end: number; level: number; collapsed?: boolean }>;
//         _outlineCols?: Array<{ start: number; end: number; level: number; collapsed?: boolean }>;
//         rowData?: Record<string, { h?: number; hd?: 0 | 1 }>;
//         columnData?: Record<string, { w?: number; hd?: 0 | 1 }>;
//       }
//     }
//   }
//
// `start` / `end` are 0-based inclusive indices; `level` is 1-based depth
// (matching Excel's outline-level convention — level 1 is the outermost group,
// inner nests increment from there). When `collapsed` is true the runtime
// patch (`applyOutlineToSheet`) sets `hd: 1` on every row/column inside the
// group so Univer hides them. This module is kept side-effect free so the
// authoring dialog and the render patch can both rely on it without dragging
// in Univer types.

export type OutlineAxis = "row" | "col";

export interface OutlineGroup {
  /** 0-based inclusive start index. */
  start: number;
  /** 0-based inclusive end index. */
  end: number;
  /** 1-based outline depth. Outer = 1, nested = 2, 3, ... */
  level: number;
  /** When true, members are hidden via `hd: 1` at render time. */
  collapsed?: boolean;
}

export interface OutlineSnapshot {
  sheets?: Record<
    string,
    {
      _outlineRows?: OutlineGroup[];
      _outlineCols?: OutlineGroup[];
      rowData?: Record<string, Record<string, unknown>>;
      columnData?: Record<string, Record<string, unknown>>;
    } | undefined
  >;
}

// Minimal shape we read off a sheet object — we only touch outline arrays.
type SheetLike = {
  _outlineRows?: OutlineGroup[];
  _outlineCols?: OutlineGroup[];
};

// Normalize an axis token to the snapshot field name. Used to dedupe the two
// near-identical row/col code paths in the helpers below.
function fieldForAxis(axis: OutlineAxis): "_outlineRows" | "_outlineCols" {
  return axis === "row" ? "_outlineRows" : "_outlineCols";
}

// Pull the current group list off a sheet, defensively cloning so callers
// can mutate the result without aliasing the snapshot.
function readGroups(sheet: SheetLike | undefined | null, axis: OutlineAxis): OutlineGroup[] {
  if (!sheet) return [];
  const raw = sheet[fieldForAxis(axis)];
  if (!Array.isArray(raw)) return [];
  const out: OutlineGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const s = (g as OutlineGroup).start;
    const e = (g as OutlineGroup).end;
    const l = (g as OutlineGroup).level;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) continue;
    out.push({
      start: s,
      end: e,
      level: Number.isInteger(l) && l >= 1 ? l : 1,
      collapsed: (g as OutlineGroup).collapsed === true ? true : undefined,
    });
  }
  return out;
}

// Sort outline groups in a stable display order: by level ascending (outer
// first), then by start ascending. This is also the order that round-trips
// nicely through JSON.
function sortGroups(groups: OutlineGroup[]): OutlineGroup[] {
  return [...groups].sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });
}

// True when `child` is entirely inside `parent` (inclusive bounds) but not
// identical — used to infer the nest depth of a freshly added group.
function strictlyContains(parent: OutlineGroup, child: { start: number; end: number }): boolean {
  return (
    parent.start <= child.start &&
    parent.end >= child.end &&
    !(parent.start === child.start && parent.end === child.end)
  );
}

/**
 * Add a new group to the given axis. If `[start, end]` is fully contained by
 * one or more existing groups, the new group's level is set to
 * `max(parent.level) + 1` so it nests cleanly. An exact-duplicate range is a
 * no-op (we return the existing list unchanged) so the dialog can call this
 * idempotently. Returns a *new* array; the input is never mutated.
 */
export function addGroup(
  sheet: SheetLike | undefined | null,
  axis: OutlineAxis,
  start: number,
  end: number,
): OutlineGroup[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return readGroups(sheet, axis);
  }
  const groups = readGroups(sheet, axis);
  // Exact-duplicate guard: Excel silently ignores re-grouping the same span.
  if (groups.some((g) => g.start === start && g.end === end)) {
    return sortGroups(groups);
  }
  let level = 1;
  for (const g of groups) {
    if (strictlyContains(g, { start, end })) {
      // Nest one level deeper than the deepest containing parent.
      if (g.level + 1 > level) level = g.level + 1;
    }
  }
  return sortGroups([...groups, { start, end, level }]);
}

/**
 * Remove a group from the given axis. Matches the *smallest* (deepest)
 * containing group when an exact-range hit is not present — this mirrors
 * Excel's "Ungroup" behavior, which always peels off one outline level.
 * Returns a new array; non-matches yield the original list unchanged.
 */
export function removeGroup(
  sheet: SheetLike | undefined | null,
  axis: OutlineAxis,
  start: number,
  end: number,
): OutlineGroup[] {
  const groups = readGroups(sheet, axis);
  if (groups.length === 0) return groups;
  // Prefer an exact range match first.
  const exactIdx = groups.findIndex((g) => g.start === start && g.end === end);
  if (exactIdx >= 0) {
    const next = [...groups];
    next.splice(exactIdx, 1);
    return sortGroups(next);
  }
  // Otherwise pick the smallest containing group (deepest = innermost).
  let bestIdx = -1;
  let bestSize = Number.POSITIVE_INFINITY;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.start <= start && g.end >= end) {
      const size = g.end - g.start;
      if (size < bestSize) {
        bestSize = size;
        bestIdx = i;
      }
    }
  }
  if (bestIdx < 0) return groups;
  const next = [...groups];
  next.splice(bestIdx, 1);
  return sortGroups(next);
}

/**
 * Toggle a group's collapsed flag. Matched the same way as `removeGroup`:
 * exact range first, otherwise the smallest containing group.
 */
export function setCollapsed(
  sheet: SheetLike | undefined | null,
  axis: OutlineAxis,
  start: number,
  end: number,
  collapsed: boolean,
): OutlineGroup[] {
  const groups = readGroups(sheet, axis);
  if (groups.length === 0) return groups;
  const exactIdx = groups.findIndex((g) => g.start === start && g.end === end);
  let targetIdx = exactIdx;
  if (targetIdx < 0) {
    let bestSize = Number.POSITIVE_INFINITY;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.start <= start && g.end >= end) {
        const size = g.end - g.start;
        if (size < bestSize) {
          bestSize = size;
          targetIdx = i;
        }
      }
    }
  }
  if (targetIdx < 0) return groups;
  const next = groups.map((g, i) =>
    i === targetIdx ? { ...g, collapsed: collapsed ? true : undefined } : g,
  );
  return sortGroups(next);
}

// A small input contract: the render patch needs to mutate rowData/columnData
// freely, so callers hand us a deep-cloned sheet (the render patch owns the
// clone — see outlineRender.ts).
type WritableSheet = {
  _outlineRows?: OutlineGroup[];
  _outlineCols?: OutlineGroup[];
  rowData?: Record<string, Record<string, unknown>>;
  columnData?: Record<string, Record<string, unknown>>;
};

// Mark a given index `hd: 1` on the row/column data map, preserving any
// width/height already attached. Keys are stringified ints to match the
// Univer snapshot convention (see xlsx_io.rs sheet_obj["rowData"]).
function markHidden(
  data: Record<string, Record<string, unknown>>,
  idx: number,
): void {
  const key = String(idx);
  const existing = data[key];
  if (existing && typeof existing === "object") {
    existing.hd = 1;
  } else {
    data[key] = { hd: 1 };
  }
}

// Clear `hd` on a given index, preserving any other fields (e.g. width/height).
// If the existing record reduces to an empty object after removing `hd`, drop
// the whole record so the snapshot stays small.
function clearHidden(
  data: Record<string, Record<string, unknown>>,
  idx: number,
): void {
  const key = String(idx);
  const existing = data[key];
  if (!existing || typeof existing !== "object") return;
  if (!("hd" in existing)) return;
  delete existing.hd;
  if (Object.keys(existing).length === 0) {
    delete data[key];
  }
}

/**
 * Apply collapsed-state to a sheet's rowData/columnData by setting `hd: 1`
 * on every index that lives inside a collapsed group. The input sheet is
 * mutated in place — callers (see outlineRender.ts) deep-clone before
 * calling so the original snapshot stays intact. Returns the same sheet
 * reference for caller convenience.
 *
 * To make un-collapse actually reveal the rows again (issue #114-A), we
 * first clear `hd` on every index that lives inside ANY outline group
 * (collapsed or not), then re-set `hd: 1` only on indices inside currently
 * collapsed groups. This is safe vs user-hidden rows because user-hidden
 * rows live outside outline group ranges (the user cannot drag-hide a row
 * that is part of an outline structure without going through the outline
 * collapse mechanism).
 */
export function applyOutlineToSheet<T extends WritableSheet>(sheet: T): T {
  if (!sheet || typeof sheet !== "object") return sheet;

  const rows = Array.isArray(sheet._outlineRows) ? sheet._outlineRows : [];
  if (rows.length > 0) {
    const rowData = (sheet.rowData ?? (sheet.rowData = {})) as Record<
      string,
      Record<string, unknown>
    >;
    // First pass: clear `hd` on every index inside any outline group so a
    // previous collapse doesn't leak into the new render.
    for (const g of rows) {
      if (!g) continue;
      for (let r = g.start; r <= g.end; r++) clearHidden(rowData, r);
    }
    // Second pass: re-set `hd: 1` on indices in currently-collapsed groups.
    for (const g of rows) {
      if (!g || g.collapsed !== true) continue;
      for (let r = g.start; r <= g.end; r++) markHidden(rowData, r);
    }
  }

  const cols = Array.isArray(sheet._outlineCols) ? sheet._outlineCols : [];
  if (cols.length > 0) {
    const columnData = (sheet.columnData ?? (sheet.columnData = {})) as Record<
      string,
      Record<string, unknown>
    >;
    for (const g of cols) {
      if (!g) continue;
      for (let c = g.start; c <= g.end; c++) clearHidden(columnData, c);
    }
    for (const g of cols) {
      if (!g || g.collapsed !== true) continue;
      for (let c = g.start; c <= g.end; c++) markHidden(columnData, c);
    }
  }

  return sheet;
}

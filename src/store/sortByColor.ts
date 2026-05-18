// Pure helpers for "Sort by Color" — Excel-parity sort where the sort key is
// a cell's fill (`bg.rgb`) or font (`cl.rgb`) color rather than its value.
//
// Two flavors:
//   - "fillTop" / "fontTop":  rows whose key color equals `pickedColor` float
//                             to the top; everything else keeps its relative
//                             order (stable partition).
//   - "fillOrder" / "fontOrder": all distinct colors found in the key column
//                                are ordered by first appearance and rows are
//                                grouped by that order (stable sort).
//
// Snapshot shape (Univer 0.5.x):
//   {
//     styles?: Record<string, { bg?: { rgb?: string }; cl?: { rgb?: string }; ... }>,
//     sheets: {
//       <sheetId>: {
//         cellData?: {
//           [row]: {
//             [col]: {
//               v?: unknown;
//               // `s` is either an inline style object or a string id into
//               // the workbook's `styles` table — we resolve both.
//               s?: string | { bg?: { rgb?: string }; cl?: { rgb?: string } };
//             }
//           }
//         }
//       }
//     }
//   }
//
// Kept side-effect free so it can be unit-tested without Univer.

export type SortByColorMode = "fillTop" | "fontTop" | "fillOrder" | "fontOrder";

export interface SortByColorRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface SortByColorParams {
  range: SortByColorRange;
  mode: SortByColorMode;
  /** Absolute 0-based column index inside the range to read colors from. */
  column: number;
  /** Required for the "*Top" modes — the color that should float to the top. */
  pickedColor?: string;
}

interface StylePayload {
  bg?: { rgb?: string };
  cl?: { rgb?: string };
}

// Resolve a cell's `s` reference (string id) against the workbook styles table,
// or use the inline style object directly. Tolerates malformed inputs by
// returning null so callers can fall through to "no color".
function resolveStyle(
  s: unknown,
  styles?: Record<string, unknown>,
): StylePayload | null {
  if (s === undefined || s === null) return null;
  if (typeof s === "string") {
    if (!styles) return null;
    const looked = styles[s];
    if (!looked || typeof looked !== "object") return null;
    return looked as StylePayload;
  }
  if (typeof s === "object") return s as StylePayload;
  return null;
}

// Normalize "#abc" / "abc" / "#AABBCC" to lowercase "#aabbcc". Returns null on
// anything that doesn't look like a hex color so we don't conflate "no fill"
// (the default white) with a user-specified white.
function normalizeColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.trim();
  if (!t) return null;
  if (t.startsWith("#")) t = t.slice(1);
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(t)) return null;
  if (t.length === 3) {
    t = t.split("").map((c) => c + c).join("");
  }
  // Drop a leading alpha byte if present (#AARRGGBB → #RRGGBB) — we ignore
  // transparency for color matching.
  if (t.length === 8) t = t.slice(2);
  return "#" + t.toLowerCase();
}

/**
 * Resolve a cell's effective color (fill or font) as a normalized "#rrggbb"
 * string, or null if no color is present. Caller passes the workbook-level
 * styles table so we can deref a cell's `s` when it's a string id.
 */
export function extractCellColor(
  cell: { s?: unknown } | null | undefined,
  kind: "fill" | "font",
  styles?: Record<string, unknown>,
): string | null {
  if (!cell) return null;
  const style = resolveStyle(cell.s, styles);
  if (!style) return null;
  const raw = kind === "fill" ? style.bg?.rgb : style.cl?.rgb;
  return normalizeColor(raw);
}

interface SheetSlice {
  cellData?: Record<string, Record<string, { s?: unknown; v?: unknown } | undefined> | undefined>;
}

interface SnapshotShape {
  styles?: Record<string, unknown>;
  sheets?: Record<string, SheetSlice | undefined>;
}

/**
 * Apply a Sort by Color operation by mutating a deep-cloned copy of the
 * supplied snapshot. Returns the mutated snapshot plus how many rows actually
 * moved (so the caller can report "並べ替えました: N 行" or skip a no-op).
 *
 * Behavior mirrors EditorScreen.applySort:
 *   - reads only the columns inside the range
 *   - reorders rows by the chosen key column
 *   - writes the slices back, deleting old cells in the column window first
 *   - leaves cells outside the column window untouched
 *
 * Stable: rows with the same key color keep their original relative order, so
 * a follow-up sort-by-color over a different column composes predictably.
 */
export function applySortByColor(
  snapshot: unknown,
  sheetId: string,
  params: SortByColorParams,
): { snapshotMutated: object; reorderedCount: number } {
  // Deep clone via JSON so we never mutate the caller's input. The snapshot is
  // already JSON-safe (it round-trips through xlsx) so this is sound.
  const cloned = JSON.parse(JSON.stringify(snapshot ?? {})) as SnapshotShape;
  const sheet = cloned.sheets?.[sheetId];
  if (!sheet) return { snapshotMutated: cloned, reorderedCount: 0 };
  if (!sheet.cellData) sheet.cellData = {};
  const cellData = sheet.cellData as Record<
    string,
    Record<string, { s?: unknown; v?: unknown } | undefined>
  >;
  const styles = cloned.styles;

  const { r1, c1, r2, c2 } = params.range;
  const startRow = Math.min(r1, r2);
  const endRow = Math.max(r1, r2);
  const startCol = Math.min(c1, c2);
  const endCol = Math.max(c1, c2);
  if (startRow > endRow || startCol > endCol) {
    return { snapshotMutated: cloned, reorderedCount: 0 };
  }
  // `column` is interpreted as an absolute 0-based sheet column. Clamp into
  // the range so a stray value can't crash the apply.
  const keyCol = Math.min(endCol, Math.max(startCol, params.column));

  const kind: "fill" | "font" =
    params.mode === "fillTop" || params.mode === "fillOrder" ? "fill" : "font";

  type RowEntry = {
    origIndex: number;
    color: string | null;
    slice: Record<string, { s?: unknown; v?: unknown } | undefined>;
  };

  // Snapshot each row's column-window so we can reorder without mid-iteration
  // mutation. Empty rows still get an entry (so blanks stay anchored to their
  // original position when no color is present).
  const rows: RowEntry[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const src = cellData[String(r)];
    const slice: Record<string, { s?: unknown; v?: unknown } | undefined> = {};
    if (src) {
      for (let c = startCol; c <= endCol; c++) {
        const cell = src[String(c)];
        if (cell !== undefined) slice[String(c)] = cell;
      }
    }
    const keyCell = src ? src[String(keyCol)] : undefined;
    const color = extractCellColor(keyCell, kind, styles);
    rows.push({ origIndex: r - startRow, color, slice });
  }

  // Compute the rank for each color. Lower rank = sorts earlier.
  const rankOf = new Map<string, number>();
  if (params.mode === "fillTop" || params.mode === "fontTop") {
    const picked = normalizeColor(params.pickedColor);
    // Selected color: rank 0. Everything else (including null): rank 1.
    // Within each bucket, original order is preserved via the stable sort.
    if (picked !== null) rankOf.set(picked, 0);
    rows.sort((a, b) => {
      const ra = a.color !== null && rankOf.has(a.color) ? 0 : 1;
      const rb = b.color !== null && rankOf.has(b.color) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.origIndex - b.origIndex;
    });
  } else {
    // Order-by-color list: rank in first-seen order. Null (no color) sinks
    // to the bottom — matches Excel's "blanks last" behavior for sorts.
    let next = 0;
    for (const r of rows) {
      if (r.color !== null && !rankOf.has(r.color)) {
        rankOf.set(r.color, next++);
      }
    }
    rows.sort((a, b) => {
      const ra = a.color !== null ? rankOf.get(a.color) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const rb = b.color !== null ? rankOf.get(b.color) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.origIndex - b.origIndex;
    });
  }

  // Count rows whose final position differs from their original — useful for
  // a no-op UI hint. Computed before we wipe & rewrite so we don't double-count.
  let moved = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].origIndex !== i) moved++;
  }

  // Wipe the original rows' columns inside the range, then write the sorted
  // slices back. Cells outside the column window stay untouched.
  for (let r = startRow; r <= endRow; r++) {
    const row = cellData[String(r)];
    if (!row) continue;
    for (let c = startCol; c <= endCol; c++) {
      delete row[String(c)];
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const r = startRow + i;
    const rowKey = String(r);
    if (!cellData[rowKey]) cellData[rowKey] = {};
    const row = cellData[rowKey];
    for (const [colKey, cell] of Object.entries(rows[i].slice)) {
      if (cell !== undefined) row[colKey] = cell;
    }
  }

  return { snapshotMutated: cloned, reorderedCount: moved };
}

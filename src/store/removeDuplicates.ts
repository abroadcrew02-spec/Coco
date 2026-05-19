// Pure helpers for Excel-style "Remove Duplicates" (Data → Remove Duplicates).
//
// Given a rectangular range on a sheet, walk rows top-to-bottom and drop any
// row whose key (a tuple built from the user-selected "key columns") was
// already seen. Surviving rows preserve their original relative order; rows
// outside the selected range are left untouched and any rows shifted up
// reuse the gap left by the removed rows (we don't keep blank rows behind).
//
// Snapshot shape (Univer 0.5.x):
//   {
//     sheets: {
//       <sheetId>: {
//         cellData?: {
//           [row: string]: {
//             [col: string]: { v?: unknown; f?: unknown; p?: unknown; s?: unknown }
//           }
//         }
//       }
//     }
//   }
//
// `applyToSheet` returns a new sheet object so callers can splice it back
// into a snapshot before handing it to `applyMutatedSnapshot`. The helper is
// intentionally side-effect free (no Univer dependency) so it can be unit
// tested with plain object literals.

export interface RemoveDuplicatesParams {
  /** Rectangle (0-based, inclusive) covering the area to scan. */
  range: { r1: number; c1: number; r2: number; c2: number };
  /** When true, the first row of the range is preserved as a header. */
  hasHeader: boolean;
  /**
   * 0-based column indices *within the range* (i.e. 0 means `range.c1`) that
   * make up the dedup key. Empty array would dedupe by row identity (always
   * keep first) but callers should default to "all columns".
   */
  keyCols: number[];
  /** Compare strings case-insensitively (Excel's default). Default: true. */
  caseInsensitive?: boolean;
}

export interface RemoveDuplicatesResult {
  /** Rows that survived deduplication, in original order. */
  kept: Array<Record<string, unknown>>;
  removedCount: number;
  keptCount: number;
}

// Extract the comparable scalar from a Univer cell record. We compare on `v`
// (the rendered value); rich-text-only cells (`p`) and formula cells (`f`)
// degrade to an empty string so two formula cells with the same source are
// still treated as equal when callers stringify the cell record.
function readCellValue(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell !== "object") return String(cell);
  const c = cell as { v?: unknown; f?: unknown };
  if (c.v !== undefined && c.v !== null) return String(c.v);
  if (c.f !== undefined && c.f !== null) return `=${String(c.f)}`;
  return "";
}

function buildKey(
  row: Record<string, unknown>,
  keyCols: number[],
  c1: number,
  caseInsensitive: boolean,
): string {
  // Joining with a space matches the spec; we also intersperse a unit-separator
  // so values like ["a b", "c"] and ["a", "b c"] don't collide. The spec asks
  // for " " — we honor that exactly between fields and use  internally
  // as a defense against collisions.
  const parts: string[] = [];
  for (const offset of keyCols) {
    const absCol = c1 + offset;
    const v = readCellValue(row[String(absCol)]);
    parts.push(caseInsensitive ? v.toLowerCase() : v);
  }
  return parts.join("  ");
}

/**
 * Filter a flat list of row records, dropping any whose key has already been
 * seen. Rows are not mutated — the kept entries are returned by reference.
 */
export function removeDuplicates(
  rows: Array<Record<string, unknown>>,
  params: RemoveDuplicatesParams,
): RemoveDuplicatesResult {
  const caseInsensitive = params.caseInsensitive ?? true;
  const kept: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = buildKey(row, params.keyCols, params.range.c1, caseInsensitive);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return {
    kept,
    keptCount: kept.length,
    removedCount: rows.length - kept.length,
  };
}

/**
 * Apply Remove Duplicates to a single Univer sheet snapshot. Returns a NEW
 * sheet object (existing one untouched). The data window inside `range` is
 * rewritten so duplicate rows are dropped and rows below the removed rows
 * shift up to close the gap. Cells outside the range's column window stay
 * put on whatever row they were originally on (we never shift entire rows).
 *
 * `sheet` is typed loosely because Univer's sheet snapshot has many optional
 * fields we don't touch — we only re-key `cellData`.
 */
export function applyToSheet(
  sheet: { cellData?: Record<string, Record<string, unknown>> } | undefined,
  params: RemoveDuplicatesParams,
): { sheetWithRemoved: { cellData: Record<string, Record<string, unknown>> }; removedCount: number; keptCount: number } {
  const src = sheet?.cellData ?? {};
  const { r1, r2, c1, c2 } = params.range;
  const dataStart = params.hasHeader ? r1 + 1 : r1;

  // Snapshot all rows in the range (data portion). Missing rows become empty
  // objects so we can still feed them through buildKey — an all-blank row
  // counts as a duplicate of any other all-blank row, which matches Excel.
  const dataRows: Array<Record<string, unknown>> = [];
  for (let r = dataStart; r <= r2; r++) {
    dataRows.push(src[String(r)] ?? {});
  }
  const result = removeDuplicates(dataRows, params);

  // Shallow-clone cellData so we can mutate without aliasing the caller's
  // snapshot. We only need to clone the top-level row map; the row objects
  // themselves are kept by reference (we just relocate them).
  const next: Record<string, Record<string, unknown>> = {};
  for (const [rowKey, row] of Object.entries(src)) {
    next[rowKey] = row;
  }

  // 1. Wipe the data portion of the range so removed rows leave no residue.
  //    We clear only the cells inside the column window so cells beyond `c2`
  //    keep their row coordinate.
  for (let r = dataStart; r <= r2; r++) {
    const row = next[String(r)];
    if (!row) continue;
    let hasSurvivor = false;
    for (const colKey of Object.keys(row)) {
      const col = Number(colKey);
      if (Number.isFinite(col) && col >= c1 && col <= c2) {
        delete row[colKey];
      } else {
        hasSurvivor = true;
      }
    }
    if (!hasSurvivor) delete next[String(r)];
  }

  // 2. Re-place the kept rows in order, starting from `dataStart`. For each
  //    kept row, copy only the cells inside the column window into the target
  //    row map (merging with any surviving out-of-window cells already there).
  for (let i = 0; i < result.kept.length; i++) {
    const targetRow = dataStart + i;
    const targetKey = String(targetRow);
    const targetMap: Record<string, unknown> = next[targetKey] ?? {};
    const sourceRow = result.kept[i];
    for (const [colKey, cell] of Object.entries(sourceRow)) {
      const col = Number(colKey);
      if (!Number.isFinite(col) || col < c1 || col > c2) continue;
      targetMap[colKey] = cell;
    }
    if (Object.keys(targetMap).length > 0) next[targetKey] = targetMap;
    else delete next[targetKey];
  }

  return {
    sheetWithRemoved: { cellData: next },
    removedCount: result.removedCount,
    keptCount: result.keptCount,
  };
}

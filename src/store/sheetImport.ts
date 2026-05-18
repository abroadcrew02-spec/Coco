// Pure helpers for merging a sheet fragment (returned by the Rust
// `workbook_extract_sheet_as_snapshot` command) into the current workbook's
// snapshot. Kept in its own module so it stays testable and out of the
// store / dialog component.

interface SheetFragment {
  name?: string;
  cellData?: Record<string, Record<string, unknown>>;
  rowData?: Record<string, unknown>;
  columnData?: Record<string, unknown>;
  mergeData?: unknown[];
  _hyperlinks?: unknown[];
  _comments?: unknown[];
  _dataValidations?: unknown[];
  _conditionalFormatting?: unknown[];
  _tabColor?: string;
  _autoFilter?: string;
  _freezePane?: Record<string, unknown>;
  _pageSetup?: Record<string, unknown>;
  _protected?: Record<string, unknown>;
  _sheetState?: string;
  /** Workbook-level styles map from the *source* snapshot, attached by
   *  the Rust extractor so style ids inside cellData stay resolvable when
   *  merged into the destination workbook. */
  _sourceStyles?: Record<string, unknown>;
  // Pass-through: anything else the importer produced is preserved verbatim.
  [k: string]: unknown;
}

interface Snapshot {
  sheetOrder?: string[];
  sheets?: Record<string, SheetFragment>;
  styles?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Find a sheet id that isn't already in use: "sheet-imported-1", "sheet-imported-2", ... */
function nextSheetId(existing: Set<string>): string {
  let n = 1;
  while (true) {
    const candidate = `sheet-imported-${n}`;
    if (!existing.has(candidate)) return candidate;
    n += 1;
  }
}

/** Find a sheet name that isn't already taken. Suffixes "(2)", "(3)" etc. */
function uniqueName(desired: string, existing: Set<string>): string {
  if (!existing.has(desired)) return desired;
  let n = 2;
  while (existing.has(`${desired} (${n})`)) n += 1;
  return `${desired} (${n})`;
}

/** Prefix every style id appearing in this sheet's cellData so the merged
 *  fragment doesn't accidentally point at the destination workbook's style
 *  with the same id. Returns the mutated style map (re-keyed with the same
 *  prefix). */
function rekeySheetStyles(
  sheet: SheetFragment,
  sourceStyles: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, def] of Object.entries(sourceStyles)) {
    out[`${prefix}${id}`] = def;
  }
  const cd = sheet.cellData;
  if (cd) {
    for (const rowKey of Object.keys(cd)) {
      const row = cd[rowKey];
      if (!row) continue;
      for (const colKey of Object.keys(row)) {
        const cell = row[colKey] as { s?: string } | null;
        if (cell && typeof cell.s === "string") {
          cell.s = `${prefix}${cell.s}`;
        }
      }
    }
  }
  return out;
}

/**
 * Merge a single-sheet fragment into the destination snapshot.
 * - Generates a fresh sheetId that doesn't collide with existing ids.
 * - Renames the sheet if its name is already taken (Excel-style suffix).
 * - Re-keys source workbook styles into the destination `styles` map under
 *   a unique prefix so style ids stay resolvable post-merge.
 *
 * Returns the mutated snapshot (caller can JSON.stringify it) and the new
 * sheetId so the caller can activate / scroll to it.
 *
 * The input objects are mutated in place — pass a deep clone if you need
 * the originals untouched. The default callsite parses JSON each time so
 * mutation is fine.
 */
export function addImportedSheetToSnapshot(
  snapshot: Snapshot,
  sheetFragment: SheetFragment,
  newName?: string,
): { snapshotMutated: Snapshot; newSheetId: string } {
  const order = Array.isArray(snapshot.sheetOrder) ? snapshot.sheetOrder : [];
  const sheets = snapshot.sheets ?? {};
  snapshot.sheetOrder = order;
  snapshot.sheets = sheets;

  const existingIds = new Set(Object.keys(sheets));
  for (const id of order) existingIds.add(id);
  const newSheetId = nextSheetId(existingIds);

  const existingNames = new Set<string>();
  for (const s of Object.values(sheets)) {
    const n = (s as SheetFragment).name;
    if (typeof n === "string") existingNames.add(n);
  }
  const desiredName = newName ?? sheetFragment.name ?? "Sheet";
  const finalName = uniqueName(desiredName, existingNames);

  // Re-key styles under a per-import prefix so source ids don't clash with
  // destination ids. The destination `styles` map gets the prefixed entries
  // appended. Sheet's `_sourceStyles` is stripped — it has served its purpose.
  const sourceStyles = sheetFragment._sourceStyles ?? {};
  const stylePrefix = `i${newSheetId}-`;
  const prefixedStyles = rekeySheetStyles(
    sheetFragment,
    sourceStyles as Record<string, unknown>,
    stylePrefix,
  );
  delete sheetFragment._sourceStyles;

  const destStyles = (snapshot.styles ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(prefixedStyles)) {
    destStyles[k] = v;
  }
  snapshot.styles = destStyles;

  // Stamp the new id + name onto the sheet object before insertion.
  sheetFragment.name = finalName;
  (sheetFragment as Record<string, unknown>).id = newSheetId;

  sheets[newSheetId] = sheetFragment;
  order.push(newSheetId);

  return { snapshotMutated: snapshot, newSheetId };
}

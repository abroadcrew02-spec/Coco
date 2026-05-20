// Pure helpers for Excel-style "Slicers" — visual filter widgets that toggle
// row visibility on a target table (or pivot, but pivots aren't implemented
// yet) based on which distinct values of a chosen column the user has
// selected.
//
// Snapshot shape (Coco extension to Univer 0.5.x workbook data):
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         cellData?: { [row]: { [col]: { v?: unknown, s?: object, hd?: 0|1 } } },
//         _tables?: TableEntry[];                         // see ./tables.ts
//         _slicers?: Array<{
//           name: string;            // workbook-unique, e.g. "Slicer1"
//           targetTable: string;     // table name referenced from _tables
//           field: string;           // column header name within the table
//           selectedValues: string[]; // empty => "show all"; otherwise inclusive whitelist
//         }>;
//       }
//     }
//   }
//
// Slicers store the selection state on the SAME sheet that hosts their target
// table (the only place we currently render the panel from). `applySlicerFilters`
// walks every slicer in the workbook and ANDs their predicates together when
// multiple slicers point at the same table (Excel semantics: each slicer is a
// row predicate, all must pass).
//
// All helpers are side-effect free so the same module can drive both the
// snapshot patch (`patchSlicerFilters` in components/slicerRender.ts) and the
// sidebar panel UI without bringing Univer into the test surface.
//
// Public surface:
//   - `SlicerEntry`, `SheetWithSlicers`, `WorkbookSlicerSnapshot` interfaces
//   - `generateSlicerName(existing)` — pick smallest unused "SlicerN"
//   - `listDistinctValues(snapshot, tableName, field)` — distinct column values
//   - `addSlicer(workbook, sheetId, entry)` — pure clone with entry appended
//   - `removeSlicer(workbook, name)` — pure clone with named slicer dropped
//   - `toggleSlicerValue(workbook, name, value)` — toggles inclusion; returns
//     a NEW workbook snapshot (deep-cloned) with the toggle applied, or null
//     when the named slicer is missing
//   - `applySlicerFilters(snapshot)` — pure clone with hd:1 applied to rows
//     whose values fail any slicer's predicate
//   - `listAllSlicers(workbook)` — flat listing with sheet ids/names

import type { TableEntry } from "./tables";

export interface SlicerEntry {
  /** Workbook-wide unique, e.g. "Slicer1". */
  name: string;
  /** Table name (from `_tables`) this slicer filters. */
  targetTable: string;
  /** Column header name within the target table. */
  field: string;
  /** Empty array => show all (no filter active); non-empty => inclusive whitelist. */
  selectedValues: string[];
}

export interface SheetWithSlicers {
  name?: string;
  cellData?: Record<
    string,
    Record<string, { v?: unknown; s?: unknown; hd?: 0 | 1 } | undefined> | undefined
  >;
  _tables?: TableEntry[];
  _slicers?: SlicerEntry[];
  [k: string]: unknown;
}

export interface WorkbookSlicerSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, SheetWithSlicers | undefined>;
}

const SLICER_NAME_RE = /^Slicer(\d+)$/;

/**
 * Pick the smallest unused "SlicerN" name (N >= 1). Mirrors `generateTableName`
 * in ./tables.ts: existing names that don't match the canonical pattern are
 * still compared verbatim so a hand-named slicer "Slicer3" blocks N=3.
 */
export function generateSlicerName(existingNames: string[]): string {
  const used = new Set<number>();
  const verbatim = new Set<string>();
  for (const n of existingNames) {
    if (typeof n !== "string") continue;
    verbatim.add(n);
    const m = SLICER_NAME_RE.exec(n);
    if (m) {
      const idx = Number.parseInt(m[1], 10);
      if (Number.isFinite(idx) && idx >= 1) used.add(idx);
    }
  }
  let i = 1;
  while (i < 1_000_000) {
    if (!used.has(i) && !verbatim.has(`Slicer${i}`)) return `Slicer${i}`;
    i++;
  }
  // #16: 1M cap exhausted. Random nonce keeps the 1,000,001st slicer name
  // unique (the previous `Slicer1000000` fallback could collide with an
  // existing entry). Format tags the overflow case for audits.
  while (true) {
    const nonce = Math.random().toString(36).slice(2, 8);
    const candidate = `Slicer1m_${nonce}`;
    if (!verbatim.has(candidate)) return candidate;
  }
}

/**
 * Walk every sheet in the workbook to find a table by name, returning both
 * the table entry AND the sheet it lives on (we need the sheet for cellData
 * access). Returns null when no table matches.
 */
function findTable(
  workbook: WorkbookSlicerSnapshot,
  tableName: string,
): { sheet: SheetWithSlicers; table: TableEntry } | null {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return null;
  for (const sid of Object.keys(sheets)) {
    const sh = sheets[sid];
    const tables = sh?._tables;
    if (!Array.isArray(tables)) continue;
    for (const t of tables) {
      if (t && t.name === tableName) return { sheet: sh!, table: t };
    }
  }
  return null;
}

/**
 * Look up the column index (within the table's range, NOT the sheet's
 * absolute column space) for a given header name. Returns -1 when the field
 * isn't found.
 */
function fieldIndexInTable(table: TableEntry, field: string): number {
  if (!table.columns) return -1;
  for (let i = 0; i < table.columns.length; i++) {
    if (table.columns[i] && table.columns[i].name === field) return i;
  }
  return -1;
}

/**
 * Stringify any cell value into the canonical form used for slicer selection
 * comparisons. We keep this stable and dumb (no formatting, no locale) so the
 * stored `selectedValues` strings always match what `listDistinctValues`
 * returns. `undefined` / `null` / blank are represented as the empty string
 * so users can opt in to "(blank)" filtering by toggling the empty value.
 */
function valueToKey(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Cell objects with `.v` are normalized by the caller; defensive fallback.
  try {
    return String(v);
  } catch {
    return "";
  }
}

/**
 * Return the sorted unique values found in the target table's `field` column,
 * skipping the header row. Returns [] when:
 *   - the table doesn't exist
 *   - the field doesn't match any of the table's columns
 *
 * Result order: locale-naive lexical sort with blanks first. Numbers are
 * compared as strings here — sufficient for the MVP filter UI (Excel does
 * the same in its slicer popovers, sorting on the display string).
 */
export function listDistinctValues(
  snapshot: WorkbookSlicerSnapshot,
  tableName: string,
  field: string,
): string[] {
  const hit = findTable(snapshot, tableName);
  if (!hit) return [];
  const { sheet, table } = hit;
  const fieldOffset = fieldIndexInTable(table, field);
  if (fieldOffset < 0) return [];
  const col = table.range.c1 + fieldOffset;
  const startRow = table.headerRow ? table.range.r1 + 1 : table.range.r1;
  const endRow = table.range.r2;
  const seen = new Set<string>();
  const cellData = sheet.cellData;
  for (let r = startRow; r <= endRow; r++) {
    let v: unknown = undefined;
    if (cellData) {
      const row = cellData[String(r)];
      const cell = row?.[String(col)];
      v = cell?.v;
    }
    seen.add(valueToKey(v));
  }
  const out = Array.from(seen);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * Append a slicer to the named sheet's `_slicers` array. Returns a NEW
 * workbook snapshot (shallow-cloned sheet + sheets map); the original is left
 * untouched so undo can keep its baseline. When the sheet doesn't exist, the
 * snapshot is returned unchanged.
 */
export function addSlicer(
  workbook: WorkbookSlicerSnapshot,
  sheetId: string,
  entry: SlicerEntry,
): WorkbookSlicerSnapshot {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return workbook;
  const sheet = sheets[sheetId];
  if (!sheet || typeof sheet !== "object") return workbook;
  const list = Array.isArray(sheet._slicers) ? sheet._slicers.slice() : [];
  // Replace if same-name slicer already exists on this sheet (idempotent).
  const idx = list.findIndex((s) => s && s.name === entry.name);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  const nextSheet: SheetWithSlicers = { ...sheet, _slicers: list };
  return {
    ...workbook,
    sheets: { ...sheets, [sheetId]: nextSheet },
  };
}

/**
 * Drop a slicer (by name) from every sheet in the workbook. Workbook-wide
 * because slicer names are workbook-unique — the caller doesn't have to know
 * which sheet hosts the slicer. Returns a new workbook snapshot.
 */
export function removeSlicer(
  workbook: WorkbookSlicerSnapshot,
  name: string,
): WorkbookSlicerSnapshot {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return workbook;
  let mutated = false;
  const nextSheets: Record<string, SheetWithSlicers | undefined> = { ...sheets };
  for (const sid of Object.keys(sheets)) {
    const sh = sheets[sid];
    const list = sh?._slicers;
    if (!Array.isArray(list) || list.length === 0) continue;
    const filtered = list.filter((s) => s && s.name !== name);
    if (filtered.length !== list.length) {
      nextSheets[sid] = { ...(sh as SheetWithSlicers), _slicers: filtered };
      mutated = true;
    }
  }
  if (!mutated) return workbook;
  return { ...workbook, sheets: nextSheets };
}

/**
 * Toggle a value's inclusion in the named slicer's `selectedValues`. When the
 * value is already selected it gets removed; otherwise it's added.
 *
 * Contract: the input `workbook` is treated as immutable. This helper
 * deep-clones the snapshot before applying the toggle so callers can pass a
 * shared / live reference safely. Returns the cloned workbook with the toggle
 * applied, or `null` when no slicer matches the name (signal for "do nothing"
 * — distinct from the pre-2026 boolean return, which silently mutated the
 * caller's object).
 */
export function toggleSlicerValue(
  workbook: WorkbookSlicerSnapshot,
  name: string,
  value: string,
): WorkbookSlicerSnapshot | null {
  if (!workbook || typeof workbook !== "object") return null;
  let cloned: WorkbookSlicerSnapshot;
  try {
    cloned = JSON.parse(JSON.stringify(workbook)) as WorkbookSlicerSnapshot;
  } catch {
    return null;
  }
  const sheets = cloned.sheets;
  if (!sheets || typeof sheets !== "object") return null;
  for (const sid of Object.keys(sheets)) {
    const sh = sheets[sid];
    const list = sh?._slicers;
    if (!Array.isArray(list)) continue;
    for (const slicer of list) {
      if (!slicer || slicer.name !== name) continue;
      const sel = Array.isArray(slicer.selectedValues)
        ? slicer.selectedValues.slice()
        : [];
      const idx = sel.indexOf(value);
      if (idx >= 0) sel.splice(idx, 1);
      else sel.push(value);
      slicer.selectedValues = sel;
      return cloned;
    }
  }
  return null;
}

/**
 * Apply every slicer's row predicate to its target table, marking
 * non-matching rows with `hd: 1` (Univer's per-row hidden flag). Returns a
 * NEW snapshot — the input is structurally cloned. Multiple slicers pointing
 * at the same table AND together (Excel semantics): a row is shown only when
 * EVERY active slicer admits its column value.
 *
 * Notes:
 *   - A slicer with an empty `selectedValues` is treated as "show all" and
 *     contributes no filter (matches Excel's "Clear Filter" state).
 *   - The header row is never hidden.
 *   - We only set `hd: 1` on rows we want to hide. Previously-hidden rows
 *     that no longer match any predicate-rejecting slicer have their `hd`
 *     flag cleared so toggling values widens the visible set as expected.
 *     Rows outside the table's range are left untouched.
 *   - When a slicer references a missing table or unknown field, it is
 *     silently skipped so bad metadata never blocks the rest of the render.
 */
export function applySlicerFilters(
  snapshot: WorkbookSlicerSnapshot,
): WorkbookSlicerSnapshot {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  let cloned: WorkbookSlicerSnapshot;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as WorkbookSlicerSnapshot;
  } catch {
    return snapshot;
  }
  const sheets = cloned.sheets;
  if (!sheets || typeof sheets !== "object") return cloned;

  // Group active filters by target table. Each filter is { col, allowed }
  // where `col` is the absolute sheet column index and `allowed` is the
  // selected-values set. Tables themselves are looked up once so we can
  // capture the host sheet for row iteration.
  type FilterPlan = {
    sheetId: string;
    sheet: SheetWithSlicers;
    table: TableEntry;
    predicates: Array<{ col: number; allowed: Set<string> }>;
  };
  const plans = new Map<string, FilterPlan>();

  for (const sid of Object.keys(sheets)) {
    const sh = sheets[sid];
    const list = sh?._slicers;
    if (!Array.isArray(list) || list.length === 0) continue;
    for (const slicer of list) {
      if (!slicer || typeof slicer.targetTable !== "string") continue;
      const sel = Array.isArray(slicer.selectedValues) ? slicer.selectedValues : [];
      if (sel.length === 0) continue; // empty selection = show all
      const hit = findTable(cloned, slicer.targetTable);
      if (!hit) continue;
      const offset = fieldIndexInTable(hit.table, slicer.field);
      if (offset < 0) continue;
      const col = hit.table.range.c1 + offset;
      // Identify the table by host-sheet id so we don't merge predicates
      // across two distinctly-named-but-collision tables (defensive).
      const tableKey = `${slicer.targetTable}`;
      let plan = plans.get(tableKey);
      if (!plan) {
        // Find the table's host sheet id within the cloned snapshot.
        let hostSid: string | null = null;
        for (const candidate of Object.keys(sheets)) {
          const candSheet = sheets[candidate];
          const tables = candSheet?._tables;
          if (!Array.isArray(tables)) continue;
          if (tables.some((t) => t && t.name === slicer.targetTable)) {
            hostSid = candidate;
            break;
          }
        }
        if (!hostSid) continue;
        plan = {
          sheetId: hostSid,
          sheet: sheets[hostSid] as SheetWithSlicers,
          table: hit.table,
          predicates: [],
        };
        plans.set(tableKey, plan);
      }
      plan.predicates.push({ col, allowed: new Set(sel) });
    }
  }

  for (const plan of plans.values()) {
    const sheet = plan.sheet;
    if (!sheet) continue;
    const cellData = (sheet.cellData ?? (sheet.cellData = {})) as Record<
      string,
      Record<string, { v?: unknown; s?: unknown; hd?: 0 | 1 } | undefined> | undefined
    >;
    const startRow = plan.table.headerRow ? plan.table.range.r1 + 1 : plan.table.range.r1;
    const endRow = plan.table.range.r2;
    for (let r = startRow; r <= endRow; r++) {
      let hide = false;
      for (const pred of plan.predicates) {
        const row = cellData[String(r)];
        const cell = row?.[String(pred.col)];
        const key = valueToKey(cell?.v);
        if (!pred.allowed.has(key)) {
          hide = true;
          break;
        }
      }
      const rowKey = String(r);
      const rowMap = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<
        string,
        { v?: unknown; s?: unknown; hd?: 0 | 1 } | undefined
      >;
      // Mirror hd:1 across every column inside the table range so the
      // grid hides the visible portion of the row. Cells outside the
      // table aren't touched; this avoids hiding unrelated annotations
      // the user may have placed alongside the table.
      for (let c = plan.table.range.c1; c <= plan.table.range.c2; c++) {
        const colKey = String(c);
        const cell = (rowMap[colKey] ?? {}) as { v?: unknown; s?: unknown; hd?: 0 | 1 };
        if (hide) {
          rowMap[colKey] = { ...cell, hd: 1 };
        } else if (cell.hd === 1) {
          const { hd: _drop, ...rest } = cell;
          void _drop;
          rowMap[colKey] = rest;
        }
      }
    }
  }

  return cloned;
}

export interface SlicerListing {
  sheetId: string;
  sheetName: string;
  slicer: SlicerEntry;
}

/**
 * Flat list of every slicer in the workbook, preserving `sheetOrder` so the
 * sidebar shows sheets in tab order. Within each sheet, slicers retain their
 * authored order. `sheetName` falls back to the sheet id when no `name` is
 * present.
 */
export function listAllSlicers(workbook: WorkbookSlicerSnapshot): SlicerListing[] {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return [];
  const order =
    Array.isArray(workbook.sheetOrder) && workbook.sheetOrder.length > 0
      ? workbook.sheetOrder.filter((id): id is string => typeof id === "string")
      : Object.keys(sheets);
  const out: SlicerListing[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const list = sheet._slicers;
    if (!Array.isArray(list) || list.length === 0) continue;
    const sheetName =
      typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    for (const slicer of list) {
      if (!slicer || typeof slicer !== "object") continue;
      if (typeof slicer.name !== "string" || typeof slicer.targetTable !== "string") continue;
      out.push({ sheetId, sheetName, slicer });
    }
  }
  return out;
}

/** Workbook-wide collection of existing slicer names (for `generateSlicerName`). */
export function collectAllSlicerNames(workbook: WorkbookSlicerSnapshot): string[] {
  return listAllSlicers(workbook).map((e) => e.slicer.name);
}

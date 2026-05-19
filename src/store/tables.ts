// Pure helpers for the Excel-style "Format as Table" (ListObject) feature.
// Round-tripped through xlsx as `<tables>` / `<table>` entries on each worksheet;
// inside the Univer snapshot we stash them at `sheets.<sheetId>._tables` so the
// existing snapshot-pipeline patches (e.g. tableRender.ts) can pick them up.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         cellData?: { [row]: { [col]: { v?: unknown, s?: object } } },
//         _tables?: Array<{
//           name: string;                       // workbook-wide unique, e.g. "Table1"
//           range: { r1: number; c1: number; r2: number; c2: number };  // inclusive 0-based
//           headerRow: boolean;
//           totalsRow?: boolean;
//           columns: Array<{
//             name: string;
//             totalsFunction?: "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN" | null;
//           }>;
//           style?: TableStylePreset;
//           showBandedRows?: boolean;
//           showFilterButton?: boolean;
//         }>;
//       }
//     }
//   }
//
// Kept side-effect free so it can be unit-tested without Univer.

/** Built-in OOXML preset names this MVP recognises. The set is open-ended
 *  in OOXML; we treat any unknown string as "use defaults" downstream. */
export type TableStylePreset =
  | "TableStyleLight1"
  | "TableStyleMedium2"
  | "TableStyleDark1";

export type TableTotalsFunction =
  | "SUM"
  | "AVERAGE"
  | "COUNT"
  | "MAX"
  | "MIN"
  | null;

export interface TableColumn {
  name: string;
  totalsFunction?: TableTotalsFunction;
}

export interface TableRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface TableEntry {
  name: string;
  range: TableRange;
  headerRow: boolean;
  totalsRow?: boolean;
  columns: TableColumn[];
  style?: TableStylePreset;
  showBandedRows?: boolean;
  showFilterButton?: boolean;
}

/** Shape we expect to see on a worksheet inside the snapshot. Everything is
 *  optional so callers can hand us partial / freshly-created sheets. */
export interface SheetWithTables {
  name?: string;
  cellData?: Record<string, Record<string, { v?: unknown; s?: unknown } | undefined> | undefined>;
  _tables?: TableEntry[];
  [k: string]: unknown;
}

export interface WorkbookTableSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, SheetWithTables | undefined>;
}

/** Default columnCount when we don't know better — matches the new-workbook
 *  default in EditorScreen.tsx. */
const DEFAULT_COLUMN_PREFIX = "Column";

const TABLE_NAME_RE = /^Table(\d+)$/;

/**
 * Pick the smallest unused "TableN" name (N ≥ 1) against an existing list.
 * Excel auto-generates names this way when the user clicks "Format as Table"
 * without typing a custom name.
 *
 * Existing names that don't match `/^Table\d+$/` are ignored when picking the
 * next free number, but ARE still compared verbatim — if "Table3" is already
 * taken (whatever its origin), N=3 is skipped.
 */
export function generateTableName(existingNames: string[]): string {
  const used = new Set<number>();
  const verbatim = new Set<string>();
  for (const n of existingNames) {
    if (typeof n !== "string") continue;
    verbatim.add(n);
    const m = TABLE_NAME_RE.exec(n);
    if (m) {
      const idx = Number.parseInt(m[1], 10);
      if (Number.isFinite(idx) && idx >= 1) used.add(idx);
    }
  }
  let i = 1;
  // Defensive cap: a workbook with 1e6 tables is pathological; bail before
  // burning forever.
  while (i < 1_000_000) {
    if (!used.has(i) && !verbatim.has(`Table${i}`)) return `Table${i}`;
    i++;
  }
  // Caller will see the duplicate and reject downstream.
  return `Table${i}`;
}

/**
 * Pull human-readable column names out of the header row of a range. When
 * `headerRow` is false (or the header cells are empty), we synthesise
 * "Column1", "Column2", ... so every table always has labelled columns.
 *
 * Cells with `.v` undefined / empty / non-string fall back to the synthesised
 * name. Duplicate header values get a numeric suffix (`Sales`, `Sales2`,
 * `Sales3`) so structured references stay unambiguous.
 */
export function inferColumns(
  cellData: SheetWithTables["cellData"] | undefined,
  range: TableRange,
  headerRow: boolean,
): TableColumn[] {
  const out: TableColumn[] = [];
  const seen = new Map<string, number>();
  const widthCols = Math.max(1, range.c2 - range.c1 + 1);
  for (let i = 0; i < widthCols; i++) {
    const col = range.c1 + i;
    let name = `${DEFAULT_COLUMN_PREFIX}${i + 1}`;
    if (headerRow && cellData) {
      const row = cellData[String(range.r1)];
      const cell = row?.[String(col)];
      const v = cell?.v;
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        name = String(v).trim();
      }
    }
    // De-dupe across the column set.
    const lower = name.toLowerCase();
    const count = seen.get(lower) ?? 0;
    if (count === 0) {
      seen.set(lower, 1);
    } else {
      seen.set(lower, count + 1);
      name = `${name}${count + 1}`;
    }
    out.push({ name });
  }
  return out;
}

/** Options accepted by `createTable`. */
export interface CreateTableOptions {
  range: TableRange;
  headerRow?: boolean;
  totalsRow?: boolean;
  style?: TableStylePreset;
  showBandedRows?: boolean;
  showFilterButton?: boolean;
  /** When omitted, the name is auto-generated workbook-wide. */
  name?: string;
  /** Workbook-wide existing table names (across every sheet) for uniqueness. */
  existingTableNames?: string[];
}

/**
 * Build a new TableEntry for the given sheet. The caller is responsible for
 * persisting the result onto `sheet._tables`; this helper keeps the function
 * pure so it's easy to test.
 *
 * `existingTableNames` should cover the ENTIRE workbook, not just this sheet
 * — Excel tables share a single namespace.
 */
export function createTable(
  sheet: SheetWithTables,
  range: TableRange,
  opts: Omit<CreateTableOptions, "range"> = {},
): TableEntry {
  const headerRow = opts.headerRow ?? true;
  const cellData = sheet.cellData;
  const columns = inferColumns(cellData, range, headerRow);
  const explicit = typeof opts.name === "string" ? opts.name.trim() : "";
  const existing = opts.existingTableNames ?? [];
  const name = explicit !== "" ? explicit : generateTableName(existing);
  const entry: TableEntry = {
    name,
    range: { r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c2 },
    headerRow,
    columns,
    style: opts.style ?? "TableStyleMedium2",
    showBandedRows: opts.showBandedRows ?? true,
    showFilterButton: opts.showFilterButton ?? true,
  };
  if (opts.totalsRow) entry.totalsRow = true;
  return entry;
}

/**
 * Return a NEW `_tables` array with the named table removed. When the table
 * isn't present, returns the original array as-is (still a fresh copy, for
 * safety against accidental shared-reference mutation downstream).
 */
export function removeTable(sheet: SheetWithTables, name: string): TableEntry[] {
  const list = Array.isArray(sheet._tables) ? sheet._tables : [];
  return list.filter((t) => t && t.name !== name);
}

/**
 * Rename a table workbook-wide. Returns a *new* WorkbookTableSnapshot with
 * matching entries renamed; the input snapshot (and its nested sheet / table
 * objects) is never mutated — see issue #114-C.
 *
 * Returns null (and does nothing) when:
 *   - newName is empty / whitespace-only
 *   - newName already exists on any other table (case-insensitive — Excel
 *     treats table names case-insensitively for uniqueness but preserves the
 *     authored casing)
 *   - the snapshot is structurally malformed (no `sheets` map)
 *
 * Returns the original workbook unchanged on a no-op (`trimmedNew === oldName`).
 * Returns a new snapshot on a successful rename, even if the old name wasn't
 * found (idempotent from the caller's perspective — if there's nothing to
 * rename and the new name is otherwise valid, we still hand back a fresh
 * snapshot reflecting the validated desired state).
 */
export function renameTable(
  workbook: WorkbookTableSnapshot,
  oldName: string,
  newName: string,
): WorkbookTableSnapshot | null {
  const trimmedNew = (newName ?? "").trim();
  if (!trimmedNew) return null;
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return null;
  if (trimmedNew === oldName) return workbook;
  const newLower = trimmedNew.toLowerCase();
  // Collision check: scan every table once. A table currently named
  // `oldName` is excluded so we can rename it onto a case-only variant of
  // itself (e.g. "Sales" → "SALES").
  for (const sid of Object.keys(sheets)) {
    const sh = sheets[sid];
    const list = sh?._tables;
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!t || typeof t !== "object") continue;
      if (t.name === oldName) continue;
      if (typeof t.name === "string" && t.name.toLowerCase() === newLower) {
        return null;
      }
    }
  }
  // Build a new sheets map, cloning only the sheets/tables we touch.
  const nextSheets: Record<string, SheetWithTables | undefined> = { ...sheets };
  for (const sid of Object.keys(sheets)) {
    const sh = sheets[sid];
    const list = sh?._tables;
    if (!sh || !Array.isArray(list)) continue;
    if (!list.some((t) => t && t.name === oldName)) continue;
    const nextList = list.map((t) =>
      t && t.name === oldName ? { ...t, name: trimmedNew } : t,
    );
    nextSheets[sid] = { ...sh, _tables: nextList };
  }
  return { ...workbook, sheets: nextSheets };
}

export interface TableListing {
  sheetId: string;
  sheetName: string;
  table: TableEntry;
}

/**
 * Flat list of every table in the workbook, preserving `sheetOrder` so the
 * sidebar shows sheets in tab order. Within each sheet, tables retain their
 * authored order. `sheetName` falls back to the sheet id when no `name` is
 * present.
 */
export function listAllTables(workbook: WorkbookTableSnapshot): TableListing[] {
  const sheets = workbook?.sheets;
  if (!sheets || typeof sheets !== "object") return [];
  const order =
    Array.isArray(workbook.sheetOrder) && workbook.sheetOrder.length > 0
      ? workbook.sheetOrder.filter((id): id is string => typeof id === "string")
      : Object.keys(sheets);
  const out: TableListing[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const list = sheet._tables;
    if (!Array.isArray(list) || list.length === 0) continue;
    const sheetName =
      typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    for (const t of list) {
      if (!t || typeof t !== "object") continue;
      if (typeof t.name !== "string" || !t.range || typeof t.range !== "object") continue;
      out.push({ sheetId, sheetName, table: t });
    }
  }
  return out;
}

/** Convenience: collect every existing table name across the workbook (for
 *  passing into `createTable` / `generateTableName`). */
export function collectAllTableNames(workbook: WorkbookTableSnapshot): string[] {
  return listAllTables(workbook).map((e) => e.table.name);
}

// ---------- A1 conversion helpers (handy for the dialog + sidebar) ----------

/** Convert a 0-based column index to A1 letters ("A", "Z", "AA"). */
function colIndexToLetters(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

function letterToColIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Format a {r1,c1,r2,c2} rectangle as an A1 range string ("A1:C10"). */
export function rangeToA1(range: TableRange): string {
  const a = `${colIndexToLetters(range.c1)}${range.r1 + 1}`;
  if (range.r1 === range.r2 && range.c1 === range.c2) return a;
  const b = `${colIndexToLetters(range.c2)}${range.r2 + 1}`;
  return `${a}:${b}`;
}

/**
 * Parse a bare or sheet-qualified A1 range string back into a {r1,c1,r2,c2}
 * rectangle. Returns null on malformed input. The sheet prefix (if any) is
 * preserved separately so the caller can route the result to the right sheet.
 */
export function parseA1ToRange(
  input: string,
): { sheetName: string | null; range: TableRange } | null {
  if (typeof input !== "string") return null;
  let body = input.trim();
  if (!body) return null;
  let sheetName: string | null = null;
  const bang = body.indexOf("!");
  if (bang >= 0) {
    sheetName = body.slice(0, bang).replace(/^'(.*)'$/, "$1");
    body = body.slice(bang + 1);
  }
  const m = /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/.exec(body);
  if (!m) return null;
  const c1 = letterToColIndex(m[1]);
  const r1 = Number.parseInt(m[2], 10) - 1;
  if (c1 < 0 || r1 < 0 || !Number.isFinite(r1)) return null;
  if (m[3] === undefined) {
    return { sheetName, range: { r1, c1, r2: r1, c2: c1 } };
  }
  const c2 = letterToColIndex(m[3]);
  const r2 = Number.parseInt(m[4], 10) - 1;
  if (c2 < 0 || r2 < 0 || !Number.isFinite(r2)) return null;
  return {
    sheetName,
    range: {
      r1: Math.min(r1, r2),
      c1: Math.min(c1, c2),
      r2: Math.max(r1, r2),
      c2: Math.max(c1, c2),
    },
  };
}

// #140 / #190 — External data connections (Power Query) store helpers.
//
// A connection is a workbook-scoped record that points at a data source
// (local CSV/JSON file, Web/REST endpoint, or a local SQLite database) and a
// destination sheet. "Refresh" re-reads the source, runs any configured ETL
// steps over the raw 2-D data, and overwrites the destination sheet's
// cellData. Connections live on the workbook snapshot under `_connections[]`
// so they round-trip with the file just like sheets, tables, etc.
//
// This module is intentionally pure: no React, no Zustand, no Tauri. The
// dialog and the EditorScreen do the I/O — these helpers only mutate
// snapshot JSON shapes and run pure ETL transforms.
//
// #190 follow-up adds: ETL step pipeline (Phase 2), Web/REST source (Phase 3),
// SQLite source (Phase 4) and scheduled refresh metadata (Phase 5).

export type DataConnectionType = "csv" | "json" | "web" | "sqlite";

// --- Phase 2: ETL steps ---------------------------------------------------

/** A row is an array of cell scalars. A grid is the header row + data rows
 *  represented uniformly as `string[][]`-ish — values keep their JS type so
 *  type-casts and numeric filters work without re-parsing. Row 0 is headers. */
export type CellScalar = string | number | boolean | null;
export type Grid = CellScalar[][];

export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "empty"
  | "not_empty";

export type CastType = "text" | "number" | "boolean" | "date";

/** ETL step union. Each step transforms a Grid → Grid. `column` references
 *  are by header name (resolved against the current header row at apply
 *  time) so reorders earlier in the pipeline stay consistent. */
export type EtlStep =
  | { kind: "filter"; column: string; op: FilterOp; value: string }
  | { kind: "rename"; column: string; to: string }
  | { kind: "cast"; column: string; to: CastType }
  | { kind: "select"; columns: string[] }
  | { kind: "sort"; column: string; direction: "asc" | "desc" }
  | { kind: "dedup"; columns: string[] };

// --- Connection record ----------------------------------------------------

/** Web/REST source options (Phase 3). */
export interface WebSourceConfig {
  /** Absolute URL. Validated against the #138 allow list / SSRF guard by the
   *  backend — there is no client-side bypass. */
  url: string;
  /** Response format. `auto` sniffs JSON vs CSV from the body. */
  format: "auto" | "json" | "csv";
  /** Extra request headers (e.g. `Accept`). Stored verbatim; the backend
   *  rejects forbidden / CRLF-injected headers. Credentials for the host are
   *  auto-attached by #180 if configured — no secrets are stored here. */
  headers: Record<string, string>;
}

/** SQLite source options (Phase 4). */
export interface SqliteSourceConfig {
  /** Absolute path to a local `.db` / `.sqlite` file. Opened read-only. */
  dbPath: string;
  /** SELECT query. The backend opens the database read-only so writes fail
   *  regardless, but we also reject obvious non-SELECT statements up front. */
  query: string;
}

/** Refresh schedule (Phase 5). `onOpen` fires once when the workbook loads;
 *  `intervalMinutes > 0` additionally schedules a periodic background
 *  refresh while the workbook is open. */
export interface RefreshSchedule {
  onOpen: boolean;
  intervalMinutes: number;
}

export interface DataConnection {
  /** Stable ID generated on creation. UUID-ish but the format is opaque. */
  id: string;
  /** User-facing display name. Defaults to the source name on creation. */
  name: string;
  type: DataConnectionType;
  /** Absolute path of the source file. Empty for `web` connections (the URL
   *  lives in `web.url`) and the `.db` path for `sqlite` connections. */
  sourcePath: string;
  /** Sheet id the connection writes to. The sheet is created on first load
   *  and reused on subsequent refreshes; if the user deleted it manually we
   *  recreate it on next refresh. */
  targetSheetId: string | null;
  /** Display name to give the target sheet. Lets the user rename without
   *  breaking the connection. */
  targetSheetName: string;
  /** Epoch ms of last successful refresh. null = never refreshed yet. */
  lastRefreshedAt: number | null;
  /** Phase 2: ETL step pipeline. Applied in array order on every refresh.
   *  Absent / empty = raw data is used as-is (back-compat with #140). */
  steps?: EtlStep[];
  /** Phase 3: present only when `type === "web"`. */
  web?: WebSourceConfig;
  /** Phase 4: present only when `type === "sqlite"`. */
  sqlite?: SqliteSourceConfig;
  /** Phase 5: refresh schedule. Absent = manual-only. */
  schedule?: RefreshSchedule;
}

export interface SheetFragment {
  /** Univer-shaped cellData: { rowIdx: { colIdx: { v: ... } } } */
  cellData: Record<string, Record<string, unknown>>;
  rowCount: number;
  columnCount: number;
  headers: string[];
}

interface Snapshot {
  _connections?: DataConnection[];
  sheetOrder?: string[];
  sheets?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Read the connection list off a snapshot. Returns [] for snapshots that
 *  have never had a connection (the `_connections` field is added lazily). */
export function listConnections(snapshot: Snapshot): DataConnection[] {
  const raw = snapshot._connections;
  if (!Array.isArray(raw)) return [];
  // Defensive filter: drop any entries that don't have the required scalars.
  return raw.filter(
    (c): c is DataConnection =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as DataConnection).id === "string" &&
      typeof (c as DataConnection).type === "string" &&
      (["csv", "json", "web", "sqlite"] as string[]).includes((c as DataConnection).type),
  );
}

/** Generate a fresh connection id. Crypto-random when available, falls back
 *  to time + Math.random() so non-Tauri test environments still work. */
export function makeConnectionId(): string {
  // crypto.randomUUID is available in modern browsers and Tauri webview.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return `conn-${c.randomUUID()}`;
  }
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a friendly default name from a source path: the file stem, falling
 *  back to the basename if there's no dot. */
export function defaultConnectionName(sourcePath: string): string {
  const sep = sourcePath.lastIndexOf("\\") >= 0
    ? sourcePath.lastIndexOf("\\")
    : sourcePath.lastIndexOf("/");
  const base = sep >= 0 ? sourcePath.slice(sep + 1) : sourcePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Infer the connection type from a file path's extension. Returns null when
 *  the extension isn't one we support — the caller surfaces a friendly error. */
export function inferConnectionType(sourcePath: string): DataConnectionType | null {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "csv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) {
    return "sqlite";
  }
  return null;
}

/** Insert a new connection into the snapshot. Mutates in place. */
export function addConnection(
  snapshot: Snapshot,
  connection: DataConnection,
): Snapshot {
  const list = listConnections(snapshot);
  list.push(connection);
  snapshot._connections = list;
  return snapshot;
}

/** Update an existing connection by id. No-op if the id isn't found. */
export function updateConnection(
  snapshot: Snapshot,
  id: string,
  patch: Partial<Omit<DataConnection, "id">>,
): Snapshot {
  const list = listConnections(snapshot);
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return snapshot;
  list[idx] = { ...list[idx], ...patch };
  snapshot._connections = list;
  return snapshot;
}

/** Remove a connection by id. No-op if the id isn't found. Does NOT delete
 *  the target sheet — the user keeps the imported data even if the link goes
 *  away (matches Excel's "remove query → keep data" option). */
export function removeConnection(snapshot: Snapshot, id: string): Snapshot {
  const list = listConnections(snapshot);
  const next = list.filter((c) => c.id !== id);
  snapshot._connections = next;
  return snapshot;
}

/** Find a unique sheet id that isn't already taken in the snapshot. */
function nextConnectionSheetId(snapshot: Snapshot): string {
  const used = new Set<string>();
  if (Array.isArray(snapshot.sheetOrder)) {
    for (const s of snapshot.sheetOrder) used.add(s);
  }
  if (snapshot.sheets && typeof snapshot.sheets === "object") {
    for (const k of Object.keys(snapshot.sheets)) used.add(k);
  }
  let n = 1;
  while (true) {
    const candidate = `sheet-conn-${n}`;
    if (!used.has(candidate)) return candidate;
    n += 1;
  }
}

/** Ensure a unique sheet name. Suffix with " (2)", " (3)", etc. when needed. */
function ensureUniqueSheetName(snapshot: Snapshot, desired: string, ignoreSheetId?: string): string {
  const taken = new Set<string>();
  const sheetsObj = (snapshot.sheets ?? {}) as Record<string, { name?: string } | undefined>;
  for (const [sid, sheet] of Object.entries(sheetsObj)) {
    if (sid === ignoreSheetId) continue;
    if (sheet && typeof sheet.name === "string") taken.add(sheet.name);
  }
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired} (${n})`)) n += 1;
  return `${desired} (${n})`;
}

/** Apply a fragment returned by `data_connection_load` to the snapshot:
 *   - If `targetSheetId` exists in the workbook, overwrite its cellData
 *     + rowCount + columnCount in place. The sheet's name is left alone.
 *   - Otherwise, allocate a fresh sheet id, insert it into `sheetOrder`,
 *     and write the fragment as its body.
 *
 *  Returns the (mutated) snapshot plus the sheet id the connection should
 *  now point at — the caller writes that id back into the connection record
 *  along with `lastRefreshedAt`.
 */
export function applyFragmentToSheet(
  snapshot: Snapshot,
  connection: DataConnection,
  fragment: SheetFragment,
): { snapshot: Snapshot; sheetId: string } {
  snapshot.sheets = snapshot.sheets ?? {};
  snapshot.sheetOrder = Array.isArray(snapshot.sheetOrder) ? snapshot.sheetOrder : [];
  const sheets = snapshot.sheets as Record<string, Record<string, unknown>>;
  const order = snapshot.sheetOrder as string[];

  const existingId =
    connection.targetSheetId && Object.prototype.hasOwnProperty.call(sheets, connection.targetSheetId)
      ? connection.targetSheetId
      : null;

  if (existingId) {
    // Refresh path: replace the cell payload while preserving the user's
    // sheet name + position in the tab bar.
    const sheet = sheets[existingId];
    sheet.cellData = fragment.cellData;
    sheet.rowCount = Math.max(fragment.rowCount, 1000);
    sheet.columnCount = Math.max(fragment.columnCount, 26);
    return { snapshot, sheetId: existingId };
  }

  // First load (or the user manually deleted the sheet). Create fresh.
  const newId = nextConnectionSheetId(snapshot);
  const finalName = ensureUniqueSheetName(snapshot, connection.targetSheetName);
  sheets[newId] = {
    id: newId,
    name: finalName,
    rowCount: Math.max(fragment.rowCount, 1000),
    columnCount: Math.max(fragment.columnCount, 26),
    cellData: fragment.cellData,
  };
  order.push(newId);
  return { snapshot, sheetId: newId };
}

/** Returns true if the sheet currently referenced by the connection contains
 *  any cells that look user-edited compared to the fragment's row count. */
export function sheetHasExtraRows(
  snapshot: Snapshot,
  connection: DataConnection,
): boolean {
  if (!connection.targetSheetId) return false;
  const sheetsObj = snapshot.sheets as Record<string, { cellData?: Record<string, unknown>; rowCount?: number }> | undefined;
  const sheet = sheetsObj?.[connection.targetSheetId];
  if (!sheet || !sheet.cellData) return false;
  const rowKeys = Object.keys(sheet.cellData);
  return rowKeys.length > 0 && rowKeys.some((k) => {
    const n = Number.parseInt(k, 10);
    return Number.isFinite(n) && n >= (sheet.rowCount ?? 0);
  });
}

// --- Phase 2: ETL pipeline (pure transforms) ------------------------------

/** Convert a raw `SheetFragment` (Univer cellData) into a dense `Grid`.
 *  Row 0 is the header row. Missing cells become `null`. */
export function fragmentToGrid(fragment: SheetFragment): Grid {
  const { cellData } = fragment;
  const rowKeys = Object.keys(cellData)
    .map((k) => Number.parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (rowKeys.length === 0) return [];
  // Column extent: max col index seen across all rows, or header count.
  let maxCol = fragment.columnCount - 1;
  for (const rk of rowKeys) {
    const row = cellData[String(rk)] ?? {};
    for (const ck of Object.keys(row)) {
      const c = Number.parseInt(ck, 10);
      if (Number.isFinite(c) && c > maxCol) maxCol = c;
    }
  }
  if (maxCol < 0) return [];
  const grid: Grid = [];
  const lastRow = rowKeys[rowKeys.length - 1];
  for (let r = 0; r <= lastRow; r += 1) {
    const srcRow = cellData[String(r)] ?? {};
    const out: CellScalar[] = [];
    for (let c = 0; c <= maxCol; c += 1) {
      const cell = srcRow[String(c)] as { v?: unknown } | undefined;
      const v = cell?.v;
      out.push(
        typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          ? v
          : null,
      );
    }
    grid.push(out);
  }
  return grid;
}

/** Convert a `Grid` back into a `SheetFragment`. Row 0 is treated as headers. */
export function gridToFragment(grid: Grid): SheetFragment {
  const cellData: Record<string, Record<string, unknown>> = {};
  let maxCol = 0;
  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r];
    const rowMap: Record<string, unknown> = {};
    for (let c = 0; c < row.length; c += 1) {
      const v = row[c];
      if (v === null || v === undefined || v === "") continue;
      rowMap[String(c)] = { v };
      if (c > maxCol) maxCol = c;
    }
    if (Object.keys(rowMap).length > 0) cellData[String(r)] = rowMap;
  }
  const headers = (grid[0] ?? []).map((h) => (h == null ? "" : String(h)));
  return {
    cellData,
    rowCount: grid.length,
    columnCount: Math.max(maxCol + 1, headers.length),
    headers,
  };
}

/** Coerce a cell to a number for numeric comparisons / casts. Returns NaN
 *  when the value can't be read as a number. */
function toNumber(v: CellScalar): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return NaN;
    return Number(t);
  }
  return NaN;
}

function evalFilter(cell: CellScalar, op: FilterOp, value: string): boolean {
  const cellStr = cell == null ? "" : String(cell);
  switch (op) {
    case "eq":
      return cellStr === value;
    case "neq":
      return cellStr !== value;
    case "contains":
      return cellStr.toLowerCase().includes(value.toLowerCase());
    case "not_contains":
      return !cellStr.toLowerCase().includes(value.toLowerCase());
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(cell);
      const b = Number(value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    case "empty":
      return cellStr.trim() === "";
    case "not_empty":
      return cellStr.trim() !== "";
    default:
      return true;
  }
}

function castCell(v: CellScalar, to: CastType): CellScalar {
  switch (to) {
    case "text":
      return v == null ? "" : String(v);
    case "number": {
      const n = toNumber(v);
      return Number.isNaN(n) ? v : n;
    }
    case "boolean": {
      if (typeof v === "boolean") return v;
      const s = String(v ?? "").trim().toLowerCase();
      if (["true", "1", "yes", "y"].includes(s)) return true;
      if (["false", "0", "no", "n", ""].includes(s)) return false;
      return v;
    }
    case "date": {
      // Convert ISO-ish date strings to an Excel serial number so the cell
      // sorts and formats as a date. Leaves the value untouched on failure.
      if (typeof v === "number") return v;
      const s = String(v ?? "").trim();
      if (s === "") return v;
      // A bare `YYYY-MM-DD` / `YYYY/MM/DD` string is parsed by Date.parse in
      // LOCAL time for non-ISO forms, drifting the serial by a day across
      // timezones. Parse such date-only strings as UTC for a stable result.
      const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
      const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Date.parse(s);
      if (Number.isNaN(ms)) return v;
      // Excel epoch: 1899-12-30. 86400000 ms per day.
      return Math.round((ms / 86400000 + 25569) * 1e6) / 1e6;
    }
    default:
      return v;
  }
}

/** Resolve a header name to its column index in the current grid. Returns -1
 *  when the header is absent (the step then becomes a no-op for safety). */
function headerIndex(grid: Grid, name: string): number {
  const headers = grid[0] ?? [];
  return headers.findIndex((h) => String(h ?? "") === name);
}

/** Apply a single ETL step to a grid. Pure: returns a new grid. Unknown
 *  columns make the step a no-op rather than throwing — the pipeline stays
 *  resilient when a source's schema drifts. */
export function applyStep(grid: Grid, step: EtlStep): Grid {
  if (grid.length === 0) return grid;
  switch (step.kind) {
    case "filter": {
      const col = headerIndex(grid, step.column);
      if (col < 0) return grid;
      const header = grid[0];
      const kept = grid.slice(1).filter((row) => evalFilter(row[col] ?? null, step.op, step.value));
      return [header, ...kept];
    }
    case "rename": {
      const col = headerIndex(grid, step.column);
      if (col < 0) return grid;
      const header = [...grid[0]];
      header[col] = step.to;
      return [header, ...grid.slice(1)];
    }
    case "cast": {
      const col = headerIndex(grid, step.column);
      if (col < 0) return grid;
      return [
        grid[0],
        ...grid.slice(1).map((row) => {
          const next = [...row];
          next[col] = castCell(next[col] ?? null, step.to);
          return next;
        }),
      ];
    }
    case "select": {
      const indices = step.columns
        .map((name) => headerIndex(grid, name))
        .filter((i) => i >= 0);
      if (indices.length === 0) return grid;
      return grid.map((row) => indices.map((i) => row[i] ?? null));
    }
    case "sort": {
      const col = headerIndex(grid, step.column);
      if (col < 0) return grid;
      const header = grid[0];
      const body = [...grid.slice(1)];
      body.sort((ra, rb) => {
        const a = ra[col] ?? null;
        const b = rb[col] ?? null;
        const an = toNumber(a);
        const bn = toNumber(b);
        let cmp: number;
        if (!Number.isNaN(an) && !Number.isNaN(bn)) {
          cmp = an - bn;
        } else {
          cmp = String(a ?? "").localeCompare(String(b ?? ""));
        }
        return step.direction === "desc" ? -cmp : cmp;
      });
      return [header, ...body];
    }
    case "dedup": {
      const indices = step.columns
        .map((name) => headerIndex(grid, name))
        .filter((i) => i >= 0);
      const header = grid[0];
      const seen = new Set<string>();
      const kept = grid.slice(1).filter((row) => {
        const key = (indices.length > 0 ? indices : row.map((_, i) => i))
          .map((i) => String(row[i] ?? ""))
          .join(" ");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [header, ...kept];
    }
    default:
      return grid;
  }
}

/** Run the full ETL pipeline over a grid. Pure. Steps apply in array order. */
export function applySteps(grid: Grid, steps: EtlStep[] | undefined): Grid {
  if (!steps || steps.length === 0) return grid;
  return steps.reduce((g, step) => applyStep(g, step), grid);
}

/** Convenience: raw fragment + steps → transformed fragment. This is the
 *  function the refresh path calls. When `steps` is empty the input fragment
 *  is returned unchanged (cheap back-compat path for #140 connections). */
export function transformFragment(
  fragment: SheetFragment,
  steps: EtlStep[] | undefined,
): SheetFragment {
  if (!steps || steps.length === 0) return fragment;
  const grid = fragmentToGrid(fragment);
  const out = applySteps(grid, steps);
  return gridToFragment(out);
}

/** Human-readable one-line summary of a step (for the step list UI). */
export function describeStep(step: EtlStep): string {
  switch (step.kind) {
    case "filter":
      return `フィルター: ${step.column} ${step.op} ${step.value}`;
    case "rename":
      return `列名変更: ${step.column} → ${step.to}`;
    case "cast":
      return `型変換: ${step.column} → ${step.to}`;
    case "select":
      return `列の選択: ${step.columns.join(", ")}`;
    case "sort":
      return `並べ替え: ${step.column} (${step.direction})`;
    case "dedup":
      return `重複削除: ${step.columns.length > 0 ? step.columns.join(", ") : "全列"}`;
    default:
      return "(unknown)";
  }
}

// --- Phase 4: SQLite query sanity check -----------------------------------

/** Scan for a statement-separating `;` that lies OUTSIDE a single-quoted
 *  string literal. SQLite escapes an embedded quote as `''`. A blunt
 *  `.includes(";")` would flag `SELECT ';' AS x` as multi-statement. */
function hasStatementSeparator(sql: string): boolean {
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inStr && sql[i + 1] === "'") {
        i++;
      } else {
        inStr = !inStr;
      }
    } else if (c === ";" && !inStr) {
      return true;
    }
  }
  return false;
}

/** Lightweight guard rejecting obvious non-SELECT statements before they
 *  reach the backend. The backend opens the DB read-only so writes fail
 *  anyway — this just gives the user a clearer error sooner. Returns null
 *  when the query looks fine, or an error message string. */
export function validateSqliteQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed === "") return "SQL クエリを入力してください";
  // Strip a leading line/block comment so `-- note\nSELECT ...` still passes.
  const withoutComments = trimmed
    .replace(/^\s*--[^\n]*\n/g, "")
    .replace(/^\s*\/\*[\s\S]*?\*\//g, "")
    .trim();
  const lower = withoutComments.toLowerCase();
  if (!lower.startsWith("select") && !lower.startsWith("with")) {
    return "SELECT / WITH で始まるクエリのみ実行できます (読み取り専用)";
  }
  // Reject statement-chaining that could smuggle a write past the prefix check.
  // A trailing semicolon is fine; an embedded one followed by more SQL is not.
  const body = withoutComments.replace(/;\s*$/, "");
  if (hasStatementSeparator(body)) {
    return "複数ステートメントは実行できません";
  }
  return null;
}

// #238 Step 7 — Query executor: source fetcher + pipeline + snapshot writer.
//
// Bridges the pipeline engine (getAndTransform.ts) and query storage
// (cocoQueries.ts). Pure / framework-free functions except for
// `createTauriSourceFetcher`, which is the sole Tauri integration point.
//
// Public API:
//   - SourceFetcher interface
//   - QueryRunResult interface
//   - QUERY_MAX_ROWS constant
//   - runQuery(query, deps) — fetch + clamp + pipeline
//   - pipelineResultToCellData(result) — PipelineResult → Univer cellData shape
//   - applyQueryResultToSnapshot(snapshot, query, result) — write output sheet
//   - createTauriSourceFetcher(invoke) — Tauri-backed SourceFetcher factory

import { runPipeline } from "./getAndTransform";
import type { PipelineResult, PipelineRow } from "./getAndTransform";
import { upsertQueryOnSnapshot } from "./cocoQueries";
import type { QuerySource, SavedQuery } from "./cocoQueries";
import { parseJsonLines } from "./jsonImport";

export type { PipelineResult, PipelineRow };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SourceFetcher {
  fetch(source: QuerySource): Promise<{
    rows: PipelineRow[];
    columns?: string[];
    warnings?: string[];
  }>;
}

export interface QueryRunResult {
  pipeline: PipelineResult;
  sourceWarnings: string[];
}

export const QUERY_MAX_ROWS = 1_000_000;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Univer-shaped cellData (row 0 = headers, row N+1 = data rows)
 * into PipelineRow[]. The header row provides the column-name mapping.
 */
function cellDataToRows(
  cellData: Record<string, Record<string, { v: unknown }>>,
  headers: string[],
): PipelineRow[] {
  const rows: PipelineRow[] = [];
  let rowIdx = 1;
  while (true) {
    const rowKey = String(rowIdx);
    const rowData = cellData[rowKey];
    if (rowData === undefined) {
      // Stop when a row key is absent; sparse cellData may have gaps, so we
      // scan until the first missing key (matches how data_connection_load
      // writes contiguous row indices).
      break;
    }
    const row: PipelineRow = {};
    for (let col = 0; col < headers.length; col++) {
      const cell = rowData[String(col)];
      row[headers[col]] = cell !== undefined ? cell.v : undefined;
    }
    rows.push(row);
    rowIdx++;
  }
  return rows;
}

/**
 * Find the next unused `sheet-N` id in the snapshot's sheets map.
 */
function nextSheetId(snapshot: Record<string, unknown>): string {
  const sheets = snapshot.sheets as Record<string, unknown> | undefined;
  const existing = sheets ? new Set(Object.keys(sheets)) : new Set<string>();
  let n = 1;
  while (existing.has(`sheet-${n}`)) {
    n++;
  }
  return `sheet-${n}`;
}

/**
 * Clamp rows to QUERY_MAX_ROWS. Returns the (possibly truncated) rows and an
 * optional warning string when truncation occurred.
 */
function clampRows(
  rows: PipelineRow[],
  max: number,
): { rows: PipelineRow[]; warning?: string } {
  if (rows.length <= max) return { rows };
  return {
    rows: rows.slice(0, max),
    warning: `ソースが ${max.toLocaleString()} 行の上限を超えたため、先頭 ${max.toLocaleString()} 行のみ処理しました`,
  };
}

// ---------------------------------------------------------------------------
// Public: runQuery
// ---------------------------------------------------------------------------

/**
 * Execute a saved query end-to-end: fetch source rows, apply MAX_ROWS clamp,
 * run the transform pipeline, and return the combined result.
 *
 * Pure except for the injected `fetcher` (which owns the I/O).
 */
export async function runQuery(
  query: SavedQuery,
  deps: { fetcher: SourceFetcher },
): Promise<QueryRunResult> {
  const fetched = await deps.fetcher.fetch(query.source);
  const clamped = clampRows(fetched.rows, QUERY_MAX_ROWS);
  const pipeline = runPipeline(clamped.rows, query.steps, fetched.columns);
  const sourceWarnings: string[] = [
    ...(fetched.warnings ?? []),
    ...(clamped.warning ? [clamped.warning] : []),
  ];
  return { pipeline, sourceWarnings };
}

// ---------------------------------------------------------------------------
// Public: pipelineResultToCellData
// ---------------------------------------------------------------------------

/**
 * Convert a PipelineResult into the Univer cellData shape expected by snapshot
 * sheets. Row 0 is the header row; data rows start at row 1.
 *
 * Pure / no I/O.
 */
export function pipelineResultToCellData(result: PipelineResult): {
  cellData: Record<string, Record<string, { v: unknown }>>;
  rowCount: number;
  columnCount: number;
} {
  const { columns, rows } = result;
  const cellData: Record<string, Record<string, { v: unknown }>> = {};

  // Header row (row 0)
  if (columns.length > 0) {
    const headerRow: Record<string, { v: unknown }> = {};
    for (let col = 0; col < columns.length; col++) {
      headerRow[String(col)] = { v: columns[col] };
    }
    cellData["0"] = headerRow;
  }

  // Data rows (row 1+)
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const rowMap: Record<string, { v: unknown }> = {};
    for (let col = 0; col < columns.length; col++) {
      const val = row[columns[col]];
      if (val !== undefined && val !== null) {
        rowMap[String(col)] = { v: val };
      }
    }
    if (Object.keys(rowMap).length > 0) {
      cellData[String(rowIdx + 1)] = rowMap;
    }
  }

  return {
    cellData,
    rowCount: rows.length + 1,
    columnCount: columns.length,
  };
}

// ---------------------------------------------------------------------------
// Public: applyQueryResultToSnapshot
// ---------------------------------------------------------------------------

/**
 * Write the query result into a snapshot clone, targeting `query.outputSheet`.
 * If a sheet with that name already exists, its cellData is replaced. Otherwise
 * a new sheet is created and appended to sheetOrder.
 *
 * Also upserts the query into `_cocoQueries` via `upsertQueryOnSnapshot`.
 *
 * Never mutates the input snapshot.
 */
export function applyQueryResultToSnapshot(
  snapshot: unknown,
  query: SavedQuery,
  result: QueryRunResult,
): Record<string, unknown> {
  const base = snapshot && typeof snapshot === "object"
    ? { ...(snapshot as Record<string, unknown>) }
    : {};

  const sheets = base.sheets
    ? { ...(base.sheets as Record<string, unknown>) }
    : {};
  const sheetOrder = Array.isArray(base.sheetOrder)
    ? [...(base.sheetOrder as string[])]
    : [];

  const { cellData, rowCount, columnCount } = pipelineResultToCellData(result.pipeline);

  // Find existing sheet by name
  let targetId: string | undefined;
  for (const [id, sheet] of Object.entries(sheets)) {
    if (
      sheet !== null &&
      typeof sheet === "object" &&
      (sheet as Record<string, unknown>).name === query.outputSheet
    ) {
      targetId = id;
      break;
    }
  }

  if (targetId !== undefined) {
    // Overwrite existing sheet — spread to avoid mutation
    sheets[targetId] = {
      ...(sheets[targetId] as Record<string, unknown>),
      cellData,
      rowCount,
      columnCount,
    };
  } else {
    // Create a new sheet
    const newId = nextSheetId(base);
    sheets[newId] = {
      id: newId,
      name: query.outputSheet,
      rowCount,
      columnCount,
      cellData,
    };
    sheetOrder.push(newId);
  }

  const withSheets: Record<string, unknown> = {
    ...base,
    sheets,
    sheetOrder,
  };

  return upsertQueryOnSnapshot(withSheets, query);
}

// ---------------------------------------------------------------------------
// Public: createTauriSourceFetcher
// ---------------------------------------------------------------------------

/**
 * Factory that creates a SourceFetcher backed by Tauri IPC. The `invoke`
 * function is injected so this module never directly imports from
 * `@tauri-apps/api` — callers wire in the real invoke at the app boundary.
 *
 * Source kind dispatch:
 *   csv / json  → data_connection_load (Rust: source_path, source_type)
 *   jsonl       → plugin:fs|read_text_file then parseJsonLines
 *   sqlite      → data_connection_load_sqlite (Rust: db_path, query, sheet_name)
 *   static      → resolved synchronously from source.rows
 */
export function createTauriSourceFetcher(
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
): SourceFetcher {
  return {
    async fetch(source: QuerySource) {
      switch (source.kind) {
        case "csv":
        case "json": {
          const result = await invoke<{
            headers: string[];
            cellData: Record<string, Record<string, { v: unknown }>>;
          }>("data_connection_load", {
            sourcePath: source.path,
            sourceType: source.kind,
          });
          const rows = cellDataToRows(result.cellData, result.headers);
          return { rows, columns: result.headers };
        }

        case "jsonl": {
          const text = await invoke<string>("plugin:fs|read_text_file", {
            path: source.path,
          });
          const parsed = parseJsonLines(text);
          return {
            rows: parsed.rows,
            columns: parsed.headers,
            warnings: parsed.warnings.length > 0 ? parsed.warnings : undefined,
          };
        }

        case "sqlite": {
          const result = await invoke<{
            headers: string[];
            cellData: Record<string, Record<string, { v: unknown }>>;
          }>("data_connection_load_sqlite", {
            dbPath: source.path,
            query: source.query,
            // sheetName only labels the loader result; cellData/headers are
            // what we consume here, so any non-empty string works.
            sheetName: "Result",
          });
          const rows = cellDataToRows(result.cellData, result.headers);
          return { rows, columns: result.headers };
        }

        case "static": {
          return {
            rows: source.rows as PipelineRow[],
            columns: source.columns,
          };
        }
      }
    },
  };
}

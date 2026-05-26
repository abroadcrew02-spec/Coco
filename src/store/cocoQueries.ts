// #238 Step 5 — Coco-native Get & Transform query storage.
//
// A SavedQuery captures a data source (csv / json / sqlite / static rows)
// + a transform pipeline (selectColumns / dropColumns / filterRows / sort /
// rename / groupBy from `getAndTransform.ts`) + a destination sheet name.
// Saved into `_cocoQueries` on the snapshot so the user can refresh the
// query after a reload (re-fetch source + re-apply pipeline → re-write
// destination).
//
// Distinct from `xl/queryTables/` (Excel's Power Query connection metadata,
// which we byte-preserve via _preservedParts). Coco queries are a separate
// JSON-typed layer; Excel won't see them, but Coco round-trips them.
//
// Pure / framework-free.

import type { TransformStep } from "./getAndTransform";

/** Data source descriptor — resolved at run time by the dialog / handler. */
export type QuerySource =
  | { kind: "csv"; path: string; encoding?: "auto" | "utf8" | "sjis" }
  | { kind: "json"; path: string }
  | { kind: "jsonl"; path: string }
  | { kind: "sqlite"; path: string; query: string }
  | { kind: "static"; rows: Array<Record<string, unknown>>; columns?: string[] };

export interface SavedQuery {
  id: string;
  /** Workbook-unique label shown in the queries panel. */
  name: string;
  source: QuerySource;
  /** Pipeline steps applied to the source rows. Order matters. */
  steps: TransformStep[];
  /** Destination sheet name. The runtime creates / replaces this sheet. */
  outputSheet: string;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

interface SnapshotWithQueries {
  _cocoQueries?: SavedQuery[];
  [k: string]: unknown;
}

/** Read the saved-queries array out of a snapshot. Always returns an array. */
export function readQueries(snapshot: unknown): SavedQuery[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const arr = (snapshot as SnapshotWithQueries)._cocoQueries;
  return Array.isArray(arr) ? arr.slice() : [];
}

/**
 * Write the array into a snapshot CLONE. Never mutates the input. Empty
 * array → key removed (snapshot stays tidy).
 */
export function writeQueries(
  snapshot: unknown,
  queries: SavedQuery[],
): Record<string, unknown> {
  const base =
    snapshot && typeof snapshot === "object"
      ? { ...(snapshot as Record<string, unknown>) }
      : {};
  if (queries.length === 0) {
    delete base._cocoQueries;
    return base;
  }
  base._cocoQueries = queries.slice();
  return base;
}

/**
 * Append OR replace a query by id (idempotent). Stamps updatedAt with
 * `new Date().toISOString()`. Returns the new array — caller passes to
 * writeQueries.
 */
export function upsertQuery(
  queries: SavedQuery[],
  next: SavedQuery,
): SavedQuery[] {
  const now = new Date().toISOString();
  const stamped: SavedQuery = { ...next, updatedAt: now };
  const idx = queries.findIndex((q) => q.id === next.id);
  if (idx >= 0) {
    const out = queries.slice();
    out[idx] = { ...stamped, createdAt: queries[idx].createdAt };
    return out;
  }
  return [...queries, { ...stamped, createdAt: stamped.createdAt || now }];
}

export function removeQuery(queries: SavedQuery[], id: string): SavedQuery[] {
  return queries.filter((q) => q.id !== id);
}

/** Convenience wrapper: upsert + writeQueries in one call. */
export function upsertQueryOnSnapshot(
  snapshot: unknown,
  query: SavedQuery,
): Record<string, unknown> {
  const queries = readQueries(snapshot);
  return writeQueries(snapshot, upsertQuery(queries, query));
}

/** Convenience wrapper: removeQuery + writeQueries in one call. */
export function removeQueryOnSnapshot(
  snapshot: unknown,
  id: string,
): Record<string, unknown> {
  const queries = readQueries(snapshot);
  return writeQueries(snapshot, removeQuery(queries, id));
}

/**
 * Auto-generate the next "Query N" name avoiding collisions with existing
 * queries. Mirrors generatePivotName / generateSlicerName / generateTableName.
 */
const QUERY_NAME_RE = /^Query(\d+)$/;
export function generateQueryName(queries: ReadonlyArray<SavedQuery>): string {
  const used = new Set<number>();
  const verbatim = new Set<string>();
  for (const q of queries) {
    if (typeof q.name !== "string") continue;
    verbatim.add(q.name);
    const m = QUERY_NAME_RE.exec(q.name);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1) used.add(n);
    }
  }
  let i = 1;
  while (i < 1_000_000) {
    if (!used.has(i) && !verbatim.has(`Query${i}`)) return `Query${i}`;
    i++;
  }
  // Defensive fallback.
  while (true) {
    const nonce = Math.random().toString(36).slice(2, 8);
    const candidate = `Query1m_${nonce}`;
    if (!verbatim.has(candidate)) return candidate;
  }
}

/**
 * Look up a query by id. Returns null when not found.
 */
export function findQuery(
  snapshot: unknown,
  id: string,
): SavedQuery | null {
  return readQueries(snapshot).find((q) => q.id === id) ?? null;
}

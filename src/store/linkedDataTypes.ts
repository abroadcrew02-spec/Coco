// #244 — Local Linked Data Types (CSV-based, serverless).
// #310 — SQLite source support added.
//
// Excel's Stock/Geography types rely on cloud APIs (Bing, Refinitiv) which
// conflict with Coco's serverless-first policy. This module provides a
// local alternative: the user registers a CSV or SQLite file as a "data type
// source", specifying a key column. Selecting a cell and opening the
// LinkedDataTypes panel performs a case-insensitive lookup and displays
// matching rows as a data card.
//
// Persistence: the `_cocoDataTypes` key is added to the Coco snapshot JSON,
// following the same pattern as `_cocoDataModel` in cocoDataModel.ts.
//
// Pure / framework-free.

export interface LinkedDataTypeSource {
  /** UUID-style stable id. */
  id: string;
  /** Display name shown in the panel (e.g. "株価データ"). */
  name: string;
  /** Absolute path to the local CSV or SQLite file. */
  sourcePath: string;
  /** Column name used for lookup (case-insensitive match against cell value). */
  keyColumn: string;
  /** All column names (header row / table columns). Used to build the data card. */
  columns: string[];
  /** ISO 8601 timestamp of last registration / update. */
  updatedAt: string;
  /**
   * Source file type. "csv" (default when absent) reads via read_csv_rows.
   * "sqlite" reads via read_sqlite_rows and requires sqliteTable.
   * Legacy sources without this field are treated as "csv".
   */
  kind?: "csv" | "sqlite";
  /**
   * For kind === "sqlite": the table name to query.
   * Absent / undefined for CSV sources.
   */
  sqliteTable?: string;
  /**
   * #323 — Optional subset of non-key columns to write when expanding to cells.
   * When absent or empty, all non-key columns are expanded (legacy behavior).
   * Column names must be members of `columns`; unknown names are silently ignored.
   */
  expandColumns?: string[];
}

/**
 * Normalize a source loaded from a snapshot so that `kind` is always present.
 * Legacy sources persisted before #310 have no `kind` field — they are CSV
 * by convention.
 */
export function normalizeSource(source: LinkedDataTypeSource): LinkedDataTypeSource {
  if (source.kind === undefined) {
    return { ...source, kind: "csv" };
  }
  return source;
}

/**
 * #323 — Resolve the effective list of columns to expand for a given source.
 *
 * When `expandColumns` is specified and non-empty, returns only those column
 * names that also appear in `source.columns` and are not the key column.
 * Otherwise returns all non-key columns in their original order (legacy behavior).
 */
export function resolveExpandColumns(source: LinkedDataTypeSource): string[] {
  const nonKey = source.columns.filter((c) => c !== source.keyColumn);
  if (source.expandColumns && source.expandColumns.length > 0) {
    const allowed = new Set(nonKey);
    return source.expandColumns.filter((c) => allowed.has(c));
  }
  return nonKey;
}

export interface CocoLinkedDataTypes {
  sources: LinkedDataTypeSource[];
}

/** Empty state — implicit when snapshot has no `_cocoDataTypes` key. */
export const EMPTY_LINKED_DATA_TYPES: CocoLinkedDataTypes = {
  sources: [],
};

// ---------------------------------------------------------------------------
// Snapshot I/O — follows cocoDataModel.ts conventions.
// ---------------------------------------------------------------------------

interface SnapshotWithDataTypes {
  _cocoDataTypes?: CocoLinkedDataTypes;
  [k: string]: unknown;
}

/** Read linked data types from a snapshot. Returns EMPTY when key is absent. */
export function readLinkedDataTypes(snapshot: unknown): CocoLinkedDataTypes {
  if (!snapshot || typeof snapshot !== "object") return EMPTY_LINKED_DATA_TYPES;
  const raw = (snapshot as SnapshotWithDataTypes)._cocoDataTypes;
  if (!raw || typeof raw !== "object") return EMPTY_LINKED_DATA_TYPES;
  return {
    sources: Array.isArray(raw.sources)
      ? (raw.sources as unknown[]).filter(isValidSource)
      : [],
  };
}

function isValidSource(v: unknown): v is LinkedDataTypeSource {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  const baseValid =
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.sourcePath === "string" &&
    typeof s.keyColumn === "string" &&
    Array.isArray(s.columns) &&
    typeof s.updatedAt === "string";
  if (!baseValid) return false;
  // kind is optional; when present must be "csv" or "sqlite".
  if (s.kind !== undefined && s.kind !== "csv" && s.kind !== "sqlite") return false;
  // sqliteTable when present must be a string.
  if (s.sqliteTable !== undefined && typeof s.sqliteTable !== "string") return false;
  // expandColumns when present must be an array of strings.
  if (s.expandColumns !== undefined) {
    if (!Array.isArray(s.expandColumns)) return false;
    if ((s.expandColumns as unknown[]).some((c) => typeof c !== "string")) return false;
  }
  return true;
}

/**
 * Write linked data types into a snapshot clone. Never mutates the input.
 * When `model` has no sources, `_cocoDataTypes` is removed to keep the
 * snapshot tidy.
 */
export function writeLinkedDataTypes(
  snapshot: unknown,
  model: CocoLinkedDataTypes,
): Record<string, unknown> {
  const base =
    snapshot && typeof snapshot === "object"
      ? { ...(snapshot as Record<string, unknown>) }
      : {};
  if (model.sources.length === 0) {
    delete base._cocoDataTypes;
    return base;
  }
  base._cocoDataTypes = { sources: model.sources };
  return base;
}

// ---------------------------------------------------------------------------
// CRUD helpers — all return new CocoLinkedDataTypes (immutable).
// ---------------------------------------------------------------------------

export function addSource(
  model: CocoLinkedDataTypes,
  source: LinkedDataTypeSource,
): CocoLinkedDataTypes {
  // Replace existing entry with same id idempotently.
  const filtered = model.sources.filter((s) => s.id !== source.id);
  return { sources: [...filtered, source] };
}

export function removeSource(
  model: CocoLinkedDataTypes,
  id: string,
): CocoLinkedDataTypes {
  return { sources: model.sources.filter((s) => s.id !== id) };
}

export function updateSource(
  model: CocoLinkedDataTypes,
  id: string,
  patch: Partial<Omit<LinkedDataTypeSource, "id">>,
): CocoLinkedDataTypes {
  return {
    sources: model.sources.map((s) =>
      s.id === id ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s,
    ),
  };
}

export function listSources(model: CocoLinkedDataTypes): LinkedDataTypeSource[] {
  return model.sources;
}

// ---------------------------------------------------------------------------
// Lookup helper — operates on in-memory CSV data (array of row objects).
// ---------------------------------------------------------------------------

/**
 * Look up `keyValue` in `sourceData` using `source.keyColumn` (case-insensitive).
 *
 * `sourceData` is the parsed CSV passed in by the caller (the frontend is
 * responsible for loading the CSV via Tauri invoke). This function is pure and
 * contains no I/O.
 *
 * Returns the first matching row as a `Record<string, string>`, or `null` when
 * no match is found. An empty / whitespace `keyValue` always returns `null`.
 */
export function lookupInSource(
  sourceData: Array<Record<string, string>>,
  keyValue: string,
  source: LinkedDataTypeSource,
): Record<string, string> | null {
  const trimmed = keyValue.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const col = source.keyColumn;
  for (const row of sourceData) {
    const cellVal = row[col];
    if (typeof cellVal === "string" && cellVal.trim().toLowerCase() === lower) {
      return row;
    }
  }
  return null;
}

/**
 * #323 — Bulk lookup for multiple key values in a single pass over `sourceData`.
 *
 * Returns a `Map` whose keys are the original `keyValues` entries (preserving
 * order and case) and whose values are the first matching row or `null` when no
 * match was found. Empty / whitespace keys always map to `null`.
 *
 * The lookup is case-insensitive, matching the behavior of `lookupInSource`.
 * Scanning is O(n × m) where n = sourceData.length and m = keyValues.length;
 * for large ranges consider pre-building an index externally.
 */
export function lookupManyInSource(
  sourceData: Array<Record<string, string>>,
  keyValues: string[],
  source: LinkedDataTypeSource,
): Map<string, Record<string, string> | null> {
  const result = new Map<string, Record<string, string> | null>();

  // Pre-normalise the look-up keys for O(1) set membership checks.
  const lowerToOriginal = new Map<string, string>();
  for (const kv of keyValues) {
    const trimmed = kv.trim();
    if (trimmed) {
      lowerToOriginal.set(trimmed.toLowerCase(), kv);
    }
    // Always initialise — blank keys get null immediately.
    if (!result.has(kv)) {
      result.set(kv, null);
    }
  }

  if (lowerToOriginal.size === 0) {
    return result;
  }

  const col = source.keyColumn;
  for (const row of sourceData) {
    const cellVal = row[col];
    if (typeof cellVal !== "string") continue;
    const normalised = cellVal.trim().toLowerCase();
    const original = lowerToOriginal.get(normalised);
    if (original !== undefined && result.get(original) === null) {
      result.set(original, row);
      lowerToOriginal.delete(normalised);
      if (lowerToOriginal.size === 0) break; // All keys satisfied.
    }
  }

  return result;
}

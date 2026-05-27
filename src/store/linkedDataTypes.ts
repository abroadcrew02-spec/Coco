// #244 — Local Linked Data Types (CSV-based, serverless).
//
// Excel's Stock/Geography types rely on cloud APIs (Bing, Refinitiv) which
// conflict with Coco's serverless-first policy. This module provides a
// local alternative: the user registers a CSV file as a "data type source",
// specifying a key column. Selecting a cell and opening the LinkedDataTypes
// panel performs a case-insensitive lookup and displays matching rows as a
// data card.
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
  /** Absolute path to the local CSV file. */
  sourcePath: string;
  /** Column name used for lookup (case-insensitive match against cell value). */
  keyColumn: string;
  /** All column names (header row). Used to build the data card. */
  columns: string[];
  /** ISO 8601 timestamp of last registration / update. */
  updatedAt: string;
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
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.sourcePath === "string" &&
    typeof s.keyColumn === "string" &&
    Array.isArray(s.columns) &&
    typeof s.updatedAt === "string"
  );
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

// #239 Step 5 — Coco-native Data Model storage.
//
// The DAX engine (`src/store/daxEngine.ts`) operates on an in-memory
// `DataModel` (tables + relationships + measures). This module persists
// that structure into the Coco snapshot as a root-level `_cocoDataModel`
// key so it survives save/reload and travels with the workbook.
//
// Distinct from Excel's binary `xl/model/item.data` (Vertipaq columnstore):
//   - Excel's model is opaque binary, only Power Pivot writes it; Coco
//     preserves it byte-for-byte via _preservedParts.
//   - Coco's model is structured JSON, authored by the user via Coco's
//     DataModelDialog (planned). Editable in Coco, ignored by Excel.
//
// Both layers coexist: opening an Excel-authored model workbook gives the
// user Excel's binary model (untouched) AND lets them add a Coco-native
// model alongside it.
//
// Pure / framework-free.

import {
  evaluateCalculatedColumns,
  type CalculatedColumnDef,
  type DataModel,
  type ModelTable,
  type ModelRelationship,
} from "./daxEngine";

/**
 * Stored measure definition. Distinct from DataModel internal types because
 * the persisted form may include UI metadata (display name, format string)
 * that the runtime engine ignores.
 */
export interface StoredMeasure {
  id: string;
  /** Workbook-unique measure name (e.g. "Total Sales"). */
  name: string;
  /** Owning table — measures appear under a table in the field list. */
  tableId: string;
  /** DAX expression source text. */
  expression: string;
  /** Optional Excel number format code for displayed results. */
  format?: string;
  /** Optional one-line documentation. */
  description?: string;
}

/**
 * Stored calculated column. Same shape as StoredMeasure plus a target column
 * name. Evaluated per row at refresh time; runtime model has the column
 * promoted into ModelTable.columns.
 */
export interface StoredCalculatedColumn extends StoredMeasure {
  /** Target column name on the owning table. */
  columnName: string;
}

/**
 * Full Coco-native data model. Tables themselves can reference workbook
 * sheets by id (the rows are sliced from sheet cellData at evaluation time)
 * OR hold inline rows (for ad-hoc data not on any sheet).
 */
export interface CocoDataModel {
  tables: ModelTable[];
  relationships: ModelRelationship[];
  measures: StoredMeasure[];
  calculatedColumns: StoredCalculatedColumn[];
  /** ISO timestamp of last edit. */
  updatedAt?: string;
}

/** Empty model — used as the implicit "no model" state. */
export const EMPTY_DATA_MODEL: CocoDataModel = {
  tables: [],
  relationships: [],
  measures: [],
  calculatedColumns: [],
};

interface SnapshotWithModel {
  _cocoDataModel?: CocoDataModel;
  [k: string]: unknown;
}

/** Read the model out of a snapshot. Returns EMPTY_DATA_MODEL when missing. */
export function readDataModel(snapshot: unknown): CocoDataModel {
  if (!snapshot || typeof snapshot !== "object") return EMPTY_DATA_MODEL;
  const m = (snapshot as SnapshotWithModel)._cocoDataModel;
  if (!m || typeof m !== "object") return EMPTY_DATA_MODEL;
  return {
    tables: Array.isArray(m.tables) ? m.tables : [],
    relationships: Array.isArray(m.relationships) ? m.relationships : [],
    measures: Array.isArray(m.measures) ? m.measures : [],
    calculatedColumns: Array.isArray(m.calculatedColumns) ? m.calculatedColumns : [],
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : undefined,
  };
}

/**
 * Write the model into a snapshot CLONE. Never mutates the input. Returns
 * a fresh snapshot object the caller passes to applyMutatedSnapshot.
 * When `model` is empty, the `_cocoDataModel` key is removed to keep the
 * snapshot tidy (so the JSON doesn't grow indefinitely with empty stubs).
 */
export function writeDataModel(
  snapshot: unknown,
  model: CocoDataModel,
): Record<string, unknown> {
  const base =
    snapshot && typeof snapshot === "object"
      ? { ...(snapshot as Record<string, unknown>) }
      : {};
  const isEmpty =
    model.tables.length === 0 &&
    model.relationships.length === 0 &&
    model.measures.length === 0 &&
    model.calculatedColumns.length === 0;
  if (isEmpty) {
    delete base._cocoDataModel;
    return base;
  }
  base._cocoDataModel = {
    ...model,
    updatedAt: new Date().toISOString(),
  };
  return base;
}

/** Convert the stored model into the runtime DataModel the DAX engine wants. */
export function toDataModel(stored: CocoDataModel): DataModel {
  return {
    tables: stored.tables.map((t) => ({ ...t, rows: t.rows.slice() })),
    relationships: stored.relationships.slice(),
  };
}

// ---------------------------------------------------------------------------
// Mutation helpers — return new CocoDataModel objects (never mutate input).
// ---------------------------------------------------------------------------

export function addTable(model: CocoDataModel, table: ModelTable): CocoDataModel {
  // Replace same-named tables idempotently — keeps "create or update" simple.
  const filtered = model.tables.filter((t) => t.name !== table.name);
  return { ...model, tables: [...filtered, table] };
}

export function removeTable(model: CocoDataModel, name: string): CocoDataModel {
  return {
    ...model,
    tables: model.tables.filter((t) => t.name !== name),
    relationships: model.relationships.filter(
      (r) => r.fromTable !== name && r.toTable !== name,
    ),
    measures: model.measures.filter((m) => m.tableId !== name),
    calculatedColumns: model.calculatedColumns.filter((c) => c.tableId !== name),
  };
}

export function addRelationship(
  model: CocoDataModel,
  rel: ModelRelationship,
): CocoDataModel {
  // Idempotent on (fromTable, fromColumn, toTable, toColumn) — replace.
  const filtered = model.relationships.filter(
    (r) =>
      !(
        r.fromTable === rel.fromTable &&
        r.fromColumn === rel.fromColumn &&
        r.toTable === rel.toTable &&
        r.toColumn === rel.toColumn
      ),
  );
  return { ...model, relationships: [...filtered, rel] };
}

export function removeRelationship(
  model: CocoDataModel,
  fromTable: string,
  toTable: string,
): CocoDataModel {
  return {
    ...model,
    relationships: model.relationships.filter(
      (r) => !(r.fromTable === fromTable && r.toTable === toTable),
    ),
  };
}

export function addMeasure(
  model: CocoDataModel,
  measure: StoredMeasure,
): CocoDataModel {
  const filtered = model.measures.filter((m) => m.id !== measure.id);
  return { ...model, measures: [...filtered, measure] };
}

export function removeMeasure(model: CocoDataModel, id: string): CocoDataModel {
  return { ...model, measures: model.measures.filter((m) => m.id !== id) };
}

export function addCalculatedColumn(
  model: CocoDataModel,
  col: StoredCalculatedColumn,
): CocoDataModel {
  const filtered = model.calculatedColumns.filter((c) => c.id !== col.id);
  return { ...model, calculatedColumns: [...filtered, col] };
}

export function removeCalculatedColumn(
  model: CocoDataModel,
  id: string,
): CocoDataModel {
  return {
    ...model,
    calculatedColumns: model.calculatedColumns.filter((c) => c.id !== id),
  };
}

// ---------------------------------------------------------------------------
// Step 4: convenience bridge — storage model → evaluated runtime model
// ---------------------------------------------------------------------------

/**
 * Convert `CocoDataModel.calculatedColumns` into the engine-facing
 * `CalculatedColumnDef[]` shape and apply them to `base` via
 * `evaluateCalculatedColumns`.
 *
 * Returns a *new* DataModel with calculated-column values injected into
 * each table's rows. The stored `CocoDataModel` is not mutated.
 *
 * Typical call-site:
 * ```ts
 * const runtimeModel = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);
 * ```
 */
export function applyCalculatedColumns(
  base: DataModel,
  cocoModel: CocoDataModel,
): DataModel {
  const defs: CalculatedColumnDef[] = cocoModel.calculatedColumns.map((cc) => ({
    tableId: cc.tableId,
    columnName: cc.columnName,
    expression: cc.expression,
  }));
  return evaluateCalculatedColumns(base, defs);
}

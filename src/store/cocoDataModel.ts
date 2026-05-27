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
  evaluateMeasure,
  evaluateAllMeasures,
  type CalculatedColumnDef,
  type DataModel,
  type MeasureDef,
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

/**
 * Rename a measure identified by `oldName` to `newName`.
 *
 * Returns:
 *   - `nameChanged: false` when `oldName === newName` (noop).
 *   - `collided: true` when `newName` is already used by a different measure
 *     (the model is not mutated; caller shows an error UI).
 *   - `nameChanged: true` on success — the returned `model` has the measure
 *     name updated.
 *
 * Cascade to Pivot references is the caller's responsibility (use
 * `renameMeasureReferences` from `pivots.ts`).
 */
export function renameMeasure(
  model: CocoDataModel,
  oldName: string,
  newName: string,
): { model: CocoDataModel; nameChanged: boolean; collided: boolean } {
  if (oldName === newName) {
    return { model, nameChanged: false, collided: false };
  }
  const target = model.measures.find((m) => m.name === oldName);
  if (!target) {
    return { model, nameChanged: false, collided: false };
  }
  const collision = model.measures.some((m) => m.name === newName && m.id !== target.id);
  if (collision) {
    return { model, nameChanged: false, collided: true };
  }
  const measures = model.measures.map((m) =>
    m.id === target.id ? { ...m, name: newName } : m,
  );
  return { model: { ...model, measures }, nameChanged: true, collided: false };
}

/**
 * Rename a calculated column identified by `id`, updating its `name` and
 * `columnName` fields to `newColumnName`.
 *
 * Returns:
 *   - `nameChanged: false` when the column's current name already equals
 *     `newColumnName` (noop).
 *   - `collided: true` when `newColumnName` conflicts with another calc col in
 *     the same table, or with an original column defined in the table's schema.
 *     The model is not mutated; caller shows a warning UI.
 *   - `nameChanged: true` on success.
 *
 * Note: DAX expression references inside measures / other calc cols are NOT
 * rewritten automatically (parser round-trip needed, out of scope for MVP).
 * The caller should warn users that expressions referencing
 * `TableName[OldName]` may break.
 */
export function renameCalculatedColumn(
  model: CocoDataModel,
  id: string,
  newColumnName: string,
): { model: CocoDataModel; nameChanged: boolean; collided: boolean } {
  const target = model.calculatedColumns.find((c) => c.id === id);
  if (!target) {
    return { model, nameChanged: false, collided: false };
  }
  if (target.columnName === newColumnName) {
    return { model, nameChanged: false, collided: false };
  }
  // Check collision against other calc cols in the same table.
  const sameTableCalcCols = model.calculatedColumns.filter(
    (c) => c.tableId === target.tableId && c.id !== id,
  );
  const collisionCalcCol = sameTableCalcCols.some((c) => c.columnName === newColumnName);
  if (collisionCalcCol) {
    return { model, nameChanged: false, collided: true };
  }
  // Check collision against original table columns.
  const table = model.tables.find((t) => t.name === target.tableId);
  const collisionOriginal = table
    ? table.columns.some((col) => col.name === newColumnName)
    : false;
  if (collisionOriginal) {
    return { model, nameChanged: false, collided: true };
  }
  const calculatedColumns = model.calculatedColumns.map((c) =>
    c.id === id ? { ...c, name: newColumnName, columnName: newColumnName } : c,
  );
  return {
    model: { ...model, calculatedColumns },
    nameChanged: true,
    collided: false,
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

// ---------------------------------------------------------------------------
// Step 6: convenience bridges — measure evaluation
// ---------------------------------------------------------------------------

/**
 * Convert `CocoDataModel.measures` into the engine-facing `MeasureDef[]`
 * and evaluate a single named measure via `evaluateMeasure`.
 *
 * `base` should normally be the result of `applyCalculatedColumns(toDataModel(cocoModel), cocoModel)`
 * so that calculated columns are visible to measure expressions.
 *
 * `filterContext` maps table names to pre-filtered row arrays. Pass `undefined`
 * to evaluate against the full dataset (no filter context).
 *
 * Returns MEASURE_ERROR ("#ERROR!") when:
 *   - The measure name is not found in `cocoModel.measures`.
 *   - The DAX expression fails to parse.
 *   - Runtime evaluation throws.
 *   - A circular reference is detected.
 */
export function evaluateStoredMeasure(
  base: DataModel,
  cocoModel: CocoDataModel,
  measureName: string,
  filterContext?: Map<string, Array<Record<string, unknown>>>,
): unknown {
  const defs: MeasureDef[] = cocoModel.measures.map((m) => ({
    name: m.name,
    expression: m.expression,
  }));
  return evaluateMeasure(base, defs, measureName, filterContext);
}

/**
 * Evaluate ALL measures in `cocoModel` and return a map of name → value.
 *
 * Typical call-site (e.g., Pivot Table refresh):
 * ```ts
 * const rt = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);
 * const vals = evaluateAllStoredMeasures(rt, cocoModel);
 * ```
 */
export function evaluateAllStoredMeasures(
  base: DataModel,
  cocoModel: CocoDataModel,
  filterContext?: Map<string, Array<Record<string, unknown>>>,
): Map<string, unknown> {
  const defs: MeasureDef[] = cocoModel.measures.map((m) => ({
    name: m.name,
    expression: m.expression,
  }));
  return evaluateAllMeasures(base, defs, filterContext);
}

// Re-export engine types that callers need when working with measure evaluation.
export type { MeasureDef };

// ---------------------------------------------------------------------------
// Live-preview helpers — evaluate transient (unsaved) definitions
// ---------------------------------------------------------------------------

/**
 * Evaluate a transient measure expression that has NOT been added to the model
 * yet. Used by the editor dialog's live-preview feature.
 *
 * Combines the existing stored measures with the transient definition so that
 * cross-measure references still resolve during preview.
 *
 * Returns MEASURE_ERROR ("#ERROR!") on any parse or runtime failure.
 */
export function evaluateTransientMeasure(
  cocoModel: CocoDataModel,
  transient: { name: string; expression: string },
): unknown {
  const base = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);
  // Merge stored measures + transient, transient wins on name collision.
  const defs: MeasureDef[] = [
    ...cocoModel.measures
      .filter((m) => m.name !== transient.name)
      .map((m) => ({ name: m.name, expression: m.expression })),
    { name: transient.name, expression: transient.expression },
  ];
  return evaluateMeasure(base, defs, transient.name);
}

/**
 * Evaluate a transient calculated column expression that has NOT been saved
 * yet. Returns the first 5 row values (or fewer) so the editor dialog can
 * display a compact preview.
 *
 * Returns an array of cell values. Each cell is either the computed value or
 * CALC_COLUMN_ERROR ("#ERROR!") for that row.
 * Returns null when the target table is not found in the model.
 */
export function evaluateTransientCalculatedColumn(
  cocoModel: CocoDataModel,
  transient: { tableId: string; columnName: string; expression: string },
  maxRows = 5,
): unknown[] | null {
  const base = applyCalculatedColumns(toDataModel(cocoModel), cocoModel);
  const table = base.tables.find((t) => t.name === transient.tableId);
  if (!table) return null;

  const withCol = evaluateCalculatedColumns(base, [
    {
      tableId: transient.tableId,
      columnName: transient.columnName,
      expression: transient.expression,
    },
  ]);

  const previewTable = withCol.tables.find((t) => t.name === transient.tableId);
  if (!previewTable) return null;

  return previewTable.rows
    .slice(0, maxRows)
    .map((r) => r[transient.columnName]);
}

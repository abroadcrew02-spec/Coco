// Pure helpers for Excel's "Scenario Manager" (シナリオの管理) What-If
// analysis. The user defines named scenarios; each scenario stores a
// snapshot of values for a set of "changing cells" that span (potentially)
// multiple sheets. Switching the active scenario writes those stored values
// back through the host engine; building a summary table emits a side-by
// -side comparison so the user can read all scenarios at once.
//
// This module is adapter-driven so it stays free of Univer / FUniver
// imports — the caller wraps `FUniver.getActiveWorkbook().getActiveSheet()
// .getRange().getValue()` and friends in a `ScenarioAdapter` for live runs,
// and tests can supply a plain object for unit coverage.
//
// Snapshot shape (Univer 0.5.x + Coco extension, at the workbook root —
// scenarios can reference cells on any sheet so we do NOT nest them per
// -sheet):
//   {
//     _scenarios?: Array<{
//       name: string;                       // unique, user-visible label
//       comment?: string;                   // free-form description
//       changingCells: string[];            // e.g. ["Sheet1!B2", "Sheet1!B3"]
//       values: Record<string, unknown>;    // cellRef -> value; mirrors changingCells
//       createdAt: string;                  // ISO timestamp for audit / sort
//     }>;
//   }
//
// Kept side-effect free (apart from the adapter-write helpers) so it can be
// unit-tested without Univer.

export interface ScenarioEntry {
  /** User-visible label. Unique within a workbook (case-insensitive). */
  name: string;
  /** Free-form description shown in the manager UI. Optional. */
  comment?: string;
  /** A1 refs (optionally sheet-qualified) of the cells this scenario drives. */
  changingCells: string[];
  /** cellRef -> value. Mirrors `changingCells`; missing refs are ignored on apply. */
  values: Record<string, unknown>;
  /** ISO timestamp at creation. Used for stable display order and audit. */
  createdAt: string;
}

export interface WorkbookScenarioSnapshot {
  _scenarios?: ScenarioEntry[];
}

/**
 * Minimal interface the algorithm needs from the host engine. Kept tiny so
 * tests can fake it with a plain object and so this module never reaches
 * into FUniver / Univer types directly.
 */
export interface ScenarioAdapter {
  /** Read the raw value at a (sheet-qualified) A1 ref. Returns undefined if missing. */
  readCell(ref: string): unknown;
  /** Write a raw value to a (sheet-qualified) A1 ref. */
  writeCell(ref: string, value: unknown): void;
}

/** Read-only accessor with tolerant handling of malformed snapshots. */
export function listScenarios(snapshot: WorkbookScenarioSnapshot | null | undefined): ScenarioEntry[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const arr = snapshot._scenarios;
  if (!Array.isArray(arr)) return [];
  return arr.filter((s): s is ScenarioEntry => {
    if (!s || typeof s !== "object") return false;
    if (typeof s.name !== "string" || !s.name) return false;
    if (!Array.isArray(s.changingCells)) return false;
    if (!s.values || typeof s.values !== "object") return false;
    return true;
  });
}

/**
 * Insert (or replace by name) a scenario. Returns a new snapshot object so
 * the caller can JSON-stringify it for Coco's snapshot pipeline. Names are
 * matched case-insensitively to match Excel's behaviour.
 */
export function addScenario(
  snapshot: WorkbookScenarioSnapshot | null | undefined,
  entry: ScenarioEntry,
): WorkbookScenarioSnapshot {
  const base = snapshot && typeof snapshot === "object" ? snapshot : {};
  const existing = listScenarios(base);
  const lower = entry.name.trim().toLowerCase();
  const filtered = existing.filter((s) => s.name.trim().toLowerCase() !== lower);
  return { ...base, _scenarios: [...filtered, entry] };
}

/** Remove a scenario by name (case-insensitive). Returns a new snapshot. */
export function removeScenario(
  snapshot: WorkbookScenarioSnapshot | null | undefined,
  name: string,
): WorkbookScenarioSnapshot {
  const base = snapshot && typeof snapshot === "object" ? snapshot : {};
  const existing = listScenarios(base);
  const lower = name.trim().toLowerCase();
  const next = existing.filter((s) => s.name.trim().toLowerCase() !== lower);
  return { ...base, _scenarios: next };
}

/**
 * Capture the current value of every changing cell via the adapter. Missing
 * reads are stored as `null` so the values object always mirrors the
 * `changingCells` array exactly.
 */
export function captureFromCurrentValues(
  adapter: ScenarioAdapter,
  changingCells: string[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const ref of changingCells) {
    const trimmed = ref.trim();
    if (!trimmed) continue;
    const v = adapter.readCell(trimmed);
    values[trimmed] = v === undefined ? null : v;
  }
  return values;
}

/**
 * Write a scenario's stored values into the workbook via the adapter. Refs
 * that don't appear in `values` are skipped silently — the snapshot is
 * authoritative for which cells to touch.
 */
export function applyScenario(adapter: ScenarioAdapter, scenario: ScenarioEntry): void {
  for (const ref of scenario.changingCells) {
    const trimmed = ref.trim();
    if (!trimmed) continue;
    if (!Object.prototype.hasOwnProperty.call(scenario.values, trimmed)) continue;
    adapter.writeCell(trimmed, scenario.values[trimmed]);
  }
}

export interface SummaryRow {
  /** Cell ref being compared (column header in the rendered table). */
  ref: string;
  /** Per-scenario value, indexed by scenario name. */
  values: Record<string, unknown>;
}

export interface SummaryTable {
  /** Column 1 = "Changing Cells" / "Result Cells" label, then one column per scenario. */
  scenarioNames: string[];
  /** One row per changing cell, in the union order across scenarios. */
  changingRows: SummaryRow[];
  /** One row per user-provided result cell (resolved from the current sheet). */
  resultRows: SummaryRow[];
}

/**
 * Build a comparison table from a list of scenarios. Rows are the union of
 * all changing cells (preserving first-seen order) plus any caller-supplied
 * result cells. Result-cell values are NOT stored in scenarios — the caller
 * is expected to switch through each scenario and read live values via the
 * adapter; this pure builder only assembles the shape, leaving live reads
 * to the dialog integration layer.
 *
 * For unit-testability this overload accepts pre-resolved `resultValues`:
 * `Record<scenarioName, Record<cellRef, value>>`. Callers in the UI fill
 * that map by toggling scenarios and reading the adapter.
 */
export function buildSummary(
  scenarios: ScenarioEntry[],
  resultCellRefs: string[],
  resultValues: Record<string, Record<string, unknown>> = {},
): SummaryTable {
  const scenarioNames = scenarios.map((s) => s.name);
  // Union of changing cells, preserving order of first appearance.
  const seen = new Set<string>();
  const orderedRefs: string[] = [];
  for (const s of scenarios) {
    for (const ref of s.changingCells) {
      const trimmed = ref.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      orderedRefs.push(trimmed);
    }
  }
  const changingRows: SummaryRow[] = orderedRefs.map((ref) => {
    const values: Record<string, unknown> = {};
    for (const s of scenarios) {
      values[s.name] = Object.prototype.hasOwnProperty.call(s.values, ref)
        ? s.values[ref]
        : null;
    }
    return { ref, values };
  });
  const resultRows: SummaryRow[] = resultCellRefs
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((ref) => {
      const values: Record<string, unknown> = {};
      for (const s of scenarios) {
        const perScenario = resultValues[s.name];
        values[s.name] = perScenario && Object.prototype.hasOwnProperty.call(perScenario, ref)
          ? perScenario[ref]
          : null;
      }
      return { ref, values };
    });
  return { scenarioNames, changingRows, resultRows };
}

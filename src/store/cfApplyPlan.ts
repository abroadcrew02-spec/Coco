// #241 Step 2 — CfApplyPlan: pure orchestrator that uses CfSidecar to drive
// the rule add/edit/remove flow without corrupting the canonical snapshot.
//
// PR #211 (reverted in v0.4.4) failed because the cell-write path consulted
// the snapshot for BASE style — but the snapshot already had previous CF
// writes baked in. By the time the user removed a rule, BASE looked like
// AFTER, the diff was empty, and the rule's color stuck forever.
//
// The Step 1 sidecar (`src/store/cfSidecar.ts`) records the user-authored
// BASE on first contact and never overwrites it. This orchestrator
// turns (sheetId, oldRules, newRules) into a list of per-cell actions:
//
//   - "paint": apply baseStyle + new cfStyle, record sidecar entry
//   - "clear": restore baseStyle, drop sidecar entry
//   - "noop":  no change needed
//
// The orchestrator is PURE — it mutates `sidecar` (because that's a stateful
// store by design) but never the snapshot. Callers (EditorScreen) take the
// plan and issue facade writes; the facade calls Univer's command service
// which DOES mutate the workbook.

import {
  composeStyle,
  type CellStyleSlice,
  type CfSidecar,
} from "./cfSidecar";
import {
  parseSqrefToCells,
  type CfRuleEntry,
  type CellCoord,
} from "../components/conditionalFormatRender";

export type CfPlanAction = "paint" | "clear" | "noop";

export interface CfPlanEntry {
  sheetId: string;
  row: number;
  col: number;
  action: CfPlanAction;
  /** When action === "paint" / "clear", this is the final style to write. */
  finalStyle: CellStyleSlice;
  /** Rules that contributed to the AFTER cfStyle (for sidecar tracking). */
  ruleIds: string[];
}

/**
 * Best-effort rule id generator. CfRuleEntry doesn't carry an id field by
 * design (xlsx never assigns one — rules are positional), so we synthesise
 * one from (sqref + priority + type) which is stable across re-evaluations
 * within a single session.
 */
export function ruleKey(rule: CfRuleEntry, index: number): string {
  const p = rule.priority ?? index;
  const t = rule.type ?? "default";
  return `${p}-${t}-${rule.sqref}`;
}

/**
 * Read a cell's current "raw" style from a snapshot shape — what the user
 * authored, ignoring whatever CF currently shows. Used as the baseStyle
 * recorded into the sidecar on first contact.
 *
 * Tolerant — non-existent cells / sheets return an empty slice.
 */
export function readBaseStyle(
  snapshotShape: {
    sheets?: Record<
      string,
      | { cellData?: Record<string, Record<string, unknown> | undefined> }
      | undefined
    >;
  },
  sheetId: string,
  row: number,
  col: number,
): CellStyleSlice {
  const cell = snapshotShape.sheets?.[sheetId]?.cellData?.[String(row)]?.[String(col)];
  if (!cell || typeof cell !== "object") return {};
  const c = cell as { s?: unknown };
  if (!c.s || typeof c.s !== "object") return {};
  const s = c.s as Record<string, unknown>;
  const out: CellStyleSlice = {};
  const bg = s.bg as { rgb?: string } | undefined;
  if (bg && typeof bg.rgb === "string") out.bg = bg.rgb;
  const cl = s.cl as { rgb?: string } | undefined;
  if (cl && typeof cl.rgb === "string") out.cl = cl.rgb;
  const bl = s.bl;
  if (bl === 0 || bl === 1) out.bl = bl;
  const it = s.it;
  if (it === 0 || it === 1) out.it = it;
  const ul = s.ul;
  if (ul === 0 || ul === 1) out.ul = ul;
  return out;
}

/**
 * Convert a CfRuleEntry's `style` field into a CellStyleSlice. CfRuleEntry
 * uses { bold, fontColor, bgColor } whereas CellStyleSlice uses the Univer
 * shape (bl / cl / bg). Pure mapping.
 */
function ruleStyleSlice(rule: CfRuleEntry): CellStyleSlice {
  const out: CellStyleSlice = {};
  const s = rule.style;
  if (!s) {
    // Default highlight when rule has no explicit style.
    out.bg = "#fff2a8";
    out.bl = 1;
    return out;
  }
  if (s.bgColor) out.bg = s.bgColor;
  if (s.fontColor) out.cl = s.fontColor;
  if (typeof s.bold === "boolean") out.bl = s.bold ? 1 : 0;
  return out;
}

/**
 * Collect every (row, col) tuple covered by a rule's `sqref`. Bridges the
 * existing parseSqrefToCells (which yields { row, col } objects) into the
 * sheet-scoped (row, col) pairs the plan needs.
 */
function cellsForRule(rule: CfRuleEntry): CellCoord[] {
  if (!rule.sqref) return [];
  return parseSqrefToCells(rule.sqref);
}

/**
 * Compute the action plan for transitioning from `prevRules` to `nextRules`
 * on a single sheet.
 *
 * Step 1 (recordBase): for every cell touched by prev or next, ensure the
 * sidecar has a baseStyle entry — recorded from the snapshot's user-authored
 * style (NOT from any current CF paint, which is the whole bug fix).
 *
 * Step 2 (compute AFTER): for each cell, find every NEXT rule whose sqref
 * includes it; merge their styles in priority order (highest priority last
 * wins per key, matching Excel's semantic). The merged cfStyle is what CF
 * wants to paint AFTER.
 *
 * Step 3 (compute PREV): for each cell touched by prev rules but NOT by
 * next rules, the sidecar's stored cfStyle is what was painted PREV. The
 * action is "clear" — restore baseStyle.
 *
 * Step 4 (diff): for cells touched by both prev and next, if the merged
 * cfStyle differs from the sidecar's stored cfStyle, action is "paint";
 * otherwise "noop".
 *
 * Side effect: sidecar entries are CREATED on first contact (recordBase)
 * and UPDATED for paint actions (trackWrite). Cleared cells DROP their
 * entries via untrackRule. This keeps the sidecar in sync with what the
 * caller will write to the facade.
 */
export function computeCfApplyPlan(
  sidecar: CfSidecar,
  snapshotShape: Parameters<typeof readBaseStyle>[0],
  sheetId: string,
  prevRules: CfRuleEntry[],
  nextRules: CfRuleEntry[],
): CfPlanEntry[] {
  // Index next rules by their stable key so we can compare against prev.
  const nextById = new Map<string, CfRuleEntry>();
  nextRules.forEach((r, i) => nextById.set(ruleKey(r, i), r));

  // Index prev rules by their stable key. Prev rules that don't appear in
  // next are "removed" — every cell they touch needs to be cleared.
  const prevById = new Map<string, CfRuleEntry>();
  prevRules.forEach((r, i) => prevById.set(ruleKey(r, i), r));

  // Union of all cells touched by any prev OR next rule.
  type CellRef = string; // "row:col"
  const cellToRules = new Map<CellRef, { prev: CfRuleEntry[]; next: CfRuleEntry[] }>();

  const addCell = (cell: CellCoord, rule: CfRuleEntry, side: "prev" | "next") => {
    const key: CellRef = `${cell.row}:${cell.col}`;
    let bag = cellToRules.get(key);
    if (!bag) {
      bag = { prev: [], next: [] };
      cellToRules.set(key, bag);
    }
    bag[side].push(rule);
  };

  for (const rule of prevRules) for (const c of cellsForRule(rule)) addCell(c, rule, "prev");
  for (const rule of nextRules) for (const c of cellsForRule(rule)) addCell(c, rule, "next");

  const plan: CfPlanEntry[] = [];

  for (const [cellRef, bag] of cellToRules) {
    const [rowStr, colStr] = cellRef.split(":");
    const row = Number.parseInt(rowStr, 10);
    const col = Number.parseInt(colStr, 10);

    // Step 1: ensure sidecar has the BASE recorded. Idempotent — won't
    // overwrite a previously-stored base. CRITICAL: from here on we use
    // `baseStyle` from sidecar.getBaseStyle (not the local readBaseStyle),
    // because the snapshot may have been polluted by a prior CF write that
    // we want to pretend never happened.
    sidecar.recordBase(sheetId, row, col, readBaseStyle(snapshotShape, sheetId, row, col));
    const baseStyle = sidecar.getBaseStyle(sheetId, row, col) ?? {};

    // Step 2: compute the merged cfStyle for the NEXT rule set. Excel:
    // "lower priority number = higher priority". To make the highest-
    // priority rule win per style key, we sort DESCENDING by priority so
    // the lowest-number (highest-priority) rule is applied LAST in the
    // composeStyle reduce — its values stay on top.
    const sortedNext = bag.next.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    let mergedCf: CellStyleSlice = {};
    const contributingRuleIds: string[] = [];
    for (let i = 0; i < sortedNext.length; i++) {
      const rule = sortedNext[i];
      const idx = nextRules.indexOf(rule);
      contributingRuleIds.push(ruleKey(rule, idx));
      mergedCf = composeStyle(mergedCf, ruleStyleSlice(rule));
    }

    if (bag.next.length === 0) {
      // No NEXT rule covers this cell → clear. Drop sidecar entry by
      // untracking every PREV rule's contribution.
      for (let i = 0; i < bag.prev.length; i++) {
        const idx = prevRules.indexOf(bag.prev[i]);
        sidecar.untrackRule(sheetId, row, col, ruleKey(bag.prev[i], idx));
      }
      plan.push({
        sheetId,
        row,
        col,
        action: "clear",
        finalStyle: { ...baseStyle },
        ruleIds: [],
      });
      continue;
    }

    // Compute what the sidecar thinks is currently painted (if anything).
    const existing = sidecar.get(sheetId, row, col);
    const prevCf: CellStyleSlice = existing?.cfStyle ?? {};

    const isSameCf =
      prevCf.bg === mergedCf.bg &&
      prevCf.cl === mergedCf.cl &&
      prevCf.bl === mergedCf.bl &&
      prevCf.it === mergedCf.it &&
      prevCf.ul === mergedCf.ul &&
      (existing?.ruleIds.size ?? 0) === contributingRuleIds.length;

    if (isSameCf) {
      plan.push({
        sheetId,
        row,
        col,
        action: "noop",
        finalStyle: composeStyle(baseStyle, mergedCf),
        ruleIds: contributingRuleIds,
      });
      continue;
    }

    // Paint: update the sidecar entry with the new cfStyle + contributing rules.
    // We trackWrite once per contributing rule so untrackRule() works later;
    // since trackWrite accumulates rule ids but replaces cfStyle wholesale,
    // calling it for every rule with the same merged style gives us the
    // correct accumulated ruleIds.
    for (const rid of contributingRuleIds) {
      sidecar.trackWrite(sheetId, row, col, baseStyle, mergedCf, rid);
    }
    // Drop any PREV rule ids that aren't in NEXT (removed contributions).
    const nextIdSet = new Set(contributingRuleIds);
    for (const prevRule of bag.prev) {
      const idx = prevRules.indexOf(prevRule);
      const rid = ruleKey(prevRule, idx);
      if (!nextIdSet.has(rid)) sidecar.untrackRule(sheetId, row, col, rid);
    }

    plan.push({
      sheetId,
      row,
      col,
      action: "paint",
      finalStyle: composeStyle(baseStyle, mergedCf),
      ruleIds: contributingRuleIds,
    });
  }

  return plan;
}

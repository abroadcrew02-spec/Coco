// Pure helpers for the "Quick CF Presets" flow — one-click application of the
// handful of conditional-formatting rules Excel users reach for most often
// (Top/Bottom 10, Above/Below Average, Duplicates/Unique, Date occurring in
// Last 7 days / This week / This month).
//
// The dialog (QuickCfDialog.tsx) collects (range, presetId); this module
// translates the choice into a CfRuleEntry and appends it to the snapshot's
// per-sheet `_conditionalFormatting` array — the same data the round-trip
// path in xlsx_io.rs (Rust side) and conditionalFormatRender.ts (TS side)
// already understand. No Univer / React imports — kept side-effect free so it
// can be unit-tested without the editor harness.
//
// Snapshot shape (Univer 0.5.x + Coco extension) consumed here:
//   {
//     sheets: {
//       <sheetId>: {
//         _conditionalFormatting?: Array<{
//           sqref: string;
//           type?: string;       // top10 | aboveAverage | duplicateValues | uniqueValues | timePeriod
//           operator?: string;
//           formula1?: string;
//           rank?: number;
//           percent?: boolean;
//           bottom?: boolean;
//           aboveAverage?: { below?: boolean; equalAverage?: boolean };
//           timePeriod?: string;
//           priority?: number;
//           style?: { bold?: boolean; fontColor?: string; bgColor?: string };
//         }>
//       }
//     }
//   }
//
// The existing ConditionalFormattingDialog already declares the full CfRule
// type (incl. aboveAverage + timePeriod), and conditionalFormatRender.ts'
// CfRuleEntry shape carries the matching optional fields — so any preset we
// emit here round-trips through both the authoring UI and the in-grid render
// path without further changes. The render module ignores unknown rule types
// (default branch in ruleMatches returns false), which keeps any future
// preset additions safe.

import type { CfRuleEntry } from "../components/conditionalFormatRender";

export interface QuickCfPreset {
  id: string;
  nameJa: string;
  nameEn: string;
  category: "topBottom" | "aboveBelowAvg" | "duplicateUnique" | "dateRange";
  defaultStyle: { bgColor: string; fontColor?: string };
}

/** Canonical preset catalog. The id is dispatched back to applyQuickCfPreset
 *  by the dialog; rename ids only with care — they're stable surface area. */
export const QUICK_CF_PRESETS: readonly QuickCfPreset[] = [
  // --- Top / Bottom ---------------------------------------------------------
  {
    id: "top10-items",
    nameJa: "上位 10 項目",
    nameEn: "Top 10 items",
    category: "topBottom",
    defaultStyle: { bgColor: "#c6efce", fontColor: "#006100" },
  },
  {
    id: "top10-percent",
    nameJa: "上位 10%",
    nameEn: "Top 10%",
    category: "topBottom",
    defaultStyle: { bgColor: "#c6efce", fontColor: "#006100" },
  },
  {
    id: "bottom10-items",
    nameJa: "下位 10 項目",
    nameEn: "Bottom 10 items",
    category: "topBottom",
    defaultStyle: { bgColor: "#ffc7ce", fontColor: "#9c0006" },
  },
  {
    id: "bottom10-percent",
    nameJa: "下位 10%",
    nameEn: "Bottom 10%",
    category: "topBottom",
    defaultStyle: { bgColor: "#ffc7ce", fontColor: "#9c0006" },
  },
  // --- Above / Below Average -----------------------------------------------
  {
    id: "above-average",
    nameJa: "平均より上",
    nameEn: "Above average",
    category: "aboveBelowAvg",
    defaultStyle: { bgColor: "#c6efce", fontColor: "#006100" },
  },
  {
    id: "below-average",
    nameJa: "平均より下",
    nameEn: "Below average",
    category: "aboveBelowAvg",
    defaultStyle: { bgColor: "#ffc7ce", fontColor: "#9c0006" },
  },
  // --- Duplicate / Unique ---------------------------------------------------
  {
    id: "duplicate-values",
    nameJa: "重複値",
    nameEn: "Duplicate values",
    category: "duplicateUnique",
    defaultStyle: { bgColor: "#ffeb9c", fontColor: "#9c5700" },
  },
  {
    id: "unique-values",
    nameJa: "一意の値",
    nameEn: "Unique values",
    category: "duplicateUnique",
    defaultStyle: { bgColor: "#bdd7ee", fontColor: "#1f4e79" },
  },
  // --- Date Range -----------------------------------------------------------
  {
    id: "date-last-7-days",
    nameJa: "過去 7 日間の日付",
    nameEn: "Date in last 7 days",
    category: "dateRange",
    defaultStyle: { bgColor: "#fff2a8", fontColor: "#7f6000" },
  },
  {
    id: "date-this-week",
    nameJa: "今週の日付",
    nameEn: "Date this week",
    category: "dateRange",
    defaultStyle: { bgColor: "#fff2a8", fontColor: "#7f6000" },
  },
  {
    id: "date-this-month",
    nameJa: "今月の日付",
    nameEn: "Date this month",
    category: "dateRange",
    defaultStyle: { bgColor: "#fff2a8", fontColor: "#7f6000" },
  },
] as const;

/** Lookup helper for the dialog — returns null on unknown id so callers can
 *  fail open without throwing. */
export function findPreset(id: string): QuickCfPreset | null {
  return QUICK_CF_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Build an aboveAverage CfRuleEntry. The render path in
 * conditionalFormatRender.ts doesn't yet evaluate aboveAverage (ruleMatches'
 * default branch returns false), but the rule still round-trips through
 * xlsx_io.rs and the existing ConditionalFormattingDialog renders it in the
 * rule list — so authoring + persistence work even without an in-grid render.
 */
export function buildAboveAverageRule(sqref: string, above: boolean): CfRuleEntry {
  // The CfRuleEntry shape declared in conditionalFormatRender.ts intentionally
  // omits the `aboveAverage` sub-object (it's CfRule-only in the dialog), so
  // we widen via `Record<string, unknown>` for the extra field while still
  // returning the CfRuleEntry-shaped fields the render path consumes.
  const rule: CfRuleEntry & Record<string, unknown> = {
    sqref,
    type: "aboveAverage",
  };
  if (!above) {
    // Excel writes `<cfRule type="aboveAverage" aboveAverage="0">` for the
    // below-average variant. Mirror that with the dialog's nested shape so
    // the authoring UI displays the toggle correctly.
    rule.aboveAverage = { below: true };
  }
  return rule;
}

/** Build a timePeriod CfRuleEntry for one of the OOXML period codes. */
function buildTimePeriodRule(
  sqref: string,
  timePeriod: "last7Days" | "thisWeek" | "thisMonth",
): CfRuleEntry {
  const rule: CfRuleEntry & Record<string, unknown> = {
    sqref,
    type: "timePeriod",
  };
  rule.timePeriod = timePeriod;
  return rule;
}

/** Build a top10 CfRuleEntry with the requested toggles flipped. */
function buildTop10Rule(
  sqref: string,
  rank: number,
  percent: boolean,
  bottom: boolean,
): CfRuleEntry {
  const rule: CfRuleEntry = {
    sqref,
    type: "top10",
    rank,
  };
  if (percent) rule.percent = true;
  if (bottom) rule.bottom = true;
  return rule;
}

/** Build a duplicateValues / uniqueValues CfRuleEntry. */
function buildDupUniqueRule(sqref: string, unique: boolean): CfRuleEntry {
  return {
    sqref,
    type: unique ? "uniqueValues" : "duplicateValues",
  };
}

/** Convert a preset id into the matching CfRuleEntry skeleton. Returns null
 *  when the id isn't recognised so callers can no-op cleanly. */
function ruleForPreset(preset: QuickCfPreset, sqref: string): CfRuleEntry | null {
  switch (preset.id) {
    case "top10-items":
      return buildTop10Rule(sqref, 10, false, false);
    case "top10-percent":
      return buildTop10Rule(sqref, 10, true, false);
    case "bottom10-items":
      return buildTop10Rule(sqref, 10, false, true);
    case "bottom10-percent":
      return buildTop10Rule(sqref, 10, true, true);
    case "above-average":
      return buildAboveAverageRule(sqref, true);
    case "below-average":
      return buildAboveAverageRule(sqref, false);
    case "duplicate-values":
      return buildDupUniqueRule(sqref, false);
    case "unique-values":
      return buildDupUniqueRule(sqref, true);
    case "date-last-7-days":
      return buildTimePeriodRule(sqref, "last7Days");
    case "date-this-week":
      return buildTimePeriodRule(sqref, "thisWeek");
    case "date-this-month":
      return buildTimePeriodRule(sqref, "thisMonth");
    default:
      return null;
  }
}

/** Internal snapshot shape used here — narrow on purpose so the helper isn't
 *  coupled to the full Univer ISnapshot definition. */
type CfSnapshot = {
  sheets?: Record<
    string,
    {
      _conditionalFormatting?: CfRuleEntry[];
    } | undefined
  >;
};

export interface ApplyQuickCfResult {
  /** New snapshot object with the rule appended. When ruleAdded is false
   *  this is === the input (no clone is performed on failure paths). */
  snapshotMutated: object;
  /** False when the snapshot is malformed, the sheet is missing, the range
   *  is empty, or the preset id is unknown. */
  ruleAdded: boolean;
}

/**
 * Append a quick-preset CF rule to `sheets[sheetId]._conditionalFormatting`.
 *
 * - Computes priority as `max(existing.priority) + 1` so the new rule sits
 *   at the lowest priority (highest number); existing higher-priority rules
 *   keep their styling when they collide on the same cells. Falls back to
 *   `existing.length + 1` when no rule carries an explicit priority.
 * - Copies `defaultStyle` from the preset onto the rule's `style` field so
 *   the in-grid render path (conditionalFormatRender.styleForRule) and the
 *   xlsx exporter (xlsx_io.rs dxf writer) produce a visible highlight.
 * - Returns `{ snapshotMutated: snapshot, ruleAdded: false }` on any failure
 *   so the caller can fail open without surfacing an error.
 * - On success, returns a *deep clone* of the input with the new rule
 *   appended; the input snapshot (and its nested sheet objects) are never
 *   mutated. This keeps callers safe from accidental aliasing — see
 *   issue #114-B.
 */
export function applyQuickCfPreset(
  snapshot: object,
  sheetId: string,
  range: string,
  presetId: string,
): ApplyQuickCfResult {
  if (!snapshot || typeof snapshot !== "object") {
    return { snapshotMutated: snapshot, ruleAdded: false };
  }
  const preset = findPreset(presetId);
  if (!preset) {
    return { snapshotMutated: snapshot, ruleAdded: false };
  }
  const sqref = range.trim();
  if (!sqref) {
    return { snapshotMutated: snapshot, ruleAdded: false };
  }
  const inputSnap = snapshot as CfSnapshot;
  const sourceSheet = inputSnap.sheets?.[sheetId];
  if (!sourceSheet) {
    return { snapshotMutated: snapshot, ruleAdded: false };
  }
  const rule = ruleForPreset(preset, sqref);
  if (!rule) {
    return { snapshotMutated: snapshot, ruleAdded: false };
  }
  // Style fields are optional in CfRuleEntry — attach the preset's defaults
  // (bg + optional fg) so the existing render module produces a highlight.
  rule.style = {
    bgColor: preset.defaultStyle.bgColor,
    ...(preset.defaultStyle.fontColor ? { fontColor: preset.defaultStyle.fontColor } : {}),
  };
  const existing = Array.isArray(sourceSheet._conditionalFormatting)
    ? sourceSheet._conditionalFormatting
    : [];
  let maxPriority = 0;
  for (const r of existing) {
    const p = typeof r?.priority === "number" ? r.priority : 0;
    if (p > maxPriority) maxPriority = p;
  }
  rule.priority = (maxPriority > 0 ? maxPriority : existing.length) + 1;
  // Deep clone before mutating so the input snapshot is never touched. On
  // serialization failure (cyclic snapshot, etc) we fail open.
  let cloned: CfSnapshot;
  try {
    cloned = JSON.parse(JSON.stringify(inputSnap)) as CfSnapshot;
  } catch {
    return { snapshotMutated: snapshot, ruleAdded: false };
  }
  const clonedSheets = cloned.sheets;
  const clonedSheet = clonedSheets ? clonedSheets[sheetId] : undefined;
  if (!clonedSheet) {
    return { snapshotMutated: snapshot, ruleAdded: false };
  }
  const clonedExisting = Array.isArray(clonedSheet._conditionalFormatting)
    ? clonedSheet._conditionalFormatting
    : [];
  clonedSheet._conditionalFormatting = [...clonedExisting, rule];
  return { snapshotMutated: cloned, ruleAdded: true };
}

/** Convenience grouping used by the dialog's category sections. */
export function presetsByCategory(): Record<QuickCfPreset["category"], QuickCfPreset[]> {
  const out: Record<QuickCfPreset["category"], QuickCfPreset[]> = {
    topBottom: [],
    aboveBelowAvg: [],
    duplicateUnique: [],
    dateRange: [],
  };
  for (const p of QUICK_CF_PRESETS) out[p.category].push(p);
  return out;
}

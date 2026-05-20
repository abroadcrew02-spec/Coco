// Pure helpers for Excel's "Manage Rules" workflow over conditional
// formatting. The CfRuleManagerDialog uses these to flatten every CF rule
// across all sheets, reorder rules by priority, and delete rules — all
// without touching Univer directly.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         _conditionalFormatting?: Array<CfRuleEntry>
//       }
//     }
//   }
//
// `_conditionalFormatting` entries are the same shape the xlsx round-trip
// uses; see CfRuleEntry in components/conditionalFormatRender.ts. Priority
// follows Excel convention: lower number = higher priority. When the field
// is omitted we fall back to the array index as the effective priority,
// matching how patchCfRenders sorts rules.

import type { CfRuleEntry } from "../components/conditionalFormatRender";

export interface CfRuleListing {
  sheetId: string;
  sheetName: string;
  rule: CfRuleEntry;
  /** Position of the rule within its sheet's `_conditionalFormatting` array. */
  ruleIndex: number;
}

export interface WorkbookCfSnapshot {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        _conditionalFormatting?: CfRuleEntry[];
      }
    | undefined
  >;
}

function deepClone<T>(value: T): T {
  // Snapshot helpers always operate on plain JSON-shaped data, so structured
  // clone via JSON is sufficient and avoids the structuredClone polyfill
  // dependency. Falls back to the original object if cloning fails (e.g.
  // exotic values that can't round-trip — none expected for CF data).
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function effectivePriority(rule: CfRuleEntry, ruleIndex: number): number {
  // Excel uses 1-based priorities; we accept missing values by falling back to
  // the array index + 1 so unsorted snapshots still produce stable ordering.
  return typeof rule.priority === "number" && Number.isFinite(rule.priority)
    ? rule.priority
    : ruleIndex + 1;
}

/**
 * Flatten every CF rule across every sheet, sorted by (sheet name, priority).
 * Returns an empty array when the snapshot has no sheets / no rules. The
 * returned `rule` is a reference into the original snapshot — callers must
 * not mutate it (use the dedicated mutation helpers below).
 */
export function listAllCfRules(snapshot: WorkbookCfSnapshot | null | undefined): CfRuleListing[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const sheets = snapshot.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  // Honor sheetOrder when present so the listing matches tab order; otherwise
  // fall back to the keys in their declared object order.
  const order: string[] =
    Array.isArray(snapshot.sheetOrder) && snapshot.sheetOrder.length > 0
      ? snapshot.sheetOrder.filter((s): s is string => typeof s === "string")
      : Object.keys(sheets);

  const out: CfRuleListing[] = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const rules = sheet._conditionalFormatting;
    if (!Array.isArray(rules) || rules.length === 0) continue;
    const sheetName = typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    rules.forEach((rule, ruleIndex) => {
      if (!rule || typeof rule !== "object") return;
      out.push({ sheetId, sheetName, rule, ruleIndex });
    });
  }

  // Sort by sheet name first, then by effective priority (low = high priority).
  out.sort((a, b) => {
    const byName = a.sheetName.localeCompare(b.sheetName);
    if (byName !== 0) return byName;
    return effectivePriority(a.rule, a.ruleIndex) - effectivePriority(b.rule, b.ruleIndex);
  });

  return out;
}

/**
 * Swap a rule's priority with its adjacent sibling (within the same sheet).
 * "up" moves toward higher priority (lower number); "down" moves toward
 * lower priority (higher number). Returns a new snapshot — the input is
 * never mutated. No-op (returns deep clone unchanged) when the swap would
 * fall off either end of the array or the rule / sheet doesn't exist.
 */
export function reorderRule(
  snapshot: WorkbookCfSnapshot,
  sheetId: string,
  ruleIndex: number,
  direction: "up" | "down",
): WorkbookCfSnapshot {
  const next = deepClone(snapshot);
  const sheet = next.sheets?.[sheetId];
  const rules = sheet?._conditionalFormatting;
  if (!Array.isArray(rules)) return next;
  if (ruleIndex < 0 || ruleIndex >= rules.length) return next;

  // Sort rules ascending by priority so swaps reflect Excel's display order
  // rather than the underlying array order (rule arrays from xlsx are not
  // guaranteed sorted). We mutate the cloned array in place then write
  // priorities back so the snapshot stays normalized.
  const indexed = rules.map((r, i) => ({ rule: r, originalIndex: i }));
  indexed.sort(
    (a, b) => effectivePriority(a.rule, a.originalIndex) - effectivePriority(b.rule, b.originalIndex),
  );
  const targetPos = indexed.findIndex((e) => e.originalIndex === ruleIndex);
  if (targetPos === -1) return next;

  const swapWith = direction === "up" ? targetPos - 1 : targetPos + 1;
  if (swapWith < 0 || swapWith >= indexed.length) return next;

  // Swap positions in the sorted view, then renumber priorities 1..N so the
  // snapshot has a clean priority sequence — easier on the round-trip and on
  // Excel's expectations of contiguous priorities.
  const tmp = indexed[targetPos];
  indexed[targetPos] = indexed[swapWith];
  indexed[swapWith] = tmp;
  indexed.forEach((entry, i) => {
    entry.rule.priority = i + 1;
  });

  // Rebuild the array in priority order so the on-disk shape matches what
  // the dialog displayed (and what `listAllCfRules` will return next time).
  sheet!._conditionalFormatting = indexed.map((e) => e.rule);
  return next;
}

/**
 * Remove a rule from a sheet. Returns a new snapshot — input is unchanged.
 * No-op when the sheet / rule index doesn't exist. After deletion the
 * remaining rules have their priorities renumbered 1..N so gaps don't
 * accumulate across repeated edits.
 */
export function deleteRule(
  snapshot: WorkbookCfSnapshot,
  sheetId: string,
  ruleIndex: number,
): WorkbookCfSnapshot {
  const next = deepClone(snapshot);
  const sheet = next.sheets?.[sheetId];
  const rules = sheet?._conditionalFormatting;
  if (!Array.isArray(rules)) return next;
  if (ruleIndex < 0 || ruleIndex >= rules.length) return next;

  rules.splice(ruleIndex, 1);
  // Renumber so priorities stay contiguous.
  const indexed = rules.map((r, i) => ({ rule: r, originalIndex: i }));
  indexed.sort(
    (a, b) => effectivePriority(a.rule, a.originalIndex) - effectivePriority(b.rule, b.originalIndex),
  );
  indexed.forEach((entry, i) => {
    entry.rule.priority = i + 1;
  });
  sheet!._conditionalFormatting = indexed.map((e) => e.rule);
  return next;
}

const ICON_STYLE_LABELS: Record<string, string> = {
  "3arrows": "3 arrows",
  "3traffic": "3 traffic lights",
  "5rating": "5 rating",
};

const TIME_PERIOD_LABELS: Record<string, string> = {
  today: "today",
  yesterday: "yesterday",
  tomorrow: "tomorrow",
  last7Days: "last 7 days",
  thisWeek: "this week",
  lastWeek: "last week",
  nextWeek: "next week",
  thisMonth: "this month",
  lastMonth: "last month",
  nextMonth: "next month",
};

const CELLIS_OP_LABELS: Record<string, string> = {
  greaterThan: ">",
  greaterThanOrEqual: ">=",
  lessThan: "<",
  lessThanOrEqual: "<=",
  equal: "=",
  notEqual: "!=",
  between: "between",
  notBetween: "not between",
};

/**
 * Render a one-line, plain-text summary of a CF rule. Used by the manager
 * dialog's table column — kept terse (no "Rule: " prefix) so it fits on a
 * row with the sqref + actions. Excel's own manager uses similar phrasing
 * ("Cell Value > 100", "Top 10%", "Color scale (3 colors)").
 */
export function summarizeRule(rule: CfRuleEntry): string {
  const type = rule.type ?? "";
  switch (type) {
    case "cellIs": {
      const op = CELLIS_OP_LABELS[rule.operator ?? ""] ?? rule.operator ?? "";
      const f1 = rule.formula1 ?? "";
      if (rule.operator === "between" || rule.operator === "notBetween") {
        return `Cell value ${op} ${f1} / ${rule.formula2 ?? ""}`.trim();
      }
      return `Cell value ${op} ${f1}`.trim();
    }
    case "containsText":
      return `Contains "${rule.text ?? ""}"`;
    case "top10": {
      const dir = rule.bottom ? "Bottom" : "Top";
      const suffix = rule.percent ? "%" : "";
      return `${dir} ${rule.rank ?? 10}${suffix}`;
    }
    case "duplicateValues":
      return "Duplicate values";
    case "uniqueValues":
      return "Unique values";
    case "dataBar":
      return `Data bar (${rule.color ?? "#638EC6"})`;
    case "colorScale":
      return `Color scale (${rule.colorScaleType === "3color" ? "3 colors" : "2 colors"})`;
    case "iconSet": {
      const label = ICON_STYLE_LABELS[rule.iconStyle ?? ""] ?? rule.iconStyle ?? "";
      return `Icon set: ${label}`.trim();
    }
    case "expression":
      return `Formula: ${rule.formula1 ?? ""}`;
    default: {
      // Some rule types (aboveAverage, timePeriod) only exist in the dialog
      // shape — handle them best-effort so they still render legibly.
      const tp = (rule as { timePeriod?: string }).timePeriod;
      if (type === "timePeriod" && tp) {
        return `Date: ${TIME_PERIOD_LABELS[tp] ?? tp}`;
      }
      const aa = (rule as { aboveAverage?: { below?: boolean; equalAverage?: boolean } }).aboveAverage;
      if (type === "aboveAverage") {
        const dir = aa?.below ? "below" : "above";
        const eq = aa?.equalAverage ? " (incl. avg)" : "";
        return `Value ${dir} average${eq}`;
      }
      return type || "(unknown rule)";
    }
  }
}

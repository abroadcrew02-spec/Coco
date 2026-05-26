import { describe, it, expect } from "vitest";
import type { CfRuleEntry } from "../../components/conditionalFormatRender";
import {
  QUICK_CF_PRESETS,
  findPreset,
  buildAboveAverageRule,
  presetsByCategory,
  applyQuickCfPreset,
} from "../quickCfPresets";

// ---------------------------------------------------------------------------
// QUICK_CF_PRESETS catalog integrity
// ---------------------------------------------------------------------------

describe("QUICK_CF_PRESETS catalog integrity", () => {
  it("contains exactly 11 presets", () => {
    expect(QUICK_CF_PRESETS).toHaveLength(11);
  });

  it("has no duplicate ids", () => {
    const ids = QUICK_CF_PRESETS.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all categories are valid union members", () => {
    const validCategories = new Set([
      "topBottom",
      "aboveBelowAvg",
      "duplicateUnique",
      "dateRange",
    ]);
    for (const p of QUICK_CF_PRESETS) {
      expect(validCategories.has(p.category)).toBe(true);
    }
  });

  it("all bgColor values match #RRGGBB format", () => {
    const hexPattern = /^#[0-9a-fA-F]{6}$/;
    for (const p of QUICK_CF_PRESETS) {
      expect(p.defaultStyle.bgColor).toMatch(hexPattern);
    }
  });

  it("all nameJa are non-empty strings", () => {
    for (const p of QUICK_CF_PRESETS) {
      expect(typeof p.nameJa).toBe("string");
      expect(p.nameJa.length).toBeGreaterThan(0);
    }
  });

  it("all nameEn are non-empty strings", () => {
    for (const p of QUICK_CF_PRESETS) {
      expect(typeof p.nameEn).toBe("string");
      expect(p.nameEn.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// findPreset
// ---------------------------------------------------------------------------

describe("findPreset", () => {
  it("returns the correct preset for each of the 11 known ids", () => {
    const knownIds = [
      "top10-items",
      "top10-percent",
      "bottom10-items",
      "bottom10-percent",
      "above-average",
      "below-average",
      "duplicate-values",
      "unique-values",
      "date-last-7-days",
      "date-this-week",
      "date-this-month",
    ];
    for (const id of knownIds) {
      const result = findPreset(id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
    }
  });

  it("returns null for an unknown id", () => {
    expect(findPreset("does-not-exist")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(findPreset("")).toBeNull();
  });

  it("returns null for undefined coerced via type cast", () => {
    // TypeScript signature is string, but runtime callers may pass undefined.
    expect(findPreset(undefined as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildAboveAverageRule
// ---------------------------------------------------------------------------

describe("buildAboveAverageRule", () => {
  it("above:true — returns type 'aboveAverage' with no aboveAverage sub-object", () => {
    const rule = buildAboveAverageRule("A1:A10", true);
    expect(rule.sqref).toBe("A1:A10");
    expect(rule.type).toBe("aboveAverage");
    expect((rule as unknown as Record<string, unknown>).aboveAverage).toBeUndefined();
  });

  it("above:false — returns type 'aboveAverage' with aboveAverage.below = true", () => {
    const rule = buildAboveAverageRule("B1:B5", false) as CfRuleEntry & {
      aboveAverage?: { below?: boolean };
    };
    expect(rule.sqref).toBe("B1:B5");
    expect(rule.type).toBe("aboveAverage");
    expect(rule.aboveAverage).toBeDefined();
    expect(rule.aboveAverage!.below).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// presetsByCategory
// ---------------------------------------------------------------------------

describe("presetsByCategory", () => {
  it("returns an object with all 4 category keys", () => {
    const result = presetsByCategory();
    expect(result).toHaveProperty("topBottom");
    expect(result).toHaveProperty("aboveBelowAvg");
    expect(result).toHaveProperty("duplicateUnique");
    expect(result).toHaveProperty("dateRange");
  });

  it("total across all categories equals 11", () => {
    const result = presetsByCategory();
    const total =
      result.topBottom.length +
      result.aboveBelowAvg.length +
      result.duplicateUnique.length +
      result.dateRange.length;
    expect(total).toBe(11);
  });

  it("topBottom has 4 presets", () => {
    expect(presetsByCategory().topBottom).toHaveLength(4);
  });

  it("aboveBelowAvg has 2 presets", () => {
    expect(presetsByCategory().aboveBelowAvg).toHaveLength(2);
  });

  it("duplicateUnique has 2 presets", () => {
    expect(presetsByCategory().duplicateUnique).toHaveLength(2);
  });

  it("dateRange has 3 presets", () => {
    expect(presetsByCategory().dateRange).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal snapshot with a single sheet containing zero CF rules. */
function makeSnap(
  sheetId: string,
  existing?: CfRuleEntry[],
): {
  sheets: Record<string, { _conditionalFormatting?: CfRuleEntry[] }>;
} {
  return {
    sheets: {
      [sheetId]: existing !== undefined ? { _conditionalFormatting: existing } : {},
    },
  };
}

// ---------------------------------------------------------------------------
// applyQuickCfPreset — success paths × 11 presets
// ---------------------------------------------------------------------------

describe("applyQuickCfPreset — rule shape per preset", () => {
  const SHEET = "sheet1";
  const RANGE = "A1:A10";

  it("top10-items: type=top10, rank=10, no percent, no bottom", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "top10-items",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rules = snap.sheets[SHEET]._conditionalFormatting!;
    const rule = rules[0];
    expect(rule.type).toBe("top10");
    expect(rule.rank).toBe(10);
    expect(rule.percent).toBeUndefined();
    expect(rule.bottom).toBeUndefined();
  });

  it("top10-percent: type=top10, rank=10, percent=true, no bottom", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "top10-percent",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.type).toBe("top10");
    expect(rule.rank).toBe(10);
    expect(rule.percent).toBe(true);
    expect(rule.bottom).toBeUndefined();
  });

  it("bottom10-items: type=top10, rank=10, no percent, bottom=true", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "bottom10-items",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.type).toBe("top10");
    expect(rule.rank).toBe(10);
    expect(rule.percent).toBeUndefined();
    expect(rule.bottom).toBe(true);
  });

  it("bottom10-percent: type=top10, rank=10, percent=true, bottom=true", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "bottom10-percent",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.type).toBe("top10");
    expect(rule.rank).toBe(10);
    expect(rule.percent).toBe(true);
    expect(rule.bottom).toBe(true);
  });

  it("above-average: type=aboveAverage, no aboveAverage sub-object", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "above-average",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0] as CfRuleEntry &
      Record<string, unknown>;
    expect(rule.type).toBe("aboveAverage");
    expect(rule.aboveAverage).toBeUndefined();
  });

  it("below-average: type=aboveAverage, aboveAverage.below=true", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "below-average",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0] as CfRuleEntry &
      Record<string, unknown>;
    expect(rule.type).toBe("aboveAverage");
    expect((rule.aboveAverage as { below?: boolean } | undefined)?.below).toBe(true);
  });

  it("duplicate-values: type=duplicateValues", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "duplicate-values",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.type).toBe("duplicateValues");
  });

  it("unique-values: type=uniqueValues", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "unique-values",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.type).toBe("uniqueValues");
  });

  it("date-last-7-days: type=timePeriod, timePeriod=last7Days", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "date-last-7-days",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0] as CfRuleEntry &
      Record<string, unknown>;
    expect(rule.type).toBe("timePeriod");
    expect(rule.timePeriod).toBe("last7Days");
  });

  it("date-this-week: type=timePeriod, timePeriod=thisWeek", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "date-this-week",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0] as CfRuleEntry &
      Record<string, unknown>;
    expect(rule.type).toBe("timePeriod");
    expect(rule.timePeriod).toBe("thisWeek");
  });

  it("date-this-month: type=timePeriod, timePeriod=thisMonth", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "date-this-month",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0] as CfRuleEntry &
      Record<string, unknown>;
    expect(rule.type).toBe("timePeriod");
    expect(rule.timePeriod).toBe("thisMonth");
  });
});

// ---------------------------------------------------------------------------
// applyQuickCfPreset — style copy
// ---------------------------------------------------------------------------

describe("applyQuickCfPreset — style copy", () => {
  const SHEET = "sheet1";
  const RANGE = "A1:A10";

  it("copies bgColor from preset defaultStyle onto rule.style", () => {
    const preset = findPreset("top10-items")!;
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "top10-items",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.style?.bgColor).toBe(preset.defaultStyle.bgColor);
  });

  it("copies fontColor from preset defaultStyle onto rule.style when present", () => {
    const preset = findPreset("above-average")!;
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET),
      SHEET,
      RANGE,
      "above-average",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.style?.fontColor).toBe(preset.defaultStyle.fontColor);
  });
});

// ---------------------------------------------------------------------------
// applyQuickCfPreset — priority calculation
// ---------------------------------------------------------------------------

describe("applyQuickCfPreset — priority calculation", () => {
  const SHEET = "sheet1";
  const RANGE = "A1:A10";

  it("existing 0 rules → priority = 1", () => {
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET, []),
      SHEET,
      RANGE,
      "top10-items",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rule = snap.sheets[SHEET]._conditionalFormatting![0];
    expect(rule.priority).toBe(1);
  });

  it("existing rules with max priority 5 → priority = 6", () => {
    const existing: CfRuleEntry[] = [
      { sqref: "A1:A5", type: "top10", priority: 3 },
      { sqref: "A1:A5", type: "top10", priority: 5 },
    ];
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET, existing),
      SHEET,
      RANGE,
      "top10-items",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rules = snap.sheets[SHEET]._conditionalFormatting!;
    const newRule = rules[rules.length - 1];
    expect(newRule.priority).toBe(6);
  });

  it("existing rules with no priority fields → priority = length + 1", () => {
    const existing: CfRuleEntry[] = [
      { sqref: "A1:A5", type: "top10" },
      { sqref: "A1:A5", type: "top10" },
    ];
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      makeSnap(SHEET, existing),
      SHEET,
      RANGE,
      "top10-items",
    );
    expect(ruleAdded).toBe(true);
    const snap = snapshotMutated as ReturnType<typeof makeSnap>;
    const rules = snap.sheets[SHEET]._conditionalFormatting!;
    const newRule = rules[rules.length - 1];
    // existing.length = 2 → priority = 2 + 1 = 3
    expect(newRule.priority).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// applyQuickCfPreset — fail-open paths
// ---------------------------------------------------------------------------

describe("applyQuickCfPreset — fail-open (ruleAdded: false)", () => {
  const SHEET = "sheet1";
  const RANGE = "A1:A10";

  it("null snapshot → ruleAdded: false, returns the input by reference", () => {
    const input = null as unknown as object;
    const result = applyQuickCfPreset(input, SHEET, RANGE, "top10-items");
    expect(result.ruleAdded).toBe(false);
    expect(result.snapshotMutated).toBe(input);
  });

  it("numeric snapshot → ruleAdded: false", () => {
    const input = 42 as unknown as object;
    const result = applyQuickCfPreset(input, SHEET, RANGE, "top10-items");
    expect(result.ruleAdded).toBe(false);
    expect(result.snapshotMutated).toBe(input);
  });

  it("string snapshot → ruleAdded: false", () => {
    const input = "not-a-snapshot" as unknown as object;
    const result = applyQuickCfPreset(input, SHEET, RANGE, "top10-items");
    expect(result.ruleAdded).toBe(false);
    expect(result.snapshotMutated).toBe(input);
  });

  it("unknown presetId → ruleAdded: false", () => {
    const snap = makeSnap(SHEET);
    const result = applyQuickCfPreset(snap, SHEET, RANGE, "non-existent-preset");
    expect(result.ruleAdded).toBe(false);
    expect(result.snapshotMutated).toBe(snap);
  });

  it("empty range string → ruleAdded: false", () => {
    const snap = makeSnap(SHEET);
    const result = applyQuickCfPreset(snap, SHEET, "   ", "top10-items");
    expect(result.ruleAdded).toBe(false);
    expect(result.snapshotMutated).toBe(snap);
  });

  it("sheet not present in snapshot → ruleAdded: false", () => {
    const snap = makeSnap("other-sheet");
    const result = applyQuickCfPreset(snap, SHEET, RANGE, "top10-items");
    expect(result.ruleAdded).toBe(false);
    expect(result.snapshotMutated).toBe(snap);
  });

  it("circular reference in snapshot → ruleAdded: false, snapshot === input", () => {
    // Create an object that will throw when JSON.stringify is called.
    const circular: Record<string, unknown> = {
      sheets: { [SHEET]: {} },
    };
    circular.self = circular;
    const result = applyQuickCfPreset(circular, SHEET, RANGE, "top10-items");
    expect(result.ruleAdded).toBe(false);
    expect(result.snapshotMutated).toBe(circular);
  });
});

// ---------------------------------------------------------------------------
// applyQuickCfPreset — immutability (input snapshot never mutated)
// ---------------------------------------------------------------------------

describe("applyQuickCfPreset — input snapshot immutability", () => {
  it("does not mutate the input snapshot on success", () => {
    const SHEET = "sheet1";
    const snap = makeSnap(SHEET, [{ sqref: "A1:A5", type: "top10", priority: 1 }]);
    const beforeStr = JSON.stringify(snap);
    const { ruleAdded } = applyQuickCfPreset(snap, SHEET, "B1:B10", "top10-items");
    expect(ruleAdded).toBe(true);
    expect(JSON.stringify(snap)).toBe(beforeStr);
  });
});

// ---------------------------------------------------------------------------
// applyQuickCfPreset — _conditionalFormatting non-array edge cases
// ---------------------------------------------------------------------------

describe("applyQuickCfPreset — _conditionalFormatting non-array treated as empty", () => {
  const SHEET = "sheet1";
  const RANGE = "A1:A10";

  it("_conditionalFormatting = {} (plain object) → treated as 0 existing, priority = 1", () => {
    const snap = {
      sheets: {
        [SHEET]: {
          _conditionalFormatting: {} as unknown as CfRuleEntry[],
        },
      },
    };
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      snap,
      SHEET,
      RANGE,
      "top10-items",
    );
    expect(ruleAdded).toBe(true);
    const result = snapshotMutated as typeof snap;
    const rules = result.sheets[SHEET]._conditionalFormatting as unknown as CfRuleEntry[];
    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toHaveLength(1);
    expect(rules[0].priority).toBe(1);
  });

  it("_conditionalFormatting = null → treated as 0 existing, priority = 1", () => {
    const snap = {
      sheets: {
        [SHEET]: {
          _conditionalFormatting: null as unknown as CfRuleEntry[],
        },
      },
    };
    const { snapshotMutated, ruleAdded } = applyQuickCfPreset(
      snap,
      SHEET,
      RANGE,
      "top10-items",
    );
    expect(ruleAdded).toBe(true);
    const result = snapshotMutated as typeof snap;
    const rules = result.sheets[SHEET]._conditionalFormatting as unknown as CfRuleEntry[];
    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toHaveLength(1);
    expect(rules[0].priority).toBe(1);
  });
});

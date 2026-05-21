// @vitest-environment happy-dom
// Custom smart-chip rule tests (#185). Covers rule validation (ReDoS-shape
// rejection, flag allowlist, http-only templates), regex compilation, URL
// template expansion, localStorage persistence round-trips, the CRUD
// helpers, and integration with the smart-chip detector's priority matrix.

import { describe, it, expect, beforeEach } from "vitest";
import {
  type CustomSmartChipRule,
  STORAGE_KEY,
  MAX_PATTERN_LEN,
  validateRulePattern,
  hasCatastrophicBacktracking,
  validateRule,
  compileRule,
  expandUrlTemplate,
  loadCustomRules,
  saveCustomRules,
  addCustomRule,
  updateCustomRule,
  deleteCustomRule,
  toggleCustomRule,
} from "./customSmartChipRules";
import { detectSmartChips, chipsForCell } from "./smartChips";

beforeEach(() => {
  localStorage.clear();
});

function rule(overrides: Partial<CustomSmartChipRule> = {}): CustomSmartChipRule {
  return {
    id: "r1",
    name: "JIRA",
    pattern: "JIRA-\\d+",
    flags: "",
    urlTemplate: "https://example.atlassian.net/browse/$0",
    enabled: true,
    ...overrides,
  };
}

describe("validateRulePattern", () => {
  it("accepts a simple pattern", () => {
    expect(validateRulePattern("JIRA-\\d+", "").ok).toBe(true);
  });

  it("accepts realistic safe patterns (C-1)", () => {
    expect(validateRulePattern("JIRA-\\d+", "").ok).toBe(true);
    expect(validateRulePattern("[A-Z]{2,5}-\\d+", "").ok).toBe(true);
    expect(validateRulePattern("(foo|bar)", "").ok).toBe(true);
    expect(validateRulePattern("https?://\\S+", "").ok).toBe(true);
  });

  it("rejects an empty pattern", () => {
    expect(validateRulePattern("", "")).toEqual({
      ok: false,
      error: "EMPTY_PATTERN",
    });
  });

  it("rejects an over-long pattern", () => {
    const long = "a".repeat(MAX_PATTERN_LEN + 1);
    expect(validateRulePattern(long, "")).toEqual({
      ok: false,
      error: "PATTERN_TOO_LONG",
    });
  });

  it("rejects nested-quantifier ReDoS shapes", () => {
    expect(validateRulePattern("(a+)+", "").error).toBe("REDOS_RISK");
    expect(validateRulePattern("(a*)*", "").error).toBe("REDOS_RISK");
    expect(validateRulePattern("(a+)*", "").error).toBe("REDOS_RISK");
    expect(validateRulePattern("(.*)+", "").error).toBe("REDOS_RISK");
  });

  it("rejects the backtracking shapes the old heuristic missed (C-1)", () => {
    // Alternation inside a quantified group (classic ReDoS).
    expect(validateRulePattern("(a|aa)+", "").error).toBe("REDOS_RISK");
    // Nested parenthesised group inside a quantified group.
    expect(validateRulePattern("((a+))+", "").error).toBe("REDOS_RISK");
    // Quantifier + alternation in a quantified group.
    expect(validateRulePattern("(a+|b)+", "").error).toBe("REDOS_RISK");
    // Alternation + quantifier in a quantified group.
    expect(validateRulePattern("(a|a?)+", "").error).toBe("REDOS_RISK");
    // Character class + quantifier under an outer quantifier.
    expect(validateRulePattern("([a-z]+)*", "").error).toBe("REDOS_RISK");
  });

  it("rejects adjacent unbounded quantifiers", () => {
    expect(validateRulePattern("a+*", "").error).toBe("REDOS_RISK");
  });

  it("rejects a malformed regex", () => {
    expect(validateRulePattern("(unclosed", "").error).toBe("INVALID_REGEX");
  });

  it("rejects flags outside the allowlist", () => {
    expect(validateRulePattern("abc", "x").error).toBe("INVALID_FLAGS");
    // 'g' and 'y' are not user-settable.
    expect(validateRulePattern("abc", "g").error).toBe("INVALID_FLAGS");
    expect(validateRulePattern("abc", "y").error).toBe("INVALID_FLAGS");
  });

  it("rejects duplicate flags", () => {
    expect(validateRulePattern("abc", "ii").error).toBe("INVALID_FLAGS");
  });

  it("accepts allowed flags", () => {
    expect(validateRulePattern("abc", "imsu").ok).toBe(true);
  });
});

describe("hasCatastrophicBacktracking (C-1)", () => {
  // Dangerous: an unbounded-quantified group with an ambiguous body.
  const dangerous = [
    "(a|aa)+",
    "((a+))+",
    "(a+|b)+",
    "(a|a?)+",
    "([a-z]+)*",
    "(a+)+",
    "(a*)*",
    "(a+)*",
    "(a*)+",
    "(.*)+",
    "(\\w+)+",
    "(a{1,})+", // {1,} is an unbounded quantifier on the body
    "(?:a+)+", // non-capturing groups are just as dangerous
    "a+*", // adjacent unbounded quantifiers
    "a*+",
  ];
  for (const p of dangerous) {
    it(`flags ${p} as dangerous`, () => {
      expect(hasCatastrophicBacktracking(p)).toBe(true);
    });
  }

  // Safe: no unbounded-quantified ambiguous group.
  const safe = [
    "JIRA-\\d+",
    "[A-Z]{2,5}-\\d+",
    "(foo|bar)", // un-quantified alternation is fine
    "https?://\\S+",
    "(abc)+", // quantified group, but body is unambiguous
    "(a{2,4})+", // inner quantifier is bounded
    "a+b+c+", // sequential quantifiers on distinct atoms
    "\\(a+\\)+", // escaped parens are literal text, not a group
    "[(|)]+", // parens/pipe inside a class are literal
    "(a)(b)(c)",
  ];
  for (const p of safe) {
    it(`treats ${p} as safe`, () => {
      expect(hasCatastrophicBacktracking(p)).toBe(false);
    });
  }
});

describe("validateRule", () => {
  it("accepts a complete valid rule", () => {
    expect(validateRule(rule()).ok).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(validateRule(rule({ name: "  " })).error).toBe("EMPTY_NAME");
  });

  it("rejects an empty template", () => {
    expect(validateRule(rule({ urlTemplate: "" })).error).toBe(
      "EMPTY_TEMPLATE",
    );
  });

  it("rejects a non-http template scheme", () => {
    expect(
      validateRule(rule({ urlTemplate: "file:///etc/passwd" })).error,
    ).toBe("TEMPLATE_NOT_HTTP");
    expect(
      validateRule(rule({ urlTemplate: "javascript:alert(1)" })).error,
    ).toBe("TEMPLATE_NOT_HTTP");
  });
});

describe("compileRule", () => {
  it("compiles a valid rule to a global regex", () => {
    const re = compileRule(rule());
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.global).toBe(true);
  });

  it("returns null for a rule with a ReDoS pattern", () => {
    expect(compileRule(rule({ pattern: "(a+)+" }))).toBeNull();
  });
});

describe("expandUrlTemplate", () => {
  it("substitutes $0 with the whole match", () => {
    const m = /JIRA-\d+/.exec("see JIRA-123 now")!;
    expect(
      expandUrlTemplate("https://x.test/browse/$0", m),
    ).toBe("https://x.test/browse/JIRA-123");
  });

  it("substitutes capture groups $1..$n", () => {
    const m = /(\w+)\/(\d+)/.exec("repo/42")!;
    expect(expandUrlTemplate("https://x.test/$1/issues/$2", m)).toBe(
      "https://x.test/repo/issues/42",
    );
  });

  it("url-encodes substituted values", () => {
    const m = /\S+/.exec("a b&c")!;
    expect(expandUrlTemplate("https://x.test/?q=$0", m)).toBe(
      "https://x.test/?q=a",
    );
    const m2 = /a&c/.exec("a&c")!;
    expect(expandUrlTemplate("https://x.test/?q=$0", m2)).toBe(
      "https://x.test/?q=a%26c",
    );
  });

  it("handles $$ as a literal dollar", () => {
    const m = /x/.exec("x")!;
    expect(expandUrlTemplate("https://x.test/$$0", m)).toBe(
      "https://x.test/$0",
    );
  });

  it("returns null when the expansion is not http(s)", () => {
    const m = /x/.exec("x")!;
    expect(expandUrlTemplate("file:///$0", m)).toBeNull();
  });
});

describe("localStorage persistence", () => {
  it("returns [] when nothing is stored", () => {
    expect(loadCustomRules()).toEqual([]);
  });

  it("round-trips rules through save/load", () => {
    const rules = [rule(), rule({ id: "r2", name: "Bug" })];
    saveCustomRules(rules);
    expect(loadCustomRules()).toEqual(rules);
  });

  it("returns [] for a corrupted payload", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadCustomRules()).toEqual([]);
  });

  it("filters out malformed entries", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([rule(), { id: "bad" }, 42]),
    );
    expect(loadCustomRules()).toHaveLength(1);
  });
});

describe("CRUD helpers", () => {
  it("adds a rule and persists it", () => {
    const result = addCustomRule({
      name: "JIRA",
      pattern: "JIRA-\\d+",
      flags: "",
      urlTemplate: "https://x.test/$0",
    });
    expect(result.ok).toBe(true);
    expect(loadCustomRules()).toHaveLength(1);
  });

  it("refuses to add an invalid rule", () => {
    const result = addCustomRule({
      name: "bad",
      pattern: "(a+)+",
      flags: "",
      urlTemplate: "https://x.test/$0",
    });
    expect(result.ok).toBe(false);
    expect(loadCustomRules()).toHaveLength(0);
  });

  it("updates an existing rule", () => {
    const added = addCustomRule({
      name: "JIRA",
      pattern: "JIRA-\\d+",
      flags: "",
      urlTemplate: "https://x.test/$0",
    });
    if (!added.ok) throw new Error("setup failed");
    const result = updateCustomRule(added.rule.id, { name: "Renamed" });
    expect(result.ok).toBe(true);
    expect(loadCustomRules()[0].name).toBe("Renamed");
  });

  it("refuses an update that would make the rule invalid", () => {
    const added = addCustomRule({
      name: "JIRA",
      pattern: "JIRA-\\d+",
      flags: "",
      urlTemplate: "https://x.test/$0",
    });
    if (!added.ok) throw new Error("setup failed");
    const result = updateCustomRule(added.rule.id, { pattern: "(a+)+" });
    expect(result.ok).toBe(false);
  });

  it("deletes a rule", () => {
    const added = addCustomRule({
      name: "JIRA",
      pattern: "JIRA-\\d+",
      flags: "",
      urlTemplate: "https://x.test/$0",
    });
    if (!added.ok) throw new Error("setup failed");
    deleteCustomRule(added.rule.id);
    expect(loadCustomRules()).toHaveLength(0);
  });

  it("toggles a rule's enabled flag", () => {
    const added = addCustomRule({
      name: "JIRA",
      pattern: "JIRA-\\d+",
      flags: "",
      urlTemplate: "https://x.test/$0",
    });
    if (!added.ok) throw new Error("setup failed");
    toggleCustomRule(added.rule.id);
    expect(loadCustomRules()[0].enabled).toBe(false);
    toggleCustomRule(added.rule.id);
    expect(loadCustomRules()[0].enabled).toBe(true);
  });
});

describe("detector integration (#185)", () => {
  it("detects a custom chip from a rule", () => {
    const chips = detectSmartChips("ticket JIRA-456 open", [rule()]);
    expect(chips).toHaveLength(1);
    expect(chips[0].kind).toBe("custom");
    expect(chips[0].value).toBe("JIRA-456");
    expect(chips[0].ruleName).toBe("JIRA");
    expect(chips[0].actionUrl).toBe(
      "https://example.atlassian.net/browse/JIRA-456",
    );
  });

  it("skips disabled rules", () => {
    const chips = detectSmartChips("ticket JIRA-456 open", [
      rule({ enabled: false }),
    ]);
    expect(chips).toHaveLength(0);
  });

  it("behaves like the MVP when no rules are passed", () => {
    const chips = detectSmartChips("ticket JIRA-456 open");
    expect(chips).toHaveLength(0);
  });

  it("never lets a custom rule outrank a real URL (priority)", () => {
    // A greedy rule that would match the whole URL substring still loses
    // to the built-in url detection.
    const greedy = rule({
      id: "g",
      name: "greedy",
      pattern: "https?://\\S+",
      urlTemplate: "https://x.test/$0",
    });
    const chips = detectSmartChips("visit https://real.example.com", [greedy]);
    expect(chips).toHaveLength(1);
    expect(chips[0].kind).toBe("url");
  });

  it("custom chips coexist with non-overlapping built-in chips", () => {
    const chips = detectSmartChips("JIRA-7 and https://a.test", [rule()]);
    const kinds = chips.map((c) => c.kind).sort();
    expect(kinds).toEqual(["custom", "url"]);
  });

  it("emits a valid http actionUrl for a custom chip", () => {
    const chips = detectSmartChips("ref JIRA-1 done", [rule()]);
    expect(chips[0].actionUrl?.startsWith("https://")).toBe(true);
  });

  it("caps matches from a pathological rule", () => {
    const everyChar = rule({
      id: "e",
      name: "all",
      pattern: "x",
      urlTemplate: "https://x.test/$0",
    });
    const chips = detectSmartChips("x".repeat(5000), [everyChar]);
    // MAX_CHIPS (16) bounds the whole detection.
    expect(chips.length).toBeLessThanOrEqual(16);
  });

  it("chipsForCell applies an explicit rule set", () => {
    const snap = {
      sheets: {
        s1: { cellData: { "0": { "0": { v: "see JIRA-99 today" } } } },
      },
    };
    const chips = chipsForCell(snap, "s1", 0, 0, [rule()]);
    expect(chips[0]?.kind).toBe("custom");
  });

  it("chipsForCell loads persisted rules when none are passed", () => {
    addCustomRule({
      name: "JIRA",
      pattern: "JIRA-\\d+",
      flags: "",
      urlTemplate: "https://x.test/$0",
    });
    const snap = {
      sheets: {
        s1: { cellData: { "0": { "0": { v: "see JIRA-1 today" } } } },
      },
    };
    const chips = chipsForCell(snap, "s1", 0, 0);
    expect(chips[0]?.kind).toBe("custom");
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  addToUserDictionary,
  BUILTIN_DICTIONARY,
  collectSpellIssues,
  isMisspelled,
  levenshtein,
  loadUserDictionary,
  suggestCorrections,
  tokenize,
} from "./spellCheck";

// Regression suite for spellCheck.ts (474 lines, no tests).
// happy-dom for localStorage (used by loadUserDictionary).

beforeEach(() => {
  try { localStorage.clear(); } catch { /* environment without storage */ }
});

describe("tokenize", () => {
  it("splits A-Z runs with internal apostrophes preserved", () => {
    expect(tokenize("don't worry about it")).toEqual([
      { word: "don't", offset: 0 },
      { word: "worry", offset: 6 },
      { word: "about", offset: 12 },
    ]);
  });

  it("drops tokens shorter than 3 chars", () => {
    expect(tokenize("hi there is a cat")).toEqual([
      { word: "there", offset: 3 },
      { word: "cat", offset: 14 },
    ]);
  });

  it("uses numbers / punctuation as delimiters", () => {
    expect(tokenize("hello.world 123 foo")).toEqual([
      { word: "hello", offset: 0 },
      { word: "world", offset: 6 },
      { word: "foo", offset: 16 },
    ]);
  });

  it("returns [] for empty / non-string input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null as unknown as string)).toEqual([]);
  });
});

describe("isMisspelled", () => {
  const dict = new Set(["hello", "world"]);

  it("returns false for dictionary words (case-insensitive)", () => {
    expect(isMisspelled("hello", dict)).toBe(false);
    expect(isMisspelled("Hello", dict)).toBe(false);
    expect(isMisspelled("HELLO", dict)).toBe(false);
  });

  it("returns true for words not in dictionary", () => {
    expect(isMisspelled("helo", dict)).toBe(true);
  });

  it("treats ALL-CAPS words >= 4 chars as acronyms (not flagged)", () => {
    expect(isMisspelled("NASA", dict)).toBe(false);
    expect(isMisspelled("HTML", dict)).toBe(false);
  });

  it("flags short ALL-CAPS words that aren't in dictionary", () => {
    // 3 chars or fewer hit the regular flow.
    expect(isMisspelled("XYZ", dict)).toBe(true);
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello", 5)).toBe(0);
  });

  it("counts single-char substitutions", () => {
    expect(levenshtein("hello", "hallo", 5)).toBe(1);
  });

  it("counts insertions / deletions", () => {
    expect(levenshtein("cat", "cats", 5)).toBe(1);
    expect(levenshtein("cats", "cat", 5)).toBe(1);
  });

  it("counts Damerau transposition as 1", () => {
    expect(levenshtein("teh", "the", 5)).toBe(1);
  });

  it("early-exits at max+1 when distance certainly exceeds", () => {
    expect(levenshtein("abcdef", "xxxxxx", 2)).toBe(3); // max + 1 = 3
  });

  it("handles empty inputs", () => {
    expect(levenshtein("", "abc", 5)).toBe(3);
    expect(levenshtein("abc", "", 5)).toBe(3);
    expect(levenshtein("", "", 5)).toBe(0);
  });
});

describe("suggestCorrections", () => {
  it("ranks closer dictionary words first", () => {
    const dict = new Set(["hello", "helmet", "hellsink"]);
    const out = suggestCorrections("hel", dict, 3, 3);
    expect(out).toContain("hello"); // distance 2
  });

  it("returns [] for empty input", () => {
    expect(suggestCorrections("", new Set(["x"]), 3, 5)).toEqual([]);
  });

  it("caps the result count at max", () => {
    const dict = new Set(["a", "b", "c", "d", "e"]);
    const out = suggestCorrections("x", dict, 5, 2);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("uses BUILTIN_DICTIONARY for real-world spell check", () => {
    // 'teh' → 'the' should be ranked at the top.
    const out = suggestCorrections("teh", new Set(BUILTIN_DICTIONARY), 2, 3);
    expect(out[0]).toBe("the");
  });
});

describe("loadUserDictionary / addToUserDictionary", () => {
  it("loadUserDictionary returns empty Set when localStorage is empty", () => {
    const dict = loadUserDictionary();
    expect(dict.size).toBe(0);
  });

  it("addToUserDictionary ignores empty-string input", () => {
    const before = loadUserDictionary().size;
    addToUserDictionary("");
    expect(loadUserDictionary().size).toBe(before);
  });

  it("addToUserDictionary persists the word (lowercased)", () => {
    addToUserDictionary("FooUnique");
    const dict = loadUserDictionary();
    expect(dict.has("foounique")).toBe(true);
  });
});

describe("collectSpellIssues", () => {
  it("returns issues for misspelled words in cell values", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Sheet1",
          cellData: {
            "0": {
              "0": { v: "helo wrold" }, // 2 misspellings
              "1": { v: "hello world" }, // both correct
            },
          },
        },
      },
    };
    const issues = collectSpellIssues(snap, new Set());
    expect(issues.length).toBeGreaterThan(0);
  });

  it("skips formula cells (formula syntax not proofed)", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          cellData: { "0": { "0": { v: "helo", f: "=A1" } } },
        },
      },
    };
    expect(collectSpellIssues(snap, new Set())).toEqual([]);
  });

  it("skips cells containing CJK", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          cellData: { "0": { "0": { v: "helo 日本語" } } },
        },
      },
    };
    expect(collectSpellIssues(snap, new Set())).toEqual([]);
  });

  it("includes suggestions per issue", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: { s1: { name: "S", cellData: { "0": { "0": { v: "teh" } } } } },
    };
    const issues = collectSpellIssues(snap, new Set());
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].suggestions.length).toBeGreaterThan(0);
  });

  it("returns [] for malformed input", () => {
    expect(collectSpellIssues(null, new Set())).toEqual([]);
    expect(collectSpellIssues({}, new Set())).toEqual([]);
  });

  it("uses the user dictionary to ignore added words", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: { s1: { name: "S", cellData: { "0": { "0": { v: "helo" } } } } },
    };
    const noUser = collectSpellIssues(snap, new Set());
    expect(noUser.length).toBeGreaterThan(0);
    const withUser = collectSpellIssues(snap, new Set(["helo"]));
    expect(withUser.length).toBe(0);
  });
});

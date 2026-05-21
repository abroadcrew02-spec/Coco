// Smart chip detector tests (#158). Covers pattern detection per kind,
// priority resolution between overlapping kinds, perf-protective bounds,
// and the chipsForCell snapshot reader.

import { describe, it, expect } from "vitest";
import {
  detectSmartChips,
  chipsForCell,
  primaryChip,
  chipActionUrl,
} from "./smartChips";

describe("detectSmartChips - URLs", () => {
  it("detects a bare https URL", () => {
    const chips = detectSmartChips("see https://example.com for details");
    expect(chips).toHaveLength(1);
    expect(chips[0].kind).toBe("url");
    expect(chips[0].value).toBe("https://example.com");
  });

  it("detects http and https alike", () => {
    const chips = detectSmartChips("http://a.test and https://b.test");
    expect(chips.map((c) => c.kind)).toEqual(["url", "url"]);
  });

  it("trims trailing punctuation off URLs", () => {
    const chips = detectSmartChips("visit https://example.com.");
    expect(chips[0].value).toBe("https://example.com");
  });

  it("does not match a bare path with no scheme", () => {
    const chips = detectSmartChips("C:\\Users\\me\\file.txt or /usr/local/bin");
    expect(chips.filter((c) => c.kind === "url")).toEqual([]);
  });

  it("does not match ftp:// (MVP is http(s) only)", () => {
    const chips = detectSmartChips("ftp://files.example.com/x");
    expect(chips.filter((c) => c.kind === "url")).toEqual([]);
  });
});

describe("detectSmartChips - emails", () => {
  it("detects a single email", () => {
    const chips = detectSmartChips("ping ops@example.co.jp please");
    expect(chips).toHaveLength(1);
    expect(chips[0].kind).toBe("email");
    expect(chips[0].value).toBe("ops@example.co.jp");
  });

  it("detects multiple emails in one cell", () => {
    const chips = detectSmartChips("a@x.com, b@y.org");
    const emails = chips.filter((c) => c.kind === "email").map((c) => c.value);
    expect(emails).toEqual(["a@x.com", "b@y.org"]);
  });

  it("rejects malformed emails", () => {
    const chips = detectSmartChips("not@anemail and @nope or bad@");
    expect(chips.filter((c) => c.kind === "email")).toEqual([]);
  });
});

describe("detectSmartChips - dates", () => {
  it("detects ISO YYYY-MM-DD", () => {
    const chips = detectSmartChips("締切: 2026-05-18");
    const date = chips.find((c) => c.kind === "date");
    expect(date?.iso).toBe("2026-05-18");
  });

  it("detects YYYY/MM/DD", () => {
    const chips = detectSmartChips("2026/01/02");
    expect(chips[0].kind).toBe("date");
    expect(chips[0].iso).toBe("2026-01-02");
  });

  it("detects YYYY年M月D日", () => {
    const chips = detectSmartChips("納期 2026年5月18日 まで");
    const date = chips.find((c) => c.kind === "date");
    expect(date?.iso).toBe("2026-05-18");
  });

  it("detects M月D日 (current year)", () => {
    const chips = detectSmartChips("5月18日 締切");
    const date = chips.find((c) => c.kind === "date");
    expect(date?.iso).toMatch(/^\d{4}-05-18$/);
  });

  it("rejects impossible dates like 2026-02-30", () => {
    const chips = detectSmartChips("2026-02-30");
    expect(chips.filter((c) => c.kind === "date")).toEqual([]);
  });

  it("falls back to Date.parse for full-cell strings only", () => {
    // RFC 2822 / Date.parse-friendly form
    const chips = detectSmartChips("May 18, 2026");
    expect(chips[0]?.kind).toBe("date");
    expect(chips[0]?.iso).toBe("2026-05-18");
  });

  it("does NOT use Date.parse for embedded substrings", () => {
    // A free-form sentence containing a date-like phrase but where the
    // whole cell isn't a parseable date should yield no fallback chip.
    const chips = detectSmartChips("blah blah blah and some other words here");
    expect(chips).toEqual([]);
  });
});

describe("detectSmartChips - priority", () => {
  it("prefers URL over date when overlapping", () => {
    // "https://example.com/2026-05-18" contains both a URL and a date span;
    // url priority should win.
    const chips = detectSmartChips("see https://example.com/2026-05-18 here");
    expect(chips).toHaveLength(1);
    expect(chips[0].kind).toBe("url");
  });

  it("keeps non-overlapping mixed kinds", () => {
    const chips = detectSmartChips("https://a.test by 2026-05-18 ping a@b.com");
    const kinds = chips.map((c) => c.kind).sort();
    expect(kinds).toEqual(["date", "email", "url"]);
  });

  it("preserves left-to-right output order", () => {
    const chips = detectSmartChips("2026-01-01 then a@b.com then https://x.test");
    expect(chips.map((c) => c.kind)).toEqual(["date", "email", "url"]);
  });
});

describe("detectSmartChips - perf bounds", () => {
  it("returns [] for empty or non-string input", () => {
    expect(detectSmartChips("")).toEqual([]);
    expect(detectSmartChips(null)).toEqual([]);
    expect(detectSmartChips(undefined)).toEqual([]);
    expect(detectSmartChips(42)).toEqual([]);
  });

  it("returns [] for cells over 8 KB", () => {
    const huge = "https://example.com ".repeat(1000);
    expect(detectSmartChips(huge)).toEqual([]);
  });
});

describe("primaryChip", () => {
  it("returns null for an empty list", () => {
    expect(primaryChip([])).toBeNull();
  });

  it("picks URL over email over date", () => {
    const chips = detectSmartChips("a@b.com 2026-05-18 https://x.test");
    const top = primaryChip(chips);
    expect(top?.kind).toBe("url");
  });

  it("picks the earliest within the same kind", () => {
    const chips = detectSmartChips("https://a.test and https://b.test");
    const top = primaryChip(chips);
    expect(top?.value).toBe("https://a.test");
  });
});

describe("chipActionUrl", () => {
  it("returns the URL value as-is for url chips", () => {
    expect(chipActionUrl({ kind: "url", value: "https://x.test", start: 0, end: 14 }))
      .toBe("https://x.test");
  });

  it("wraps email in mailto:", () => {
    expect(chipActionUrl({ kind: "email", value: "a@b.com", start: 0, end: 7 }))
      .toBe("mailto:a@b.com");
  });

  it("returns null for date chips", () => {
    expect(chipActionUrl({ kind: "date", value: "2026-05-18", start: 0, end: 10, iso: "2026-05-18" }))
      .toBeNull();
  });
});

describe("chipsForCell", () => {
  const snap = {
    sheets: {
      s1: {
        cellData: {
          "0": {
            "0": { v: "https://example.com" },
            "1": { v: "ops@example.com" },
            "2": { v: "2026-05-18" },
            "3": { v: "plain text" },
            "4": { f: "=HYPERLINK(\"...\")", v: "should be skipped" },
          },
        },
      },
    },
  };

  it("detects a URL chip at the named cell", () => {
    const chips = chipsForCell(snap, "s1", 0, 0);
    expect(chips[0]?.kind).toBe("url");
  });

  it("detects an email chip", () => {
    const chips = chipsForCell(snap, "s1", 0, 1);
    expect(chips[0]?.kind).toBe("email");
  });

  it("detects a date chip", () => {
    const chips = chipsForCell(snap, "s1", 0, 2);
    expect(chips[0]?.kind).toBe("date");
    expect(chips[0]?.iso).toBe("2026-05-18");
  });

  it("returns [] for plain text", () => {
    expect(chipsForCell(snap, "s1", 0, 3)).toEqual([]);
  });

  it("skips formula-driven cells", () => {
    expect(chipsForCell(snap, "s1", 0, 4)).toEqual([]);
  });

  it("handles snapshots passed as JSON string", () => {
    const chips = chipsForCell(JSON.stringify(snap), "s1", 0, 0);
    expect(chips[0]?.kind).toBe("url");
  });

  it("returns [] for malformed input", () => {
    expect(chipsForCell(null, "s1", 0, 0)).toEqual([]);
    expect(chipsForCell("{not-json", "s1", 0, 0)).toEqual([]);
    expect(chipsForCell(snap, "nope", 0, 0)).toEqual([]);
    expect(chipsForCell(snap, "s1", 99, 99)).toEqual([]);
  });
});

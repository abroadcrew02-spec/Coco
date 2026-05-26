import { describe, it, expect } from "vitest";
import {
  compileSearcher,
  findAll,
  replaceAll,
  replaceOne,
  type FindMatch,
  type FindReplaceParams,
} from "./findReplaceAll";

// Regression suite for findReplaceAll.ts (380 lines, no tests).

function fixture() {
  return {
    sheetOrder: ["s1", "s2"],
    sheets: {
      s1: {
        name: "Sheet1",
        cellData: {
          "0": {
            "0": { v: "Hello World" },
            "1": { v: "Tokyo" },
            "2": { v: "HelloHello" },
          },
          "1": {
            "0": { v: "hello world" }, // lowercase
            "1": { v: 42 },             // numeric
          },
        },
      },
      s2: {
        name: "Sheet2",
        cellData: {
          "0": { "0": { v: "Hello again" } },
        },
      },
    },
  };
}

const base: FindReplaceParams = {
  find: "hello",
  isRegex: false,
  matchCase: false,
  matchEntireCell: false,
  scope: "workbook",
};

describe("compileSearcher", () => {
  it("returns a searcher that yields [] for empty find string", () => {
    const s = compileSearcher({ ...base, find: "" });
    // Per the JSDoc: empty find returns a function that yields no matches.
    // (Distinct from invalid regex which returns null.)
    expect(s).toBeTruthy();
    if (s) expect(s("anything")).toEqual([]);
  });

  it("returns null for an invalid regex when isRegex=true", () => {
    expect(compileSearcher({ ...base, find: "(", isRegex: true })).toBeNull();
  });

  it("finds case-insensitive matches when matchCase=false", () => {
    const s = compileSearcher({ ...base, find: "hello", matchCase: false })!;
    const hits = s("Hello world");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("respects matchCase=true", () => {
    const s = compileSearcher({ ...base, find: "hello", matchCase: true })!;
    expect(s("Hello world")).toHaveLength(0);
    expect(s("hello world")).toHaveLength(1);
  });

  it("matchEntireCell returns a sentinel start=-1 on match, [] on miss", () => {
    const s = compileSearcher({ ...base, find: "hello", matchEntireCell: true })!;
    const hit = s("Hello");
    expect(hit).toHaveLength(1);
    expect(hit[0].start).toBe(-1);
    expect(s("Hello world")).toHaveLength(0); // not exact
  });
});

describe("findAll", () => {
  it("finds matches across the entire workbook (case-insensitive)", () => {
    const matches = findAll(fixture(), base);
    // "Hello World" (s1!A1), "HelloHello" → 2 hits (s1!C1), "hello world" (s1!A2), "Hello again" (s2!A1)
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it("limits to the active sheet when scope='sheet'", () => {
    const matches = findAll(fixture(), { ...base, scope: "sheet", activeSheetId: "s2" });
    expect(matches.every((m) => m.sheetId === "s2")).toBe(true);
  });

  it("respects matchEntireCell", () => {
    const matches = findAll(fixture(), {
      ...base,
      find: "tokyo",
      matchEntireCell: true,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].matchStart).toBe(-1);
  });

  it("respects matchCase", () => {
    const matches = findAll(fixture(), { ...base, find: "hello", matchCase: true });
    // Only the lowercase "hello world" in s1!A2 matches.
    expect(matches).toHaveLength(1);
    expect(matches[0].cellRef).toBe("A2");
  });

  it("supports regex find", () => {
    const matches = findAll(fixture(), {
      ...base,
      find: "h(ello|ello)",
      isRegex: true,
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  it("returns [] for empty find / malformed input", () => {
    expect(findAll(fixture(), { ...base, find: "" })).toEqual([]);
    expect(findAll(null, base)).toEqual([]);
  });

  it("attaches cellRef + sheetName to every match", () => {
    const matches = findAll(fixture(), base);
    for (const m of matches) {
      expect(typeof m.cellRef).toBe("string");
      expect(typeof m.sheetName).toBe("string");
      expect(m.cellRef.length).toBeGreaterThan(0);
    }
  });
});

describe("replaceOne", () => {
  it("replaces a single match without mutating the input", () => {
    const wb = fixture();
    const matches = findAll(wb, base);
    const target = matches.find((m) => m.cellRef === "A1" && m.sheetId === "s1")!;
    const out = replaceOne(wb, target, "Goodbye") as ReturnType<typeof fixture>;
    expect(out.sheets!.s1!.cellData!["0"]!["0"].v).toBe("Goodbye World");
    // Original untouched
    expect(wb.sheets.s1.cellData["0"]["0"].v).toBe("Hello World");
  });

  it("handles matchEntireCell hits", () => {
    const wb = fixture();
    const matches = findAll(wb, {
      ...base,
      find: "tokyo",
      matchEntireCell: true,
    });
    const out = replaceOne(wb, matches[0], "OSAKA") as ReturnType<typeof fixture>;
    expect(out.sheets!.s1!.cellData!["0"]!["1"].v).toBe("OSAKA");
  });

  it("returns the clone even when match coordinates are stale", () => {
    const wb = fixture();
    const stale: FindMatch = {
      sheetId: "s1",
      sheetName: "Sheet1",
      row: 99,
      col: 99,
      cellRef: "ZZ100",
      value: "nope",
      matchStart: 0,
      matchLength: 4,
    };
    expect(() => replaceOne(wb, stale, "x")).not.toThrow();
  });
});

describe("replaceAll", () => {
  it("replaces every occurrence workbook-wide", () => {
    const { snapshotMutated, replacedCount } = replaceAll(fixture(), {
      ...base,
      find: "hello",
      replace: "GOODBYE",
    });
    expect(replacedCount).toBeGreaterThanOrEqual(5);
    const s1 = (snapshotMutated as ReturnType<typeof fixture>).sheets!.s1!.cellData!;
    expect(s1["0"]!["0"].v).toBe("GOODBYE World");
    expect(s1["0"]!["2"].v).toBe("GOODBYEGOODBYE"); // both hits replaced
  });

  it("scope='sheet' only touches the named sheet", () => {
    const { snapshotMutated, replacedCount } = replaceAll(fixture(), {
      ...base,
      find: "hello",
      replace: "X",
      scope: "sheet",
      activeSheetId: "s2",
    });
    expect(replacedCount).toBeGreaterThan(0);
    const s = snapshotMutated as ReturnType<typeof fixture>;
    expect(s.sheets!.s2!.cellData!["0"]!["0"].v).toBe("X again");
    expect(s.sheets!.s1!.cellData!["0"]!["0"].v).toBe("Hello World"); // untouched
  });

  it("matchEntireCell swaps the whole value once", () => {
    const { snapshotMutated, replacedCount } = replaceAll(fixture(), {
      ...base,
      find: "tokyo",
      replace: "OSAKA",
      matchEntireCell: true,
    });
    expect(replacedCount).toBe(1);
    const s = snapshotMutated as ReturnType<typeof fixture>;
    expect(s.sheets!.s1!.cellData!["0"]!["1"].v).toBe("OSAKA");
  });

  it("returns 0 replacements for an empty find string", () => {
    const { replacedCount } = replaceAll(fixture(), { ...base, find: "" });
    expect(replacedCount).toBe(0);
  });
});

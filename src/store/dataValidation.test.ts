import { describe, it, expect } from "vitest";
import {
  validateMutation,
  sqrefCovers,
  extractCellWrites,
  type DataValidationRule,
} from "./dataValidation";

function snap(sheetId: string, rules: DataValidationRule[]): string {
  return JSON.stringify({ sheets: { [sheetId]: { _dataValidations: rules } } });
}

describe("sqrefCovers", () => {
  it("single cell", () => {
    expect(sqrefCovers("B2", 1, 1)).toBe(true);
    expect(sqrefCovers("B2", 2, 1)).toBe(false);
  });

  it("range", () => {
    expect(sqrefCovers("A1:B10", 0, 0)).toBe(true);
    expect(sqrefCovers("A1:B10", 9, 1)).toBe(true);
    expect(sqrefCovers("A1:B10", 10, 1)).toBe(false);
    expect(sqrefCovers("A1:B10", 5, 2)).toBe(false);
  });

  it("space-separated tokens", () => {
    expect(sqrefCovers("A1 C3:D4", 0, 0)).toBe(true);
    expect(sqrefCovers("A1 C3:D4", 2, 2)).toBe(true);
    expect(sqrefCovers("A1 C3:D4", 1, 1)).toBe(false);
  });

  it("$-absolute references", () => {
    expect(sqrefCovers("$A$1:$B$2", 1, 1)).toBe(true);
  });

  it("malformed token is skipped (no throw)", () => {
    expect(sqrefCovers("garbage A1", 0, 0)).toBe(true);
    expect(sqrefCovers("garbage", 0, 0)).toBe(false);
  });
});

describe("validateMutation — empty / edge cases", () => {
  it("returns null for missing snapshot", () => {
    expect(validateMutation(null, "s1", 0, 0, "x")).toBeNull();
    expect(validateMutation("", "s1", 0, 0, "x")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(validateMutation("{not json", "s1", 0, 0, "x")).toBeNull();
  });

  it("returns null when sheet has no rules", () => {
    const s = JSON.stringify({ sheets: { s1: {} } });
    expect(validateMutation(s, "s1", 0, 0, "x")).toBeNull();
  });

  it("returns null when (row,col) is outside every rule's sqref", () => {
    const s = snap("s1", [
      { sqref: "A1:A10", type: "list", formula1: '"Yes,No"' },
    ]);
    expect(validateMutation(s, "s1", 0, 1, "anything")).toBeNull();
  });

  it("blank value passes when allowBlank is unset (default permissive)", () => {
    const s = snap("s1", [{ sqref: "A1", type: "list", formula1: '"Yes,No"' }]);
    expect(validateMutation(s, "s1", 0, 0, "")).toBeNull();
    expect(validateMutation(s, "s1", 0, 0, null)).toBeNull();
  });

  it("blank value fails when allowBlank is explicitly false", () => {
    const s = snap("s1", [
      { sqref: "A1", type: "list", formula1: '"Yes,No"', allowBlank: false },
    ]);
    const r = validateMutation(s, "s1", 0, 0, "");
    expect(r).not.toBeNull();
    expect(r?.code).toBe("blank-not-allowed");
  });
});

describe("validateMutation — list", () => {
  const s = snap("s1", [{ sqref: "A1:A10", type: "list", formula1: '"Yes,No,Maybe"' }]);

  it("happy: value matches a list token", () => {
    expect(validateMutation(s, "s1", 0, 0, "Yes")).toBeNull();
    expect(validateMutation(s, "s1", 5, 0, "Maybe")).toBeNull();
  });

  it("fail: value not in list", () => {
    const r = validateMutation(s, "s1", 0, 0, "Foo");
    expect(r).not.toBeNull();
    expect(r?.code).toBe("list-not-allowed");
  });

  it("opaque cell-ref source is fail-open", () => {
    const s2 = snap("s1", [{ sqref: "A1", type: "list", formula1: "=Sheet1!$A$1:$A$3" }]);
    expect(validateMutation(s2, "s1", 0, 0, "anything")).toBeNull();
  });

  it("unquoted comma list also parses", () => {
    const s2 = snap("s1", [{ sqref: "A1", type: "list", formula1: "Yes,No" }]);
    expect(validateMutation(s2, "s1", 0, 0, "Yes")).toBeNull();
    expect(validateMutation(s2, "s1", 0, 0, "x")?.code).toBe("list-not-allowed");
  });

  it("uses custom errorMessage when provided", () => {
    const s2 = snap("s1", [
      {
        sqref: "A1",
        type: "list",
        formula1: '"Yes,No"',
        errorMessage: "リストから選んでください",
      },
    ]);
    const r = validateMutation(s2, "s1", 0, 0, "Foo");
    expect(r?.message).toBe("リストから選んでください");
  });
});

describe("validateMutation — decimal", () => {
  const s = snap("s1", [
    { sqref: "B1:B5", type: "decimal", operator: "between", formula1: "0", formula2: "100" },
  ]);

  it("happy: in range", () => {
    expect(validateMutation(s, "s1", 0, 1, 50)).toBeNull();
    expect(validateMutation(s, "s1", 0, 1, "50.5")).toBeNull();
    expect(validateMutation(s, "s1", 0, 1, 0)).toBeNull();
    expect(validateMutation(s, "s1", 0, 1, 100)).toBeNull();
  });

  it("fail: out of range", () => {
    expect(validateMutation(s, "s1", 0, 1, 101)?.code).toBe("decimal-out-of-range");
    expect(validateMutation(s, "s1", 0, 1, -1)?.code).toBe("decimal-out-of-range");
  });

  it("fail: not a number", () => {
    expect(validateMutation(s, "s1", 0, 1, "abc")?.code).toBe("decimal-not-number");
  });

  it("operator: greaterThan", () => {
    const s2 = snap("s1", [
      { sqref: "A1", type: "decimal", operator: "greaterThan", formula1: "10" },
    ]);
    expect(validateMutation(s2, "s1", 0, 0, 11)).toBeNull();
    expect(validateMutation(s2, "s1", 0, 0, 10)?.code).toBe("decimal-out-of-range");
  });

  it("operator: notBetween", () => {
    const s2 = snap("s1", [
      {
        sqref: "A1",
        type: "decimal",
        operator: "notBetween",
        formula1: "0",
        formula2: "10",
      },
    ]);
    expect(validateMutation(s2, "s1", 0, 0, 20)).toBeNull();
    expect(validateMutation(s2, "s1", 0, 0, 5)?.code).toBe("decimal-out-of-range");
  });

  it("operator: equal / notEqual / lessThan / lessThanOrEqual / greaterThanOrEqual", () => {
    const mk = (operator: string, formula1: string) =>
      snap("s1", [{ sqref: "A1", type: "decimal", operator, formula1 }]);
    expect(validateMutation(mk("equal", "7"), "s1", 0, 0, 7)).toBeNull();
    expect(validateMutation(mk("equal", "7"), "s1", 0, 0, 8)?.code).toBe("decimal-out-of-range");
    expect(validateMutation(mk("notEqual", "7"), "s1", 0, 0, 8)).toBeNull();
    expect(validateMutation(mk("notEqual", "7"), "s1", 0, 0, 7)?.code).toBe("decimal-out-of-range");
    expect(validateMutation(mk("lessThan", "5"), "s1", 0, 0, 4)).toBeNull();
    expect(validateMutation(mk("lessThan", "5"), "s1", 0, 0, 5)?.code).toBe("decimal-out-of-range");
    expect(validateMutation(mk("lessThanOrEqual", "5"), "s1", 0, 0, 5)).toBeNull();
    expect(validateMutation(mk("greaterThanOrEqual", "5"), "s1", 0, 0, 5)).toBeNull();
  });
});

describe("validateMutation — whole", () => {
  const s = snap("s1", [
    { sqref: "A1", type: "whole", operator: "between", formula1: "1", formula2: "10" },
  ]);

  it("happy: integer in range", () => {
    expect(validateMutation(s, "s1", 0, 0, 5)).toBeNull();
    expect(validateMutation(s, "s1", 0, 0, "7")).toBeNull();
  });

  it("fail: non-integer", () => {
    expect(validateMutation(s, "s1", 0, 0, 5.5)?.code).toBe("whole-not-integer");
  });

  it("fail: out of range integer", () => {
    expect(validateMutation(s, "s1", 0, 0, 11)?.code).toBe("whole-out-of-range");
  });
});

describe("validateMutation — textLength", () => {
  const s = snap("s1", [
    {
      sqref: "A1",
      type: "textLength",
      operator: "between",
      formula1: "3",
      formula2: "8",
    },
  ]);

  it("happy: length within bounds", () => {
    expect(validateMutation(s, "s1", 0, 0, "hello")).toBeNull();
    expect(validateMutation(s, "s1", 0, 0, "abc")).toBeNull();
  });

  it("fail: too short / too long", () => {
    expect(validateMutation(s, "s1", 0, 0, "hi")?.code).toBe("textLength-out-of-range");
    expect(validateMutation(s, "s1", 0, 0, "abcdefghi")?.code).toBe("textLength-out-of-range");
  });
});

describe("validateMutation — date", () => {
  const s = snap("s1", [
    {
      sqref: "A1",
      type: "date",
      operator: "between",
      formula1: "2024-01-01",
      formula2: "2024-12-31",
    },
  ]);

  it("happy: date in range", () => {
    expect(validateMutation(s, "s1", 0, 0, "2024-06-15")).toBeNull();
  });

  it("fail: date out of range", () => {
    expect(validateMutation(s, "s1", 0, 0, "2025-01-01")?.code).toBe("date-out-of-range");
  });

  it("fail: unparseable date string", () => {
    expect(validateMutation(s, "s1", 0, 0, "not a date")?.code).toBe("date-not-date");
  });
});

describe("validateMutation — multiple rules overlapping", () => {
  it("first failing rule wins", () => {
    const s = snap("s1", [
      { sqref: "A1:A10", type: "list", formula1: '"Yes,No"' },
      {
        sqref: "A1:A10",
        type: "textLength",
        operator: "between",
        formula1: "1",
        formula2: "1",
      },
    ]);
    // "Yes" passes the list but fails textLength (3 > 1)
    const r = validateMutation(s, "s1", 0, 0, "Yes");
    expect(r).not.toBeNull();
    expect(r?.code).toBe("textLength-out-of-range");
  });
});

describe("validateMutation — unsupported type fails open", () => {
  it("custom rule passes", () => {
    const s = snap("s1", [{ sqref: "A1", type: "custom", formula1: "=A1>0" }]);
    expect(validateMutation(s, "s1", 0, 0, "anything")).toBeNull();
  });
});

describe("extractCellWrites", () => {
  it("returns empty for non-object params", () => {
    expect(extractCellWrites(null).writes).toEqual([]);
    expect(extractCellWrites(undefined).writes).toEqual([]);
    expect(extractCellWrites("not an object").writes).toEqual([]);
  });

  it("extracts subUnitId + writes from a SetRangeValuesMutation params shape", () => {
    const out = extractCellWrites({
      subUnitId: "s1",
      cellValue: {
        "0": { "1": { v: "Yes" } },
        "2": { "3": { v: 42 } },
      },
    });
    expect(out.subUnitId).toBe("s1");
    expect(out.writes).toEqual([
      { row: 0, col: 1, value: "Yes" },
      { row: 2, col: 3, value: 42 },
    ]);
  });

  it("treats null cell as a clear (value === null)", () => {
    const out = extractCellWrites({
      subUnitId: "s1",
      cellValue: { "0": { "0": null } },
    });
    expect(out.writes).toEqual([{ row: 0, col: 0, value: null }]);
  });

  it("skips pure-formula writes", () => {
    const out = extractCellWrites({
      subUnitId: "s1",
      cellValue: { "0": { "0": { f: "=SUM(A1:A2)" } } },
    });
    expect(out.writes).toEqual([]);
  });

  it("missing cellValue yields empty writes", () => {
    const out = extractCellWrites({ subUnitId: "s1" });
    expect(out.subUnitId).toBe("s1");
    expect(out.writes).toEqual([]);
  });
});

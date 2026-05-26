import { describe, it, expect } from "vitest";
import {
  applyAdvancedFilter,
  matchesCriteria,
  parseExpression,
  type AdvancedFilterParams,
} from "./advancedFilter";

// Regression suite for advancedFilter.ts (350 lines, no tests).

describe("parseExpression", () => {
  it("treats bare values as equality", () => {
    expect(parseExpression("foo")).toEqual({ op: "=", value: "foo" });
    expect(parseExpression("25")).toEqual({ op: "=", value: 25 });
  });

  it("parses the 6 comparison operators (longest first)", () => {
    expect(parseExpression("<>foo")).toEqual({ op: "<>", value: "foo" });
    expect(parseExpression(">=10")).toEqual({ op: ">=", value: 10 });
    expect(parseExpression("<=20")).toEqual({ op: "<=", value: 20 });
    expect(parseExpression(">5")).toEqual({ op: ">", value: 5 });
    expect(parseExpression("<5")).toEqual({ op: "<", value: 5 });
    expect(parseExpression("=foo")).toEqual({ op: "=", value: "foo" });
  });

  it("falls back to string when number coercion fails", () => {
    expect(parseExpression(">B")).toEqual({ op: ">", value: "B" });
  });

  it("treats whitespace/empty as no-op equality with empty string", () => {
    expect(parseExpression("")).toEqual({ op: "=", value: "" });
    expect(parseExpression("   ")).toEqual({ op: "=", value: "" });
  });
});

describe("matchesCriteria", () => {
  const sourceHeaders = ["Region", "Sales"];

  it("returns true when no criteria rows", () => {
    expect(matchesCriteria({ Region: "East", Sales: 100 }, sourceHeaders, [], [])).toBe(true);
  });

  it("matches an exact equality criteria", () => {
    const rows = [{ Region: "East" }];
    expect(matchesCriteria({ Region: "East", Sales: 100 }, sourceHeaders, rows, ["Region"])).toBe(true);
    expect(matchesCriteria({ Region: "West", Sales: 100 }, sourceHeaders, rows, ["Region"])).toBe(false);
  });

  it("ORs across criteria rows", () => {
    const rows = [{ Region: "East" }, { Region: "West" }];
    const cands = [
      { Region: "East", Sales: 1 },
      { Region: "West", Sales: 2 },
      { Region: "North", Sales: 3 },
    ];
    expect(matchesCriteria(cands[0], sourceHeaders, rows, ["Region"])).toBe(true);
    expect(matchesCriteria(cands[1], sourceHeaders, rows, ["Region"])).toBe(true);
    expect(matchesCriteria(cands[2], sourceHeaders, rows, ["Region"])).toBe(false);
  });

  it("ANDs across cells within a row", () => {
    const rows = [{ Region: "East", Sales: ">50" }];
    expect(matchesCriteria({ Region: "East", Sales: 100 }, sourceHeaders, rows, ["Region", "Sales"])).toBe(true);
    expect(matchesCriteria({ Region: "East", Sales: 20 }, sourceHeaders, rows, ["Region", "Sales"])).toBe(false);
    expect(matchesCriteria({ Region: "West", Sales: 100 }, sourceHeaders, rows, ["Region", "Sales"])).toBe(false);
  });

  it("is case-insensitive on text comparisons", () => {
    const rows = [{ Region: "EAST" }];
    expect(matchesCriteria({ Region: "east", Sales: 1 }, sourceHeaders, rows, ["Region"])).toBe(true);
  });

  it("silently skips criteria headers not present in source headers", () => {
    const rows = [{ Region: "East", NoSuchCol: ">50" }];
    // Should NOT block the match — unknown criteria header treated as no-op.
    expect(matchesCriteria(
      { Region: "East", Sales: 100 },
      sourceHeaders,
      rows,
      ["Region", "NoSuchCol"],
    )).toBe(true);
  });
});

describe("applyAdvancedFilter", () => {
  // Sheet layout (cellData maps row-string → col-string → {v: ...}):
  //   Source (rows 0-3, cols 0-1):
  //     Header: Region, Sales
  //     East 100
  //     West 200
  //     East 150
  //   Criteria (rows 0-1, cols 3-3):
  //     Header: Region
  //     East
  function makeSheet() {
    return {
      cellData: {
        "0": { "0": { v: "Region" }, "1": { v: "Sales" }, "3": { v: "Region" } },
        "1": { "0": { v: "East" }, "1": { v: 100 }, "3": { v: "East" } },
        "2": { "0": { v: "West" }, "1": { v: 200 } },
        "3": { "0": { v: "East" }, "1": { v: 150 } },
      },
    };
  }

  const baseParams: AdvancedFilterParams = {
    sourceRange: { r1: 0, c1: 0, r2: 3, c2: 1 },
    criteriaRange: { r1: 0, c1: 3, r2: 1, c2: 3 },
    mode: "inPlace",
  };

  it("returns matchedRows for source rows passing criteria", () => {
    const result = applyAdvancedFilter(makeSheet(), baseParams);
    expect(result.matchedRows).toEqual([1, 3]);
  });

  it("inPlace mode returns mutatedSheet with rowData hd flags", () => {
    const result = applyAdvancedFilter(makeSheet(), baseParams);
    expect(result.mutatedSheet?.rowData?.["1"]?.hd).toBe(0); // East — visible
    expect(result.mutatedSheet?.rowData?.["2"]?.hd).toBe(1); // West — hidden
    expect(result.mutatedSheet?.rowData?.["3"]?.hd).toBe(0); // East — visible
  });

  it("emits copyOutput in copyTo mode with header + matching rows", () => {
    const result = applyAdvancedFilter(makeSheet(), {
      ...baseParams,
      mode: "copyTo",
      destination: { row: 10, col: 0 },
    });
    expect(result.copyOutput).toBeDefined();
    expect(result.copyOutput).toHaveLength(3);
    expect(result.copyOutput?.[0]).toEqual(["Region", "Sales"]);
    expect(result.copyOutput?.[1]).toEqual(["East", 100]);
    expect(result.copyOutput?.[2]).toEqual(["East", 150]);
  });

  it("supports uniqueRecordsOnly", () => {
    const sheet: { cellData: Record<string, Record<string, { v: unknown }>> } = makeSheet();
    // Add a duplicate East/100 row at index 4.
    sheet.cellData["4"] = { "0": { v: "East" }, "1": { v: 100 } };
    const result = applyAdvancedFilter(sheet, {
      ...baseParams,
      sourceRange: { r1: 0, c1: 0, r2: 4, c2: 1 },
      mode: "copyTo",
      destination: { row: 10, col: 0 },
      uniqueRecordsOnly: true,
    });
    // Header + East 100 + East 150 (duplicate dropped)
    expect(result.copyOutput).toHaveLength(3);
  });

  it("matches with >= operator for numeric criteria", () => {
    const sheet = {
      cellData: {
        "0": { "0": { v: "Region" }, "1": { v: "Sales" }, "3": { v: "Sales" } },
        "1": { "0": { v: "East" }, "1": { v: 100 }, "3": { v: ">=150" } },
        "2": { "0": { v: "West" }, "1": { v: 200 } },
        "3": { "0": { v: "East" }, "1": { v: 150 } },
      },
    };
    const result = applyAdvancedFilter(sheet, {
      sourceRange: { r1: 0, c1: 0, r2: 3, c2: 1 },
      criteriaRange: { r1: 0, c1: 3, r2: 1, c2: 3 },
      mode: "inPlace",
    });
    expect(result.matchedRows).toEqual([2, 3]); // 200, 150
  });

  it("falls back to all rows when criteria has no source-header overlap", () => {
    const sheet = {
      cellData: {
        "0": { "0": { v: "Region" }, "1": { v: "Sales" }, "3": { v: "UnknownCol" } },
        "1": { "0": { v: "East" }, "1": { v: 100 }, "3": { v: "anything" } },
        "2": { "0": { v: "West" }, "1": { v: 200 } },
      },
    };
    const result = applyAdvancedFilter(sheet, {
      sourceRange: { r1: 0, c1: 0, r2: 2, c2: 1 },
      criteriaRange: { r1: 0, c1: 3, r2: 1, c2: 3 },
      mode: "inPlace",
    });
    // Unknown criteria header skipped → criteria has no real conditions →
    // matches all source rows.
    expect(result.matchedRows).toEqual([1, 2]);
  });
});

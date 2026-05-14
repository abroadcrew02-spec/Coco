import { describe, it, expect } from "vitest";
import { computeCommentIndicators } from "./commentIndicators";

describe("computeCommentIndicators", () => {
  it("returns [] for null/undefined/empty snapshot", () => {
    expect(computeCommentIndicators(null)).toEqual([]);
    expect(computeCommentIndicators(undefined)).toEqual([]);
    expect(computeCommentIndicators("")).toEqual([]);
  });

  it("returns [] on malformed JSON", () => {
    expect(computeCommentIndicators("not json {")).toEqual([]);
  });

  it("returns [] when no sheets carry _comments", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: { name: "Sheet1", cellData: {} } },
    });
    expect(computeCommentIndicators(snap)).toEqual([]);
  });

  it("emits one indicator per comment entry, preserving sheetOrder", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: {
          name: "Alpha",
          _comments: [
            { cell: "A1", author: "Jin", text: "first" },
            { cell: "B2", text: "no author" },
          ],
        },
        s2: {
          name: "Beta",
          _comments: [{ cell: "C3", author: "Lee", text: "second sheet" }],
        },
      },
    });
    const result = computeCommentIndicators(snap);
    expect(result).toEqual([
      { sheetId: "s1", sheetName: "Alpha", cell: "A1", author: "Jin", text: "first" },
      { sheetId: "s1", sheetName: "Alpha", cell: "B2", text: "no author" },
      { sheetId: "s2", sheetName: "Beta", cell: "C3", author: "Lee", text: "second sheet" },
    ]);
  });

  it("falls back to sheetId when the sheet has no explicit name", () => {
    const snap = JSON.stringify({
      sheetOrder: ["sheet-orphan"],
      sheets: {
        "sheet-orphan": { _comments: [{ cell: "A1", text: "hello" }] },
      },
    });
    expect(computeCommentIndicators(snap)).toEqual([
      { sheetId: "sheet-orphan", sheetName: "sheet-orphan", cell: "A1", text: "hello" },
    ]);
  });

  it("falls back to Object.keys order when sheetOrder is missing", () => {
    const snap = JSON.stringify({
      sheets: {
        s1: { name: "Sheet1", _comments: [{ cell: "A1", text: "x" }] },
        s2: { name: "Sheet2", _comments: [{ cell: "B2", text: "y" }] },
      },
    });
    const result = computeCommentIndicators(snap);
    expect(result.map((r) => r.cell)).toEqual(["A1", "B2"]);
  });

  it("skips malformed comment entries (missing cell, missing text, wrong types)", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Sheet1",
          _comments: [
            { cell: "A1", text: "ok" },
            { cell: 5, text: "bad cell type" },
            { text: "no cell" },
            { cell: "B2" },
            null,
            "not an object",
            { cell: "C3", text: 42 },
            { cell: "D4", text: "ok2" },
          ],
        },
      },
    });
    const result = computeCommentIndicators(snap);
    expect(result.map((r) => r.cell)).toEqual(["A1", "D4"]);
  });

  it("skips sheets with empty _comments arrays", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: { name: "Empty", _comments: [] },
        s2: { name: "WithOne", _comments: [{ cell: "A1", text: "only" }] },
      },
    });
    const result = computeCommentIndicators(snap);
    expect(result).toHaveLength(1);
    expect(result[0].sheetId).toBe("s2");
  });

  it("ignores author when it's not a non-empty string", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "S",
          _comments: [
            { cell: "A1", author: "", text: "empty author" },
            { cell: "A2", author: 42, text: "numeric author" },
            { cell: "A3", author: "Real", text: "good author" },
          ],
        },
      },
    });
    const result = computeCommentIndicators(snap);
    expect(result[0].author).toBeUndefined();
    expect(result[1].author).toBeUndefined();
    expect(result[2].author).toBe("Real");
  });
});

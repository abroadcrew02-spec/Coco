import { describe, it, expect, beforeEach } from "vitest";
import {
  bulkDeleteResolved,
  clearListAllCommentsCache,
  deleteComment,
  exportToCsv,
  exportToMarkdown,
  listAllComments,
  setCommentResolved,
  type CommentListing,
} from "./commentsManager";

// Regression suite for commentsManager.ts (357 lines, no tests).

beforeEach(() => {
  clearListAllCommentsCache();
});

function fixture() {
  return {
    sheetOrder: ["s1", "s2"],
    sheets: {
      s1: {
        name: "Sheet1",
        _comments: [
          { cellRef: "A1", author: "Alice", text: "first", createdAt: "2026-05-01T00:00:00Z" },
          { cellRef: "B2", author: "Bob", body: "second", resolved: true, replies: [{ author: "Alice", body: "ok" }] },
        ],
      },
      s2: {
        name: "Sheet2",
        _comments: [
          { cell: "C3", author: "Carol", body: "third" },
        ],
      },
    },
  };
}

describe("listAllComments", () => {
  it("flattens comments across sheets in sheetOrder", () => {
    const list = listAllComments(fixture());
    expect(list).toHaveLength(3);
    expect(list[0].sheetName).toBe("Sheet1");
    expect(list[0].cellRef).toBe("A1");
    expect(list[0].author).toBe("Alice");
    expect(list[2].sheetName).toBe("Sheet2");
  });

  it("normalises body / text / replies / resolved fields", () => {
    const list = listAllComments(fixture());
    const b2 = list.find((c) => c.cellRef === "B2");
    expect(b2?.body).toBe("second");
    expect(b2?.replies).toBe(1);
    expect(b2?.resolved).toBe(true);
  });

  it("falls back to insertion order when sheetOrder is missing", () => {
    const wb = fixture();
    const result = listAllComments({ ...wb, sheetOrder: undefined as unknown as string[] });
    expect(result.length).toBe(3);
  });

  it("returns [] for malformed / empty input", () => {
    expect(listAllComments(null)).toEqual([]);
    expect(listAllComments(undefined)).toEqual([]);
    expect(listAllComments("not json")).toEqual([]);
    expect(listAllComments({})).toEqual([]);
  });

  it("uses string-identity cache (same string ref → same result ref)", () => {
    const json = JSON.stringify(fixture());
    const a = listAllComments(json);
    const b = listAllComments(json);
    expect(b).toBe(a);
  });

  it("clearListAllCommentsCache invalidates the identity cache", () => {
    const json = JSON.stringify(fixture());
    const a = listAllComments(json);
    clearListAllCommentsCache();
    const b = listAllComments(json);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });
});

describe("setCommentResolved", () => {
  it("flags a comment as resolved + stamps resolvedAt", () => {
    const next = setCommentResolved(fixture(), "s1", "A1", true);
    const row = next.sheets?.s1?._comments?.[0];
    expect(row?.resolved).toBe(true);
    expect(typeof row?.resolvedAt).toBe("string");
  });

  it("unresolving clears resolvedAt / resolvedBy", () => {
    const next = setCommentResolved(fixture(), "s1", "B2", false);
    const row = next.sheets?.s1?._comments?.[1];
    expect(row?.resolved).toBe(false);
    expect(row?.resolvedAt).toBeUndefined();
    expect(row?.resolvedBy).toBeUndefined();
  });

  it("is a no-op when the comment is missing", () => {
    const wb = fixture();
    const next = setCommentResolved(wb, "s1", "ZZ99", true);
    expect(next.sheets?.s1?._comments).toEqual(wb.sheets.s1._comments);
  });
});

describe("deleteComment", () => {
  it("removes the named comment", () => {
    const next = deleteComment(fixture(), "s1", "A1");
    expect(next.sheets?.s1?._comments).toHaveLength(1);
    expect(next.sheets?.s1?._comments?.[0].cellRef).toBe("B2");
  });

  it("is a no-op when the target is missing", () => {
    const next = deleteComment(fixture(), "s1", "ZZ99");
    expect(next.sheets?.s1?._comments).toHaveLength(2);
  });
});

describe("bulkDeleteResolved", () => {
  it("removes every resolved comment workbook-wide", () => {
    const { snapshotMutated, deletedCount } = bulkDeleteResolved(fixture());
    expect(deletedCount).toBe(1); // only B2 is resolved
    expect(snapshotMutated.sheets?.s1?._comments).toHaveLength(1);
    expect(snapshotMutated.sheets?.s2?._comments).toHaveLength(1);
  });

  it("returns deletedCount=0 + unchanged snapshot when nothing resolved", () => {
    const wb = {
      sheets: {
        s1: { name: "S", _comments: [{ cellRef: "A1", author: "x", body: "y" }] },
      },
    };
    const { deletedCount } = bulkDeleteResolved(wb);
    expect(deletedCount).toBe(0);
  });
});

describe("exportToMarkdown", () => {
  it("emits a placeholder header for empty input", () => {
    expect(exportToMarkdown([])).toContain("コメントなし");
  });

  it("emits a header + one row per comment", () => {
    const items: CommentListing[] = [
      { sheetId: "s1", sheetName: "Sheet1", cellRef: "A1", author: "Alice", body: "hello", replies: 0, resolved: false },
      { sheetId: "s1", sheetName: "Sheet1", cellRef: "B2", body: "world", replies: 1, resolved: true },
    ];
    const md = exportToMarkdown(items);
    expect(md).toContain("Sheet1");
    expect(md).toContain("A1");
    expect(md).toContain("hello");
    expect(md).toContain("✓"); // resolved marker
  });

  it("escapes pipe and newline in body cells", () => {
    const items: CommentListing[] = [
      { sheetId: "s1", sheetName: "Sheet1", cellRef: "A1", body: "a|b\nc", replies: 0, resolved: false },
    ];
    const md = exportToMarkdown(items);
    expect(md).toContain("a\\|b c"); // pipe escaped + newline → space
  });
});

describe("exportToCsv", () => {
  it("emits a header row for empty input", () => {
    const csv = exportToCsv([]);
    expect(csv.split("\r\n")[0]).toContain("Sheet");
  });

  it("emits one row per comment with header", () => {
    const items: CommentListing[] = [
      { sheetId: "s1", sheetName: "Sheet1", cellRef: "A1", author: "Alice", body: "hello", replies: 0, resolved: false },
    ];
    const csv = exportToCsv(items);
    const rows = csv.split("\r\n").filter(Boolean);
    expect(rows).toHaveLength(2); // header + 1 row
    expect(rows[1]).toContain("Sheet1,A1,Alice,hello");
  });

  it("escapes commas and quotes per RFC 4180", () => {
    const items: CommentListing[] = [
      { sheetId: "s1", sheetName: "S", cellRef: "A1", body: 'a "b" c, d', replies: 0, resolved: false },
    ];
    const csv = exportToCsv(items);
    expect(csv).toContain('"a ""b"" c, d"');
  });
});

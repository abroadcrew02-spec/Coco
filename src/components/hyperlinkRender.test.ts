// Unit test for the hyperlink render helpers (Phase 2). We don't drive Univer
// here — just verify the pure snapshot patch produces the right cellData /
// inline style shape, and that the lookup + classifier helpers handle the
// realistic edge cases (missing entries, internal vs external targets,
// malformed A1, value-preservation).

import { describe, it, expect } from "vitest";
import {
  patchHyperlinkRenders,
  parseA1,
  lookupHyperlink,
  classifyHyperlink,
  chooseHyperlinkRestyle,
  HYPERLINK_STYLE,
} from "./hyperlinkRender";

describe("parseA1", () => {
  it("decodes single-letter columns", () => {
    expect(parseA1("A1")).toEqual({ row: 0, col: 0 });
    expect(parseA1("B3")).toEqual({ row: 2, col: 1 });
    expect(parseA1("Z100")).toEqual({ row: 99, col: 25 });
  });

  it("decodes multi-letter columns", () => {
    expect(parseA1("AA1")).toEqual({ row: 0, col: 26 });
    expect(parseA1("AZ2")).toEqual({ row: 1, col: 51 });
    expect(parseA1("BA1")).toEqual({ row: 0, col: 52 });
  });

  it("rejects malformed input", () => {
    expect(parseA1("")).toBeNull();
    expect(parseA1("1A")).toBeNull();
    expect(parseA1("A0")).toBeNull();
    expect(parseA1("A1:B2")).toBeNull();
  });
});

describe("patchHyperlinkRenders", () => {
  it("returns the input unchanged when there are no _hyperlinks", () => {
    const snap = {
      sheets: {
        s1: { cellData: { "0": { "0": { v: "hello" } } } },
      },
    };
    const out = patchHyperlinkRenders(snap) as typeof snap;
    expect(out.sheets.s1.cellData).toEqual({ "0": { "0": { v: "hello" } } });
  });

  it("styles a blank cell with the link label and adds blue+underline", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {},
          _hyperlinks: [
            { cell: "B2", target: "https://example.com", display: "Example" },
          ],
        },
      },
    };
    const out = patchHyperlinkRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { v?: unknown; s?: unknown }>> } };
    };
    const cell = out.sheets.s1.cellData["1"]["1"];
    expect(cell.v).toBe("Example");
    expect(cell.s).toEqual({ cl: HYPERLINK_STYLE.cl, ul: HYPERLINK_STYLE.ul });
  });

  it("preserves a pre-existing cell value", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: "Custom Label" } } },
          _hyperlinks: [{ cell: "A1", target: "https://example.com", display: "Ignored" }],
        },
      },
    };
    const out = patchHyperlinkRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { v?: unknown }>> } };
    };
    expect(out.sheets.s1.cellData["0"]["0"].v).toBe("Custom Label");
  });

  it("merges with an existing inline style object", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: { "0": { "0": { v: "x", s: { bl: 1, ff: "Arial" } } } },
          _hyperlinks: [{ cell: "A1", target: "https://example.com" }],
        },
      },
    };
    const out = patchHyperlinkRenders(snap) as {
      sheets: {
        s1: {
          cellData: Record<string, Record<string, { s?: Record<string, unknown> }>>;
        };
      };
    };
    const s = out.sheets.s1.cellData["0"]["0"].s ?? {};
    expect(s.bl).toBe(1);
    expect(s.ff).toBe("Arial");
    expect(s.cl).toEqual(HYPERLINK_STYLE.cl);
    expect(s.ul).toEqual(HYPERLINK_STYLE.ul);
  });

  it("falls back to target text when no display is provided", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {},
          _hyperlinks: [{ cell: "A1", target: "https://example.com" }],
        },
      },
    };
    const out = patchHyperlinkRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, { v?: unknown }>> } };
    };
    expect(out.sheets.s1.cellData["0"]["0"].v).toBe("https://example.com");
  });

  it("skips malformed entries silently", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {},
          _hyperlinks: [
            { cell: "ZZZ", target: "https://example.com" },
            { cell: "A1", target: "" }, // empty target still parses target as string
            null as unknown as { cell: string; target: string },
            { cell: "B2", target: "https://ok.example" },
          ],
        },
      },
    };
    const out = patchHyperlinkRenders(snap) as {
      sheets: { s1: { cellData: Record<string, Record<string, unknown>> } };
    };
    // ZZZ is parseable (col 18277) — verify it produces a cell. The empty
    // target entry still styles A1 since target is a string. Null is skipped.
    // The B2 entry is the canonical success case.
    expect(out.sheets.s1.cellData["1"]?.["1"]).toBeDefined();
  });

  it("does not mutate the input snapshot", () => {
    const snap = {
      sheets: {
        s1: {
          cellData: {},
          _hyperlinks: [{ cell: "A1", target: "https://x" }],
        },
      },
    };
    const before = JSON.stringify(snap);
    patchHyperlinkRenders(snap);
    expect(JSON.stringify(snap)).toBe(before);
  });
});

describe("lookupHyperlink", () => {
  const snap = JSON.stringify({
    sheets: {
      s1: {
        _hyperlinks: [
          { cell: "A1", target: "https://example.com" },
          { cell: "B3", target: "#Sheet2!A1", display: "go" },
        ],
      },
    },
  });

  it("finds entries by row/col", () => {
    expect(lookupHyperlink(snap, "s1", 0, 0)?.target).toBe("https://example.com");
    expect(lookupHyperlink(snap, "s1", 2, 1)?.target).toBe("#Sheet2!A1");
  });

  it("returns null on misses", () => {
    expect(lookupHyperlink(snap, "s1", 5, 5)).toBeNull();
    expect(lookupHyperlink(snap, "nonexistent", 0, 0)).toBeNull();
    expect(lookupHyperlink(null, "s1", 0, 0)).toBeNull();
    expect(lookupHyperlink("{not json", "s1", 0, 0)).toBeNull();
  });
});

describe("chooseHyperlinkRestyle", () => {
  it("returns the label as value when the cell is empty", () => {
    const restyle = chooseHyperlinkRestyle(
      { cell: "B2", target: "https://example.com", display: "Example" },
      "",
    );
    expect(restyle).toEqual({
      cell: "B2",
      value: "Example",
      color: HYPERLINK_STYLE.cl.rgb,
      underline: true,
    });
  });

  it("falls back to the target when no display is provided", () => {
    const restyle = chooseHyperlinkRestyle(
      { cell: "A1", target: "https://example.com" },
      null,
    );
    expect(restyle?.value).toBe("https://example.com");
  });

  it("preserves a pre-existing cell value (value=null) but still restyles", () => {
    const restyle = chooseHyperlinkRestyle(
      { cell: "A1", target: "https://example.com", display: "Ignored" },
      "Existing text",
    );
    expect(restyle?.value).toBeNull();
    expect(restyle?.color).toBe(HYPERLINK_STYLE.cl.rgb);
    expect(restyle?.underline).toBe(true);
  });

  it("treats #-prefixed internal targets the same as external ones", () => {
    const restyle = chooseHyperlinkRestyle(
      { cell: "C5", target: "#Sheet2!A1" },
      "",
    );
    expect(restyle).toEqual({
      cell: "C5",
      value: "#Sheet2!A1",
      color: HYPERLINK_STYLE.cl.rgb,
      underline: true,
    });
  });

  it("returns null on bad input", () => {
    expect(chooseHyperlinkRestyle({ cell: "", target: "https://x" }, "")).toBeNull();
    expect(chooseHyperlinkRestyle({ cell: "A1", target: "" }, "")).toBeNull();
    expect(chooseHyperlinkRestyle({ cell: "A1", target: "   " }, "")).toBeNull();
    expect(chooseHyperlinkRestyle({ cell: "ZZ", target: "https://x" }, "")).toBeNull();
  });
});

describe("classifyHyperlink", () => {
  it("treats #-prefixed targets as internal", () => {
    expect(classifyHyperlink("#Sheet2!A1")).toEqual({
      kind: "internal",
      sheet: "Sheet2",
      cell: "A1",
    });
    // No `!` means whole-sheet — we default to A1.
    expect(classifyHyperlink("#Sheet2")).toEqual({
      kind: "internal",
      sheet: "Sheet2",
      cell: "A1",
    });
  });

  it("treats everything else as external", () => {
    expect(classifyHyperlink("https://example.com")).toEqual({
      kind: "external",
      url: "https://example.com",
    });
    expect(classifyHyperlink("mailto:foo@bar")).toEqual({
      kind: "external",
      url: "mailto:foo@bar",
    });
  });

  it("returns null for empty input", () => {
    expect(classifyHyperlink("")).toBeNull();
    expect(classifyHyperlink("   ")).toBeNull();
  });
});

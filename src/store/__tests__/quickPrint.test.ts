import { describe, it, expect } from "vitest";
import { buildPrintHtml } from "../quickPrint";

// ---------------------------------------------------------------------------
// Helpers: minimal snapshot builders
// ---------------------------------------------------------------------------

function makeSheet(overrides: {
  name?: string;
  cellData?: Record<string, Record<string, { v?: unknown; f?: string; s?: string } | undefined> | undefined>;
  columnData?: Record<string, { w?: number } | undefined>;
  rowData?: Record<string, { h?: number } | undefined>;
  mergeData?: Array<{ startRow?: number; endRow?: number; startCol?: number; endCol?: number }>;
  _pageSetup?: { header?: string; footer?: string };
} = {}) {
  return overrides;
}

function makeWorkbook(overrides: {
  name?: string;
  sheetOrder?: string[];
  styles?: Record<string, unknown>;
  sheets?: Record<string, unknown>;
} = {}) {
  return overrides;
}

// ---------------------------------------------------------------------------
// buildPrintHtml — scope: activeSheet
// ---------------------------------------------------------------------------

describe("buildPrintHtml — activeSheet scope", () => {
  it("renders only the active sheet when activeSheetId is valid", () => {
    const snapshot = makeWorkbook({
      name: "TestWB",
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: makeSheet({ name: "Sheet1", cellData: { "0": { "0": { v: "hello" } } } }),
        s2: makeSheet({ name: "Sheet2", cellData: { "0": { "0": { v: "world" } } } }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "activeSheet", activeSheetId: "s1" });
    expect(html).toContain("Sheet1");
    expect(html).not.toContain("Sheet2");
    expect(html).toContain("hello");
    expect(html).not.toContain("world");
  });

  it("falls back to the first sheet in sheetOrder when activeSheetId is missing", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: makeSheet({ name: "First", cellData: { "0": { "0": { v: "first" } } } }),
        s2: makeSheet({ name: "Second", cellData: { "0": { "0": { v: "second" } } } }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "activeSheet" });
    expect(html).toContain("First");
    expect(html).not.toContain("Second");
  });

  it("falls back to the first sheet when activeSheetId does not exist in sheets", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1", "s2"],
      sheets: {
        s1: makeSheet({ name: "SheetA", cellData: { "0": { "0": { v: "A" } } } }),
        s2: makeSheet({ name: "SheetB", cellData: { "0": { "0": { v: "B" } } } }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "activeSheet", activeSheetId: "nonexistent" });
    expect(html).toContain("SheetA");
    expect(html).not.toContain("SheetB");
  });

  it("renders an empty body (no sections) when sheetOrder is empty and activeSheetId is invalid", () => {
    const snapshot = makeWorkbook({
      sheetOrder: [],
      sheets: {},
    });
    const html = buildPrintHtml(snapshot, { scope: "activeSheet", activeSheetId: "nope" });
    expect(html).not.toContain('<section class="sheet">');
  });
});

// ---------------------------------------------------------------------------
// buildPrintHtml — scope: allSheets
// ---------------------------------------------------------------------------

describe("buildPrintHtml — allSheets scope", () => {
  it("renders all sheets in sheetOrder", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["a", "b", "c"],
      sheets: {
        a: makeSheet({ name: "Alpha", cellData: { "0": { "0": { v: 1 } } } }),
        b: makeSheet({ name: "Beta",  cellData: { "0": { "0": { v: 2 } } } }),
        c: makeSheet({ name: "Gamma", cellData: { "0": { "0": { v: 3 } } } }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain("Gamma");
  });

  it("skips sheetOrder ids that have no corresponding sheet entry", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["present", "absent"],
      sheets: {
        present: makeSheet({ name: "Present", cellData: { "0": { "0": { v: "ok" } } } }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("Present");
    // "absent" key is not in sheets, no section rendered for it
    const sectionCount = (html.match(/<section class="sheet">/g) ?? []).length;
    expect(sectionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildPrintHtml — empty / malformed snapshot
// ---------------------------------------------------------------------------

describe("buildPrintHtml — empty snapshot", () => {
  it("returns a valid HTML document for an empty object", () => {
    const html = buildPrintHtml({}, { scope: "allSheets" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("uses 'Workbook' as the title when name is absent", () => {
    const html = buildPrintHtml({}, { scope: "allSheets" });
    expect(html).toContain("<title>Workbook</title>");
  });

  it("renders workbook name in the h1 header", () => {
    const snapshot = makeWorkbook({ name: "My Report" });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("<h1>My Report</h1>");
  });
});

// ---------------------------------------------------------------------------
// escapeHtml (tested via buildPrintHtml output)
// ---------------------------------------------------------------------------

describe("escapeHtml — via buildPrintHtml cell values", () => {
  function htmlWithCell(v: unknown) {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({ name: "S", cellData: { "0": { "0": { v } } } }),
      },
    });
    return buildPrintHtml(snapshot, { scope: "allSheets" });
  }

  it("escapes < and > in cell values", () => {
    const html = htmlWithCell("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("escapes & in cell values", () => {
    const html = htmlWithCell("a & b");
    expect(html).toContain("a &amp; b");
  });

  it("escapes double quotes in cell values", () => {
    const html = htmlWithCell('say "hi"');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('"hi"');
  });

  it("escapes single quotes in cell values", () => {
    const html = htmlWithCell("it's");
    expect(html).toContain("&#39;");
    expect(html).not.toContain("'s");
  });

  it("converts newlines to <br>", () => {
    const html = htmlWithCell("line1\nline2");
    expect(html).toContain("line1<br>line2");
  });

  it("escapes < and > in sheet names", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({ name: "<Sheet>", cellData: { "0": { "0": { v: "x" } } } }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("&lt;Sheet&gt;");
    expect(html).not.toContain("<Sheet>");
  });

  it("escapes workbook name that contains HTML special chars", () => {
    const snapshot = makeWorkbook({ name: "Report & <2024>" });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("Report &amp; &lt;2024&gt;");
  });
});

// ---------------------------------------------------------------------------
// isSafeColor (tested via style output in buildPrintHtml)
// ---------------------------------------------------------------------------

describe("isSafeColor — via buildPrintHtml inline styles", () => {
  function htmlWithStyle(fontColor: string) {
    const snapshot = {
      sheetOrder: ["s1"],
      styles: { st1: { font: { color: fontColor } } },
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "text", s: "st1" } } },
        }),
      },
    };
    return buildPrintHtml(snapshot, { scope: "allSheets" });
  }

  it("allows 3-digit hex color #abc", () => {
    const html = htmlWithStyle("#abc");
    expect(html).toContain("color:#abc");
  });

  it("allows 6-digit hex color #abcdef", () => {
    const html = htmlWithStyle("#abcdef");
    expect(html).toContain("color:#abcdef");
  });

  it("allows 8-digit hex color #abcdef12", () => {
    const html = htmlWithStyle("#abcdef12");
    expect(html).toContain("color:#abcdef12");
  });

  it("rejects named color 'red' (no style attribute emitted)", () => {
    const html = htmlWithStyle("red");
    expect(html).not.toContain("color:red");
  });

  it("rejects invalid hex #zzz", () => {
    const html = htmlWithStyle("#zzz");
    expect(html).not.toContain("color:#zzz");
  });

  it("rejects rgba(...) syntax", () => {
    const html = htmlWithStyle("rgba(0,0,0,1)");
    expect(html).not.toContain("color:rgba");
  });

  it("rejects javascript: injection attempt", () => {
    const html = htmlWithStyle("javascript:alert(1)");
    expect(html).not.toContain("color:javascript");
  });
});

// ---------------------------------------------------------------------------
// computeUsedExtent (tested via renderSheetTable output)
// ---------------------------------------------------------------------------

describe("computeUsedExtent — via buildPrintHtml sheet rendering", () => {
  function renderSheet(cellData: Record<string, Record<string, { v?: unknown } | undefined> | undefined>) {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: { s1: makeSheet({ name: "S", cellData }) },
    });
    return buildPrintHtml(snapshot, { scope: "allSheets" });
  }

  it("renders a sparse cellData (non-contiguous rows/cols)", () => {
    const html = renderSheet({
      "0": { "0": { v: "A" } },
      "5": { "3": { v: "B" } },
    });
    // Should emit a table (not empty), containing both values
    expect(html).toContain('<table class="sheet-table">');
    expect(html).toContain("A");
    expect(html).toContain("B");
  });

  it("ignores negative row keys", () => {
    const html = renderSheet({
      "-1": { "0": { v: "neg" } },
      "0": { "0": { v: "pos" } },
    });
    expect(html).toContain("pos");
    // The table exists (row 0 is valid)
    expect(html).toContain('<table class="sheet-table">');
  });

  it("ignores NaN / non-integer keys", () => {
    const html = renderSheet({
      "foo": { "0": { v: "bad" } },
      "0": { "0": { v: "good" } },
    });
    expect(html).toContain("good");
  });

  it("renders qp-empty for completely empty cellData", () => {
    const html = renderSheet({});
    expect(html).toContain('class="qp-empty"');
    expect(html).not.toContain('<table class="sheet-table">');
  });

  it("renders qp-empty when cellData is undefined", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: { s1: makeSheet({ name: "S" }) },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain('class="qp-empty"');
  });
});

// ---------------------------------------------------------------------------
// renderCellText — boolean / integer / large number / formula-only / all-undefined
// ---------------------------------------------------------------------------

describe("renderCellText — via buildPrintHtml cell output", () => {
  function cellHtml(cell: { v?: unknown; f?: string }) {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({ name: "S", cellData: { "0": { "0": cell } } }),
      },
    });
    return buildPrintHtml(snapshot, { scope: "allSheets" });
  }

  it("renders boolean true as 'TRUE'", () => {
    expect(cellHtml({ v: true })).toContain("TRUE");
  });

  it("renders boolean false as 'FALSE'", () => {
    expect(cellHtml({ v: false })).toContain("FALSE");
  });

  it("renders integer number without decimal point", () => {
    const html = cellHtml({ v: 42 });
    expect(html).toContain("42");
    expect(html).not.toContain("42.");
  });

  it("renders large integer (< 1e15) as string without scientific notation", () => {
    const html = cellHtml({ v: 999_999_999_999_999 });
    expect(html).toContain("999999999999999");
  });

  it("renders formula when v is absent (formula-only cell)", () => {
    const html = cellHtml({ f: "SUM(A1:A10)" });
    expect(html).toContain("=SUM(A1:A10)");
  });

  it("renders empty string when both v and f are absent", () => {
    const html = cellHtml({});
    // Cell exists but renders no text — td should still appear
    expect(html).toContain("<td>");
  });
});

// ---------------------------------------------------------------------------
// renderCell span — colspan / rowspan attributes
// ---------------------------------------------------------------------------

describe("renderCell — colspan/rowspan attributes", () => {
  it("emits colspan on the anchor cell of a wide merge", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "merged" } } },
          mergeData: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 2 }],
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain('colspan="3"');
    expect(html).toContain("merged");
  });

  it("emits rowspan on the anchor cell of a tall merge", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "tall" } } },
          mergeData: [{ startRow: 0, endRow: 2, startCol: 0, endCol: 0 }],
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain('rowspan="3"');
  });

  it("emits colspan+rowspan for a 2x2 block merge", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "2x2" } } },
          mergeData: [{ startRow: 0, endRow: 1, startCol: 0, endCol: 1 }],
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
  });

  it("emits a plain <td></td> for an undefined cell with no span", () => {
    // A cell position that exists in extent but has no data and no merge
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          // Only r=0,c=1 exists — r=0,c=0 is absent
          cellData: { "0": { "1": { v: "right" } } },
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("<td></td>");
  });

  it("emits a plain colspan/rowspan td for an undefined cell that is a merge anchor", () => {
    // Anchor cell (0,0) has no cellData entry but mergeData says it spans 2 cols
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "2": { v: "far" } } },
          mergeData: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 1 }],
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain('colspan="2"');
  });
});

// ---------------------------------------------------------------------------
// mergeData — skipping covered cells
// ---------------------------------------------------------------------------

describe("mergeData — covered cells are omitted from output", () => {
  it("does not emit a <td> for cells covered by a merge", () => {
    // 1x3 merge: anchor at (0,0), covers (0,1) and (0,2)
    // Total cells in row: anchor emits 1 <td colspan="3">, the others are skipped
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: {
            "0": { "0": { v: "A" }, "1": { v: "B" }, "2": { v: "C" } },
          },
          mergeData: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 2 }],
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    // Only the anchor <td colspan="3"> should appear, not separate tds for B/C
    expect(html).toContain('colspan="3"');
    // The row should contain exactly one <td (the anchor)
    const rowMatch = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/);
    if (rowMatch) {
      const rowHtml = rowMatch[1];
      const tdCount = (rowHtml.match(/<td/g) ?? []).length;
      expect(tdCount).toBe(1);
    }
  });

  it("ignores malformed merge entries with non-integer indices", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "ok" }, "1": { v: "ok2" } } },
          mergeData: [{ startRow: 0, endRow: 0, startCol: 0, endCol: undefined as unknown as number }],
        }),
      },
    });
    // Should not throw; renders both cells normally
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("ok");
  });

  it("ignores merge entry with inverted range (endRow < startRow)", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "safe" } } },
          mergeData: [{ startRow: 5, endRow: 0, startCol: 0, endCol: 0 }],
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("safe");
    // No rowspan or colspan emitted from the invalid merge
    expect(html).not.toContain("rowspan");
  });
});

// ---------------------------------------------------------------------------
// _pageSetup header / footer
// ---------------------------------------------------------------------------

describe("_pageSetup header and footer", () => {
  it("renders page header when _pageSetup.header is set", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "x" } } },
          _pageSetup: { header: "Confidential" },
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("Confidential");
    expect(html).toContain('class="page-header"');
  });

  it("renders page footer when _pageSetup.footer is set", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "x" } } },
          _pageSetup: { footer: "Page 1 of 1" },
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("Page 1 of 1");
    expect(html).toContain('class="page-footer"');
  });

  it("does not render header/footer div when _pageSetup is absent", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "x" } } },
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).not.toContain('class="page-header"');
    expect(html).not.toContain('class="page-footer"');
  });

  it("escapes special chars in header/footer", () => {
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: {
        s1: makeSheet({
          name: "S",
          cellData: { "0": { "0": { v: "x" } } },
          _pageSetup: { header: "<b>Top</b>", footer: "R&D" },
        }),
      },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain("&lt;b&gt;Top&lt;/b&gt;");
    expect(html).toContain("R&amp;D");
  });
});

// ---------------------------------------------------------------------------
// Immutability: input snapshot must not be mutated
// ---------------------------------------------------------------------------

describe("immutability", () => {
  it("does not mutate the input snapshot", () => {
    const cellData = { "0": { "0": { v: "original" } } };
    const sheet = makeSheet({ name: "S", cellData });
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: { s1: sheet },
    });
    const snapshotCopy = JSON.parse(JSON.stringify(snapshot));
    buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(snapshot).toEqual(snapshotCopy);
  });
});

// ---------------------------------------------------------------------------
// MAX_CELLS_PER_SHEET guard (1_000_000 cells)
// ---------------------------------------------------------------------------

describe("MAX_CELLS_PER_SHEET guard", () => {
  it("renders qp-truncated when rows*cols exceeds 1_000_000", () => {
    // 1001 rows x 1000 cols = 1_001_000 > 1_000_000
    // We only need the extent to be > limit; actual cellData can be sparse
    const cellData: Record<string, Record<string, { v: number }>> = {};
    // Place a cell at row=1000, col=999 to make extent 1001x1000
    cellData["0"] = { "0": { v: 1 } };
    cellData["1000"] = { "999": { v: 2 } };
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: { s1: makeSheet({ name: "Big", cellData }) },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).toContain('class="qp-truncated"');
    expect(html).not.toContain('<table class="sheet-table">');
  });

  it("renders the table when rows*cols is exactly at the limit (1_000_000)", () => {
    // 1000 rows x 1000 cols = 1_000_000, which should still render
    const cellData: Record<string, Record<string, { v: number }>> = {};
    cellData["0"] = { "0": { v: 1 } };
    cellData["999"] = { "999": { v: 2 } };
    const snapshot = makeWorkbook({
      sheetOrder: ["s1"],
      sheets: { s1: makeSheet({ name: "Exact", cellData }) },
    });
    const html = buildPrintHtml(snapshot, { scope: "allSheets" });
    expect(html).not.toContain('class="qp-truncated"');
    expect(html).toContain('<table class="sheet-table">');
  });
});

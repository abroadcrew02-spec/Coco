// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  a1ToColRow,
  addTextBox,
  buildDrawingXmlForTextBoxes,
  buildGroupAnchorXml,
  buildTextBoxAnchorXml,
  colRowToA1,
  deleteTextBox,
  escapeXml,
  flushTextBoxesToPreservedParts,
  listTextBoxes,
  listTextBoxesForSheet,
  makeTextBoxId,
  maxCNvId,
  serializeShapesToAnchors,
  spliceTextBoxesIntoDrawingXml,
  updateTextBox,
  type TextBox,
} from "../textBoxes";

const sampleBox = (overrides: Partial<TextBox> = {}): TextBox => ({
  id: "tb_test_1",
  sheetId: "sheet-1",
  x: 1,
  y: 2,
  w: 4,
  h: 3,
  text: "hello",
  fontFamily: "Calibri",
  fontSize: 11,
  color: "#000000",
  backgroundColor: "#ffffff",
  borderColor: "#000000",
  ...overrides,
});

describe("a1ToColRow", () => {
  it("parses single-cell A1 refs to 0-based (col, row)", () => {
    expect(a1ToColRow("A1")).toEqual({ col: 0, row: 0 });
    expect(a1ToColRow("B2")).toEqual({ col: 1, row: 1 });
    expect(a1ToColRow("AA10")).toEqual({ col: 26, row: 9 });
    expect(a1ToColRow("$C$5")).toEqual({ col: 2, row: 4 });
  });

  it("returns null on malformed input", () => {
    expect(a1ToColRow("")).toBeNull();
    expect(a1ToColRow("A0")).toBeNull(); // row must be 1+
    expect(a1ToColRow("1A")).toBeNull();
    expect(a1ToColRow("A1:B2")).toBeNull();
  });
});

describe("colRowToA1", () => {
  it("inverts a1ToColRow for the common cases", () => {
    expect(colRowToA1(0, 0)).toBe("A1");
    expect(colRowToA1(25, 0)).toBe("Z1");
    expect(colRowToA1(26, 9)).toBe("AA10");
  });
});

describe("escapeXml", () => {
  it("escapes the five canonical entities", () => {
    expect(escapeXml(`<a b="c'd">&</a>`)).toBe(
      "&lt;a b=&quot;c&apos;d&quot;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("makeTextBoxId", () => {
  it("returns a non-empty string and is unique on rapid calls", () => {
    const a = makeTextBoxId();
    const b = makeTextBoxId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("listTextBoxes", () => {
  it("returns [] for null/empty/malformed snapshots", () => {
    expect(listTextBoxes(null)).toEqual([]);
    expect(listTextBoxes(undefined)).toEqual([]);
    expect(listTextBoxes("")).toEqual([]);
    expect(listTextBoxes("not json")).toEqual([]);
    expect(listTextBoxes({})).toEqual([]);
  });

  it("returns the array as-is when present", () => {
    const snap = { _textBoxes: [sampleBox(), sampleBox({ id: "tb_2" })] };
    const result = listTextBoxes(snap);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("tb_test_1");
  });

  it("drops entries with missing required fields", () => {
    const snap = {
      _textBoxes: [
        sampleBox(),
        { id: "", sheetId: "x", x: 0, y: 0, w: 1, h: 1 }, // bad id
        { id: "tb_bad", x: 0, y: 0, w: 1, h: 1 }, // missing sheetId
        sampleBox({ id: "tb_3" }),
      ],
    };
    expect(listTextBoxes(snap)).toHaveLength(2);
  });

  it("coerces numeric fields and applies sane defaults", () => {
    const snap = {
      _textBoxes: [
        {
          id: "x",
          sheetId: "s",
          x: 1.7,
          y: 2.3,
          w: 0, // clamped to 1
          h: 4,
          // text / fontFamily / fontSize / colors missing → defaults
        },
      ],
    };
    const [tb] = listTextBoxes(snap);
    expect(tb.x).toBe(1);
    expect(tb.y).toBe(2);
    expect(tb.w).toBe(1); // clamped from 0
    expect(tb.text).toBe("");
    expect(tb.fontFamily).toBe("");
    expect(tb.fontSize).toBe(11);
    expect(tb.color).toBe("#000000");
  });
});

describe("listTextBoxesForSheet", () => {
  it("filters to a single sheet", () => {
    const snap = {
      _textBoxes: [
        sampleBox({ id: "a", sheetId: "s1" }),
        sampleBox({ id: "b", sheetId: "s2" }),
        sampleBox({ id: "c", sheetId: "s1" }),
      ],
    };
    expect(listTextBoxesForSheet(snap, "s1").map((t) => t.id)).toEqual(["a", "c"]);
    expect(listTextBoxesForSheet(snap, "missing")).toEqual([]);
  });
});

describe("addTextBox / updateTextBox / deleteTextBox", () => {
  it("appends a text box", () => {
    const next = addTextBox({}, sampleBox());
    expect(next._textBoxes).toHaveLength(1);
  });

  it("replaces on duplicate id (idempotent)", () => {
    const a = addTextBox({}, sampleBox({ text: "first" }));
    const b = addTextBox(a, sampleBox({ text: "second" }));
    expect(b._textBoxes).toHaveLength(1);
    expect((b._textBoxes?.[0] as TextBox).text).toBe("second");
  });

  it("updates fields by id", () => {
    const a = addTextBox({}, sampleBox());
    const b = updateTextBox(a, "tb_test_1", { text: "updated", w: 9 });
    expect((b._textBoxes?.[0] as TextBox).text).toBe("updated");
    expect((b._textBoxes?.[0] as TextBox).w).toBe(9);
  });

  it("no-op when id missing", () => {
    const a = addTextBox({}, sampleBox());
    const b = updateTextBox(a, "missing", { text: "noop" });
    expect((b._textBoxes?.[0] as TextBox).text).toBe("hello");
  });

  it("deletes a text box by id", () => {
    const a = addTextBox({}, sampleBox());
    const b = deleteTextBox(a, "tb_test_1");
    expect(b._textBoxes).toEqual([]);
  });

  it("preserves prior _textBoxes when missing", () => {
    expect(deleteTextBox({}, "anything")._textBoxes).toEqual([]);
  });
});

describe("buildTextBoxAnchorXml", () => {
  it("emits a twoCellAnchor with from/to and a sp/txBody", () => {
    const xml = buildTextBoxAnchorXml(sampleBox());
    expect(xml).toContain("<xdr:twoCellAnchor");
    expect(xml).toContain("<xdr:from><xdr:col>1</xdr:col>");
    expect(xml).toContain("<xdr:row>2</xdr:row>");
    // to is from + (w, h) so 1+4=5 and 2+3=5.
    expect(xml).toContain("<xdr:to><xdr:col>5</xdr:col>");
    expect(xml).toContain("<xdr:row>5</xdr:row>");
    expect(xml).toContain("<xdr:sp");
    expect(xml).toContain("<xdr:txBody>");
    expect(xml).toContain("<a:t>hello</a:t>");
  });

  it("escapes special characters in the text payload", () => {
    const xml = buildTextBoxAnchorXml(sampleBox({ text: "<a>&\"'b" }));
    expect(xml).toContain("<a:t>&lt;a&gt;&amp;&quot;&apos;b</a:t>");
  });

  it("splits newlines into separate <a:p> paragraphs", () => {
    const xml = buildTextBoxAnchorXml(sampleBox({ text: "line1\nline2" }));
    const paraCount = (xml.match(/<a:p>/g) ?? []).length;
    expect(paraCount).toBe(2);
    expect(xml).toContain("<a:t>line1</a:t>");
    expect(xml).toContain("<a:t>line2</a:t>");
  });

  it("emits noFill when backgroundColor is transparent", () => {
    const xml = buildTextBoxAnchorXml(
      sampleBox({ backgroundColor: "transparent" }),
    );
    expect(xml).toContain("<a:noFill/>");
  });
});

describe("buildDrawingXmlForTextBoxes", () => {
  it("wraps the anchors in a wsDr envelope with the right namespaces", () => {
    const xml = buildDrawingXmlForTextBoxes([sampleBox(), sampleBox({ id: "b" })]);
    expect(xml).toMatch(/<\?xml/);
    expect(xml).toContain("<xdr:wsDr");
    expect(xml).toContain("xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\"");
    expect(xml).toContain("xmlns:a=");
    const anchorCount = (xml.match(/<xdr:twoCellAnchor/g) ?? []).length;
    expect(anchorCount).toBe(2);
  });
});

describe("spliceTextBoxesIntoDrawingXml", () => {
  it("inserts anchors before </xdr:wsDr>", () => {
    const existing =
      `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="x" xmlns:a="y"><xdr:twoCellAnchor>EXISTING</xdr:twoCellAnchor></xdr:wsDr>`;
    const next = spliceTextBoxesIntoDrawingXml(existing, [sampleBox()]);
    const closeIdx = next.lastIndexOf("</xdr:wsDr>");
    const existingIdx = next.indexOf("EXISTING");
    expect(closeIdx).toBeGreaterThan(0);
    expect(existingIdx).toBeGreaterThan(-1);
    // The text-box anchor must come after the existing anchor but before close.
    expect(next.indexOf("<a:t>hello</a:t>")).toBeGreaterThan(existingIdx);
    expect(next.indexOf("<a:t>hello</a:t>")).toBeLessThan(closeIdx);
  });

  it("falls back to a fresh envelope when the input has no close tag", () => {
    const next = spliceTextBoxesIntoDrawingXml("not a drawing", [sampleBox()]);
    expect(next).toContain("<xdr:wsDr");
    expect(next).toContain("<a:t>hello</a:t>");
  });

  it("returns input unchanged when there are no text boxes", () => {
    expect(spliceTextBoxesIntoDrawingXml("anything", [])).toBe("anything");
  });
});

describe("flushTextBoxesToPreservedParts", () => {
  it("returns the input unchanged when no text boxes exist", () => {
    const snap = JSON.stringify({ sheetOrder: ["s1"], sheets: { s1: {} } });
    expect(flushTextBoxesToPreservedParts(snap)).toBe(snap);
  });

  it("mints a fresh drawingN.xml + rels when the sheet has no existing drawing", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: { name: "Alpha" } },
      _textBoxes: [sampleBox({ sheetId: "s1" })],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    expect(out._preservedParts).toBeDefined();
    expect(out._preservedParts.parts["xl/drawings/drawing1.xml"]).toBeDefined();
    expect(out._preservedParts.parts["xl/drawings/_rels/drawing1.xml.rels"]).toBeDefined();
    expect(out._preservedParts.sheetRefs[0].drawingRid).toBe("rId1");
    expect(out._preservedParts.sheetRefs[0].drawingTarget).toBe(
      "../drawings/drawing1.xml",
    );
    // Round-trip the drawing XML so we can assert on its content.
    const xml = atob(out._preservedParts.parts["xl/drawings/drawing1.xml"]);
    expect(xml).toContain("<xdr:wsDr");
    expect(xml).toContain("<a:t>hello</a:t>");
  });

  it("splices anchors into an existing drawing part instead of minting a new one", () => {
    const existingXml =
      `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="x" xmlns:a="y"><xdr:twoCellAnchor>EXISTING</xdr:twoCellAnchor></xdr:wsDr>`;
    // browser-safe utf8→b64
    const b64Existing = btoa(existingXml);
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: { name: "Alpha" } },
      _preservedParts: {
        parts: { "xl/drawings/drawing7.xml": b64Existing },
        sheetRefs: [
          {
            drawingRid: "rId1",
            drawingTarget: "../drawings/drawing7.xml",
          },
        ],
      },
      _textBoxes: [sampleBox({ sheetId: "s1" })],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    const xml = atob(out._preservedParts.parts["xl/drawings/drawing7.xml"]);
    expect(xml).toContain("EXISTING");
    expect(xml).toContain("<a:t>hello</a:t>");
    // Did not mint a new drawing for this sheet.
    expect(out._preservedParts.parts["xl/drawings/drawing1.xml"]).toBeUndefined();
  });

  it("drops text boxes whose sheetId isn't in sheetOrder", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: {} },
      _textBoxes: [sampleBox({ sheetId: "missing" })],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    // No preserved drawing parts were created.
    expect(
      out._preservedParts?.parts?.["xl/drawings/drawing1.xml"],
    ).toBeUndefined();
  });

  it("handles malformed JSON input by returning it unchanged", () => {
    expect(flushTextBoxesToPreservedParts("not json {")).toBe("not json {");
  });

  it("groups multiple text boxes on the same sheet into one drawing part", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: {} },
      _textBoxes: [
        sampleBox({ id: "tb_a", sheetId: "s1", text: "A" }),
        sampleBox({ id: "tb_b", sheetId: "s1", text: "B" }),
      ],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    const xml = atob(out._preservedParts.parts["xl/drawings/drawing1.xml"]);
    expect(xml).toContain("<a:t>A</a:t>");
    expect(xml).toContain("<a:t>B</a:t>");
    const anchorCount = (xml.match(/<xdr:twoCellAnchor/g) ?? []).length;
    expect(anchorCount).toBe(2);
  });

  it("advertises a content-type Override for a freshly-minted drawing part (#188)", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: {} },
      _textBoxes: [sampleBox({ sheetId: "s1" })],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    // Even with no source contentTypes, a minimal one carrying the Override
    // is synthesized so the Rust exporter advertises the drawing part.
    expect(out._preservedParts.contentTypes).toContain(
      'PartName="/xl/drawings/drawing1.xml"',
    );
    expect(out._preservedParts.contentTypes).toContain("drawing+xml");
  });
});

// ---------------------------------------------------------------------------
// #188 — autoshapes (rect / ellipse / line) and grouping
// ---------------------------------------------------------------------------

describe("buildTextBoxAnchorXml — shape kinds (#188)", () => {
  it("emits prst=\"rect\" for a rectangle with a txBody", () => {
    const xml = buildTextBoxAnchorXml(sampleBox({ type: "rect", text: "" }));
    expect(xml).toContain('<a:prstGeom prst="rect">');
    expect(xml).toContain("<xdr:txBody>");
    // Non-text-box shapes are not flagged txBox.
    expect(xml).not.toContain('txBox="1"');
  });

  it("emits prst=\"ellipse\" for an ellipse", () => {
    const xml = buildTextBoxAnchorXml(sampleBox({ type: "ellipse" }));
    expect(xml).toContain('<a:prstGeom prst="ellipse">');
  });

  it("emits prst=\"line\" with an arrowhead and no txBody for a line", () => {
    const xml = buildTextBoxAnchorXml(sampleBox({ type: "line", text: "x" }));
    expect(xml).toContain('<a:prstGeom prst="line">');
    expect(xml).toContain('<a:tailEnd type="triangle"/>');
    expect(xml).not.toContain("<xdr:txBody>");
  });

  it("keeps txBox=\"1\" for the original text-box kind", () => {
    const xml = buildTextBoxAnchorXml(sampleBox({ type: "textbox" }));
    expect(xml).toContain('<a:prstGeom prst="rect">');
    expect(xml).toContain('txBox="1"');
  });

  it("treats a missing type as a text box (back-compat)", () => {
    const xml = buildTextBoxAnchorXml(sampleBox());
    expect(xml).toContain('txBox="1"');
  });
});

describe("listTextBoxes — type / groupId parsing (#188)", () => {
  it("parses a valid shape kind and defaults unknown kinds to textbox", () => {
    const snap = {
      _textBoxes: [
        { ...sampleBox({ id: "a" }), type: "ellipse" },
        { ...sampleBox({ id: "b" }), type: "bogus" },
        sampleBox({ id: "c" }),
      ],
    };
    const out = listTextBoxes(snap);
    expect(out.find((t) => t.id === "a")?.type).toBe("ellipse");
    expect(out.find((t) => t.id === "b")?.type).toBe("textbox");
    expect(out.find((t) => t.id === "c")?.type).toBe("textbox");
  });

  it("carries a groupId through when present and omits it otherwise", () => {
    const snap = {
      _textBoxes: [
        { ...sampleBox({ id: "a" }), groupId: "grp_1" },
        sampleBox({ id: "b" }),
      ],
    };
    const out = listTextBoxes(snap);
    expect(out.find((t) => t.id === "a")?.groupId).toBe("grp_1");
    expect(out.find((t) => t.id === "b")?.groupId).toBeUndefined();
  });
});

describe("buildGroupAnchorXml (#188)", () => {
  it("wraps members in one grpSp spanning their bounding box", () => {
    const members: TextBox[] = [
      sampleBox({ id: "a", x: 1, y: 1, w: 2, h: 2, text: "A" }),
      sampleBox({ id: "b", x: 5, y: 4, w: 3, h: 1, text: "B" }),
    ];
    const { xml } = buildGroupAnchorXml(members, "grp_1");
    expect(xml).toContain("<xdr:grpSp>");
    // Bounding box: from (1,1) to (max(3,8), max(3,5)) = (8,5).
    expect(xml).toContain("<xdr:from><xdr:col>1</xdr:col>");
    expect(xml).toContain("<xdr:to><xdr:col>8</xdr:col>");
    expect(xml).toContain("<xdr:row>5</xdr:row>");
    // Both child shapes are inside.
    expect(xml).toContain("<a:t>A</a:t>");
    expect(xml).toContain("<a:t>B</a:t>");
    const spCount = (xml.match(/<xdr:sp /g) ?? []).length;
    expect(spCount).toBe(2);
  });

  it("gives child <xdr:sp> real non-zero <a:ext> so the group is visible (#188 M2)", () => {
    const members: TextBox[] = [
      sampleBox({ id: "a", x: 1, y: 1, w: 2, h: 2, text: "A" }),
      sampleBox({ id: "b", x: 5, y: 4, w: 3, h: 1, text: "B" }),
    ];
    const { xml } = buildGroupAnchorXml(members, "grp_1");
    // No child shape may carry a collapsed (zero) extent — that would render
    // the group invisible at the group origin.
    expect(xml).not.toContain('<a:ext cx="0" cy="0"/>');
    // Member A: w=2,h=2 → ext = 2*914400 x 2*914400; off relative to (1,1)=0.
    expect(xml).toContain(
      `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${2 * 914400}" cy="${2 * 914400}"/></a:xfrm>`,
    );
    // Member B: at (5,4), group top-left (1,1) → off = (4*914400, 3*914400);
    // w=3,h=1 → ext = 3*914400 x 1*914400.
    expect(xml).toContain(
      `<a:xfrm><a:off x="${4 * 914400}" y="${3 * 914400}"/><a:ext cx="${3 * 914400}" cy="${1 * 914400}"/></a:xfrm>`,
    );
  });

  it("assigns the group and its children distinct cNvPr ids (#188 M1)", () => {
    const members: TextBox[] = [
      sampleBox({ id: "a", text: "A" }),
      sampleBox({ id: "b", text: "B" }),
    ];
    const { xml, nextCNvId } = buildGroupAnchorXml(members, "grp_1", 5);
    // group=5, child a=6, child b=7 → next free id is 8.
    expect(xml).toContain('<xdr:cNvPr id="5" name="Group grp_1"/>');
    const ids = [...xml.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["5", "6", "7"]);
    expect(nextCNvId).toBe(8);
  });
});

describe("cNvPr id uniqueness across multiple shapes (#188 M1)", () => {
  const collectIds = (xml: string): string[] =>
    [...xml.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map((m) => m[1]);

  it("emits a unique cNvPr id for every shape on a multi-shape sheet", () => {
    const shapes: TextBox[] = [
      sampleBox({ id: "s1", text: "1" }),
      sampleBox({ id: "s2", text: "2" }),
      sampleBox({ id: "s3", type: "rect", text: "3" }),
      { ...sampleBox({ id: "g1", text: "G1" }), groupId: "grp_a" },
      { ...sampleBox({ id: "g2", text: "G2" }), groupId: "grp_a" },
    ];
    const xml = serializeShapesToAnchors(shapes);
    const ids = collectIds(xml);
    // 3 standalone sp + 1 grpSp + 2 grouped sp = 6 cNvPr elements.
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("flushed drawing part has all-unique cNvPr ids for many shapes", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: {} },
      _textBoxes: [
        sampleBox({ id: "a", sheetId: "s1", text: "A" }),
        sampleBox({ id: "b", sheetId: "s1", type: "ellipse", text: "B" }),
        sampleBox({ id: "c", sheetId: "s1", type: "line", text: "" }),
      ],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    const xml = atob(out._preservedParts.parts["xl/drawings/drawing1.xml"]);
    const ids = collectIds(xml);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("splicing into an existing drawing starts ids above the existing max", () => {
    // Existing drawing already uses cNvPr id 2 and 9 (e.g. an image + chart).
    const existing =
      `<?xml version="1.0"?>` +
      `<xdr:wsDr xmlns:xdr="x" xmlns:a="y">` +
      `<xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr>` +
      `<xdr:cNvPr id="2" name="Image"/></xdr:nvPicPr></xdr:pic></xdr:twoCellAnchor>` +
      `<xdr:twoCellAnchor><xdr:graphicFrame><xdr:nvGraphicFramePr>` +
      `<xdr:cNvPr id="9" name="Chart"/></xdr:nvGraphicFramePr></xdr:graphicFrame>` +
      `</xdr:twoCellAnchor>` +
      `</xdr:wsDr>`;
    expect(maxCNvId(existing)).toBe(9);
    const next = spliceTextBoxesIntoDrawingXml(existing, [
      sampleBox({ id: "new1", text: "N1" }),
      sampleBox({ id: "new2", text: "N2" }),
    ]);
    const ids = collectIds(next);
    // 2 pre-existing + 2 spliced = 4 ids, all unique, new ones above 9.
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    const splicedIds = ids
      .map((s) => parseInt(s, 10))
      .filter((n) => n > 9);
    expect(splicedIds).toHaveLength(2);
  });
});

describe("serializeShapesToAnchors (#188)", () => {
  it("emits one grpSp per group and a plain anchor per ungrouped shape", () => {
    const shapes: TextBox[] = [
      { ...sampleBox({ id: "g1a", text: "G1A" }), groupId: "grp_1" },
      { ...sampleBox({ id: "g1b", text: "G1B" }), groupId: "grp_1" },
      sampleBox({ id: "solo", text: "SOLO" }),
    ];
    const xml = serializeShapesToAnchors(shapes);
    const groupCount = (xml.match(/<xdr:grpSp>/g) ?? []).length;
    expect(groupCount).toBe(1);
    // 1 group anchor + 1 standalone anchor = 2 twoCellAnchor elements.
    const anchorCount = (xml.match(/<xdr:twoCellAnchor/g) ?? []).length;
    expect(anchorCount).toBe(2);
    expect(xml).toContain("<a:t>SOLO</a:t>");
  });

  it("emits a single-member group as a plain anchor (no grpSp)", () => {
    const shapes: TextBox[] = [
      { ...sampleBox({ id: "only" }), groupId: "grp_x" },
    ];
    const xml = serializeShapesToAnchors(shapes);
    expect(xml).not.toContain("<xdr:grpSp>");
    expect(xml).toContain("<xdr:twoCellAnchor");
  });
});

describe("flushTextBoxesToPreservedParts — shapes + grouping (#188)", () => {
  it("serialises rect / ellipse / line shapes into the drawing part", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: {} },
      _textBoxes: [
        sampleBox({ id: "r", sheetId: "s1", type: "rect", text: "" }),
        sampleBox({ id: "e", sheetId: "s1", type: "ellipse", text: "" }),
        sampleBox({ id: "l", sheetId: "s1", type: "line", text: "" }),
      ],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    const xml = atob(out._preservedParts.parts["xl/drawings/drawing1.xml"]);
    expect(xml).toContain('prst="rect"');
    expect(xml).toContain('prst="ellipse"');
    expect(xml).toContain('prst="line"');
  });

  it("emits a grpSp for grouped shapes on export", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: {} },
      _textBoxes: [
        { ...sampleBox({ id: "a", sheetId: "s1" }), groupId: "grp_1" },
        { ...sampleBox({ id: "b", sheetId: "s1" }), groupId: "grp_1" },
      ],
    });
    const out = JSON.parse(flushTextBoxesToPreservedParts(snap));
    const xml = atob(out._preservedParts.parts["xl/drawings/drawing1.xml"]);
    expect(xml).toContain("<xdr:grpSp>");
    const anchorCount = (xml.match(/<xdr:twoCellAnchor/g) ?? []).length;
    expect(anchorCount).toBe(1);
  });
});

describe("drawing XML well-formedness (#188 — Excel must open it)", () => {
  // A malformed drawing part is the most common way an xlsx fails to open.
  // Parse every emitted drawing doc with DOMParser and assert no parse error.
  const assertWellFormed = (xml: string) => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const err = doc.querySelector("parsererror");
    expect(err, err?.textContent ?? "parse error").toBeNull();
  };

  it("produces well-formed XML for every shape kind", () => {
    for (const type of ["textbox", "rect", "ellipse", "line"] as const) {
      const xml = buildDrawingXmlForTextBoxes([
        sampleBox({ type, text: "label & <stuff>" }),
      ]);
      assertWellFormed(xml);
    }
  });

  it("produces well-formed XML for a grouped drawing", () => {
    const xml = buildDrawingXmlForTextBoxes([
      { ...sampleBox({ id: "a", type: "rect" }), groupId: "grp_1" },
      { ...sampleBox({ id: "b", type: "ellipse" }), groupId: "grp_1" },
      sampleBox({ id: "c", type: "line" }),
    ]);
    assertWellFormed(xml);
  });
});

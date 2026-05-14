// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  computeImagePreviews,
  decodeBase64Utf8,
  parseRels,
  resolveMediaPath,
  parseAnchor,
  extToMime,
  colRowToA1,
} from "./imagePreviews";

// Tiny ASCII-only base64 helper for fixture construction. We can't reuse
// btoa directly in some node runtimes, but it's available in happy-dom.
function b64(s: string): string {
  return btoa(s);
}

// 1x1 transparent PNG — the smallest legal PNG payload. Suitable for
// fixture round-trips because the decoder doesn't care about the content,
// only that the base64 makes it through.
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("decodeBase64Utf8", () => {
  it("round-trips an ASCII string", () => {
    expect(decodeBase64Utf8(b64("hello world"))).toBe("hello world");
  });

  it("returns null on malformed base64", () => {
    expect(decodeBase64Utf8("!!!not base64!!!")).toBe(null);
  });

  it("handles multibyte UTF-8 (Japanese)", () => {
    const original = "<x>こんにちは</x>";
    const bytes = new TextEncoder().encode(original);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    expect(decodeBase64Utf8(btoa(bin))).toBe(original);
  });
});

describe("parseRels", () => {
  it("extracts Id→Target pairs from a drawing rels XML", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.jpg"/>` +
      `</Relationships>`;
    expect(parseRels(xml)).toEqual({
      rId1: "../media/image1.png",
      rId2: "../media/image2.jpg",
    });
  });

  it("returns {} for empty input", () => {
    expect(parseRels("")).toEqual({});
  });
});

describe("resolveMediaPath", () => {
  it("resolves ../media/imageN.png relative to xl/drawings/drawingN.xml", () => {
    expect(resolveMediaPath("xl/drawings/drawing1.xml", "../media/image1.png"))
      .toBe("xl/media/image1.png");
  });

  it("passes through an already-absolute xlsx path", () => {
    expect(resolveMediaPath("xl/drawings/drawing1.xml", "xl/media/image3.gif"))
      .toBe("xl/media/image3.gif");
  });
});

describe("parseAnchor", () => {
  it("extracts from-col/row and to-col/row from a twoCellAnchor", () => {
    const xml =
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">` +
      `<xdr:twoCellAnchor>` +
      `<xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>13</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `</xdr:twoCellAnchor>` +
      `</xdr:wsDr>`;
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const anchor =
      doc.getElementsByTagName("twoCellAnchor")[0] ??
      doc.getElementsByTagName("xdr:twoCellAnchor")[0];
    expect(parseAnchor(anchor)).toEqual({
      fromCol: 2,
      fromRow: 3,
      toCol: 6,
      toRow: 13,
    });
  });
});

describe("extToMime", () => {
  it("maps the common xlsx-supported image extensions", () => {
    expect(extToMime("png")).toBe("image/png");
    expect(extToMime("PNG")).toBe("image/png");
    expect(extToMime("jpg")).toBe("image/jpeg");
    expect(extToMime("jpeg")).toBe("image/jpeg");
    expect(extToMime("gif")).toBe("image/gif");
    expect(extToMime("bmp")).toBe("image/bmp");
  });
});

describe("colRowToA1", () => {
  it("converts 0-based col/row to A1", () => {
    expect(colRowToA1(0, 0)).toBe("A1");
    expect(colRowToA1(1, 0)).toBe("B1");
    expect(colRowToA1(25, 0)).toBe("Z1");
    expect(colRowToA1(26, 9)).toBe("AA10");
  });
});

describe("computeImagePreviews", () => {
  it("returns [] for null/empty/malformed snapshots", () => {
    expect(computeImagePreviews(null)).toEqual([]);
    expect(computeImagePreviews("")).toEqual([]);
    expect(computeImagePreviews("not json {")).toEqual([]);
    expect(
      computeImagePreviews(JSON.stringify({ sheets: { s1: {} } })),
    ).toEqual([]);
  });

  it("emits one preview per twoCellAnchor with a resolvable embed", () => {
    const drawingXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
      ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
      ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<xdr:twoCellAnchor editAs="oneCell">` +
      `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:pic>` +
      `<xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>` +
      `</xdr:pic>` +
      `</xdr:twoCellAnchor>` +
      `</xdr:wsDr>`;
    const relsXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
      `</Relationships>`;
    const snap = {
      sheetOrder: ["s1"],
      sheets: { s1: { name: "Alpha" } },
      _preservedParts: {
        parts: {
          "xl/drawings/drawing1.xml": b64(drawingXml),
          "xl/drawings/_rels/drawing1.xml.rels": b64(relsXml),
          "xl/media/image1.png": PNG_1X1_B64,
        },
        sheetRefs: [
          {
            drawingRid: "rId1",
            drawingTarget: "../drawings/drawing1.xml",
          },
        ],
      },
    };
    const result = computeImagePreviews(JSON.stringify(snap));
    expect(result.length).toBe(1);
    expect(result[0].sheetId).toBe("s1");
    expect(result[0].sheetName).toBe("Alpha");
    expect(result[0].fromCol).toBe(1);
    expect(result[0].fromRow).toBe(2);
    expect(result[0].toCol).toBe(5);
    expect(result[0].toRow).toBe(12);
    expect(result[0].mediaPath).toBe("xl/media/image1.png");
    expect(result[0].src).toBe(`data:image/png;base64,${PNG_1X1_B64}`);
  });

  it("skips sheets whose drawingTarget points at a missing part", () => {
    const snap = {
      sheetOrder: ["s1"],
      sheets: { s1: { name: "Alpha" } },
      _preservedParts: {
        parts: {},
        sheetRefs: [
          { drawingRid: "rId1", drawingTarget: "../drawings/drawing1.xml" },
        ],
      },
    };
    expect(computeImagePreviews(JSON.stringify(snap))).toEqual([]);
  });
});

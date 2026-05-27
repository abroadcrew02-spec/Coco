import { describe, it, expect } from "vitest";
import { resolveInGridImagesForSheet } from "./inGridImageLayout";

// #312 — inGridImageLayout tests.

function makeSnapshot(
  sheetId: string,
  images: Array<Record<string, unknown>>,
  extraSheets: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    sheetOrder: [sheetId, ...Object.keys(extraSheets)],
    sheets: {
      [sheetId]: {
        name: "Sheet1",
        _images: images,
      },
      ...extraSheets,
    },
  });
}

const validImage = {
  base64: "abc123",
  ext: "png",
  anchorRow: 2,
  anchorCol: 3,
  widthPx: 320,
  heightPx: 200,
};

describe("resolveInGridImagesForSheet", () => {
  it("returns [] for null snapshotJson", () => {
    expect(resolveInGridImagesForSheet(null, "s1")).toEqual([]);
  });

  it("returns [] for null sheetId", () => {
    expect(resolveInGridImagesForSheet("{}", null)).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(resolveInGridImagesForSheet("{bad json", "s1")).toEqual([]);
  });

  it("returns [] when sheet has no _images", () => {
    const snap = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: { s1: { name: "Sheet1" } },
    });
    expect(resolveInGridImagesForSheet(snap, "s1")).toEqual([]);
  });

  it("returns [] when _images is an empty array", () => {
    const snap = makeSnapshot("s1", []);
    expect(resolveInGridImagesForSheet(snap, "s1")).toEqual([]);
  });

  it("returns [] when sheetId does not exist in snapshot", () => {
    const snap = makeSnapshot("s1", [validImage]);
    expect(resolveInGridImagesForSheet(snap, "s99")).toEqual([]);
  });

  it("skips entries missing anchor fields", () => {
    const snap = makeSnapshot("s1", [
      { base64: "abc", ext: "png", anchorRow: 0 }, // missing anchorCol, widthPx, heightPx
    ]);
    expect(resolveInGridImagesForSheet(snap, "s1")).toEqual([]);
  });

  it("skips entries with zero widthPx", () => {
    const snap = makeSnapshot("s1", [{ ...validImage, widthPx: 0 }]);
    expect(resolveInGridImagesForSheet(snap, "s1")).toEqual([]);
  });

  it("skips entries with negative anchorRow", () => {
    const snap = makeSnapshot("s1", [{ ...validImage, anchorRow: -1 }]);
    expect(resolveInGridImagesForSheet(snap, "s1")).toEqual([]);
  });

  it("skips null/undefined entries in _images array", () => {
    const snap = makeSnapshot("s1", [null as unknown as Record<string, unknown>, validImage]);
    const result = resolveInGridImagesForSheet(snap, "s1");
    expect(result).toHaveLength(1);
  });

  it("returns one placement for a valid image", () => {
    const snap = makeSnapshot("s1", [validImage]);
    const result = resolveInGridImagesForSheet(snap, "s1");
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
    expect(result[0].key).toBe("s1-0");
    expect(result[0].entry.ext).toBe("png");
    expect(result[0].box.width).toBe(320);
    expect(result[0].box.height).toBe(200);
    expect(result[0].box.left).toBeGreaterThan(0);
    expect(result[0].box.top).toBeGreaterThan(0);
  });

  it("returns multiple placements for multiple valid images", () => {
    const image2 = { base64: "def", ext: "jpg", anchorRow: 5, anchorCol: 0, widthPx: 160, heightPx: 120 };
    const snap = makeSnapshot("s1", [validImage, image2]);
    const result = resolveInGridImagesForSheet(snap, "s1");
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
  });

  it("assigns correct key based on sheetId and index", () => {
    const snap = makeSnapshot("mySheet", [validImage]);
    const result = resolveInGridImagesForSheet(snap, "mySheet");
    expect(result[0].key).toBe("mySheet-0");
  });

  it("skips dangling entry but includes valid ones (mixed array)", () => {
    const dangling = { base64: "x", ext: "png" }; // no anchor fields
    const snap = makeSnapshot("s1", [dangling, validImage]);
    const result = resolveInGridImagesForSheet(snap, "s1");
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(1); // index 1 is the valid one
  });

  it("is independent of other sheets (multi-sheet snapshot)", () => {
    const otherSheetImages = [
      { base64: "ghi", ext: "gif", anchorRow: 0, anchorCol: 0, widthPx: 80, heightPx: 60 },
    ];
    const snap = makeSnapshot("s1", [validImage], {
      s2: { name: "Sheet2", _images: otherSheetImages },
    });
    const result1 = resolveInGridImagesForSheet(snap, "s1");
    const result2 = resolveInGridImagesForSheet(snap, "s2");
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(result1[0].entry.ext).toBe("png");
    expect(result2[0].entry.ext).toBe("gif");
  });

  it("uses sheet layout data for pixel resolution (wider column → larger left offset)", () => {
    const snap1 = makeSnapshot("s1", [{ ...validImage, anchorCol: 2 }]);
    const snap2 = JSON.stringify({
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          name: "Sheet1",
          _images: [{ ...validImage, anchorCol: 2 }],
          defaultColumnWidth: 200,
        },
      },
    });
    const r1 = resolveInGridImagesForSheet(snap1, "s1");
    const r2 = resolveInGridImagesForSheet(snap2, "s1");
    expect(r2[0].box.left).toBeGreaterThan(r1[0].box.left);
  });
});

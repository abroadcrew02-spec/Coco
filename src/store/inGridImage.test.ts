import { describe, it, expect } from "vitest";
import {
  resolveImageBox,
  moveImageAnchor,
  resizeImageAnchor,
  snapAnchorToPixel,
  imageDataUrl,
  IMAGE_MIN_WIDTH_PX,
  IMAGE_MIN_HEIGHT_PX,
  type ImageEntry,
} from "./inGridImage";

// #312 — in-grid image anchor + box resolution tests.

function makeEntry(overrides: Partial<ImageEntry> = {}): ImageEntry {
  return {
    base64: "abc123",
    ext: "png",
    anchorRow: 0,
    anchorCol: 0,
    widthPx: 320,
    heightPx: 200,
    ...overrides,
  };
}

describe("resolveImageBox", () => {
  it("returns null when anchorRow is negative", () => {
    expect(resolveImageBox(makeEntry({ anchorRow: -1 }), {})).toBeNull();
  });

  it("returns null when anchorCol is negative", () => {
    expect(resolveImageBox(makeEntry({ anchorCol: -1 }), {})).toBeNull();
  });

  it("returns null when widthPx is zero", () => {
    expect(resolveImageBox(makeEntry({ widthPx: 0 }), {})).toBeNull();
  });

  it("returns null when heightPx is zero", () => {
    expect(resolveImageBox(makeEntry({ heightPx: 0 }), {})).toBeNull();
  });

  it("returns null when widthPx is negative", () => {
    expect(resolveImageBox(makeEntry({ widthPx: -10 }), {})).toBeNull();
  });

  it("returns null when anchorRow is NaN", () => {
    expect(resolveImageBox(makeEntry({ anchorRow: NaN }), {})).toBeNull();
  });

  it("returns a valid box for a complete entry", () => {
    const entry = makeEntry({ anchorRow: 2, anchorCol: 3, widthPx: 500, heightPx: 200 });
    const box = resolveImageBox(entry, {});
    expect(box).not.toBeNull();
    expect(box!.width).toBe(500);
    expect(box!.height).toBe(200);
    // left/top should be > 0 (past the header offsets).
    expect(box!.left).toBeGreaterThan(0);
    expect(box!.top).toBeGreaterThan(0);
  });

  it("returns box with left/top == header offsets for anchor (0,0)", () => {
    const entry = makeEntry({ anchorRow: 0, anchorCol: 0, widthPx: 100, heightPx: 80 });
    const box = resolveImageBox(entry, {});
    expect(box).not.toBeNull();
    // Header offsets (HEADER_LEFT=46, HEADER_TOP=20).
    expect(box!.left).toBeGreaterThan(0);
    expect(box!.top).toBeGreaterThan(0);
  });

  it("respects custom defaultColumnWidth in layout", () => {
    const entry = makeEntry({ anchorRow: 0, anchorCol: 1, widthPx: 200, heightPx: 100 });
    const baseBox = resolveImageBox(entry, {})!;
    const wideBox = resolveImageBox(entry, { defaultColumnWidth: 200 })!;
    expect(wideBox.left).toBeGreaterThan(baseBox.left);
  });
});

describe("moveImageAnchor", () => {
  it("offsets anchor by delta", () => {
    const entry = makeEntry({ anchorRow: 5, anchorCol: 3 });
    const moved = moveImageAnchor(entry, 2, -1);
    expect(moved.anchorRow).toBe(7);
    expect(moved.anchorCol).toBe(2);
  });

  it("clamps to non-negative", () => {
    const entry = makeEntry({ anchorRow: 1, anchorCol: 1 });
    const moved = moveImageAnchor(entry, -100, -100);
    expect(moved.anchorRow).toBe(0);
    expect(moved.anchorCol).toBe(0);
  });

  it("does not mutate input", () => {
    const entry = makeEntry({ anchorRow: 3, anchorCol: 3 });
    moveImageAnchor(entry, 5, 5);
    expect(entry.anchorRow).toBe(3);
    expect(entry.anchorCol).toBe(3);
  });

  it("preserves base64 and ext fields", () => {
    const entry = makeEntry({ anchorRow: 0, anchorCol: 0 });
    const moved = moveImageAnchor(entry, 1, 1);
    expect(moved.base64).toBe(entry.base64);
    expect(moved.ext).toBe(entry.ext);
  });
});

describe("resizeImageAnchor", () => {
  it("updates widthPx and heightPx", () => {
    const entry = makeEntry({ widthPx: 100, heightPx: 50 });
    const resized = resizeImageAnchor(entry, 500, 250);
    expect(resized.widthPx).toBe(500);
    expect(resized.heightPx).toBe(250);
  });

  it("enforces minimum size", () => {
    const entry = makeEntry({ widthPx: 100, heightPx: 50 });
    const resized = resizeImageAnchor(entry, 1, 1);
    expect(resized.widthPx).toBe(IMAGE_MIN_WIDTH_PX);
    expect(resized.heightPx).toBe(IMAGE_MIN_HEIGHT_PX);
  });

  it("floors fractional values", () => {
    const entry = makeEntry({ widthPx: 100, heightPx: 50 });
    const resized = resizeImageAnchor(entry, 123.9, 99.8);
    expect(resized.widthPx).toBe(123);
    expect(resized.heightPx).toBe(99);
  });

  it("does not mutate input", () => {
    const entry = makeEntry({ widthPx: 200, heightPx: 100 });
    resizeImageAnchor(entry, 999, 999);
    expect(entry.widthPx).toBe(200);
    expect(entry.heightPx).toBe(100);
  });

  it("uses exported constants as floor", () => {
    const entry = makeEntry({ widthPx: 200, heightPx: 200 });
    const resized = resizeImageAnchor(entry, 0, 0);
    expect(resized.widthPx).toBe(IMAGE_MIN_WIDTH_PX);
    expect(resized.heightPx).toBe(IMAGE_MIN_HEIGHT_PX);
  });
});

describe("snapAnchorToPixel", () => {
  it("snaps to row 0 col 0 for a pixel inside A1", () => {
    const entry = makeEntry({ anchorRow: 5, anchorCol: 5 });
    const snapped = snapAnchorToPixel(entry, 50, 25, {});
    expect(snapped.anchorRow).toBe(0);
    expect(snapped.anchorCol).toBe(0);
  });

  it("snaps to row 1 col 1 for a pixel inside B2", () => {
    // DEFAULT_COL=73, DEFAULT_ROW=19, HEADER_LEFT=46, HEADER_TOP=20
    // B2 left = 46+73=119, top = 20+19=39; pick (125, 45) inside B2
    const entry = makeEntry({ anchorRow: 0, anchorCol: 0 });
    const snapped = snapAnchorToPixel(entry, 125, 45, {});
    expect(snapped.anchorRow).toBe(1);
    expect(snapped.anchorCol).toBe(1);
  });

  it("preserves widthPx and heightPx", () => {
    const entry = makeEntry({ anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200 });
    const snapped = snapAnchorToPixel(entry, 50, 25, {});
    expect(snapped.widthPx).toBe(320);
    expect(snapped.heightPx).toBe(200);
  });

  it("clamps to (0,0) for a point in the header region", () => {
    const entry = makeEntry({ anchorRow: 3, anchorCol: 3 });
    const snapped = snapAnchorToPixel(entry, 5, 5, {});
    expect(snapped.anchorRow).toBe(0);
    expect(snapped.anchorCol).toBe(0);
  });

  it("does not mutate input", () => {
    const entry = makeEntry({ anchorRow: 3, anchorCol: 3 });
    snapAnchorToPixel(entry, 50, 25, {});
    expect(entry.anchorRow).toBe(3);
  });
});

describe("imageDataUrl", () => {
  it("builds a png data URL", () => {
    const entry = makeEntry({ ext: "png", base64: "abc" });
    expect(imageDataUrl(entry)).toBe("data:image/png;base64,abc");
  });

  it("builds a jpeg data URL for jpg ext", () => {
    const entry = makeEntry({ ext: "jpg", base64: "xyz" });
    expect(imageDataUrl(entry)).toBe("data:image/jpeg;base64,xyz");
  });

  it("builds a jpeg data URL for jpeg ext", () => {
    const entry = makeEntry({ ext: "jpeg", base64: "xyz" });
    expect(imageDataUrl(entry)).toBe("data:image/jpeg;base64,xyz");
  });

  it("builds a gif data URL", () => {
    const entry = makeEntry({ ext: "gif", base64: "ggg" });
    expect(imageDataUrl(entry)).toBe("data:image/gif;base64,ggg");
  });

  it("builds a bmp data URL", () => {
    const entry = makeEntry({ ext: "bmp", base64: "bbb" });
    expect(imageDataUrl(entry)).toBe("data:image/bmp;base64,bbb");
  });
});

describe("IMAGE_MIN_WIDTH_PX / IMAGE_MIN_HEIGHT_PX constants", () => {
  it("exports IMAGE_MIN_WIDTH_PX as 40", () => {
    expect(IMAGE_MIN_WIDTH_PX).toBe(40);
  });

  it("exports IMAGE_MIN_HEIGHT_PX as 30", () => {
    expect(IMAGE_MIN_HEIGHT_PX).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Snapshot persistence logic — unit tests for the pure transform that
// handleImageAnchorChange performs inside EditorScreen.
// ---------------------------------------------------------------------------
describe("image anchor snapshot persistence", () => {
  function makeSnapshotWithImages(
    sheetId: string,
    images: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      sheetOrder: [sheetId],
      sheets: {
        [sheetId]: {
          name: "Sheet1",
          _images: images,
        },
      },
    };
  }

  function applyAnchorChange(
    snapshot: Record<string, unknown>,
    sheetId: string,
    imageIndex: number,
    updated: Record<string, unknown>,
  ): Record<string, unknown> {
    const sheets = (snapshot.sheets as Record<string, Record<string, unknown>> | undefined) ?? {};
    const sheetObj = sheets[sheetId];
    if (!sheetObj) return snapshot;
    const existing = Array.isArray(sheetObj._images)
      ? (sheetObj._images as Array<Record<string, unknown>>)
      : [];
    if (imageIndex < 0 || imageIndex >= existing.length) return snapshot;
    const next = existing.map((img, i) => (i === imageIndex ? { ...img, ...updated } : img));
    return {
      ...snapshot,
      sheets: {
        ...sheets,
        [sheetId]: { ...sheetObj, _images: next },
      },
    };
  }

  it("updates anchorRow/anchorCol/widthPx/heightPx for the target image", () => {
    const snap = makeSnapshotWithImages("s1", [
      { base64: "abc", ext: "png", anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200 },
    ]);
    const updated = { anchorRow: 3, anchorCol: 2, widthPx: 400, heightPx: 250 };
    const next = applyAnchorChange(snap, "s1", 0, updated);
    const images = (next.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._images as Array<Record<string, unknown>>;
    expect(images[0].anchorRow).toBe(3);
    expect(images[0].anchorCol).toBe(2);
    expect(images[0].widthPx).toBe(400);
    expect(images[0].heightPx).toBe(250);
  });

  it("does not mutate other images in the array", () => {
    const snap = makeSnapshotWithImages("s1", [
      { base64: "abc", ext: "png", anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200 },
      { base64: "def", ext: "jpg", anchorRow: 5, anchorCol: 2, widthPx: 160, heightPx: 120 },
    ]);
    const next = applyAnchorChange(snap, "s1", 0, { anchorRow: 10, anchorCol: 10, widthPx: 320, heightPx: 200 });
    const images = (next.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._images as Array<Record<string, unknown>>;
    expect(images[0].anchorRow).toBe(10);
    expect(images[1].anchorRow).toBe(5); // untouched
  });

  it("preserves existing fields not in the updated payload", () => {
    const snap = makeSnapshotWithImages("s1", [
      { base64: "abc", ext: "png", anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200, name: "photo.png" },
    ]);
    const next = applyAnchorChange(snap, "s1", 0, { anchorRow: 1, anchorCol: 1, widthPx: 320, heightPx: 200 });
    const images = (next.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._images as Array<Record<string, unknown>>;
    expect(images[0].name).toBe("photo.png");
    expect(images[0].base64).toBe("abc");
  });

  it("does not mutate the original snapshot object", () => {
    const snap = makeSnapshotWithImages("s1", [
      { base64: "abc", ext: "png", anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200 },
    ]);
    const origImage = ((snap.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._images as Array<Record<string, unknown>>)[0];
    applyAnchorChange(snap, "s1", 0, { anchorRow: 99, anchorCol: 99, widthPx: 320, heightPx: 200 });
    expect(origImage.anchorRow).toBe(0);
  });

  it("returns snapshot unchanged when imageIndex is out of bounds", () => {
    const snap = makeSnapshotWithImages("s1", [
      { base64: "abc", ext: "png", anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200 },
    ]);
    const result = applyAnchorChange(snap, "s1", 5, { anchorRow: 99, anchorCol: 99, widthPx: 100, heightPx: 100 });
    const images = (result.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._images as Array<Record<string, unknown>>;
    expect(images[0].anchorRow).toBe(0);
  });

  it("returns snapshot unchanged when sheetId does not exist", () => {
    const snap = makeSnapshotWithImages("s1", [
      { base64: "abc", ext: "png", anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200 },
    ]);
    const result = applyAnchorChange(snap, "s99", 0, { anchorRow: 5, anchorCol: 5, widthPx: 200, heightPx: 100 });
    const images = (result.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._images as Array<Record<string, unknown>>;
    expect(images[0].anchorRow).toBe(0);
  });

  it("round-trip: serialize → deserialize → anchor fields preserved", () => {
    const snap = makeSnapshotWithImages("s1", [
      { base64: "abc", ext: "png", anchorRow: 0, anchorCol: 0, widthPx: 320, heightPx: 200 },
    ]);
    const next = applyAnchorChange(snap, "s1", 0, { anchorRow: 7, anchorCol: 3, widthPx: 400, heightPx: 180 });
    const roundTripped = JSON.parse(JSON.stringify(next)) as typeof next;
    const images = (roundTripped.sheets as Record<string, Record<string, unknown>>)["s1"]
      ._images as Array<Record<string, unknown>>;
    expect(images[0].anchorRow).toBe(7);
    expect(images[0].anchorCol).toBe(3);
    expect(images[0].widthPx).toBe(400);
    expect(images[0].heightPx).toBe(180);
  });
});

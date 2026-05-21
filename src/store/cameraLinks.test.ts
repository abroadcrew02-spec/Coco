import { describe, it, expect } from "vitest";
import {
  CAMERA_LINKS_MAX,
  generateCameraLinkId,
  listCameraLinks,
  addCameraLink,
  removeCameraLink,
  updateCameraLinkRender,
  isSourceResolvable,
  type CameraLink,
} from "./cameraLinks";

function makeLink(id: string, sheetId = "s1"): CameraLink {
  return {
    id,
    sourceSheetId: sheetId,
    sourceRange: { r1: 0, c1: 0, r2: 1, c2: 1 },
    dstSheetId: sheetId,
    dstAnchor: { row: 0, col: 4 },
    dataUrl: "data:image/png;base64,AAA",
    broken: false,
    generatedAt: "2026-05-20T00:00:00.000Z",
  };
}

describe("generateCameraLinkId", () => {
  it("returns camera-1 for an empty workbook", () => {
    expect(generateCameraLinkId([])).toBe("camera-1");
  });

  it("picks the smallest unused index", () => {
    const existing = [makeLink("camera-1"), makeLink("camera-3")];
    expect(generateCameraLinkId(existing)).toBe("camera-2");
  });

  it("ignores non-conforming ids", () => {
    expect(generateCameraLinkId([makeLink("hand-named")])).toBe("camera-1");
  });
});

describe("listCameraLinks", () => {
  it("returns [] for null/missing/malformed input", () => {
    expect(listCameraLinks(null)).toEqual([]);
    expect(listCameraLinks(undefined)).toEqual([]);
    expect(listCameraLinks({})).toEqual([]);
    expect(listCameraLinks({ _cameraLinks: "nope" } as never)).toEqual([]);
  });

  it("filters out null entries", () => {
    const snap = { _cameraLinks: [makeLink("camera-1"), null] } as never;
    expect(listCameraLinks(snap)).toHaveLength(1);
  });
});

describe("addCameraLink", () => {
  it("appends a link and reports added:true", () => {
    const { snapshot, added } = addCameraLink({}, makeLink("camera-1"));
    expect(added).toBe(true);
    expect(listCameraLinks(snapshot)).toHaveLength(1);
  });

  it("does not mutate the input snapshot", () => {
    const input = { _cameraLinks: [makeLink("camera-1")] };
    const { snapshot } = addCameraLink(input, makeLink("camera-2"));
    expect(input._cameraLinks).toHaveLength(1);
    expect(listCameraLinks(snapshot)).toHaveLength(2);
  });

  it("refuses to add past the 50-link cap and reports added:false", () => {
    const links = Array.from({ length: CAMERA_LINKS_MAX }, (_, i) =>
      makeLink(`camera-${i + 1}`),
    );
    const full = { _cameraLinks: links };
    const { snapshot, added } = addCameraLink(full, makeLink("camera-overflow"));
    expect(added).toBe(false);
    expect(listCameraLinks(snapshot)).toHaveLength(CAMERA_LINKS_MAX);
  });

  it("allows adding exactly up to the cap", () => {
    let snap: Record<string, unknown> = {};
    for (let i = 1; i <= CAMERA_LINKS_MAX; i++) {
      const res = addCameraLink(snap, makeLink(`camera-${i}`));
      expect(res.added).toBe(true);
      snap = res.snapshot as Record<string, unknown>;
    }
    expect(listCameraLinks(snap)).toHaveLength(CAMERA_LINKS_MAX);
  });
});

describe("removeCameraLink", () => {
  it("drops the link by id", () => {
    const snap = { _cameraLinks: [makeLink("camera-1"), makeLink("camera-2")] };
    const next = removeCameraLink(snap, "camera-1");
    expect(listCameraLinks(next).map((l) => l.id)).toEqual(["camera-2"]);
  });

  it("returns the input unchanged when the id is absent", () => {
    const snap = { _cameraLinks: [makeLink("camera-1")] };
    expect(removeCameraLink(snap, "camera-9")).toBe(snap);
  });
});

describe("updateCameraLinkRender", () => {
  it("patches dataUrl + broken and refreshes generatedAt", () => {
    const snap = { _cameraLinks: [makeLink("camera-1")] };
    const next = updateCameraLinkRender(snap, "camera-1", {
      dataUrl: "data:image/png;base64,BBB",
      broken: false,
    });
    const link = listCameraLinks(next)[0];
    expect(link.dataUrl).toBe("data:image/png;base64,BBB");
    expect(link.generatedAt).not.toBe("2026-05-20T00:00:00.000Z");
  });

  it("can flag a link as broken", () => {
    const snap = { _cameraLinks: [makeLink("camera-1")] };
    const next = updateCameraLinkRender(snap, "camera-1", {
      dataUrl: "",
      broken: true,
    });
    expect(listCameraLinks(next)[0].broken).toBe(true);
  });

  it("returns the input unchanged when the id is absent", () => {
    const snap = { _cameraLinks: [makeLink("camera-1")] };
    expect(
      updateCameraLinkRender(snap, "camera-9", { dataUrl: "x", broken: false }),
    ).toBe(snap);
  });
});

describe("isSourceResolvable", () => {
  it("true when the source sheet exists", () => {
    const snap = { sheets: { s1: {} } };
    expect(isSourceResolvable(snap, makeLink("camera-1", "s1"))).toBe(true);
  });

  it("false when the source sheet was deleted", () => {
    const snap = { sheets: { s2: {} } };
    expect(isSourceResolvable(snap, makeLink("camera-1", "s1"))).toBe(false);
  });

  it("false for malformed snapshot", () => {
    expect(isSourceResolvable(null, makeLink("camera-1"))).toBe(false);
    expect(isSourceResolvable({}, makeLink("camera-1"))).toBe(false);
  });
});

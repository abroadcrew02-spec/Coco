// Pure helpers for the "camera" feature (#184): live snapshot images of a
// cell range. Excel's Camera tool / Sheets' "snapshot image" — the source
// range is baked into a data-URL image that re-renders whenever the source
// cells change.
//
// Univer 0.5.x has no in-grid overlay/decoration API and no pixel
// coordinates for cells, so (per the issue) the camera images are surfaced
// in a sidebar panel (CameraLinksPanel) rather than floating on the grid.
// The `dstAnchor` is still recorded so a future in-grid renderer can use it.
//
// Storage: a workbook-root `_cameraLinks` array on the Univer snapshot.
// xlsx round-trip is handled by xlsx_io.rs via the cocoExtensions mechanism
// (the "cameraLinks" family under COCO_EXTENSION_ROOT_FIELDS).
//
// Snapshot shape (Coco extension to Univer 0.5.x workbook data):
//   {
//     sheetOrder?: string[],
//     sheets: { ... },
//     _cameraLinks?: CameraLink[],
//   }
//
// All helpers are side-effect free so they can drive both the snapshot patch
// and the sidebar panel without bringing Univer into the test surface.

/** Inclusive 0-based cell rectangle (source range / dst anchor cell). */
export interface CameraRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface CameraLink {
  /** Workbook-unique id, e.g. "camera-1". */
  id: string;
  /** Sheet id the source range lives on. */
  sourceSheetId: string;
  /** Source range (inclusive, 0-based). */
  sourceRange: CameraRect;
  /** Sheet id the snapshot image is anchored to (for a future in-grid view). */
  dstSheetId: string;
  /** Top-left anchor cell of the snapshot image. */
  dstAnchor: { row: number; col: number };
  /** Baked PNG `data:image/png;base64,...` URL — empty string when stale. */
  dataUrl: string;
  /** True when the source range no longer resolves (=> #REF! placeholder). */
  broken?: boolean;
  /** ISO timestamp the dataUrl was last (re)generated. */
  generatedAt: string;
}

/** Per-workbook cap — keeps re-render cost and snapshot size bounded. */
export const CAMERA_LINKS_MAX = 50;

interface CameraLinksSnapshot {
  _cameraLinks?: CameraLink[];
  [k: string]: unknown;
}

const ID_RE = /^camera-(\d+)$/;

/** Pick the smallest unused "camera-N" id (N >= 1). */
export function generateCameraLinkId(existing: CameraLink[]): string {
  const used = new Set<number>();
  for (const l of existing) {
    if (!l || typeof l.id !== "string") continue;
    const m = ID_RE.exec(l.id);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1) used.add(n);
    }
  }
  let i = 1;
  while (used.has(i)) i++;
  return `camera-${i}`;
}

/** Read the `_cameraLinks` array out of a snapshot; always returns an array. */
export function listCameraLinks(
  snapshot: CameraLinksSnapshot | null | undefined,
): CameraLink[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const arr = snapshot._cameraLinks;
  return Array.isArray(arr) ? arr.filter((l): l is CameraLink => !!l && typeof l === "object") : [];
}

/**
 * Append a camera link to the snapshot's `_cameraLinks`. Returns a NEW
 * snapshot object (shallow clone) with the link added.
 *
 * Throws nothing — when the workbook already holds `CAMERA_LINKS_MAX` links
 * the input is returned UNCHANGED and `added` is false so the caller can
 * surface a "limit reached" message.
 */
export function addCameraLink(
  snapshot: CameraLinksSnapshot,
  link: CameraLink,
): { snapshot: CameraLinksSnapshot; added: boolean } {
  if (!snapshot || typeof snapshot !== "object") {
    return { snapshot, added: false };
  }
  const list = listCameraLinks(snapshot);
  if (list.length >= CAMERA_LINKS_MAX) {
    return { snapshot, added: false };
  }
  return {
    snapshot: { ...snapshot, _cameraLinks: [...list, link] },
    added: true,
  };
}

/** Drop a camera link by id. Returns a new snapshot (unchanged when absent). */
export function removeCameraLink(
  snapshot: CameraLinksSnapshot,
  id: string,
): CameraLinksSnapshot {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const list = listCameraLinks(snapshot);
  const next = list.filter((l) => l.id !== id);
  if (next.length === list.length) return snapshot;
  return { ...snapshot, _cameraLinks: next };
}

/**
 * Update a single camera link's `dataUrl` / `broken` / `generatedAt`. Returns
 * a new snapshot (unchanged when the id is absent). Used by the live
 * re-render path after a debounced source-cell change.
 */
export function updateCameraLinkRender(
  snapshot: CameraLinksSnapshot,
  id: string,
  patch: { dataUrl: string; broken: boolean },
): CameraLinksSnapshot {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const list = listCameraLinks(snapshot);
  let hit = false;
  const next = list.map((l) => {
    if (l.id !== id) return l;
    hit = true;
    return {
      ...l,
      dataUrl: patch.dataUrl,
      broken: patch.broken,
      generatedAt: new Date().toISOString(),
    };
  });
  if (!hit) return snapshot;
  return { ...snapshot, _cameraLinks: next };
}

/**
 * Whether a camera link's source range still resolves against the snapshot.
 * "Resolves" = the source sheet still exists. (Cell deletion inside a live
 * sheet just yields a blank-cell snapshot, which is correct behaviour — only
 * a deleted sheet is a true #REF!.)
 */
export function isSourceResolvable(
  snapshot: { sheets?: Record<string, unknown> } | null | undefined,
  link: CameraLink,
): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const sheets = snapshot.sheets;
  if (!sheets || typeof sheets !== "object") return false;
  return Object.prototype.hasOwnProperty.call(sheets, link.sourceSheetId);
}

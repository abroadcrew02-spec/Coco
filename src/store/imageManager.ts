// Pure helpers for the workbook-wide Image Manager dialog. Surfaces every
// embedded xlsx image across every sheet so the user can audit / delete /
// export without hunting through anchors. Companion to imagePreviews.ts —
// reuses its parsing pipeline to derive listings, then layers on the
// snapshot-mutating helpers the bulk-manager UI needs.
//
// Snapshot shape (mirrors imagePreviews.ts):
//   {
//     sheetOrder?: string[],
//     sheets?: Record<sheetId, { name?: string } | undefined>,
//     _preservedParts?: {
//       parts?:     Record<string, base64-string>  // keyed by xlsx zip path
//       sheetRefs?: Array<{
//         drawingTarget?: string | null,
//         drawingRid?:    string | null,
//       } | null>                                 // indexed by sheet order
//     }
//   }
//
// Deletes mutate the drawing XML (strip the matching <xdr:twoCellAnchor> /
// <xdr:oneCellAnchor>) and remove the orphaned media part from `parts`.
// We don't touch the drawing rels — leaving the dangling rId there is
// harmless to xlsx readers (Excel ignores rIds with no consumer) and keeps
// the diff minimal so undo via snapshot replacement stays cheap.
//
// All mutators return a fresh snapshot object so the caller can JSON.stringify
// the result back into the workbook store while retaining the previous
// snapshot for undo. Kept side-effect free.

import {
  colRowToA1,
  computeImagePreviews,
  decodeBase64Utf8,
  extToMime,
  parseRels,
  resolveMediaPath,
  type ImagePreview,
} from "./imagePreviews";

/** Row shape consumed by the Image Manager table. */
export interface ImageListing {
  sheetId: string;
  sheetName: string;
  /** A1-style anchor cell (e.g. "B5"). Same `${sheetName}!${anchor}` convention as the preview panel. */
  anchor: string;
  /** Display name — filename from the media path (e.g. "image1.png"). */
  name: string;
  /** Decoded byte size of the embedded media. */
  sizeBytes: number;
  /** MIME type derived from the file extension. */
  mimeType: string;
  /** Original media path (e.g. "xl/media/image1.png") — used as the stable key for delete / export. */
  mediaPath: string;
  /** Base64 payload — only populated for export (kept off the table render to keep memory low). */
  bytesBase64: string;
  /** data: URL ready for thumbnail render. */
  src: string;
}

interface PreservedParts {
  parts?: Record<string, string>;
  sheetRefs?: Array<
    | {
        drawingTarget?: string | null;
        drawingRid?: string | null;
      }
    | null
  >;
}

interface ImageMgrSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, { name?: string } | undefined>;
  _preservedParts?: PreservedParts;
}

function parseSnapshot(input: unknown): ImageMgrSnapshot | null {
  if (input && typeof input === "object") return input as ImageMgrSnapshot;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as ImageMgrSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decode base64 to a byte length without materialising the Uint8Array. atob
 * is the standard fast path; we count via the decoded string's length (one
 * char per byte for binary). Returns 0 on malformed input.
 */
function base64ByteLength(b64: string): number {
  if (!b64) return 0;
  try {
    return atob(b64).length;
  } catch {
    // Cheap fallback: 4 base64 chars → 3 bytes, minus padding.
    const padding = (b64.match(/=+$/)?.[0] ?? "").length;
    return Math.floor((b64.length * 3) / 4) - padding;
  }
}

/**
 * Walks every sheet's embedded images and emits a flat `ImageListing[]`
 * suitable for table render. Re-uses computeImagePreviews so the parse
 * pipeline stays single-source-of-truth and any robustness fixes there
 * flow through automatically.
 *
 * Tolerates malformed snapshots (empty result). Returns rows in the same
 * (sheetOrder, drawing-order) order as the preview panel so the two views
 * stay visually aligned.
 */
export function listAllImages(
  snapshot: string | ImageMgrSnapshot | null | undefined,
): ImageListing[] {
  if (snapshot === null || snapshot === undefined) return [];
  // computeImagePreviews accepts a JSON string only; if we got an object,
  // re-serialise so the existing pipeline can parse it. Cheap relative to
  // the DOMParser walks that follow.
  const json = typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
  const parsed = parseSnapshot(snapshot);
  const previews: ImagePreview[] = computeImagePreviews(json);
  const partsMap = parsed?._preservedParts?.parts ?? {};
  const out: ImageListing[] = [];
  for (const p of previews) {
    const slash = p.mediaPath.lastIndexOf("/");
    const name = slash >= 0 ? p.mediaPath.slice(slash + 1) : p.mediaPath;
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1) : "";
    const b64 = partsMap[p.mediaPath] ?? "";
    out.push({
      sheetId: p.sheetId,
      sheetName: p.sheetName,
      anchor: colRowToA1(p.fromCol, p.fromRow),
      name,
      sizeBytes: base64ByteLength(b64),
      mimeType: extToMime(ext),
      mediaPath: p.mediaPath,
      bytesBase64: b64,
      src: p.src,
    });
  }
  return out;
}

/**
 * Returns the parsed snapshot object as-is when given an object, or after
 * a JSON.parse when given a string. Returns an empty stub when the input
 * can't be parsed so mutators below treat it as "nothing to do".
 */
function ensureSnapshot(
  snapshot: string | ImageMgrSnapshot | null | undefined,
): ImageMgrSnapshot {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || typeof parsed !== "object") return { sheets: {} };
  return { ...parsed };
}

/**
 * Walk a drawing XML and remove every anchor (twoCellAnchor / oneCellAnchor)
 * whose embedded media resolves to one of the target media paths. Returns
 * the serialised XML (or the original when no edits applied so we don't
 * pay XMLSerializer cost on a no-op) and the set of rels actually orphaned.
 */
function stripAnchorsForMedia(
  drawingXml: string,
  drawingPath: string,
  rels: Record<string, string>,
  targetMediaPaths: Set<string>,
): string {
  if (!drawingXml || targetMediaPaths.size === 0) return drawingXml;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(drawingXml, "text/xml");
  } catch {
    return drawingXml;
  }
  let mutated = false;
  for (const tag of ["twoCellAnchor", "oneCellAnchor"]) {
    const all: Element[] = [];
    const a = doc.getElementsByTagName(tag);
    const b = doc.getElementsByTagName(`xdr:${tag}`);
    for (let i = 0; i < a.length; i++) all.push(a[i]);
    for (let i = 0; i < b.length; i++) all.push(b[i]);
    for (const anchor of all) {
      const blip =
        anchor.getElementsByTagName("blip")[0] ??
        anchor.getElementsByTagName("a:blip")[0];
      if (!blip) continue;
      const rid =
        blip.getAttribute("r:embed") ?? blip.getAttribute("embed") ?? "";
      if (!rid) continue;
      const relTarget = rels[rid];
      if (!relTarget) continue;
      const mediaPath = resolveMediaPath(drawingPath, relTarget);
      if (targetMediaPaths.has(mediaPath)) {
        anchor.parentNode?.removeChild(anchor);
        mutated = true;
      }
    }
  }
  if (!mutated) return drawingXml;
  try {
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return drawingXml;
  }
}

/**
 * RFC-4648 base64 encoder over a UTF-8 string. Mirrors the renderer-side
 * encoder used elsewhere in the project (no `Buffer` in the browser bundle).
 */
function utf8ToBase64(s: string): string {
  // Browser-safe UTF-8 → base64: encode to bytes first, then base64 the bytes.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  try {
    return btoa(bin);
  } catch {
    return "";
  }
}

/**
 * Resolve the drawing part path that backs a given sheet index. Mirrors the
 * convention computeImagePreviews uses (drawingTarget is relative to
 * xl/worksheets/sheet.xml).
 */
function drawingPathForSheet(
  preservedParts: PreservedParts,
  sheetIdx: number,
): string | null {
  const ref = preservedParts.sheetRefs?.[sheetIdx];
  if (!ref || !ref.drawingTarget) return null;
  return resolveMediaPath("xl/worksheets/sheet.xml", ref.drawingTarget);
}

/**
 * Remove the image anchored at (sheetId, anchor) from the snapshot. Strips
 * the matching drawing anchor and deletes the orphaned media part. When the
 * target can't be located the returned snapshot is a no-op clone so callers
 * can diff without special-casing the miss.
 */
export function deleteImage(
  snapshot: string | ImageMgrSnapshot | null | undefined,
  sheetId: string,
  anchor: string,
): ImageMgrSnapshot {
  const out = ensureSnapshot(snapshot);
  const pp = out._preservedParts;
  if (!pp || !pp.parts || !Array.isArray(pp.sheetRefs)) return out;
  const sheetOrder = Array.isArray(out.sheetOrder) ? out.sheetOrder : [];
  const sheetIdx = sheetOrder.indexOf(sheetId);
  if (sheetIdx < 0) return out;
  const drawingPath = drawingPathForSheet(pp, sheetIdx);
  if (!drawingPath) return out;
  // Locate the matching listing to recover its mediaPath — cheaper than
  // re-walking the drawing XML in this helper and reusing the existing
  // listing pipeline keeps the lookup logic in one place.
  const listings = listAllImages(out);
  const target = listings.find((l) => l.sheetId === sheetId && l.anchor === anchor);
  if (!target) return out;
  const drawingB64 = pp.parts[drawingPath];
  if (!drawingB64) return out;
  const drawingXml = decodeBase64Utf8(drawingB64);
  if (!drawingXml) return out;
  const slash = drawingPath.lastIndexOf("/");
  const drawingDir = slash >= 0 ? drawingPath.slice(0, slash) : "";
  const drawingFile = slash >= 0 ? drawingPath.slice(slash + 1) : drawingPath;
  const relsPath = `${drawingDir}/_rels/${drawingFile}.rels`;
  const relsB64 = pp.parts[relsPath];
  const relsXml = relsB64 ? decodeBase64Utf8(relsB64) ?? "" : "";
  const rels = parseRels(relsXml);
  const targets = new Set<string>([target.mediaPath]);
  const newXml = stripAnchorsForMedia(drawingXml, drawingPath, rels, targets);
  const nextParts: Record<string, string> = { ...pp.parts };
  if (newXml !== drawingXml) {
    const reEncoded = utf8ToBase64(newXml);
    if (reEncoded) nextParts[drawingPath] = reEncoded;
  }
  delete nextParts[target.mediaPath];
  out._preservedParts = { ...pp, parts: nextParts };
  return out;
}

/**
 * Strip every image anchored on the given sheet. Returns the mutated
 * snapshot plus the deleted count so the UI can surface a confirmation
 * toast ("シート X の画像 N 枚を削除しました").
 */
export function bulkDeleteImagesOnSheet(
  snapshot: string | ImageMgrSnapshot | null | undefined,
  sheetId: string,
): { snapshotMutated: ImageMgrSnapshot; deletedCount: number } {
  const out = ensureSnapshot(snapshot);
  const pp = out._preservedParts;
  if (!pp || !pp.parts || !Array.isArray(pp.sheetRefs)) {
    return { snapshotMutated: out, deletedCount: 0 };
  }
  const sheetOrder = Array.isArray(out.sheetOrder) ? out.sheetOrder : [];
  const sheetIdx = sheetOrder.indexOf(sheetId);
  if (sheetIdx < 0) return { snapshotMutated: out, deletedCount: 0 };
  const drawingPath = drawingPathForSheet(pp, sheetIdx);
  if (!drawingPath) return { snapshotMutated: out, deletedCount: 0 };
  const listings = listAllImages(out).filter((l) => l.sheetId === sheetId);
  if (listings.length === 0) {
    return { snapshotMutated: out, deletedCount: 0 };
  }
  const drawingB64 = pp.parts[drawingPath];
  if (!drawingB64) return { snapshotMutated: out, deletedCount: 0 };
  const drawingXml = decodeBase64Utf8(drawingB64);
  if (!drawingXml) return { snapshotMutated: out, deletedCount: 0 };
  const slash = drawingPath.lastIndexOf("/");
  const drawingDir = slash >= 0 ? drawingPath.slice(0, slash) : "";
  const drawingFile = slash >= 0 ? drawingPath.slice(slash + 1) : drawingPath;
  const relsPath = `${drawingDir}/_rels/${drawingFile}.rels`;
  const relsB64 = pp.parts[relsPath];
  const relsXml = relsB64 ? decodeBase64Utf8(relsB64) ?? "" : "";
  const rels = parseRels(relsXml);
  const targets = new Set(listings.map((l) => l.mediaPath));
  const newXml = stripAnchorsForMedia(drawingXml, drawingPath, rels, targets);
  const nextParts: Record<string, string> = { ...pp.parts };
  if (newXml !== drawingXml) {
    const reEncoded = utf8ToBase64(newXml);
    if (reEncoded) nextParts[drawingPath] = reEncoded;
  }
  for (const mp of targets) delete nextParts[mp];
  out._preservedParts = { ...pp, parts: nextParts };
  return { snapshotMutated: out, deletedCount: listings.length };
}

/**
 * Write a base64-encoded image to disk at `targetPath`. Decodes via atob
 * → Uint8Array, then asks the runtime's fs plugin to persist the bytes.
 * Mirrors the export pattern used by CommentsManagerDialog (which writes
 * text), except the payload is a binary numeric array per the Tauri 2 fs
 * plugin convention.
 *
 * Caller is responsible for picking the target path via the save dialog —
 * this helper just performs the byte write so it can be reused from any
 * caller (Image Manager, future drag-export, etc.).
 *
 * Lazy-imports `@tauri-apps/api/core` so unit tests that don't stub Tauri
 * can still import the module without blowing up.
 */
export async function exportImageToFile(
  _name: string,
  bytesBase64: string,
  targetPath: string,
): Promise<void> {
  if (!targetPath) throw new Error("EMPTY_TARGET_PATH");
  if (!bytesBase64) throw new Error("EMPTY_PAYLOAD");
  // Pass the base64 string straight to the backend — the Rust command
  // (write_file_bytes_base64) re-decodes and verifies the magic bytes,
  // matching the read_file_bytes_base64 protections. Avoids dragging in
  // @tauri-apps/plugin-fs just for one binary write.
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_file_bytes_base64", {
    path: targetPath,
    base64: bytesBase64,
  });
}

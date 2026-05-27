// Pure helpers for surfacing embedded xlsx images out of a Univer workbook
// snapshot. Used by the in-grid image preview panel (EditorScreen) so users
// can see image anchors without leaving the app — the Univer 0.5.x facade
// has no decoration/pixel API for live in-cell image rendering, so we lean
// on the same DOM-overlay-as-sidebar pattern that CommentIndicatorsPanel
// uses.
//
// `_preservedParts` shape (mirrors xlsx_io.rs):
//   {
//     parts:     Record<string, base64-string>  // keyed by xlsx zip path
//                                               // e.g. "xl/media/image1.png",
//                                               //      "xl/drawings/drawing1.xml",
//                                               //      "xl/drawings/_rels/drawing1.xml.rels"
//     sheetRefs: Array<{
//       drawingRid?:    string | null,
//       drawingTarget?: string | null,   // e.g. "../drawings/drawing1.xml"
//       pivotRels?:     unknown,
//     } | null>                          // indexed by sheetOrder position
//   }
//
// Each `<xdr:twoCellAnchor>` inside the drawing XML carries an `<xdr:from>`
// (col/row pair the image is anchored to) and a `<xdr:pic>` whose
// `<a:blip r:embed="rIdN"/>` resolves via the sibling `_rels/*.xml.rels` to
// a `xl/media/imageN.<ext>` part. Decoding that base64 yields a renderable
// `data:image/<ext>;base64,...` URL.

export interface ImagePreview {
  /** Sheet id (matches `sheetOrder[i]`). */
  sheetId: string;
  /** Display name for the sheet — falls back to sheetId. */
  sheetName: string;
  /** 0-based anchor column from `<xdr:from><xdr:col>`. */
  fromCol: number;
  /** 0-based anchor row from `<xdr:from><xdr:row>`. */
  fromRow: number;
  /** Optional 0-based bottom-right anchor — present for twoCellAnchor. */
  toCol?: number;
  toRow?: number;
  /** `data:image/<ext>;base64,...` ready to drop into an <img src>. */
  src: string;
  /** Original media path (e.g. `xl/media/image1.png`) for diagnostics. */
  mediaPath: string;
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

interface InGridImageEntry {
  base64: string;
  ext: string;
  anchorRow: number;
  anchorCol: number;
  widthPx: number;
  heightPx: number;
  name?: string;
  mediaPath?: string;
}

interface ImageSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, { name?: string; _images?: InGridImageEntry[] } | undefined>;
  _preservedParts?: PreservedParts;
}

/**
 * Decode a base64 xlsx part back to a UTF-8 string. xlsx_io.rs uses the
 * standard RFC 4648 alphabet with `=` padding, so atob is a direct match.
 * Returns null on malformed input so callers can skip the part instead of
 * crashing the panel.
 */
export function decodeBase64Utf8(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parse a drawing rels XML and return { rId -> Target }. Targets are kept
 * verbatim (typically a relative path like `../media/image1.png`).
 *
 * Tolerates malformed XML by returning an empty map — the panel then just
 * skips that drawing instead of crashing.
 */
export function parseRels(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return out;
  }
  const rels = doc.getElementsByTagName("Relationship");
  for (let i = 0; i < rels.length; i++) {
    const el = rels[i];
    const id = el.getAttribute("Id");
    const target = el.getAttribute("Target");
    if (id && target) out[id] = target;
  }
  return out;
}

/**
 * Resolve a rels Target (e.g. `../media/image1.png`) against the drawing
 * part path (e.g. `xl/drawings/drawing1.xml`) and return the canonical
 * media path (`xl/media/image1.png`). Handles the typical `../foo/bar`
 * relative form OOXML emits. Falls back to a best-effort join when the
 * target is already absolute-ish.
 */
export function resolveMediaPath(
  drawingPartPath: string,
  relTarget: string,
): string {
  if (!relTarget) return "";
  // Already an absolute xlsx path.
  if (relTarget.startsWith("xl/") || relTarget.startsWith("/xl/")) {
    return relTarget.replace(/^\/+/, "");
  }
  const drawDir = drawingPartPath.includes("/")
    ? drawingPartPath.slice(0, drawingPartPath.lastIndexOf("/"))
    : "";
  const parts = drawDir.split("/").filter(Boolean);
  const segs = relTarget.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Parse the `<xdr:from>` (and `<xdr:to>` when present) from a single
 * twoCellAnchor element. Returns null when col/row aren't both present —
 * absoluteAnchor / oneCellAnchor without a from block are skipped because
 * we have no canvas pixel coords to anchor against anyway.
 */
export function parseAnchor(
  anchor: Element,
): {
  fromCol: number;
  fromRow: number;
  toCol?: number;
  toRow?: number;
} | null {
  const readPair = (tag: string): [number, number] | null => {
    const els = anchor.getElementsByTagName(tag);
    // `getElementsByTagName` is namespace-agnostic in text/xml mode, but
    // the actual element name in the source is `xdr:from`/`xdr:to`. Try
    // both — happy-dom and browsers handle this differently.
    let el: Element | undefined = els[0];
    if (!el) {
      // Fall back to a manual scan: getElementsByTagName with prefix.
      const all = anchor.getElementsByTagName(`xdr:${tag}`);
      el = all[0];
    }
    if (!el) return null;
    const colEl =
      el.getElementsByTagName("col")[0] ??
      el.getElementsByTagName("xdr:col")[0];
    const rowEl =
      el.getElementsByTagName("row")[0] ??
      el.getElementsByTagName("xdr:row")[0];
    if (!colEl || !rowEl) return null;
    const col = parseInt(colEl.textContent ?? "", 10);
    const row = parseInt(rowEl.textContent ?? "", 10);
    if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
    return [col, row];
  };
  const from = readPair("from");
  if (!from) return null;
  const to = readPair("to");
  const out: {
    fromCol: number;
    fromRow: number;
    toCol?: number;
    toRow?: number;
  } = { fromCol: from[0], fromRow: from[1] };
  if (to) {
    out.toCol = to[0];
    out.toRow = to[1];
  }
  return out;
}

/**
 * Map a file extension (lowercased) to the MIME type that goes into a
 * `data:` URL. xlsx ships a small fixed set; anything else falls back to
 * `application/octet-stream` so the browser at least tries.
 */
export function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/**
 * Walk every sheet's drawing XML and emit one ImagePreview per
 * `<xdr:twoCellAnchor>` that has both a resolvable from-anchor and a
 * resolvable embedded media part.
 *
 * Priority: reads from sheets[id]._images (new #312 path) first. Falls back
 * to the legacy _preservedParts drawing XML path for images that came in via
 * xlsx import before #312 was deployed.
 *
 * Tolerates: missing _preservedParts, missing parts map, missing
 * sheetRefs, broken base64, malformed XML, dangling rIds, and absent
 * media files. In every failure case the offending anchor is silently
 * skipped — the panel never throws.
 */
export function computeImagePreviews(
  snapshotJson: string | null | undefined,
): ImagePreview[] {
  if (!snapshotJson) return [];
  let parsed: ImageSnapshot;
  try {
    parsed = JSON.parse(snapshotJson) as ImageSnapshot;
  } catch {
    return [];
  }

  const sheetOrder = Array.isArray(parsed.sheetOrder) ? parsed.sheetOrder : [];
  const sheets = parsed.sheets ?? {};
  const out: ImagePreview[] = [];

  // --- Path 1: _images entries (new #312 in-grid flow) ---
  for (const sheetId of sheetOrder) {
    const sheetEntry = sheets[sheetId];
    if (!sheetEntry) continue;
    const sheetName =
      typeof sheetEntry.name === "string" && sheetEntry.name
        ? sheetEntry.name
        : sheetId;
    const images = sheetEntry._images;
    if (!Array.isArray(images) || images.length === 0) continue;
    for (const img of images) {
      if (!img || typeof img !== "object") continue;
      if (typeof img.anchorRow !== "number" || typeof img.anchorCol !== "number") continue;
      if (!img.base64 || !img.ext) continue;
      const mime = extToMime(img.ext);
      out.push({
        sheetId,
        sheetName,
        fromCol: img.anchorCol,
        fromRow: img.anchorRow,
        src: `data:${mime};base64,${img.base64}`,
        mediaPath: img.mediaPath ?? "",
      });
    }
  }

  // --- Path 2: _preservedParts fallback (legacy xlsx-imported images) ---
  const pp = parsed._preservedParts;
  if (!pp || typeof pp !== "object") return out;
  const parts = pp.parts;
  const sheetRefs = pp.sheetRefs;
  if (!parts || !Array.isArray(sheetRefs)) return out;

  for (let i = 0; i < sheetRefs.length; i++) {
    const ref = sheetRefs[i];
    if (!ref || !ref.drawingTarget) continue;
    const sheetId = sheetOrder[i] ?? "";
    if (!sheetId) continue;
    const sheetEntry = sheets[sheetId];
    const sheetName =
      sheetEntry && typeof sheetEntry.name === "string" && sheetEntry.name
        ? sheetEntry.name
        : sheetId;

    // drawingTarget is relative to xl/worksheets/, e.g.
    // "../drawings/drawing1.xml" → canonical "xl/drawings/drawing1.xml".
    const drawingPath = resolveMediaPath(
      "xl/worksheets/sheet.xml",
      ref.drawingTarget,
    );
    const drawingB64 = parts[drawingPath];
    if (!drawingB64) continue;
    const drawingXml = decodeBase64Utf8(drawingB64);
    if (!drawingXml) continue;

    // Drawing rels: xl/drawings/drawing1.xml → xl/drawings/_rels/drawing1.xml.rels
    const slash = drawingPath.lastIndexOf("/");
    const drawingDir = slash >= 0 ? drawingPath.slice(0, slash) : "";
    const drawingFile = slash >= 0 ? drawingPath.slice(slash + 1) : drawingPath;
    const relsPath = `${drawingDir}/_rels/${drawingFile}.rels`;
    const relsB64 = parts[relsPath];
    const relsXml = relsB64 ? decodeBase64Utf8(relsB64) ?? "" : "";
    const rels = parseRels(relsXml);

    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(drawingXml, "text/xml");
    } catch {
      continue;
    }

    // Walk every twoCellAnchor. We accept both `twoCellAnchor` and
    // `oneCellAnchor` — both share the `<xdr:from>` shape.
    const anchorTags = ["twoCellAnchor", "oneCellAnchor"];
    for (const tag of anchorTags) {
      const elsA = doc.getElementsByTagName(tag);
      const elsB = doc.getElementsByTagName(`xdr:${tag}`);
      const all: Element[] = [];
      for (let k = 0; k < elsA.length; k++) all.push(elsA[k]);
      for (let k = 0; k < elsB.length; k++) all.push(elsB[k]);

      for (const anchor of all) {
        const pos = parseAnchor(anchor);
        if (!pos) continue;

        // Find the embed rId. `<a:blip r:embed="rIdN"/>` lives inside
        // `<xdr:pic>/<xdr:blipFill>/<a:blip>`.
        const blipA = anchor.getElementsByTagName("blip");
        const blipB = anchor.getElementsByTagName("a:blip");
        const blip = blipA[0] ?? blipB[0];
        if (!blip) continue;
        const rid =
          blip.getAttribute("r:embed") ?? blip.getAttribute("embed") ?? "";
        if (!rid) continue;
        const target = rels[rid];
        if (!target) continue;
        const mediaPath = resolveMediaPath(drawingPath, target);
        const mediaB64 = parts[mediaPath];
        if (!mediaB64) continue;
        const dot = mediaPath.lastIndexOf(".");
        const ext = dot >= 0 ? mediaPath.slice(dot + 1) : "";
        const mime = extToMime(ext);
        out.push({
          sheetId,
          sheetName,
          fromCol: pos.fromCol,
          fromRow: pos.fromRow,
          toCol: pos.toCol,
          toRow: pos.toRow,
          src: `data:${mime};base64,${mediaB64}`,
          mediaPath,
        });
      }
    }
  }
  return out;
}

/**
 * Convert a (col, row) anchor pair to an A1-style cell reference for
 * display. 0-based input — col 0 / row 0 yields "A1".
 */
export function colRowToA1(col: number, row: number): string {
  let n = col;
  let letters = "";
  while (true) {
    const rem = n % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return `${letters}${row + 1}`;
}

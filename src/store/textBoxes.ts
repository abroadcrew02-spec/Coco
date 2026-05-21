// Pure helpers for the floating "text box" overlay introduced for issue #146.
// We deliberately keep the in-memory representation OUT of `_preservedParts`
// (which is a byte-for-byte mirror of the source xlsx parts and is treated as
// opaque by the Univer snapshot pipeline). Instead, text boxes live under a
// top-level `_textBoxes` array on the snapshot. The xlsx export hook serialises
// them into `<xdr:sp>` anchors inside the sheet's drawing XML at save time —
// see `serializeTextBoxesToDrawingXml` below.
//
// Snapshot shape (additive):
//   {
//     sheetOrder?: string[],
//     sheets?:     Record<sheetId, { name?: string } | undefined>,
//     _textBoxes?: TextBox[],
//     _preservedParts?: { ... }   // unchanged
//   }
//
// Rationale for an array (not a per-sheet map) keyed by `sheetId`: matches the
// existing pattern used by `_preservedParts.sheetRefs` walks, keeps the per-id
// reduce / filter operations the UI needs (delete, list, update) trivial, and
// avoids the merge headaches that the `Record<sheetId, TextBox[]>` shape would
// introduce when sheets get renamed/cloned.
//
// All mutators return a fresh snapshot object so callers can JSON.stringify
// it back into the workbook store without losing the prior snapshot for undo.
// Kept side-effect free.

/**
 * Shape kind (#188). `textbox` is the original #146 MVP shape; `rect`,
 * `ellipse` and `line` are autoshapes added by #188. The kind maps directly
 * onto the OOXML `<a:prstGeom prst="...">` preset so the xlsx round-trip is a
 * pure preset swap on the shared `<xdr:sp>` writer — see `buildTextBoxAnchorXml`.
 * Optional on the wire: snapshots written by #146 carry no `type`, so absence
 * is treated as `"textbox"` everywhere.
 */
export type ShapeKind = "textbox" | "rect" | "ellipse" | "line";

export interface TextBox {
  /** Stable id — generated client-side, persists across saves. */
  id: string;
  /**
   * Shape kind (#188). Absent → `"textbox"` for #146 back-compat.
   * `textbox`/`rect`/`ellipse` carry a `<xdr:txBody>`; `line` is geometry-only.
   */
  type?: ShapeKind;
  /**
   * Optional group id (#188). All shapes sharing a `groupId` are emitted
   * inside one `<xdr:grpSp>` so Excel treats them as a single moveable unit.
   * Absent → the shape is standalone.
   */
  groupId?: string;
  /** Target sheet id. Must match an entry in `sheetOrder`. */
  sheetId: string;
  /** 0-based anchor column (top-left). */
  x: number;
  /** 0-based anchor row (top-left). */
  y: number;
  /** Width in column units (cells). Minimum 1. */
  w: number;
  /** Height in row units (cells). Minimum 1. */
  h: number;
  /** Display text. May contain newlines. */
  text: string;
  /** CSS font-family. Empty string → caller falls back to the workbook default. */
  fontFamily: string;
  /** Font size in points. Sensible range: 6..72. */
  fontSize: number;
  /** Text color (CSS `#rrggbb`). */
  color: string;
  /** Background fill color (CSS `#rrggbb` or "transparent"). */
  backgroundColor: string;
  /** Border color (CSS `#rrggbb` or "transparent"). */
  borderColor: string;
}

interface TextBoxSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, { name?: string } | undefined>;
  // Permissive: callers (.coco files, unit-test fixtures, malformed snapshots)
  // may carry partial / wrongly-typed entries here. `listTextBoxes` validates
  // each entry before exposing it to the rest of the app.
  _textBoxes?: unknown[];
}

/** Parse JSON or pass through an already-parsed object. Returns null on garbage. */
function parseSnapshot(input: unknown): TextBoxSnapshot | null {
  if (input && typeof input === "object") return input as TextBoxSnapshot;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as TextBoxSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

/** Empty-input safe getter. Returns [] when the snapshot has no `_textBoxes`. */
export function listTextBoxes(
  snapshot: string | TextBoxSnapshot | null | undefined,
): TextBox[] {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || !Array.isArray(parsed._textBoxes)) return [];
  // Defensive copy + shape-validate. We drop entries with missing required
  // fields so a malformed `.coco` file can't crash the panel.
  const out: TextBox[] = [];
  for (const raw of parsed._textBoxes) {
    if (!raw || typeof raw !== "object") continue;
    const tb = raw as Record<string, unknown>;
    if (typeof tb.id !== "string" || !tb.id) continue;
    if (typeof tb.sheetId !== "string" || !tb.sheetId) continue;
    const x = typeof tb.x === "number" ? tb.x : NaN;
    const y = typeof tb.y === "number" ? tb.y : NaN;
    const w = typeof tb.w === "number" ? tb.w : NaN;
    const h = typeof tb.h === "number" ? tb.h : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    const kind: ShapeKind =
      tb.type === "rect" || tb.type === "ellipse" || tb.type === "line"
        ? tb.type
        : "textbox";
    out.push({
      id: tb.id,
      type: kind,
      ...(typeof tb.groupId === "string" && tb.groupId
        ? { groupId: tb.groupId }
        : {}),
      sheetId: tb.sheetId,
      x: Math.max(0, Math.floor(x)),
      y: Math.max(0, Math.floor(y)),
      w: Math.max(1, Math.floor(w)),
      h: Math.max(1, Math.floor(h)),
      text: typeof tb.text === "string" ? tb.text : "",
      fontFamily: typeof tb.fontFamily === "string" ? tb.fontFamily : "",
      fontSize:
        typeof tb.fontSize === "number" && Number.isFinite(tb.fontSize)
          ? tb.fontSize
          : 11,
      color: typeof tb.color === "string" ? tb.color : "#000000",
      backgroundColor:
        typeof tb.backgroundColor === "string" ? tb.backgroundColor : "#ffffff",
      borderColor:
        typeof tb.borderColor === "string" ? tb.borderColor : "#000000",
    });
  }
  return out;
}

/** Filter to a single sheet. Convenience wrapper around `listTextBoxes`. */
export function listTextBoxesForSheet(
  snapshot: string | TextBoxSnapshot | null | undefined,
  sheetId: string,
): TextBox[] {
  return listTextBoxes(snapshot).filter((tb) => tb.sheetId === sheetId);
}

/**
 * Generate a stable text-box id. Format `tb_<timestamp>_<rand>` so it sorts
 * by insertion order and stays unique across rapid inserts. crypto.randomUUID
 * would also work but isn't available in every Tauri webview build, and the
 * timestamp prefix is handy for debugging.
 */
export function makeTextBoxId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `tb_${ts}_${rand}`;
}

/**
 * Returns a fresh snapshot object with `tb` appended to `_textBoxes`. The
 * caller is responsible for ensuring `tb.id` is unique — typically by minting
 * via `makeTextBoxId`. Idempotent on duplicate ids: replaces in place.
 */
export function addTextBox(
  snapshot: string | TextBoxSnapshot | null | undefined,
  tb: TextBox,
): TextBoxSnapshot {
  const parsed = parseSnapshot(snapshot) ?? {};
  const existing = Array.isArray(parsed._textBoxes) ? parsed._textBoxes : [];
  const filtered = existing.filter(
    (t) => !t || typeof t !== "object" || (t as { id?: unknown }).id !== tb.id,
  );
  return { ...parsed, _textBoxes: [...filtered, tb] };
}

/**
 * Remove a text box by id. No-op when the id isn't present. Returns a fresh
 * snapshot — never the same object reference — so React/Zustand selectors
 * trigger updates.
 */
export function deleteTextBox(
  snapshot: string | TextBoxSnapshot | null | undefined,
  id: string,
): TextBoxSnapshot {
  const parsed = parseSnapshot(snapshot) ?? {};
  const existing = Array.isArray(parsed._textBoxes) ? parsed._textBoxes : [];
  return {
    ...parsed,
    _textBoxes: existing.filter(
      (t) => !t || typeof t !== "object" || (t as { id?: unknown }).id !== id,
    ),
  };
}

/**
 * Update fields on an existing text box. Returns a no-op fresh snapshot
 * when the id isn't present so callers can `JSON.stringify` and diff
 * without special-casing the miss.
 */
export function updateTextBox(
  snapshot: string | TextBoxSnapshot | null | undefined,
  id: string,
  patch: Partial<Omit<TextBox, "id">>,
): TextBoxSnapshot {
  const parsed = parseSnapshot(snapshot) ?? {};
  const existing = Array.isArray(parsed._textBoxes) ? parsed._textBoxes : [];
  const next = existing.map((t) =>
    t && typeof t === "object" && (t as { id?: unknown }).id === id
      ? { ...(t as Record<string, unknown>), ...patch }
      : t,
  );
  return { ...parsed, _textBoxes: next };
}

/**
 * Single-cell A1 ref → 0-based (col, row). Returns null on malformed input.
 * Same regex shape used by InsertImageDialog so the two dialogs validate
 * anchors identically.
 */
export function a1ToColRow(
  a1: string,
): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]+)\$?([1-9]\d*)$/.exec(a1.trim());
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

/**
 * 0-based (col, row) → A1. Duplicated from imagePreviews.ts to keep the
 * text-box module self-contained — same algorithm, kept inline so callers
 * don't pull the imagePreviews surface in.
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

/**
 * Escape a string for embedding as XML text. Mirrors the minimal escape set
 * required by OOXML — the five canonical entities. Used by the xlsx-export
 * helper below; kept exported so callers writing their own drawing XML can
 * reuse it without duplicating the table.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Map a shape kind to its OOXML `<a:prstGeom>` preset name. */
function prstForKind(kind: ShapeKind | undefined): string {
  switch (kind) {
    case "ellipse":
      return "ellipse";
    case "line":
      return "line";
    case "rect":
    case "textbox":
    default:
      return "rect";
  }
}

/** EMU per cell unit — drawing coordinates use one column/row width per cell. */
const EMU_PER_CELL = 914400;

/**
 * Explicit `<a:xfrm>` geometry for a shape, in EMU. Standalone shapes pass
 * `null` (Excel re-lays them from the `twoCellAnchor` from/to cells, so a
 * zeroed xfrm is fine); grouped child shapes MUST pass real off/ext because
 * `<xdr:grpSp>` children are positioned inside the group's child coordinate
 * space and a zeroed ext collapses them to an invisible point (#188 M2).
 */
interface ShapeXfrm {
  offX: number;
  offY: number;
  extCx: number;
  extCy: number;
}

/**
 * Build the `<xdr:sp>` element for a shape. Shared by the standalone-anchor
 * and grouped-shape writers (#188): grouping only changes the enclosing
 * envelope, not the shape body. `cNvId` becomes the OOXML `cNvPr@id`, which
 * must be unique within one drawing part.
 *
 * `xfrm` is the explicit `<a:xfrm>` geometry: `null` for standalone shapes
 * (Excel re-lays from the anchor), a real off/ext for grouped children so
 * they don't collapse to the group origin.
 *
 * Kind handling:
 *  - `textbox`/`rect`/`ellipse`: closed geometry + fill + border + a
 *    `<xdr:txBody>` (text optional — empty text still produces a valid body).
 *  - `line`: open geometry, no fill, no txBody; the border color/width drives
 *    the visible stroke, with a triangle arrowhead on the tail end.
 */
function buildShapeSpXml(
  tb: TextBox,
  cNvId: number,
  xfrm: ShapeXfrm | null,
): string {
  const kind: ShapeKind = tb.type ?? "textbox";
  const isLine = kind === "line";
  const isTextBox = kind === "textbox";
  const fontPt = Math.max(1, Math.floor(tb.fontSize));
  // OOXML font size unit is hundredths of a point.
  const fontSz = fontPt * 100;
  const color = (tb.color || "#000000").replace(/^#/, "");
  const bg = (tb.backgroundColor || "").replace(/^#/, "");
  const border = (tb.borderColor || "").replace(/^#/, "");
  const fillXml = isLine
    ? `<a:noFill/>`
    : tb.backgroundColor && tb.backgroundColor !== "transparent" && bg
      ? `<a:solidFill><a:srgbClr val="${bg}"/></a:solidFill>`
      : `<a:noFill/>`;
  // Lines need a visible stroke even when borderColor is unset → fall back to
  // black so an inserted arrow is never invisible. Arrowheads only on lines.
  const lineStroke =
    tb.borderColor && tb.borderColor !== "transparent" && border
      ? border
      : isLine
        ? "000000"
        : "";
  const lineXml = lineStroke
    ? `<a:ln w="${isLine ? 19050 : 9525}"><a:solidFill><a:srgbClr val="${lineStroke}"/></a:solidFill>` +
      (isLine ? `<a:tailEnd type="triangle"/>` : ``) +
      `</a:ln>`
    : `<a:ln><a:noFill/></a:ln>`;
  const fontAttr = tb.fontFamily
    ? `<a:latin typeface="${escapeXml(tb.fontFamily)}"/>`
    : "";
  // Split user text on '\n' so each line becomes its own `<a:p>` paragraph —
  // Excel honours paragraph breaks, soft line breaks (`<a:br/>`) work too
  // but paragraph-per-line is what Excel itself emits when you press Enter.
  const lines = (tb.text || "").split(/\r?\n/);
  const paragraphs = lines
    .map((line) => {
      if (!line) return `<a:p><a:endParaRPr lang="en-US" sz="${fontSz}"/></a:p>`;
      return (
        `<a:p>` +
        `<a:r>` +
        `<a:rPr lang="en-US" sz="${fontSz}">` +
        `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
        fontAttr +
        `</a:rPr>` +
        `<a:t>${escapeXml(line)}</a:t>` +
        `</a:r>` +
        `</a:p>`
      );
    })
    .join("");
  // Lines carry no text; rect/ellipse may carry text but aren't text boxes.
  const txBodyXml = isLine
    ? ``
    : `<xdr:txBody>` +
      `<a:bodyPr wrap="square" rtlCol="0" anchor="t"/>` +
      `<a:lstStyle/>` +
      paragraphs +
      `</xdr:txBody>`;
  const namePrefix = isTextBox
    ? "TextBox"
    : kind === "rect"
      ? "Rectangle"
      : kind === "ellipse"
        ? "Oval"
        : "Line";
  const off = xfrm
    ? { x: xfrm.offX, y: xfrm.offY }
    : { x: 0, y: 0 };
  const ext = xfrm
    ? { cx: xfrm.extCx, cy: xfrm.extCy }
    : { cx: 0, cy: 0 };
  return (
    `<xdr:sp macro="" textlink="">` +
    `<xdr:nvSpPr>` +
    `<xdr:cNvPr id="${cNvId}" name="${namePrefix} ${escapeXml(tb.id)}"/>` +
    `<xdr:cNvSpPr${isTextBox ? ` txBox="1"` : ``}/>` +
    `</xdr:nvSpPr>` +
    `<xdr:spPr>` +
    `<a:xfrm><a:off x="${off.x}" y="${off.y}"/><a:ext cx="${ext.cx}" cy="${ext.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${prstForKind(kind)}"><a:avLst/></a:prstGeom>` +
    fillXml +
    lineXml +
    `</xdr:spPr>` +
    txBodyXml +
    `</xdr:sp>`
  );
}

/**
 * Build a single `<xdr:twoCellAnchor>` element containing an `<xdr:sp>` shape
 * for the supplied text box / autoshape. The anchor is column/row cell-based
 * (matching the image insert path) so Excel reflows it correctly when columns
 * are resized. Coordinates are 0-based.
 *
 * Fill / border / font are applied inline so Excel renders without needing a
 * theme lookup. The geometry preset is derived from `tb.type` (#188): `rect`,
 * `ellipse`, `line`, or `rect` for the original text box.
 *
 * Rationale for not using `<xdr:absoluteAnchor>`: cells move; a pixel anchor
 * would drift relative to the data the user placed it next to.
 *
 * `cNvId` is the OOXML `cNvPr@id` for the shape — must be unique within the
 * drawing part. Defaults to `2` for back-compat with callers that don't
 * thread an id counter, but `serializeShapesToAnchors` always supplies a
 * fresh unique id so multi-shape sheets stay OOXML-valid (#188 M1).
 */
export function buildTextBoxAnchorXml(tb: TextBox, cNvId = 2): string {
  const fromCol = Math.max(0, Math.floor(tb.x));
  const fromRow = Math.max(0, Math.floor(tb.y));
  const toCol = fromCol + Math.max(1, Math.floor(tb.w));
  const toRow = fromRow + Math.max(1, Math.floor(tb.h));
  return (
    `<xdr:twoCellAnchor editAs="oneCell">` +
    `<xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    buildShapeSpXml(tb, cNvId, null) +
    `<xdr:clientData/>` +
    `</xdr:twoCellAnchor>`
  );
}

/**
 * Build a `<xdr:twoCellAnchor>` whose body is a `<xdr:grpSp>` group (#188)
 * wrapping every shape that shares a `groupId`. The group anchor spans the
 * bounding box of its members so Excel moves them together.
 *
 * Child shape coordinates inside the group are expressed in the group's own
 * child coordinate space (`<a:chOff>`/`<a:chExt>`), which we set 1:1 with the
 * EMU extent. Each child `<xdr:sp>` therefore carries a *real* `<a:xfrm>`
 * off/ext (relative to the group's top-left, in EMU): grouped children are
 * NOT re-laid from the anchor, so a zeroed ext would collapse them all to the
 * group origin and make them invisible (#188 M2).
 *
 * `startCNvId` is the first OOXML `cNvPr@id` to hand out; the group element
 * itself takes `startCNvId` and each child takes a subsequent value so every
 * id is unique within the drawing part (#188 M1). Returns the XML plus the
 * next free id so callers can keep numbering across multiple anchors.
 *
 * Members must be non-empty; callers group only when `.length > 1`.
 */
export function buildGroupAnchorXml(
  members: TextBox[],
  groupId: string,
  startCNvId = 1,
): { xml: string; nextCNvId: number } {
  // Bounding box across all members, in cell units.
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (const m of members) {
    const c = Math.max(0, Math.floor(m.x));
    const r = Math.max(0, Math.floor(m.y));
    minCol = Math.min(minCol, c);
    minRow = Math.min(minRow, r);
    maxCol = Math.max(maxCol, c + Math.max(1, Math.floor(m.w)));
    maxRow = Math.max(maxRow, r + Math.max(1, Math.floor(m.h)));
  }
  if (!Number.isFinite(minCol)) {
    // Defensive — should not happen for a non-empty member list.
    minCol = 0;
    minRow = 0;
    maxCol = 1;
    maxRow = 1;
  }
  // Child coordinate space — EMU extent of the bounding box. chOff/chExt match
  // the group ext for a 1:1 mapping, so child off/ext are absolute EMU within
  // the group measured from the group's top-left cell.
  const cx = Math.max(1, maxCol - minCol) * EMU_PER_CELL;
  const cy = Math.max(1, maxRow - minRow) * EMU_PER_CELL;
  const groupCNvId = startCNvId;
  let nextCNvId = startCNvId + 1;
  const children = members
    .map((m) => {
      const c = Math.max(0, Math.floor(m.x));
      const r = Math.max(0, Math.floor(m.y));
      const xfrm: ShapeXfrm = {
        // Position relative to the group's top-left cell, in EMU.
        offX: (c - minCol) * EMU_PER_CELL,
        offY: (r - minRow) * EMU_PER_CELL,
        extCx: Math.max(1, Math.floor(m.w)) * EMU_PER_CELL,
        extCy: Math.max(1, Math.floor(m.h)) * EMU_PER_CELL,
      };
      return buildShapeSpXml(m, nextCNvId++, xfrm);
    })
    .join("");
  const xml =
    `<xdr:twoCellAnchor editAs="oneCell">` +
    `<xdr:from><xdr:col>${minCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${minRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${maxCol}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${maxRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:grpSp>` +
    `<xdr:nvGrpSpPr>` +
    `<xdr:cNvPr id="${groupCNvId}" name="Group ${escapeXml(groupId)}"/>` +
    `<xdr:cNvGrpSpPr/>` +
    `</xdr:nvGrpSpPr>` +
    `<xdr:grpSpPr>` +
    `<a:xfrm>` +
    `<a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${cx}" cy="${cy}"/>` +
    `</a:xfrm>` +
    `</xdr:grpSpPr>` +
    children +
    `</xdr:grpSp>` +
    `<xdr:clientData/>` +
    `</xdr:twoCellAnchor>`;
  return { xml, nextCNvId };
}

/**
 * Serialize a list of shapes into anchor XML, emitting one `<xdr:grpSp>` per
 * distinct `groupId` (#188) and a plain `<xdr:twoCellAnchor>` per ungrouped
 * shape. Insertion order is preserved for ungrouped shapes; each group is
 * emitted at the position of its first member.
 *
 * Every `<xdr:sp>` / `<xdr:grpSp>` gets a unique OOXML `cNvPr@id` threaded
 * from a single counter — drawing parts require `cNvPr@id` to be unique
 * within the part, so a fixed id breaks multi-shape sheets (#188 M1).
 *
 * `startCNvId` is the first id to hand out. When splicing into a drawing that
 * already contains shapes/images/charts, pass `maxCNvId(existingXml) + 1` so
 * the new ids don't collide with the existing part's ids.
 */
export function serializeShapesToAnchors(
  tbs: TextBox[],
  startCNvId = 2,
): string {
  const out: string[] = [];
  const emittedGroups = new Set<string>();
  let cNvId = startCNvId;
  for (const tb of tbs) {
    const gid = tb.groupId;
    if (gid) {
      if (emittedGroups.has(gid)) continue;
      emittedGroups.add(gid);
      const members = tbs.filter((t) => t.groupId === gid);
      if (members.length > 1) {
        const { xml, nextCNvId } = buildGroupAnchorXml(members, gid, cNvId);
        out.push(xml);
        cNvId = nextCNvId;
      } else {
        out.push(buildTextBoxAnchorXml(members[0], cNvId));
        cNvId += 1;
      }
    } else {
      out.push(buildTextBoxAnchorXml(tb, cNvId));
      cNvId += 1;
    }
  }
  return out.join("");
}

/**
 * Scan a drawing XML for the highest existing `cNvPr@id`. Used when splicing
 * new shapes into a drawing that already carries images / charts / shapes so
 * the freshly-minted ids start above every id already in the part (#188 M1).
 * Returns 1 when the part has no `cNvPr` at all.
 */
export function maxCNvId(drawingXml: string): number {
  let max = 1;
  const re = /<xdr:cNvPr\b[^>]*\bid="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(drawingXml)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Build a complete drawing XML for a fresh sheet that has no existing
 * `xl/drawings/drawingN.xml`. The exporter (xlsx round-trip) calls this when
 * `_textBoxes` is non-empty on a sheet whose `_preservedParts.sheetRefs` is
 * either null or has no `drawingTarget`. Wraps a `<xdr:wsDr>` envelope around
 * one or more anchors.
 */
export function buildDrawingXmlForTextBoxes(tbs: TextBox[]): string {
  const anchors = serializeShapesToAnchors(tbs);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    anchors +
    `</xdr:wsDr>`
  );
}

/**
 * Splice a list of text-box anchors into an existing drawing XML by inserting
 * them just before the closing `</xdr:wsDr>` tag. Falls back to wrapping a
 * fresh envelope when the supplied XML doesn't look like a drawing doc, so
 * callers don't have to special-case malformed input.
 */
export function spliceTextBoxesIntoDrawingXml(
  drawingXml: string,
  tbs: TextBox[],
): string {
  if (tbs.length === 0) return drawingXml;
  // Existing drawing parts (images / charts / earlier shapes) already use up
  // `cNvPr@id` values — start the new shapes above the highest one so the
  // spliced ids stay unique within the part (#188 M1).
  const anchors = serializeShapesToAnchors(tbs, maxCNvId(drawingXml) + 1);
  const closeTag = "</xdr:wsDr>";
  const idx = drawingXml.lastIndexOf(closeTag);
  if (idx < 0) return buildDrawingXmlForTextBoxes(tbs);
  return drawingXml.slice(0, idx) + anchors + drawingXml.slice(idx);
}

// ---------------------------------------------------------------------------
// xlsx export hook
// ---------------------------------------------------------------------------

interface PreservedPartsShape {
  parts?: Record<string, string>;
  sheetRefs?: Array<
    | {
        drawingTarget?: string | null;
        drawingRid?: string | null;
        pivotRels?: unknown;
      }
    | null
  >;
  contentTypes?: string;
}

interface FlushSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, { name?: string } | undefined>;
  _textBoxes?: TextBox[];
  _preservedParts?: PreservedPartsShape;
}

/** Browser-safe UTF-8 → base64. Duplicated from imageManager so this module stays self-contained. */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  try {
    return btoa(bin);
  } catch {
    return "";
  }
}

/** RFC-4648 base64 → UTF-8 string. Returns "" on malformed input. */
function base64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

/**
 * Resolve a rels-style relative path against an absolute xlsx part path.
 * Inlined from imagePreviews.resolveMediaPath so this module stays single-
 * file (textBoxes.ts has no dep on imagePreviews.ts).
 */
function joinXlsxPath(basePath: string, rel: string): string {
  if (!rel) return "";
  if (rel.startsWith("xl/") || rel.startsWith("/xl/")) {
    return rel.replace(/^\/+/, "");
  }
  const baseDir = basePath.includes("/")
    ? basePath.slice(0, basePath.lastIndexOf("/"))
    : "";
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Mint a fresh `xl/drawings/drawingN.xml` name not used by `_preservedParts.parts`.
 * Picks the smallest available 1-based suffix so the xlsx stays compact.
 */
function nextDrawingPartName(parts: Record<string, string>): {
  drawingName: string;
  relsName: string;
  drawingN: number;
} {
  const used = new Set<number>();
  for (const key of Object.keys(parts)) {
    const m = /^xl\/drawings\/drawing(\d+)\.xml$/.exec(key);
    if (m) used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return {
    drawingName: `xl/drawings/drawing${n}.xml`,
    relsName: `xl/drawings/_rels/drawing${n}.xml.rels`,
    drawingN: n,
  };
}

/** OOXML content-type for a spreadsheet drawing part. */
const DRAWING_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.drawing+xml";

/**
 * Ensure `[Content_Types].xml` advertises the supplied drawing part. The Rust
 * exporter (`merge_content_type_overrides`) only re-injects drawing Overrides
 * that were present in the *source* file's content-types — so a freshly-minted
 * `xl/drawings/drawingN.xml` in a workbook that had no prior drawing would have
 * no Override and Excel would reject the file. We stamp the Override into the
 * preserved `contentTypes` string here so the round-trip stays valid.
 *
 * When the workbook carried no preserved content-types at all (brand-new xlsx
 * that never had drawings), we synthesize a minimal `<Types>` doc holding just
 * the Override — `merge_content_type_overrides` only scrapes `<Override>` /
 * image `<Default>` tags out of it, so a minimal doc is sufficient.
 */
function ensureDrawingContentType(
  contentTypes: string | undefined,
  drawingName: string,
): string {
  const partName = `/${drawingName}`;
  const override = `<Override PartName="${partName}" ContentType="${DRAWING_CONTENT_TYPE}"/>`;
  const ct = contentTypes ?? "";
  if (ct.includes(`PartName="${partName}"`)) return ct;
  const closeIdx = ct.lastIndexOf("</Types>");
  if (closeIdx < 0) {
    // No usable content-types doc — synthesize a minimal one carrying just
    // the Override. The Rust merge step scrapes Override tags out of this.
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      override +
      `</Types>`
    );
  }
  return ct.slice(0, closeIdx) + override + ct.slice(closeIdx);
}

/**
 * Flush every in-memory text box into the snapshot's `_preservedParts`
 * structure so the Rust xlsx exporter writes them as `<xdr:sp>` shapes
 * inside the matching sheet's drawing XML. Returns a fresh JSON string —
 * idempotent: calling it twice without inserting new text boxes is a no-op.
 *
 * Strategy:
 *  - For each sheet with text boxes:
 *    - If the sheet already has a drawing part (image / chart), splice the
 *      new `<xdr:sp>` anchors before `</xdr:wsDr>`.
 *    - Otherwise mint a new `xl/drawings/drawingN.xml` and matching empty
 *      rels file, and stamp `sheetRefs[i].drawingTarget` / `drawingRid`.
 *  - Clears `_textBoxes` on the returned snapshot so a subsequent flush
 *    doesn't double-write the same anchors.
 *
 * Tolerates: missing `_preservedParts`, malformed JSON input, sheets that
 * are not in `sheetOrder` (those text boxes are silently dropped — matches
 * the image insert path's "object must reference a known sheet" contract).
 */
export function flushTextBoxesToPreservedParts(
  snapshotJson: string | null | undefined,
): string {
  if (!snapshotJson) return snapshotJson ?? "";
  let snap: FlushSnapshot;
  try {
    snap = JSON.parse(snapshotJson) as FlushSnapshot;
  } catch {
    return snapshotJson;
  }
  const allBoxes = Array.isArray(snap._textBoxes) ? snap._textBoxes : [];
  if (allBoxes.length === 0) return snapshotJson;

  const sheetOrder = Array.isArray(snap.sheetOrder) ? snap.sheetOrder : [];
  if (sheetOrder.length === 0) {
    // No sheets to anchor against — drop the boxes rather than crash export.
    snap._textBoxes = [];
    return JSON.stringify(snap);
  }

  // Group text boxes by sheet id.
  const bySheet = new Map<string, TextBox[]>();
  for (const tb of allBoxes) {
    if (!tb || !tb.sheetId) continue;
    const arr = bySheet.get(tb.sheetId) ?? [];
    arr.push(tb);
    bySheet.set(tb.sheetId, arr);
  }

  // Deep-copy parts / sheetRefs so we never mutate the caller's snapshot.
  const preserved: PreservedPartsShape = snap._preservedParts ?? {};
  const parts: Record<string, string> = { ...(preserved.parts ?? {}) };
  const sheetRefs: PreservedPartsShape["sheetRefs"] = Array.isArray(
    preserved.sheetRefs,
  )
    ? preserved.sheetRefs.slice()
    : [];
  // Accumulates content-type Overrides for every freshly-minted drawing part
  // so the Rust exporter advertises them (see `ensureDrawingContentType`).
  let contentTypes: string | undefined = preserved.contentTypes;

  for (const [sheetId, boxes] of bySheet) {
    const idx = sheetOrder.indexOf(sheetId);
    if (idx < 0) continue; // sheet was deleted — drop these boxes.

    while (sheetRefs.length <= idx) sheetRefs.push(null);
    const existing = sheetRefs[idx];

    if (existing && existing.drawingTarget) {
      // Reuse the existing drawing part — splice anchors before the close tag.
      const drawingPath = joinXlsxPath(
        "xl/worksheets/sheet.xml",
        existing.drawingTarget,
      );
      const b64 = parts[drawingPath];
      const xml = b64 ? base64ToUtf8(b64) : "";
      const nextXml = xml
        ? spliceTextBoxesIntoDrawingXml(xml, boxes)
        : buildDrawingXmlForTextBoxes(boxes);
      const encoded = utf8ToBase64(nextXml);
      if (encoded) parts[drawingPath] = encoded;
    } else {
      // Mint a fresh drawing part for this sheet.
      const { drawingName, relsName, drawingN } = nextDrawingPartName(parts);
      const drawingXml = buildDrawingXmlForTextBoxes(boxes);
      // Empty rels — text boxes don't reference media or hyperlinks. The
      // file still has to exist for OOXML conformance (sheet1.xml.rels →
      // drawing rId → drawing part; drawing part itself has its own rels
      // doc even when empty).
      const relsXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
      const drawingB64 = utf8ToBase64(drawingXml);
      const relsB64 = utf8ToBase64(relsXml);
      if (drawingB64) parts[drawingName] = drawingB64;
      if (relsB64) parts[relsName] = relsB64;
      sheetRefs[idx] = {
        drawingRid: "rId1",
        drawingTarget: `../drawings/drawing${drawingN}.xml`,
        pivotRels: (existing && existing.pivotRels) ?? [],
      };
      // The minted part needs a `[Content_Types].xml` Override or Excel
      // rejects the file. Stamp it into the preserved content-types string.
      contentTypes = ensureDrawingContentType(contentTypes, drawingName);
    }
  }

  snap._preservedParts = {
    ...preserved,
    parts,
    sheetRefs,
    ...(contentTypes !== undefined ? { contentTypes } : {}),
  };
  // Keep the resolved text boxes in `_textBoxes` so the in-memory render
  // stays consistent with what was just written. The Rust importer ignores
  // unknown top-level keys, so this field round-trips through .coco saves
  // without interference. (xlsx round-trip drops it on re-import because
  // xlsx doesn't carry the structured form.)
  return JSON.stringify(snap);
}

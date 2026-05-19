// Pure helpers for the Excel-style "Borders" dialog. Provides the 12 preset
// border patterns (None / All / Outside / Top / Bottom / Left / Right /
// Inside / Bottom Double / Bottom Thick / Top-and-Bottom / Top-and-Thick-
// Bottom), a line-style enum mirroring Univer's BorderStyleTypes, and the
// `applyBorders` snapshot mutator the EditorScreen wires into
// "format-borders". Kept framework-free so the helper stays testable without
// pulling Univer.
//
// Snapshot shape (Univer 0.5.x — same shape cellStyles.ts / quickNumberFormat
// operate on):
//   {
//     sheets: {
//       [sheetId]: {
//         cellData: {
//           [row]: {
//             [col]: {
//               s?: object | string,        -- inline style or interned id
//               _fmt?: string,              -- per-cell number format
//               v?: ...                     -- value
//             }
//           }
//         }
//       }
//     }
//   }
//
// Border payload lives inside `cell.s.bd`:
//   bd: {
//     t?: { s: <BorderStyleTypes>, cl: { rgb } },   -- top
//     b?: { s: ...,                cl: { rgb } },   -- bottom
//     l?: { s: ...,                cl: { rgb } },   -- left
//     r?: { s: ...,                cl: { rgb } },   -- right
//   }
//
// Univer's renderer reads `cell.s.bd` directly — there's no separate "inside
// border" key on a single cell. Inside borders are emulated by writing the
// matching adjacent-cell edges (e.g. an interior horizontal line is the
// bottom of row N + top of row N+1). The preset's `insideH` / `insideV`
// flags fan out to those edges; "All" is just "outside ∪ insideH ∪ insideV".
//
// "None" clears `cell.s.bd` entirely (and drops `cell.s` if that was the
// only key on `s`).
//
// Snapshot is consumed as a parsed JS object (not a JSON string) — the
// EditorScreen already holds the parsed snapshot for other mutations and
// re-stringifies after.

export type BorderStyle =
  | "thin"
  | "medium"
  | "thick"
  | "dashed"
  | "dotted"
  | "double"
  | "none";

/** Univer BorderStyleTypes enum (subset we use). 0 = no border, 1 = thin,
 *  2 = hair, 3 = dotted, 4 = dashed, 5 = dash-dot, 6 = dash-dot-dot,
 *  7 = double, 8 = medium, 9 = medium-dashed, 10..12 = medium variants,
 *  13 = thick. The `xlsx_io` round-trip in this build maps thin/medium/thick
 *  cleanly; dashed/dotted/double are best-effort but still render in-app. */
export function borderStyleToUniverIndex(style: BorderStyle): number {
  switch (style) {
    case "none":
      return 0;
    case "thin":
      return 1;
    case "dotted":
      return 3;
    case "dashed":
      return 4;
    case "double":
      return 7;
    case "medium":
      return 8;
    case "thick":
      return 13;
  }
}

export interface BorderPresetSides {
  /** Outer edges of the entire range. */
  t?: boolean;
  b?: boolean;
  l?: boolean;
  r?: boolean;
  /** Interior horizontal lines (between adjacent rows in the range). */
  insideH?: boolean;
  /** Interior vertical lines (between adjacent columns in the range). */
  insideV?: boolean;
  /** Bottom outer edge drawn as a double line, regardless of `style`. */
  doubleBottom?: boolean;
  /** Bottom outer edge drawn thick, regardless of `style`. */
  thickBottom?: boolean;
}

export interface BorderPreset {
  id: string;
  nameJa: string;
  nameEn: string;
  sides: BorderPresetSides;
}

/** 12 preset border patterns mirroring Excel's "Borders" dropdown. The
 *  `id` doubles as the dialog's button key and the runtime selector for
 *  applyBorders. Order matches Excel's gallery so users see the same grid. */
export const BORDER_PRESETS: ReadonlyArray<BorderPreset> = [
  { id: "none", nameJa: "枠線なし", nameEn: "No Border", sides: {} },
  {
    id: "all",
    nameJa: "格子",
    nameEn: "All Borders",
    sides: { t: true, b: true, l: true, r: true, insideH: true, insideV: true },
  },
  {
    id: "outside",
    nameJa: "外枠",
    nameEn: "Outside Borders",
    sides: { t: true, b: true, l: true, r: true },
  },
  { id: "top", nameJa: "上罫線", nameEn: "Top Border", sides: { t: true } },
  { id: "bottom", nameJa: "下罫線", nameEn: "Bottom Border", sides: { b: true } },
  { id: "left", nameJa: "左罫線", nameEn: "Left Border", sides: { l: true } },
  { id: "right", nameJa: "右罫線", nameEn: "Right Border", sides: { r: true } },
  {
    id: "inside",
    nameJa: "内側",
    nameEn: "Inside Borders",
    sides: { insideH: true, insideV: true },
  },
  {
    id: "bottom-double",
    nameJa: "下二重罫線",
    nameEn: "Bottom Double Border",
    sides: { b: true, doubleBottom: true },
  },
  {
    id: "bottom-thick",
    nameJa: "下太罫線",
    nameEn: "Thick Bottom Border",
    sides: { b: true, thickBottom: true },
  },
  {
    id: "top-and-bottom",
    nameJa: "上罫線 + 下罫線",
    nameEn: "Top and Bottom Border",
    sides: { t: true, b: true },
  },
  {
    id: "top-and-thick-bottom",
    nameJa: "上罫線 + 下太罫線",
    nameEn: "Top and Thick Bottom Border",
    sides: { t: true, b: true, thickBottom: true },
  },
];

export function getBorderPreset(presetId: string): BorderPreset | null {
  return BORDER_PRESETS.find((p) => p.id === presetId) ?? null;
}

export interface BorderParams {
  /** Inclusive zero-based rectangle. r1<=r2, c1<=c2 (normalised by caller). */
  range: { r1: number; c1: number; r2: number; c2: number };
  /** One of BORDER_PRESETS[*].id. Unknown ids no-op. */
  preset: string;
  /** Border color as `#RRGGBB`. */
  color: string;
  /** Line style applied to every painted edge unless overridden by the
   *  preset's doubleBottom / thickBottom hints. */
  style: BorderStyle;
}

/** Snapshot shape we mutate. We keep `s` permissive (object | string) so the
 *  helper plays nicely with cells whose style is interned to a workbook
 *  styles-table id (a string) — we replace it with an inline `{ bd }` object
 *  in that case, same approach cellStyles.ts uses. */
interface BordersSnapshot {
  sheets?: Record<
    string,
    {
      cellData?: Record<
        string,
        Record<string, Record<string, unknown> | undefined> | undefined
      >;
    } | undefined
  >;
}

interface EdgePayload {
  s: number;
  cl: { rgb: string };
}

/** Cap empty-cell materialisation, same as cellStyles.ts / quickNumberFormat
 *  use. Whole-column selections would otherwise blow up the snapshot. */
const BORDERS_MAX_NEW_CELLS = 100_000;

function ensureCell(
  cellData: Record<
    string,
    Record<string, Record<string, unknown> | undefined> | undefined
  >,
  r: number,
  c: number,
): Record<string, unknown> {
  const rowKey = String(r);
  if (!cellData[rowKey]) cellData[rowKey] = {};
  const row = cellData[rowKey]!;
  const colKey = String(c);
  const existing = row[colKey];
  const cell = (existing ?? {}) as Record<string, unknown>;
  row[colKey] = cell;
  return cell;
}

/** Get-or-create the cell's `bd` map. Promotes interned `s` (string id) to
 *  an inline object so we can attach borders. */
function ensureBd(cell: Record<string, unknown>): Record<string, EdgePayload> {
  let s = cell.s;
  if (!s || typeof s !== "object") {
    s = {};
    cell.s = s;
  }
  const styleObj = s as Record<string, unknown>;
  let bd = styleObj.bd;
  if (!bd || typeof bd !== "object") {
    bd = {};
    styleObj.bd = bd;
  }
  return bd as Record<string, EdgePayload>;
}

/** Drop the cell's borders. If `s` becomes empty after the delete we drop
 *  it too so the snapshot stays clean. */
function clearBd(cell: Record<string, unknown>): void {
  const s = cell.s;
  if (!s || typeof s !== "object") return;
  const styleObj = s as Record<string, unknown>;
  delete styleObj.bd;
  if (Object.keys(styleObj).length === 0) {
    delete cell.s;
  }
}

/**
 * Apply a border preset to the range. Returns the mutated snapshot object
 * (same reference as `snapshot` — caller is expected to re-stringify) and
 * the number of cells touched.
 *
 * No-op (returns `{ snapshotMutated: snapshot, cellsTouched: 0 }`) when the
 * snapshot is malformed, the sheet is missing, the preset is unknown, or
 * the range is degenerate.
 */
export function applyBorders(
  snapshot: object,
  sheetId: string,
  params: BorderParams,
): { snapshotMutated: object; cellsTouched: number } {
  const preset = getBorderPreset(params.preset);
  if (!preset) return { snapshotMutated: snapshot, cellsTouched: 0 };
  if (!snapshot || typeof snapshot !== "object") {
    return { snapshotMutated: snapshot, cellsTouched: 0 };
  }
  const parsed = snapshot as BordersSnapshot;
  const sheet = parsed.sheets?.[sheetId];
  if (!sheet) return { snapshotMutated: snapshot, cellsTouched: 0 };
  if (!sheet.cellData) sheet.cellData = {};
  const cellData = sheet.cellData;

  const r1 = Math.min(params.range.r1, params.range.r2);
  const r2 = Math.max(params.range.r1, params.range.r2);
  const c1 = Math.min(params.range.c1, params.range.c2);
  const c2 = Math.max(params.range.c1, params.range.c2);
  if (r1 < 0 || c1 < 0) return { snapshotMutated: snapshot, cellsTouched: 0 };

  const rangeCellCount = (r2 - r1 + 1) * (c2 - c1 + 1);
  const usedRangeOnly = rangeCellCount > BORDERS_MAX_NEW_CELLS;

  // None: clear bd for every existing cell in the range; never materialise
  // empty cells just to delete a key that isn't there.
  if (preset.id === "none") {
    let touched = 0;
    for (let r = r1; r <= r2; r++) {
      const row = cellData[String(r)];
      if (!row) continue;
      for (let c = c1; c <= c2; c++) {
        const cell = row[String(c)];
        if (!cell) continue;
        clearBd(cell as Record<string, unknown>);
        touched++;
      }
    }
    return { snapshotMutated: snapshot, cellsTouched: touched };
  }

  const baseStyleIdx = borderStyleToUniverIndex(params.style);
  // The "none" line-style is meaningless for a paint preset; fall back to
  // thin so the user still sees something rather than silently doing nothing.
  const styleIdx = baseStyleIdx === 0 ? borderStyleToUniverIndex("thin") : baseStyleIdx;
  const color = { rgb: params.color };

  const edge = (idx: number): EdgePayload => ({ s: idx, cl: color });
  const baseEdge = edge(styleIdx);
  const doubleEdge = edge(borderStyleToUniverIndex("double"));
  const thickEdge = edge(borderStyleToUniverIndex("thick"));

  // Resolve the bottom-edge override once: presets like "bottom-double" want
  // the bottom drawn as double regardless of the user's style dropdown.
  const bottomEdge = preset.sides.doubleBottom
    ? doubleEdge
    : preset.sides.thickBottom
      ? thickEdge
      : baseEdge;

  let touched = 0;
  const touchedSet = new Set<string>();

  const paint = (r: number, c: number, side: "t" | "b" | "l" | "r", payload: EdgePayload) => {
    if (r < 0 || c < 0) return;
    // Honour the empty-cell cap: when the range is too big, only paint cells
    // that already exist in cellData.
    if (usedRangeOnly) {
      const row = cellData[String(r)];
      if (!row || row[String(c)] === undefined) return;
    }
    const cell = ensureCell(cellData, r, c);
    const bd = ensureBd(cell);
    bd[side] = payload;
    const key = `${r}:${c}`;
    if (!touchedSet.has(key)) {
      touchedSet.add(key);
      touched++;
    }
  };

  // Outer edges — paint only the matching cells of the outermost row/column.
  if (preset.sides.t) {
    for (let c = c1; c <= c2; c++) paint(r1, c, "t", baseEdge);
  }
  if (preset.sides.b) {
    for (let c = c1; c <= c2; c++) paint(r2, c, "b", bottomEdge);
  }
  if (preset.sides.l) {
    for (let r = r1; r <= r2; r++) paint(r, c1, "l", baseEdge);
  }
  if (preset.sides.r) {
    for (let r = r1; r <= r2; r++) paint(r, c2, "r", baseEdge);
  }

  // Inside horizontals: bottom of row r + top of row r+1 for each interior
  // gap. Each gap requires the range to span >=2 rows.
  if (preset.sides.insideH && r2 > r1) {
    for (let r = r1; r < r2; r++) {
      for (let c = c1; c <= c2; c++) {
        paint(r, c, "b", baseEdge);
        paint(r + 1, c, "t", baseEdge);
      }
    }
  }

  // Inside verticals: right of col c + left of col c+1 for each interior gap.
  if (preset.sides.insideV && c2 > c1) {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c < c2; c++) {
        paint(r, c, "r", baseEdge);
        paint(r, c + 1, "l", baseEdge);
      }
    }
  }

  return { snapshotMutated: snapshot, cellsTouched: touched };
}

// Pure helpers that derive at-a-glance workbook statistics from the Univer
// 0.5.x snapshot JSON. Kept side-effect free + framework-free so the dialog
// (WorkbookStatsDialog) and any future caller (status bar tooltip, CLI) can
// share the same numbers without standing up Univer.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheetOrder?: string[];
//     namedRanges?: unknown[];
//     styles?: Record<string, unknown>;            // workbook-level style table
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         _sheetState?: "hidden" | "veryHidden";
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;                       // cell value (number / string / boolean)
//               f?: unknown;                       // formula text (when present)
//               s?: object | string;               // style id or inline style
//               _fmt?: string;                     // Coco-managed number-format code
//               [k: string]: unknown;
//             } | undefined;
//           };
//         };
//         mergeData?: unknown[];                   // merged-cell rectangles
//         _comments?: unknown[];                   // sheet-level comment array
//         _hyperlinks?: unknown[];                 // sheet-level hyperlink array
//         _dataValidations?: unknown[];            // see store/dataValidation.ts
//         _conditionalFormatting?: unknown[];      // see store/cfRuleManager.ts
//         _sparklines?: unknown[];                 // see store/sparklines.ts
//         _charts?: unknown[];                     // see store/chartRender.ts
//         _tables?: unknown[];                     // see store/tables.ts
//         _pivots?: unknown[];                     // see store/pivots.ts
//         _slicers?: unknown[];                    // see store/slicers.ts
//         _bookmarks?: unknown[];                  // optional snapshot bookmarks (else localStorage)
//       };
//     };
//   }
//
// All counters tolerate malformed input by treating the missing/invalid
// branch as zero — the dialog should never throw on a partial workbook.

export interface OverviewStats {
  sheetCount: number;
  hiddenSheetCount: number;
  totalCells: number;
  formulaCells: number;
  sizeBytes: number;
}

export interface PerSheetStats {
  sheetId: string;
  sheetName: string;
  cellCount: number;
  formulaCount: number;
  mergedCount: number;
  cfRules: number;
  dvRules: number;
  commentCount: number;
}

export interface FeatureUsageStats {
  hyperlinks: number;
  comments: number;
  dataValidations: number;
  conditionalFormats: number;
  sparklines: number;
  charts: number;
  tables: number;
  pivots: number;
  slicers: number;
  bookmarks: number;
  namedRanges: number;
}

export interface DataTypeStats {
  numeric: number;
  text: number;
  formula: number;
  boolean: number;
  blank: number;
}

export interface StyleStats {
  uniqueStyles: number;
  uniqueNumberFormats: number;
}

export interface WorkbookStatsBundle {
  overview: OverviewStats;
  perSheet: PerSheetStats[];
  features: FeatureUsageStats;
  dataTypes: DataTypeStats;
  styles: StyleStats;
  /** Top-N (N=5) sheets by cell count, descending. */
  topSheets: PerSheetStats[];
}

interface SnapshotCell {
  v?: unknown;
  f?: unknown;
  s?: unknown;
  _fmt?: unknown;
  [k: string]: unknown;
}

interface SnapshotSheet {
  name?: unknown;
  _sheetState?: unknown;
  cellData?: Record<string, Record<string, SnapshotCell | undefined> | undefined>;
  mergeData?: unknown;
  _comments?: unknown;
  _hyperlinks?: unknown;
  _dataValidations?: unknown;
  _conditionalFormatting?: unknown;
  _sparklines?: unknown;
  _charts?: unknown;
  _tables?: unknown;
  _pivots?: unknown;
  _slicers?: unknown;
  _bookmarks?: unknown;
  [k: string]: unknown;
}

interface Snapshot {
  sheetOrder?: unknown;
  sheets?: Record<string, SnapshotSheet | undefined>;
  styles?: Record<string, unknown>;
  namedRanges?: unknown;
  [k: string]: unknown;
}

const EMPTY_BUNDLE: WorkbookStatsBundle = {
  overview: {
    sheetCount: 0,
    hiddenSheetCount: 0,
    totalCells: 0,
    formulaCells: 0,
    sizeBytes: 0,
  },
  perSheet: [],
  features: {
    hyperlinks: 0,
    comments: 0,
    dataValidations: 0,
    conditionalFormats: 0,
    sparklines: 0,
    charts: 0,
    tables: 0,
    pivots: 0,
    slicers: 0,
    bookmarks: 0,
    namedRanges: 0,
  },
  dataTypes: { numeric: 0, text: 0, formula: 0, boolean: 0, blank: 0 },
  styles: { uniqueStyles: 0, uniqueNumberFormats: 0 },
  topSheets: [],
};

function arrayLen(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function parseSnapshot(input: string | Snapshot | null | undefined): {
  parsed: Snapshot | null;
  byteLength: number;
} {
  if (input === null || input === undefined) return { parsed: null, byteLength: 0 };
  if (typeof input === "object") {
    // Caller already holds the parsed shape; re-stringify for size only.
    let bytes = 0;
    try {
      bytes = JSON.stringify(input).length;
    } catch {
      bytes = 0;
    }
    return { parsed: input as Snapshot, byteLength: bytes };
  }
  if (typeof input !== "string") return { parsed: null, byteLength: 0 };
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object") return { parsed: null, byteLength: input.length };
    return { parsed: parsed as Snapshot, byteLength: input.length };
  } catch {
    return { parsed: null, byteLength: input.length };
  }
}

function sheetIdsOrdered(snapshot: Snapshot): string[] {
  const order = snapshot.sheetOrder;
  if (Array.isArray(order)) {
    const out: string[] = [];
    for (const id of order) {
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
    if (out.length > 0) return out;
  }
  if (snapshot.sheets && typeof snapshot.sheets === "object") {
    return Object.keys(snapshot.sheets);
  }
  return [];
}

function sheetDisplayName(sheet: SnapshotSheet | undefined, fallback: string): string {
  const raw = sheet && typeof sheet.name === "string" ? sheet.name.trim() : "";
  return raw.length > 0 ? raw : fallback;
}

function isHiddenSheet(sheet: SnapshotSheet | undefined): boolean {
  const state = sheet?._sheetState;
  return state === "hidden" || state === "veryHidden";
}

/**
 * Walk one sheet's cellData and accumulate counts:
 *   - totalCells: any non-null cell entry (matches snapshotStats.ts)
 *   - formulaCells: cells with a non-empty `f`
 *   - per data-type buckets (numeric / text / formula / boolean / blank)
 *   - inline style ids and number-format codes (added to the workbook-wide sets)
 *
 * Pure pass — runs once per sheet so the per-sheet table and the global
 * data-type histogram stay consistent.
 */
function walkSheetCells(
  sheet: SnapshotSheet | undefined,
  dataTypes: DataTypeStats,
  styleIds: Set<string>,
  numberFormats: Set<string>,
): { cellCount: number; formulaCount: number } {
  let cellCount = 0;
  let formulaCount = 0;
  const cellData = sheet?.cellData;
  if (!cellData || typeof cellData !== "object") return { cellCount, formulaCount };

  for (const row of Object.values(cellData)) {
    if (!row || typeof row !== "object") continue;
    for (const cell of Object.values(row)) {
      if (cell === null || cell === undefined) continue;
      cellCount += 1;

      // Style id — supports both inline (string id) and object form.
      const s = cell.s;
      if (typeof s === "string" && s.length > 0) {
        styleIds.add(s);
      } else if (s && typeof s === "object") {
        // Inline styles are unique per cell unless explicitly deduped; serialise
        // to a key so identical inline objects collapse into one count.
        try {
          styleIds.add(JSON.stringify(s));
        } catch {
          // Cycle or non-serialisable — skip rather than throw.
        }
      }

      // Number format — both Coco-managed `_fmt` and inline `s.n.pattern` are
      // recognised by numberFormatManager; we only need the unique-set count
      // here so `_fmt` is sufficient (inline patterns serialise via styleIds).
      if (typeof cell._fmt === "string" && cell._fmt.trim().length > 0) {
        numberFormats.add(cell._fmt);
      }

      const hasFormula =
        cell.f !== undefined && cell.f !== null && cell.f !== "";
      if (hasFormula) {
        formulaCount += 1;
        dataTypes.formula += 1;
        continue;
      }

      const v = cell.v;
      if (v === null || v === undefined || v === "") {
        dataTypes.blank += 1;
      } else if (typeof v === "number") {
        dataTypes.numeric += 1;
      } else if (typeof v === "boolean") {
        dataTypes.boolean += 1;
      } else {
        dataTypes.text += 1;
      }
    }
  }
  return { cellCount, formulaCount };
}

/**
 * Build the full statistics bundle from a snapshot (string or pre-parsed).
 * Returns a zeroed bundle (never null) for malformed input so the dialog can
 * render unconditionally.
 *
 * `sizeBytes` is the JSON length (UTF-16 code units when input is a string —
 * matches `snapshotStats.ts`'s convention; pre-parsed input is re-stringified
 * once to derive the same metric).
 */
export function collectWorkbookStats(
  snapshot: string | Snapshot | null | undefined,
): WorkbookStatsBundle {
  const { parsed, byteLength } = parseSnapshot(snapshot);
  if (!parsed) {
    return { ...EMPTY_BUNDLE, overview: { ...EMPTY_BUNDLE.overview, sizeBytes: byteLength } };
  }

  const dataTypes: DataTypeStats = { numeric: 0, text: 0, formula: 0, boolean: 0, blank: 0 };
  const styleIds = new Set<string>();
  const numberFormats = new Set<string>();

  const ids = sheetIdsOrdered(parsed);
  const perSheet: PerSheetStats[] = [];

  let hiddenSheetCount = 0;
  let totalCells = 0;
  let formulaCells = 0;
  const features: FeatureUsageStats = {
    hyperlinks: 0,
    comments: 0,
    dataValidations: 0,
    conditionalFormats: 0,
    sparklines: 0,
    charts: 0,
    tables: 0,
    pivots: 0,
    slicers: 0,
    bookmarks: 0,
    namedRanges: arrayLen(parsed.namedRanges),
  };

  for (const sheetId of ids) {
    const sheet = parsed.sheets?.[sheetId];
    const hidden = isHiddenSheet(sheet);
    if (hidden) hiddenSheetCount += 1;

    const walked = walkSheetCells(sheet, dataTypes, styleIds, numberFormats);
    const commentCount = arrayLen(sheet?._comments);
    const cfRules = arrayLen(sheet?._conditionalFormatting);
    const dvRules = arrayLen(sheet?._dataValidations);
    const mergedCount = arrayLen(sheet?.mergeData);

    perSheet.push({
      sheetId,
      sheetName: sheetDisplayName(sheet, sheetId),
      cellCount: walked.cellCount,
      formulaCount: walked.formulaCount,
      mergedCount,
      cfRules,
      dvRules,
      commentCount,
    });

    totalCells += walked.cellCount;
    formulaCells += walked.formulaCount;

    features.hyperlinks += arrayLen(sheet?._hyperlinks);
    features.comments += commentCount;
    features.dataValidations += dvRules;
    features.conditionalFormats += cfRules;
    features.sparklines += arrayLen(sheet?._sparklines);
    features.charts += arrayLen(sheet?._charts);
    features.tables += arrayLen(sheet?._tables);
    features.pivots += arrayLen(sheet?._pivots);
    features.slicers += arrayLen(sheet?._slicers);
    features.bookmarks += arrayLen(sheet?._bookmarks);
  }

  // Workbook-level styles map contributes too (xlsx round-trip stashes
  // shared styles there). Union with inline cell styles for the unique count.
  if (parsed.styles && typeof parsed.styles === "object") {
    for (const key of Object.keys(parsed.styles)) styleIds.add(key);
  }

  const topSheets = perSheet
    .slice()
    .sort((a, b) => b.cellCount - a.cellCount)
    .slice(0, 5);

  return {
    overview: {
      sheetCount: ids.length,
      hiddenSheetCount,
      totalCells,
      formulaCells,
      sizeBytes: byteLength,
    },
    perSheet,
    features,
    dataTypes,
    styles: {
      uniqueStyles: styleIds.size,
      uniqueNumberFormats: numberFormats.size,
    },
    topSheets,
  };
}

/** Human-readable byte formatter (B / KB / MB) for the Overview tab. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

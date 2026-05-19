// Pure helpers for the per-sheet "Page Setup" snapshot extension. The dialog
// (PageSetupDialog) writes a structured `_pageSetup` block into the active
// sheet's snapshot entry; xlsx round-trip already preserves unknown sheet
// extension data, so we simply need to read/write this field today. A future
// pass can map these fields onto OOXML <pageSetup>/<pageMargins>/<headerFooter>/
// <printOptions> elements for full Excel-compatible print metadata.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     sheets: {
//       <sheetId>: {
//         _pageSetup?: {
//           page?: {
//             orientation?: "portrait" | "landscape";
//             paperSize?: "A4" | "A3" | "Letter" | "Legal" | "B4" | "B5";
//             scalePercent?: number;       // 10..400
//             fitToPagesWide?: number | null;
//             fitToPagesTall?: number | null;
//           };
//           margins?: {
//             top?, bottom?, left?, right?, header?, footer?: number;  // mm
//             centerH?: boolean; centerV?: boolean;
//           };
//           headerFooter?: {
//             headerLeft?, headerCenter?, headerRight?: string;
//             footerLeft?, footerCenter?, footerRight?: string;
//           };
//           sheetOpts?: {
//             printArea?: string;            // "A1:D50"
//             printTitleRows?: string;       // "$1:$3"
//             printTitleCols?: string;       // "$A:$B"
//             gridlines?, blackAndWhite?, draftQuality?, headings?: boolean;
//             pageOrder?: "downThenOver" | "overThenDown";
//           };
//         }
//       }
//     }
//   }
//
// Kept side-effect free so it can be unit-tested without Univer.

export type PaperSize = "A4" | "A3" | "Letter" | "Legal" | "B4" | "B5";
export type Orientation = "portrait" | "landscape";
export type PageOrder = "downThenOver" | "overThenDown";

export interface PageSetupPage {
  orientation?: Orientation;
  paperSize?: PaperSize;
  scalePercent?: number;
  fitToPagesWide?: number | null;
  fitToPagesTall?: number | null;
}

export interface PageSetupMargins {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  header?: number;
  footer?: number;
  centerH?: boolean;
  centerV?: boolean;
}

export interface PageSetupHeaderFooter {
  headerLeft?: string;
  headerCenter?: string;
  headerRight?: string;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
}

export interface PageSetupSheetOpts {
  printArea?: string;
  printTitleRows?: string;
  printTitleCols?: string;
  gridlines?: boolean;
  blackAndWhite?: boolean;
  draftQuality?: boolean;
  headings?: boolean;
  pageOrder?: PageOrder;
}

export interface PageSetupValue {
  page?: PageSetupPage;
  margins?: PageSetupMargins;
  headerFooter?: PageSetupHeaderFooter;
  sheetOpts?: PageSetupSheetOpts;
}

export interface WorkbookPageSetupSnapshot {
  sheets?: Record<string, { _pageSetup?: PageSetupValue } | undefined>;
}

export const PAPER_SIZES: readonly PaperSize[] = [
  "A4",
  "A3",
  "Letter",
  "Legal",
  "B4",
  "B5",
] as const;

const ORIENTATIONS: readonly Orientation[] = ["portrait", "landscape"] as const;
const PAGE_ORDERS: readonly PageOrder[] = ["downThenOver", "overThenDown"] as const;

/** Sensible defaults: A4 portrait, 20 mm side / 10 mm header/footer, gridlines on. */
export function defaultPageSetup(): PageSetupValue {
  return {
    page: {
      orientation: "portrait",
      paperSize: "A4",
      scalePercent: 100,
      fitToPagesWide: null,
      fitToPagesTall: null,
    },
    margins: {
      top: 20,
      bottom: 20,
      left: 20,
      right: 20,
      header: 10,
      footer: 10,
      centerH: false,
      centerV: false,
    },
    headerFooter: {
      headerLeft: "",
      headerCenter: "",
      headerRight: "",
      footerLeft: "",
      footerCenter: "",
      footerRight: "",
    },
    sheetOpts: {
      printArea: "",
      printTitleRows: "",
      printTitleCols: "",
      gridlines: true,
      blackAndWhite: false,
      draftQuality: false,
      headings: false,
      pageOrder: "downThenOver",
    },
  };
}

// Shallow object check that excludes arrays/null.
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Merge `override` over `base`, preferring `override`'s value when defined.
// Used per-section so callers can omit any subset of fields and still get
// a fully-populated PageSetupValue back from `getPageSetup`.
function mergeSection<T extends object>(base: T, override: unknown): T {
  if (!isObj(override)) return { ...base };
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const k of Object.keys(override)) {
    const v = (override as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/**
 * Parse a snapshot (object or JSON string) and return the effective page setup
 * for the given sheet, merging stored values over `defaultPageSetup()`.
 * Tolerates malformed / missing input — returns defaults in any error case.
 */
export function getPageSetup(
  snapshot: WorkbookPageSetupSnapshot | string | null | undefined,
  sheetId: string | null | undefined,
): PageSetupValue {
  const defaults = defaultPageSetup();
  if (!sheetId) return defaults;
  let parsed: WorkbookPageSetupSnapshot | null = null;
  if (typeof snapshot === "string") {
    try {
      parsed = JSON.parse(snapshot) as WorkbookPageSetupSnapshot;
    } catch {
      return defaults;
    }
  } else if (isObj(snapshot)) {
    parsed = snapshot;
  }
  if (!parsed) return defaults;
  const stored = parsed.sheets?.[sheetId]?._pageSetup;
  if (!isObj(stored)) return defaults;

  return {
    page: mergeSection(defaults.page!, (stored as PageSetupValue).page),
    margins: mergeSection(defaults.margins!, (stored as PageSetupValue).margins),
    headerFooter: mergeSection(
      defaults.headerFooter!,
      (stored as PageSetupValue).headerFooter,
    ),
    sheetOpts: mergeSection(defaults.sheetOpts!, (stored as PageSetupValue).sheetOpts),
  };
}

/**
 * Write `value` into `snapshotJson` at `sheets[sheetId]._pageSetup` and return
 * the new snapshot JSON string. Throws if the snapshot is malformed or the
 * target sheet doesn't exist — callers should surface that as an editor error.
 */
export function setPageSetup(
  snapshotJson: string,
  sheetId: string,
  value: PageSetupValue,
): string {
  const parsed = JSON.parse(snapshotJson) as WorkbookPageSetupSnapshot;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid snapshot");
  }
  if (!parsed.sheets || typeof parsed.sheets !== "object") {
    throw new Error("snapshot missing sheets map");
  }
  const sheet = parsed.sheets[sheetId];
  if (!sheet) throw new Error(`sheet ${sheetId} not in snapshot`);
  sheet._pageSetup = value;
  return JSON.stringify(parsed);
}

export interface PageSetupValidationResult {
  ok: boolean;
  errors?: string[];
}

// A1 column-range like "$A:$B" or "A:B" (optionally sheet-qualified).
const COL_RANGE_RE = /^(?:[^!\s]+!)?\$?[A-Za-z]+(?::\$?[A-Za-z]+)?$/;
// A1 row-range like "$1:$3" or "1:3" (optionally sheet-qualified).
const ROW_RANGE_RE = /^(?:[^!\s]+!)?\$?[1-9]\d*(?::\$?[1-9]\d*)?$/;
// Single cell or rectangular range like "A1:D50" (optionally sheet-qualified).
const RECT_RANGE_RE =
  /^(?:[^!\s]+!)?\$?[A-Za-z]+\$?[1-9]\d*(?::\$?[A-Za-z]+\$?[1-9]\d*)?$/;

/**
 * Validate a candidate PageSetupValue. Returns `{ ok: true }` when every
 * provided field is within range / matches its expected enum, otherwise
 * a list of human-readable error strings.
 */
export function validatePageSetup(value: PageSetupValue): PageSetupValidationResult {
  const errors: string[] = [];

  const page = value.page;
  if (page) {
    if (page.orientation !== undefined && !ORIENTATIONS.includes(page.orientation)) {
      errors.push("印刷の向きが不正です。");
    }
    if (page.paperSize !== undefined && !PAPER_SIZES.includes(page.paperSize)) {
      errors.push("用紙サイズが不正です。");
    }
    if (page.scalePercent !== undefined) {
      const s = page.scalePercent;
      if (!Number.isFinite(s) || s < 10 || s > 400) {
        errors.push("拡大縮小は 10〜400% の範囲で指定してください。");
      }
    }
    for (const k of ["fitToPagesWide", "fitToPagesTall"] as const) {
      const v = page[k];
      if (v !== undefined && v !== null) {
        if (!Number.isInteger(v) || v < 1 || v > 1000) {
          errors.push("「ページに合わせる」の値は 1〜1000 の整数で指定してください。");
          break;
        }
      }
    }
  }

  const margins = value.margins;
  if (margins) {
    const mKeys = ["top", "bottom", "left", "right", "header", "footer"] as const;
    for (const k of mKeys) {
      const v = margins[k];
      if (v !== undefined) {
        if (!Number.isFinite(v) || v < 0 || v > 200) {
          errors.push(`余白 (${k}) は 0〜200 mm の範囲で指定してください。`);
        }
      }
    }
  }

  const sheetOpts = value.sheetOpts;
  if (sheetOpts) {
    if (sheetOpts.printArea && !RECT_RANGE_RE.test(sheetOpts.printArea.trim())) {
      errors.push("印刷範囲は A1 形式で指定してください (例: A1:D50)。");
    }
    if (sheetOpts.printTitleRows && !ROW_RANGE_RE.test(sheetOpts.printTitleRows.trim())) {
      errors.push("タイトル行は $1:$3 のような行範囲で指定してください。");
    }
    if (sheetOpts.printTitleCols && !COL_RANGE_RE.test(sheetOpts.printTitleCols.trim())) {
      errors.push("タイトル列は $A:$B のような列範囲で指定してください。");
    }
    if (
      sheetOpts.pageOrder !== undefined &&
      !PAGE_ORDERS.includes(sheetOpts.pageOrder)
    ) {
      errors.push("ページの順序が不正です。");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/** Header/footer quick-insert tokens (Excel-compatible). */
export const HEADER_FOOTER_TOKENS: ReadonlyArray<{ label: string; token: string }> = [
  { label: "ページ番号", token: "&[Page]" },
  { label: "総ページ数", token: "&[Pages]" },
  { label: "日付", token: "&[Date]" },
  { label: "時刻", token: "&[Time]" },
  { label: "ファイル名", token: "&[File]" },
  { label: "シート名", token: "&[Tab]" },
];

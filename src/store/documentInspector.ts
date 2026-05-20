// Pure helpers for Excel-style "Document Inspector" (File → Info → Inspect
// Document). Scans the workbook snapshot for items the user might want to
// scrub before sharing (hidden sheets, comments, personal info, hidden
// rows/cols, external links, preserved parts, file-level metadata) and
// offers per-category "strip" mutators that return a fresh snapshot object.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     name?: string;                          // workbook display name
//     creator?: string;                       // file-level metadata
//     lastModifiedBy?: string;
//     sheetOrder?: string[];                  // ordered sheet ids
//     _preservedParts?: Record<string, unknown>; // E1 preserved xlsx parts
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         _sheetState?: "hidden" | "veryHidden";
//         _comments?: Array<{ cell?: string; cellRef?: string;
//                             author?: string; text?: string; body?: string;
//                             createdAt?: string;
//                             replies?: Array<{ author?: string; body?: string }>;
//                             resolved?: boolean; resolvedBy?: string }>;
//         rowData?: Record<string, { h?: number; hd?: 0 | 1 }>;
//         columnData?: Record<string, { w?: number; hd?: 0 | 1 }>;
//         cellData?: Record<string, Record<string, { v?: unknown; f?: unknown }>>;
//         ...
//       }
//     }
//   }
//
// External-link detection (cellData.f):
//   - any formula referencing another workbook: `=[Book2.xlsx]Sheet1!A1`,
//     `='C:\path\[Book.xlsx]Sheet1'!A1`
//   - `=HYPERLINK("http://...", ...)` / `=HYPERLINK("https://...", ...)`
//
// All mutators return { snapshotMutated, strippedCount } and never mutate the
// input. The caller JSON.stringify's snapshotMutated back into the workbook
// store (EditorScreen.applyMutatedSnapshot wraps it in a Coco undo checkpoint).
//
// Kept side-effect free so it can be unit-tested without Univer.

export type InspectionCategory =
  | "hiddenSheets"
  | "comments"
  | "personalInfo"
  | "hiddenRowsCols"
  | "externalLinks"
  | "snapshots"
  | "preservedParts"
  | "metadata";

export interface InspectionItem {
  sheetId?: string;
  cellRef?: string;
  label: string;
}

export interface InspectionResult {
  category: InspectionCategory;
  count: number;
  items: InspectionItem[];
  description: string;
  /** false for categories surfaced read-only (e.g. snapshots managed in SQLite). */
  canStrip: boolean;
}

interface InspectorRowCol {
  h?: number;
  w?: number;
  hd?: 0 | 1;
  [k: string]: unknown;
}

interface InspectorComment {
  cell?: string;
  cellRef?: string;
  author?: string;
  text?: string;
  body?: string;
  createdAt?: string;
  replies?: Array<{ author?: string; body?: string; createdAt?: string }>;
  resolved?: boolean;
  resolvedBy?: string;
  [k: string]: unknown;
}

interface InspectorSheet {
  name?: string;
  _sheetState?: "hidden" | "veryHidden";
  _comments?: InspectorComment[];
  rowData?: Record<string, InspectorRowCol | undefined>;
  columnData?: Record<string, InspectorRowCol | undefined>;
  cellData?: Record<string, Record<string, { v?: unknown; f?: unknown } | undefined> | undefined>;
  [k: string]: unknown;
}

export interface InspectorSnapshot {
  name?: string;
  creator?: string;
  lastModifiedBy?: string;
  lastModified?: string;
  sheetOrder?: string[];
  sheets?: Record<string, InspectorSheet | undefined>;
  _preservedParts?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Snapshot parsing / cloning
// ---------------------------------------------------------------------------

function parseSnapshot(
  input: string | InspectorSnapshot | null | undefined,
): InspectorSnapshot | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "object") return input as InspectorSnapshot;
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as InspectorSnapshot;
  } catch {
    return null;
  }
}

// Deep clone via JSON round-trip. Snapshot is plain JSON anyway so this is
// safe and keeps the mutators simple (every per-sheet field is owned by the
// returned object — no aliasing back to the caller's snapshot).
function cloneSnapshot(snapshot: InspectorSnapshot): InspectorSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as InspectorSnapshot;
}

function getOrderedSheetIds(snapshot: InspectorSnapshot): string[] {
  if (Array.isArray(snapshot.sheetOrder) && snapshot.sheetOrder.length > 0) {
    return snapshot.sheetOrder.filter((id): id is string => typeof id === "string");
  }
  if (snapshot.sheets && typeof snapshot.sheets === "object") {
    return Object.keys(snapshot.sheets);
  }
  return [];
}

function sheetDisplayName(snapshot: InspectorSnapshot, sheetId: string): string {
  const s = snapshot.sheets?.[sheetId];
  const raw = s && typeof s.name === "string" ? s.name.trim() : "";
  return raw.length > 0 ? raw : sheetId;
}

// ---------------------------------------------------------------------------
// A1 helpers (purely for label rendering — column index → letters)
// ---------------------------------------------------------------------------

function colIndexToLetters(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// ---------------------------------------------------------------------------
// External-link detection
// ---------------------------------------------------------------------------

const EXTERNAL_BOOK_RE = /\[[^\]]+\.(?:xls[xm]?|xlsb|xltx|xltm)\]/i;
const HYPERLINK_HTTP_RE = /=\s*HYPERLINK\s*\(\s*(['"])\s*https?:\/\//i;

/**
 * Returns true when the formula references another workbook (e.g.
 * `=[Book2.xlsx]Sheet1!A1`) or is a `=HYPERLINK("http(s)://...")` call.
 * Tolerates non-string input by returning false.
 */
export function isExternalLinkFormula(formula: unknown): boolean {
  if (typeof formula !== "string") return false;
  const f = formula.trim();
  if (f.length === 0) return false;
  if (EXTERNAL_BOOK_RE.test(f)) return true;
  if (HYPERLINK_HTTP_RE.test(f)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

function inspectHiddenSheets(snapshot: InspectorSnapshot): InspectionResult {
  const items: InspectionItem[] = [];
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    const state = sheet?._sheetState;
    if (state === "hidden" || state === "veryHidden") {
      items.push({
        sheetId,
        label: `${sheetDisplayName(snapshot, sheetId)} (${state})`,
      });
    }
  }
  return {
    category: "hiddenSheets",
    count: items.length,
    items,
    description:
      "他のユーザーには見えない非表示のシートが含まれている可能性があります。",
    canStrip: true,
  };
}

function inspectComments(snapshot: InspectorSnapshot): InspectionResult {
  const items: InspectionItem[] = [];
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet || !Array.isArray(sheet._comments)) continue;
    const name = sheetDisplayName(snapshot, sheetId);
    for (const raw of sheet._comments) {
      if (!raw || typeof raw !== "object") continue;
      const ref =
        typeof raw.cellRef === "string"
          ? raw.cellRef
          : typeof raw.cell === "string"
          ? raw.cell
          : "";
      if (!ref) continue;
      items.push({ sheetId, cellRef: ref, label: `${name}!${ref}` });
    }
  }
  return {
    category: "comments",
    count: items.length,
    items,
    description: "セル コメント / 注釈が残っています。",
    canStrip: true,
  };
}

function inspectPersonalInfo(snapshot: InspectorSnapshot): InspectionResult {
  const authors = new Set<string>();
  const items: InspectionItem[] = [];
  // File-level metadata authors
  if (typeof snapshot.creator === "string" && snapshot.creator.trim()) {
    authors.add(snapshot.creator.trim());
  }
  if (typeof snapshot.lastModifiedBy === "string" && snapshot.lastModifiedBy.trim()) {
    authors.add(snapshot.lastModifiedBy.trim());
  }
  // Comment authors (top-level + replies + resolvedBy)
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet || !Array.isArray(sheet._comments)) continue;
    for (const c of sheet._comments) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.author === "string" && c.author.trim()) authors.add(c.author.trim());
      if (typeof c.resolvedBy === "string" && c.resolvedBy.trim())
        authors.add(c.resolvedBy.trim());
      if (Array.isArray(c.replies)) {
        for (const r of c.replies) {
          if (r && typeof r === "object" && typeof r.author === "string" && r.author.trim()) {
            authors.add(r.author.trim());
          }
        }
      }
    }
  }
  for (const name of Array.from(authors).sort((a, b) => a.localeCompare(b))) {
    items.push({ label: name });
  }
  return {
    category: "personalInfo",
    count: items.length,
    items,
    description:
      "ファイルやコメントに保存されている個人情報 (作成者名など) が見つかりました。",
    canStrip: true,
  };
}

function inspectHiddenRowsCols(snapshot: InspectorSnapshot): InspectionResult {
  const items: InspectionItem[] = [];
  let total = 0;
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet) continue;
    const name = sheetDisplayName(snapshot, sheetId);
    let rowHits = 0;
    if (sheet.rowData && typeof sheet.rowData === "object") {
      for (const rowKey of Object.keys(sheet.rowData)) {
        const r = sheet.rowData[rowKey];
        if (r && typeof r === "object" && r.hd === 1) rowHits++;
      }
    }
    let colHits = 0;
    if (sheet.columnData && typeof sheet.columnData === "object") {
      for (const colKey of Object.keys(sheet.columnData)) {
        const c = sheet.columnData[colKey];
        if (c && typeof c === "object" && c.hd === 1) colHits++;
      }
    }
    if (rowHits === 0 && colHits === 0) continue;
    total += rowHits + colHits;
    // Surface a sheet-level summary item so jump-to lands the user on the
    // sheet — individual row/col indices are too granular for a single
    // "Inspect" click.
    items.push({
      sheetId,
      cellRef: "A1",
      label: `${name} — 非表示行 ${rowHits} 件 / 非表示列 ${colHits} 件`,
    });
  }
  return {
    category: "hiddenRowsCols",
    count: total,
    items,
    description: "非表示の行 / 列が含まれています。",
    canStrip: true,
  };
}

function inspectExternalLinks(snapshot: InspectorSnapshot): InspectionResult {
  const items: InspectionItem[] = [];
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet || !sheet.cellData || typeof sheet.cellData !== "object") continue;
    const name = sheetDisplayName(snapshot, sheetId);
    for (const rowKey of Object.keys(sheet.cellData)) {
      const rowNum = Number(rowKey);
      if (!Number.isFinite(rowNum)) continue;
      const rowObj = sheet.cellData[rowKey];
      if (!rowObj || typeof rowObj !== "object") continue;
      for (const colKey of Object.keys(rowObj)) {
        const colNum = Number(colKey);
        if (!Number.isFinite(colNum)) continue;
        const cell = rowObj[colKey];
        if (!cell || typeof cell !== "object") continue;
        if (!isExternalLinkFormula(cell.f)) continue;
        const ref = `${colIndexToLetters(colNum)}${rowNum + 1}`;
        items.push({ sheetId, cellRef: ref, label: `${name}!${ref}` });
      }
    }
  }
  return {
    category: "externalLinks",
    count: items.length,
    items,
    description: "外部ブックや Web URL を参照する数式が含まれています。",
    canStrip: true,
  };
}

function inspectSnapshots(): InspectionResult {
  // Snapshots live in the Tauri-managed SQLite store; the frontend can't
  // enumerate them here without an async backend call. We expose the
  // category as a read-only reminder so users know to clear via the
  // Snapshot History dialog if desired.
  return {
    category: "snapshots",
    count: 0,
    items: [],
    description:
      "Coco スナップショット履歴は SQLite で管理されています。履歴ダイアログから個別に削除してください。",
    canStrip: false,
  };
}

function inspectPreservedParts(snapshot: InspectorSnapshot): InspectionResult {
  const pp = snapshot._preservedParts;
  const items: InspectionItem[] = [];
  let count = 0;
  if (pp && typeof pp === "object") {
    for (const key of Object.keys(pp)) {
      count++;
      items.push({ label: key });
    }
  }
  return {
    category: "preservedParts",
    count,
    items,
    description:
      "Coco が認識しないカスタム XML / 保持パーツが含まれています (チャート, ピボット, 画像など)。",
    canStrip: true,
  };
}

function inspectMetadata(snapshot: InspectorSnapshot): InspectionResult {
  const items: InspectionItem[] = [];
  if (typeof snapshot.name === "string" && snapshot.name.trim()) {
    items.push({ label: `name: ${snapshot.name.trim()}` });
  }
  if (typeof snapshot.creator === "string" && snapshot.creator.trim()) {
    items.push({ label: `creator: ${snapshot.creator.trim()}` });
  }
  if (typeof snapshot.lastModifiedBy === "string" && snapshot.lastModifiedBy.trim()) {
    items.push({ label: `lastModifiedBy: ${snapshot.lastModifiedBy.trim()}` });
  }
  if (typeof snapshot.lastModified === "string" && snapshot.lastModified.trim()) {
    items.push({ label: `lastModified: ${snapshot.lastModified.trim()}` });
  }
  return {
    category: "metadata",
    count: items.length,
    items,
    description: "ブック メタデータ (作成者 / 最終更新者など) が記録されています。",
    canStrip: true,
  };
}

/**
 * Run every inspection category over the snapshot. Returns an ordered list
 * (same order as InspectionCategory union, top-to-bottom in the dialog).
 *
 * Accepts either a snapshot JSON string or a pre-parsed snapshot object so
 * callers that already hold the parsed shape don't pay a re-parse cost.
 * Returns an empty list for null/malformed input so the dialog can render
 * unconditionally.
 */
export function inspectDocument(
  snapshot: string | InspectorSnapshot | null | undefined,
): InspectionResult[] {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return [];
  return [
    inspectHiddenSheets(parsed),
    inspectComments(parsed),
    inspectPersonalInfo(parsed),
    inspectHiddenRowsCols(parsed),
    inspectExternalLinks(parsed),
    inspectSnapshots(),
    inspectPreservedParts(parsed),
    inspectMetadata(parsed),
  ];
}

// ---------------------------------------------------------------------------
// Strip mutators
// ---------------------------------------------------------------------------

function stripHiddenSheets(snapshot: InspectorSnapshot): number {
  let count = 0;
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet) continue;
    if (sheet._sheetState === "hidden" || sheet._sheetState === "veryHidden") {
      // MVP: unhide rather than delete — deletion is destructive and the
      // user can still drop the sheet manually if desired.
      delete sheet._sheetState;
      count++;
    }
  }
  return count;
}

function stripComments(snapshot: InspectorSnapshot): number {
  let count = 0;
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet || !Array.isArray(sheet._comments)) continue;
    count += sheet._comments.length;
    sheet._comments = [];
  }
  return count;
}

function stripPersonalInfo(snapshot: InspectorSnapshot): number {
  let count = 0;
  if (typeof snapshot.creator === "string" && snapshot.creator.trim()) {
    snapshot.creator = "";
    count++;
  }
  if (typeof snapshot.lastModifiedBy === "string" && snapshot.lastModifiedBy.trim()) {
    snapshot.lastModifiedBy = "";
    count++;
  }
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet || !Array.isArray(sheet._comments)) continue;
    for (const c of sheet._comments) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.author === "string" && c.author.trim()) {
        c.author = "";
        count++;
      }
      if (typeof c.resolvedBy === "string" && c.resolvedBy.trim()) {
        c.resolvedBy = "";
        count++;
      }
      if (Array.isArray(c.replies)) {
        for (const r of c.replies) {
          if (r && typeof r === "object" && typeof r.author === "string" && r.author.trim()) {
            r.author = "";
            count++;
          }
        }
      }
    }
  }
  return count;
}

function stripHiddenRowsCols(snapshot: InspectorSnapshot): number {
  let count = 0;
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet) continue;
    if (sheet.rowData && typeof sheet.rowData === "object") {
      for (const rowKey of Object.keys(sheet.rowData)) {
        const r = sheet.rowData[rowKey];
        if (r && typeof r === "object" && r.hd === 1) {
          delete r.hd;
          count++;
        }
      }
    }
    if (sheet.columnData && typeof sheet.columnData === "object") {
      for (const colKey of Object.keys(sheet.columnData)) {
        const c = sheet.columnData[colKey];
        if (c && typeof c === "object" && c.hd === 1) {
          delete c.hd;
          count++;
        }
      }
    }
  }
  return count;
}

// Pull the display text out of a HYPERLINK call: the second argument when
// present, otherwise the URL itself. Falls back to empty string when we
// can't parse the formula confidently.
function hyperlinkDisplayText(formula: string): string {
  // =HYPERLINK("url"[, "display"])
  const m = /=\s*HYPERLINK\s*\(\s*(['"])([^'"]*)\1\s*(?:,\s*(['"])([^'"]*)\3\s*)?\)/i.exec(
    formula,
  );
  if (!m) return "";
  return (m[4] ?? m[2] ?? "").trim();
}

function stripExternalLinks(snapshot: InspectorSnapshot): number {
  let count = 0;
  for (const sheetId of getOrderedSheetIds(snapshot)) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet || !sheet.cellData || typeof sheet.cellData !== "object") continue;
    for (const rowKey of Object.keys(sheet.cellData)) {
      const rowObj = sheet.cellData[rowKey];
      if (!rowObj || typeof rowObj !== "object") continue;
      for (const colKey of Object.keys(rowObj)) {
        const cell = rowObj[colKey];
        if (!cell || typeof cell !== "object") continue;
        if (!isExternalLinkFormula(cell.f)) continue;
        const f = String(cell.f);
        if (HYPERLINK_HTTP_RE.test(f)) {
          // Replace =HYPERLINK("http...", "label") with the label / url
          // as a literal string so the cell still reads meaningfully.
          const display = hyperlinkDisplayText(f);
          delete cell.f;
          cell.v = display;
        } else {
          // External book reference — clear formula and value so no stale
          // computed value misleads the reader.
          delete cell.f;
          cell.v = "";
        }
        count++;
      }
    }
  }
  return count;
}

function stripPreservedParts(snapshot: InspectorSnapshot): number {
  if (!snapshot._preservedParts || typeof snapshot._preservedParts !== "object") return 0;
  const count = Object.keys(snapshot._preservedParts).length;
  delete snapshot._preservedParts;
  return count;
}

function stripMetadata(snapshot: InspectorSnapshot): number {
  let count = 0;
  if (typeof snapshot.creator === "string" && snapshot.creator.trim()) {
    snapshot.creator = "";
    count++;
  }
  if (typeof snapshot.lastModifiedBy === "string" && snapshot.lastModifiedBy.trim()) {
    snapshot.lastModifiedBy = "";
    count++;
  }
  if (typeof snapshot.lastModified === "string" && snapshot.lastModified.trim()) {
    snapshot.lastModified = "";
    count++;
  }
  return count;
}

/**
 * Strip every occurrence of a single category from the snapshot.
 *
 * Returns `{ snapshotMutated, strippedCount }`:
 *   - snapshotMutated: a fresh snapshot object (deep clone, never aliased
 *     back to the caller). The caller JSON.stringify's it back into the
 *     workbook store via applyMutatedSnapshot to get a Coco undo checkpoint.
 *   - strippedCount: number of individual items removed.
 *
 * Snapshots are tracked by the Tauri-managed SQLite layer; "snapshots"
 * here is a no-op (canStrip=false). All other categories mutate the
 * snapshot in-place on the clone and return the count.
 *
 * Tolerates malformed input by returning `{ snapshotMutated: {}, strippedCount: 0 }`.
 */
export function stripCategory(
  snapshot: string | InspectorSnapshot | null | undefined,
  category: InspectionCategory,
): { snapshotMutated: InspectorSnapshot; strippedCount: number } {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return { snapshotMutated: {}, strippedCount: 0 };
  const next = cloneSnapshot(parsed);

  let strippedCount = 0;
  switch (category) {
    case "hiddenSheets":
      strippedCount = stripHiddenSheets(next);
      break;
    case "comments":
      strippedCount = stripComments(next);
      break;
    case "personalInfo":
      strippedCount = stripPersonalInfo(next);
      break;
    case "hiddenRowsCols":
      strippedCount = stripHiddenRowsCols(next);
      break;
    case "externalLinks":
      strippedCount = stripExternalLinks(next);
      break;
    case "snapshots":
      // Managed in the SQLite layer; nothing to do here.
      strippedCount = 0;
      break;
    case "preservedParts":
      strippedCount = stripPreservedParts(next);
      break;
    case "metadata":
      strippedCount = stripMetadata(next);
      break;
  }
  return { snapshotMutated: next, strippedCount };
}

// Pure helpers for the "Formula Audit" feature set (Show Formulas,
// Error Indicators sidebar, and Error Checking dialog).
//
// Snapshot shape (Univer 0.5.x + Coco extension) the helpers walk:
//   {
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;       // computed / display value
//               f?: string;        // formula text (without leading "=")
//               s?: ...            // style ref or inline IStyleData
//               p?: ...            // rich-text paragraph
//             }
//           }
//         }
//       }
//     }
//   }
//
// All exports here are pure (no DOM, no Univer dependency) so the rest of
// the audit feature can call them from snapshot patches, the indicators
// panel, and the dialog without dragging in render-time state.

/**
 * The eight Excel error tokens. Cell values are matched verbatim against
 * this list (case-sensitive — Excel itself writes them in uppercase).
 *
 * Note: `#GETTING_DATA` and `#CALC!` exist in newer Excel builds but are
 * intentionally omitted from the MVP — Coco doesn't currently emit them
 * and the auditor only needs to cover what our formula engine produces.
 */
export const ERROR_VALUES: readonly string[] = [
  "#DIV/0!",
  "#N/A",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#VALUE!",
  "#NULL!",
  "#SPILL!",
] as const;

/** Display-prefix prepended to a cell's `v` by patchErrorIndicators. Re-used
 *  by the panel for "strip the marker" presentation and by the patch itself
 *  to keep the prefix step idempotent. */
export const ERROR_PREFIX = "⚠ ";

/** Red font color applied by patchErrorIndicators. Matches Excel's
 *  "Bad" preset closely enough to read as an error without theming work. */
export const ERROR_FONT_COLOR = "#C00000";

/**
 * True when `v` is one of the eight Excel error tokens. Tolerates
 * non-string values (returns false) so callers don't have to pre-narrow.
 * Strips the optional ERROR_PREFIX we add in patchErrorIndicators so the
 * predicate stays true after a second-pass walk over a patched snapshot
 * (idempotence helper for `collectAuditIssues`).
 */
export function isErrorValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const stripped = v.startsWith(ERROR_PREFIX) ? v.slice(ERROR_PREFIX.length) : v;
  return ERROR_VALUES.includes(stripped);
}

/**
 * A single issue the auditor surfaced. The `kind` field is currently
 * "error-value" only; the broader Excel set ("inconsistent-formula",
 * "number-as-text", "refers-to-empty") is reserved here so callers can
 * pattern-match without churning when those detectors land.
 */
export interface AuditIssue {
  sheetId: string;
  sheetName: string;
  /** A1 cell ref, e.g. "B12". Always uppercase column letters. */
  cellRef: string;
  /** Detector kind — MVP emits "error-value" only. */
  kind: "error-value";
  /** Detector-specific detail — for "error-value" this is the error token
   *  (e.g. "#DIV/0!") so the panel + dialog can show what went wrong. */
  detail: string;
}

type Snapshot = {
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<string, Record<string, { v?: unknown } | undefined>>;
      }
    | undefined
  >;
  sheetOrder?: string[];
};

/** 0-based column index → A1 column letters ("A", "AA", "AAA", ...). */
function colIndexToLetters(col: number): string {
  if (!Number.isFinite(col) || col < 0) return "A";
  let n = Math.floor(col) + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Compose an A1 ref from 0-based (row, col). */
export function toA1Ref(row: number, col: number): string {
  const r = Math.max(0, Math.floor(row)) + 1;
  return `${colIndexToLetters(col)}${r}`;
}

/**
 * Walk every cell in every sheet of the snapshot and return one AuditIssue
 * per cell whose value reads as an Excel error token. Order: by sheet
 * (snapshot `sheetOrder` when present, otherwise object-key order) then
 * row-major within the sheet so the dialog's Previous/Next iteration
 * follows a visually sensible path.
 *
 * Tolerates a malformed / partial snapshot — returns [] in the failure
 * cases rather than throwing, matching the rest of Coco's best-effort
 * snapshot patches.
 */
export function collectAuditIssues(snapshot: unknown): AuditIssue[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const snap = snapshot as Snapshot;
  const sheets = snap.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  // Prefer the snapshot's declared sheet order so the dialog steps through
  // the workbook in the same order the user sees in the tabs strip.
  const orderedIds = Array.isArray(snap.sheetOrder) && snap.sheetOrder.length > 0
    ? snap.sheetOrder.filter((id) => typeof id === "string" && id in sheets)
    : Object.keys(sheets);

  const out: AuditIssue[] = [];
  for (const sheetId of orderedIds) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const cellData = sheet.cellData;
    if (!cellData || typeof cellData !== "object") continue;
    const sheetName = typeof sheet.name === "string" && sheet.name.length > 0
      ? sheet.name
      : sheetId;

    // Numeric-sort row & col keys so the visit order is row-major (top-left
    // first) — Object.keys order on integer-like keys is implementation-
    // defined-but-numeric in practice, but we sort explicitly to be safe.
    const rowKeys = Object.keys(cellData)
      .map((k) => ({ k, n: Number.parseInt(k, 10) }))
      .filter((x) => Number.isFinite(x.n) && x.n >= 0)
      .sort((a, b) => a.n - b.n);

    for (const { k: rowKey, n: row } of rowKeys) {
      const rowObj = cellData[rowKey];
      if (!rowObj || typeof rowObj !== "object") continue;
      const colKeys = Object.keys(rowObj)
        .map((k) => ({ k, n: Number.parseInt(k, 10) }))
        .filter((x) => Number.isFinite(x.n) && x.n >= 0)
        .sort((a, b) => a.n - b.n);
      for (const { k: colKey, n: col } of colKeys) {
        const cell = rowObj[colKey];
        if (!cell || typeof cell !== "object") continue;
        if (!isErrorValue(cell.v)) continue;
        // Strip the marker prefix so the recorded detail is the raw error
        // token even after patchErrorIndicators has run.
        const raw = typeof cell.v === "string" ? cell.v : "";
        const detail = raw.startsWith(ERROR_PREFIX)
          ? raw.slice(ERROR_PREFIX.length)
          : raw;
        out.push({
          sheetId,
          sheetName,
          cellRef: toA1Ref(row, col),
          kind: "error-value",
          detail,
        });
      }
    }
  }
  return out;
}

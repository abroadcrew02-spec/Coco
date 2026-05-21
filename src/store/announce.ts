// Screen-reader announcement helpers (issue #177 — follow-up to #155).
//
// Two concerns live here:
//   1. Pure message builders that turn editor events (cell selection,
//      edit-mode changes, save status, errors) into localized strings.
//      Side-effect free so they are trivially unit-testable.
//   2. A tiny pub/sub channel the `<LiveRegion>` component subscribes to so
//      any part of the app can push an announcement without prop-drilling.
//
// The actual ARIA `aria-live` element is rendered by `<LiveRegion>`; this
// module never touches the DOM. `politeness` selects which live region the
// message lands in: "polite" waits for the screen reader to be idle,
// "assertive" interrupts (used for errors).

import { t } from "../i18n/locale";

export type Politeness = "polite" | "assertive";

export interface Announcement {
  /** The text the screen reader should speak. */
  message: string;
  /** Which live region to route through. */
  politeness: Politeness;
  /** Monotonic id so identical consecutive messages still re-announce. */
  token: number;
}

// --- Pure message builders --------------------------------------------------

/**
 * Convert a 0-based column index to its spreadsheet letter (0 -> A, 26 -> AA).
 * Mirrors the A1 conventions used elsewhere in the codebase.
 */
export function columnLetter(colIndex: number): string {
  if (!Number.isInteger(colIndex) || colIndex < 0) return "";
  let n = colIndex;
  let label = "";
  do {
    label = String.fromCharCode((n % 26) + 65) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * Format a raw cell value for speech. Empty / blank cells become the localized
 * "empty cell" phrase so the screen reader still says something meaningful.
 */
export function describeCellValue(value: unknown): string {
  if (value === null || value === undefined) return t("a11y.cell.empty");
  if (typeof value === "string") {
    return value.trim() === "" ? t("a11y.cell.empty") : value;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : t("a11y.cell.empty");
  }
  // Univer ICellData wrapper ({ v, f, ... }).
  if (typeof value === "object") {
    return describeCellValue((value as { v?: unknown }).v);
  }
  return String(value);
}

/**
 * Build the "column X row Y: value" announcement spoken when the active cell
 * moves. `rowIndex` / `colIndex` are 0-based (as Univer reports them); the
 * spoken row number is 1-based to match the grid headers.
 */
export function buildCellAnnouncement(
  rowIndex: number,
  colIndex: number,
  value: unknown,
): string {
  const col = columnLetter(colIndex);
  const row = rowIndex + 1;
  return t("a11y.cell.position", col, row, describeCellValue(value));
}

/**
 * Build the announcement for a multi-cell selection ("range A1:C4 selected,
 * N cells").
 */
export function buildRangeAnnouncement(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const a1 = `${columnLetter(startCol)}${startRow + 1}`;
  const b1 = `${columnLetter(endCol)}${endRow + 1}`;
  const cells =
    (Math.abs(endRow - startRow) + 1) * (Math.abs(endCol - startCol) + 1);
  return t("a11y.range.selected", `${a1}:${b1}`, cells);
}

export type EditModeEvent = "start" | "commit" | "cancel";

/** Build the announcement for entering / leaving cell edit mode. */
export function buildEditModeAnnouncement(event: EditModeEvent): string {
  switch (event) {
    case "start":
      return t("a11y.edit.start");
    case "commit":
      return t("a11y.edit.commit");
    case "cancel":
      return t("a11y.edit.cancel");
  }
}

// --- Live-region pub/sub channel -------------------------------------------

type Listener = (announcement: Announcement) => void;

const listeners = new Set<Listener>();
let tokenCounter = 0;

/**
 * Subscribe to announcements. The `<LiveRegion>` component is the primary
 * subscriber. Returns an unsubscribe function.
 */
export function subscribeAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Push a message to the live region(s). No-ops gracefully when there are no
 * subscribers (e.g. before the editor mounts).
 */
export function announce(
  message: string,
  politeness: Politeness = "polite",
): void {
  if (!message) return;
  tokenCounter += 1;
  const payload: Announcement = { message, politeness, token: tokenCounter };
  for (const listener of listeners) {
    listener(payload);
  }
}

/** Convenience: announce an error string through the assertive region. */
export function announceError(message: string): void {
  announce(message, "assertive");
}

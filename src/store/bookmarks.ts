// Pure helpers + localStorage persistence for the "Bookmarks" feature.
//
// Bookmarks are personal navigation aids — named jump points to specific
// cells/ranges across a workbook. They live in localStorage (NOT the
// workbook snapshot) so they're per-user-per-workbook and don't pollute
// the xlsx round-trip. Mirrors the watchList.ts pattern but keyed by
// workbook id so different files have separate bookmark lists.
//
// Storage key: `coco.bookmarks.<workbookId>` — the EditorScreen derives
// the id from `currentHandle?.path` (fallback "default") so each opened
// file gets its own list.
//
// Kept side-effect-free (apart from localStorage I/O in the two load/save
// helpers) so the panel and any future menu action can reuse the same code.

export interface BookmarkEntry {
  /** Stable id for React keys + removal. Generated at add-time. */
  id: string;
  /** Human-readable label, chosen by the user. */
  label: string;
  /** Univer subUnitId for the target sheet. */
  sheetId: string;
  /** A1 cell reference, e.g. "B12". Always uppercase column letters. */
  cellRef: string;
  /** Optional color tag (hex like "#ef4444") rendered as a dot next to
   *  the label. Undefined means "no color". */
  color?: string;
  /** ISO 8601 timestamp captured at add-time. Used for ordering and
   *  display ("3 minutes ago" — future enhancement). */
  createdAt: string;
}

export const LOCAL_STORAGE_KEY_PREFIX = "coco.bookmarks.";

function storageKey(workbookId: string): string {
  return `${LOCAL_STORAGE_KEY_PREFIX}${workbookId}`;
}

/** Read the persisted bookmark list for a workbook. Returns [] on any
 *  failure (missing key, malformed JSON, wrong shape) so the caller can
 *  render an empty panel without crashing. */
export function loadBookmarks(workbookId: string): BookmarkEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(storageKey(workbookId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: BookmarkEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const e = item as Partial<BookmarkEntry>;
      if (
        typeof e.id !== "string" ||
        typeof e.label !== "string" ||
        typeof e.sheetId !== "string" ||
        typeof e.cellRef !== "string" ||
        typeof e.createdAt !== "string"
      ) {
        continue;
      }
      const entry: BookmarkEntry = {
        id: e.id,
        label: e.label,
        sheetId: e.sheetId,
        cellRef: e.cellRef,
        createdAt: e.createdAt,
      };
      if (typeof e.color === "string" && e.color.length > 0) {
        entry.color = e.color;
      }
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/** Best-effort persist. Swallows quota / sandbox errors so the UI flow
 *  isn't interrupted by storage failures (the panel still updates in
 *  memory; the list just won't survive a reload). */
export function saveBookmarks(workbookId: string, list: BookmarkEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(storageKey(workbookId), JSON.stringify(list));
  } catch {
    // Ignore — see comment above.
  }
}

// Generate a reasonably-unique id without pulling in crypto.randomUUID
// (which is unavailable in some older webview contexts). Time + counter
// is enough since adds are user-paced.
let idCounter = 0;
function makeId(): string {
  idCounter = (idCounter + 1) & 0xffff;
  return `b-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Generate a per-session workbook id used to namespace bookmarks when no
 * stable path is available (e.g. a brand-new untitled workbook). Falls back
 * to a time + random suffix when `crypto.randomUUID` is unavailable so the
 * helper never throws in older webview contexts.
 *
 * Intended use: the EditorScreen integrator calls this once when opening or
 * creating a workbook without a `currentHandle?.path` and threads the
 * returned id through `loadBookmarks` / `saveBookmarks`. This replaces the
 * previous `"default"` literal that caused different untitled workbooks to
 * bleed into one another's bookmark lists (issue #109).
 */
export function generateWorkbookSessionId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto && typeof g.crypto.randomUUID === "function") {
      return `session-${g.crypto.randomUUID()}`;
    }
  } catch {
    // fall through to the deterministic fallback below.
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `session-${Date.now().toString(36)}-${rand}`;
}

/**
 * Append a new bookmark. Unlike addWatch we do NOT dedupe on
 * (sheetId, cellRef) — a user might bookmark the same cell with two
 * different labels ("Q4 total", "needs review") and we shouldn't merge
 * those. The cellRef is uppercased so display stays consistent.
 */
export function addBookmark(
  list: BookmarkEntry[],
  entry: Omit<BookmarkEntry, "id" | "createdAt">,
): BookmarkEntry[] {
  const cellRef = entry.cellRef.toUpperCase();
  const next: BookmarkEntry = {
    ...entry,
    cellRef,
    id: makeId(),
    createdAt: new Date().toISOString(),
  };
  // Drop an empty/whitespace color so we don't persist "" sentinel.
  if (next.color !== undefined && next.color.trim().length === 0) {
    delete next.color;
  }
  return [...list, next];
}

/** Remove the entry whose id matches. Returns the original list reference
 *  when no entry matched (so React can skip the re-render). */
export function removeBookmark(list: BookmarkEntry[], id: string): BookmarkEntry[] {
  const next = list.filter((e) => e.id !== id);
  return next.length === list.length ? list : next;
}

/** Rename a bookmark's label. Returns the original list reference when
 *  the id isn't found or the label is unchanged so React can short-circuit. */
export function renameBookmark(
  list: BookmarkEntry[],
  id: string,
  label: string,
): BookmarkEntry[] {
  let changed = false;
  const next = list.map((e) => {
    if (e.id !== id) return e;
    if (e.label === label) return e;
    changed = true;
    return { ...e, label };
  });
  return changed ? next : list;
}

/** Set or clear a bookmark's color tag. Pass `null` to clear, a hex
 *  string to set. Returns the original list reference when nothing
 *  actually changed. */
export function setColor(
  list: BookmarkEntry[],
  id: string,
  color: string | null,
): BookmarkEntry[] {
  let changed = false;
  const next = list.map((e) => {
    if (e.id !== id) return e;
    if (color === null || color.trim().length === 0) {
      if (e.color === undefined) return e;
      const copy = { ...e };
      delete copy.color;
      changed = true;
      return copy;
    }
    if (e.color === color) return e;
    changed = true;
    return { ...e, color };
  });
  return changed ? next : list;
}

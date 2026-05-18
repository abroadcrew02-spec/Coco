// Pure helpers + localStorage persistence for the "Watch Window" feature.
//
// Mirrors Excel's Watch Window: a floating panel listing user-pinned cells
// with their current computed value and formula, regardless of which sheet
// is active. Persists to localStorage under `coco.watchList` so the list
// survives reloads.
//
// Snapshot shape walked by readCellSnapshot (Univer 0.5.x + Coco extension —
// same one formulaAudit.ts / dataValidation.ts use):
//   {
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;       // computed / display value
//               f?: string;        // formula text (without leading "=")
//             }
//           }
//         }
//       }
//     }
//   }
//
// Kept side-effect-free (apart from localStorage I/O in the two load/save
// helpers) so the panel and any future menu action can reuse the same code.

export interface WatchEntry {
  /** Stable id for React keys + removal. Generated at add-time. */
  id: string;
  /** Univer subUnitId for the target sheet. */
  sheetId: string;
  /** Human-readable sheet name, captured at add-time. Refreshed on render
   *  via the snapshot when available, but this is the fallback when the
   *  sheet has since been renamed or deleted. */
  sheetName: string;
  /** A1 cell reference, e.g. "B12". Always uppercase column letters. */
  cellRef: string;
}

export const LOCAL_STORAGE_KEY = "coco.watchList";

/** Read the persisted watch list. Returns [] on any failure (missing key,
 *  malformed JSON, wrong shape) so the caller can render an empty panel
 *  without crashing. */
export function loadWatchList(): WatchEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: WatchEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const e = item as Partial<WatchEntry>;
      if (
        typeof e.id !== "string" ||
        typeof e.sheetId !== "string" ||
        typeof e.sheetName !== "string" ||
        typeof e.cellRef !== "string"
      ) {
        continue;
      }
      out.push({ id: e.id, sheetId: e.sheetId, sheetName: e.sheetName, cellRef: e.cellRef });
    }
    return out;
  } catch {
    return [];
  }
}

/** Best-effort persist. Swallows quota / sandbox errors so the UI flow
 *  isn't interrupted by storage failures (the panel still updates in
 *  memory; the list just won't survive a reload). */
export function saveWatchList(list: WatchEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
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
  return `w-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Append a new watch entry, deduplicating by (sheetId, cellRef). If a
 * matching entry already exists the list is returned unchanged so React's
 * referential-equality short-circuits and the panel doesn't re-render.
 * The cellRef is uppercased so "a1" and "A1" dedup correctly.
 */
export function addWatch(
  list: WatchEntry[],
  entry: Omit<WatchEntry, "id">,
): WatchEntry[] {
  const cellRef = entry.cellRef.toUpperCase();
  for (const existing of list) {
    if (existing.sheetId === entry.sheetId && existing.cellRef.toUpperCase() === cellRef) {
      return list;
    }
  }
  return [...list, { ...entry, cellRef, id: makeId() }];
}

/** Remove the entry whose id matches. Returns the original list reference
 *  when no entry matched (so React can skip the re-render). */
export function removeWatch(list: WatchEntry[], id: string): WatchEntry[] {
  const next = list.filter((e) => e.id !== id);
  return next.length === list.length ? list : next;
}

// --- snapshot lookup ---------------------------------------------------

type CellSnapshot = {
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<string, Record<string, { v?: unknown; f?: unknown } | undefined>>;
      }
    | undefined
  >;
};

/** 0-based column letters ("A", "AA") → numeric index. Returns -1 on
 *  malformed input so callers can fail-safe (panel just shows "-"). */
function colLettersToIndex(letters: string): number {
  if (!letters) return -1;
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const c = letters.charCodeAt(i);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Split an A1 ref like "B12" or "$AA$3" into (row, col), both 0-based.
 *  Returns null on malformed input. */
function parseA1(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const col = colLettersToIndex(m[1].toUpperCase());
  const row = Number.parseInt(m[2], 10) - 1;
  if (col < 0 || !Number.isFinite(row) || row < 0) return null;
  return { row, col };
}

/**
 * Look up the watched cell's current state from a workbook snapshot.
 * Returns `{ value: undefined, formula: null }` when the cell is missing,
 * the sheet is gone, or the snapshot is malformed — the panel renders
 * these as "(空)" / "—" so the user can see the watch is alive but the
 * target is empty.
 *
 * The formula is returned with a leading "=" prepended (Univer stores
 * formula text without the equals sign in `f`) so the panel can show it
 * the way the user would type it.
 */
export function readCellSnapshot(
  snapshot: unknown,
  sheetId: string,
  cellRef: string,
): { value: unknown; formula: string | null } {
  if (!snapshot || typeof snapshot !== "object") {
    return { value: undefined, formula: null };
  }
  const snap = snapshot as CellSnapshot;
  const sheet = snap.sheets?.[sheetId];
  if (!sheet || typeof sheet !== "object") {
    return { value: undefined, formula: null };
  }
  const cellData = sheet.cellData;
  if (!cellData || typeof cellData !== "object") {
    return { value: undefined, formula: null };
  }
  const parsed = parseA1(cellRef);
  if (!parsed) return { value: undefined, formula: null };
  const rowObj = cellData[String(parsed.row)];
  if (!rowObj || typeof rowObj !== "object") {
    return { value: undefined, formula: null };
  }
  const cell = rowObj[String(parsed.col)];
  if (!cell || typeof cell !== "object") {
    return { value: undefined, formula: null };
  }
  const formula =
    typeof cell.f === "string" && cell.f.length > 0 ? `=${cell.f}` : null;
  return { value: cell.v, formula };
}

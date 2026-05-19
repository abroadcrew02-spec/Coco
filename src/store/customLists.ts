// Pure helpers for Excel-style "Custom Lists". A custom list is an ordered
// sequence of strings (e.g. ["Mon","Tue","Wed",...]) that powers drag-to-fill
// autocompletion: dropping "Mon" into A1 and dragging down auto-fills the
// remaining members. Coco's MVP wires the list into a settings-style dialog
// and exposes an "Apply List" action that writes the members into a target
// range starting from the active cell.
//
// Storage shape (localStorage key `coco.customLists`):
//   [
//     { id: "list-…", name: "四半期", items: ["Q1","Q2","Q3","Q4"] },
//     ...
//   ]
//
// Built-in lists (BUILTIN_LISTS) are merged in at read time but are NOT
// persisted — users can override the name by saving a list with the same
// items, but cannot delete the built-ins. The dialog enforces that.
//
// Kept side-effect free (apart from localStorage IO, which is gated behind
// try/catch so private-mode and SSR don't throw) so the helper can be unit
// tested without React or Univer.

export interface CustomList {
  id: string;
  name: string;
  items: string[];
}

export const LOCAL_STORAGE_KEY = "coco.customLists";

// Built-ins mirror Excel's default custom lists: weekdays (en short/long),
// months (en short/long), Japanese weekdays (short/long), kanji numerals,
// and a few business-friendly extras (Q1..Q4, A..E). Keep ids stable so
// later versions can patch built-ins without breaking persisted overrides.
export const BUILTIN_LISTS: readonly CustomList[] = [
  {
    id: "builtin-weekday-en-short",
    name: "Mon, Tue, Wed, …",
    items: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  },
  {
    id: "builtin-weekday-en-long",
    name: "Monday, Tuesday, …",
    items: [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ],
  },
  {
    id: "builtin-month-en-short",
    name: "Jan, Feb, Mar, …",
    items: [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ],
  },
  {
    id: "builtin-month-en-long",
    name: "January, February, …",
    items: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
  },
  {
    id: "builtin-weekday-ja-short",
    name: "月, 火, 水, …",
    items: ["月", "火", "水", "木", "金", "土", "日"],
  },
  {
    id: "builtin-weekday-ja-long",
    name: "日曜日, 月曜日, …",
    items: [
      "日曜日",
      "月曜日",
      "火曜日",
      "水曜日",
      "木曜日",
      "金曜日",
      "土曜日",
    ],
  },
  {
    id: "builtin-kanji-numerals",
    name: "一, 二, 三, …",
    items: ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"],
  },
  {
    id: "builtin-quarter",
    name: "Q1, Q2, Q3, Q4",
    items: ["Q1", "Q2", "Q3", "Q4"],
  },
  {
    id: "builtin-quarter-ja",
    name: "第1四半期, 第2四半期, …",
    items: ["第1四半期", "第2四半期", "第3四半期", "第4四半期"],
  },
  {
    id: "builtin-alphabet-upper",
    name: "A, B, C, …",
    items: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
  },
];

/**
 * Read user-defined lists from localStorage. Returns an empty array when the
 * key is missing, the JSON is malformed, the payload is the wrong shape, or
 * localStorage itself throws (private/sandbox mode). Built-ins are NOT
 * included here — callers should concatenate via `BUILTIN_LISTS` when they
 * need the full set.
 */
export function loadCustomLists(): CustomList[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CustomList[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || !e.id) continue;
      if (typeof e.name !== "string") continue;
      if (!Array.isArray(e.items)) continue;
      const items = e.items
        .filter((x): x is string => typeof x === "string")
        .map((s) => s);
      out.push({ id: e.id, name: e.name, items });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Persist user-defined lists to localStorage. Silently swallows IO errors
 * (private mode, quota exceeded) — the caller already holds the in-memory
 * copy so a failed write only loses persistence, not the active edit.
 * Built-in ids are filtered out as a safety net so a misuse can't shadow
 * the canonical built-ins on next reload.
 */
export function saveCustomLists(lists: CustomList[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    const builtinIds = new Set(BUILTIN_LISTS.map((l) => l.id));
    const cleaned = lists.filter((l) => !builtinIds.has(l.id));
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Best-effort — caller will see no error.
  }
}

/**
 * Generate a reasonably-unique id for a new user list. We don't need
 * cryptographic uniqueness here — these ids only need to be stable within
 * the user's local persistence — so a timestamp + random suffix is fine and
 * dodges the crypto-API availability question across the Tauri webview.
 */
export function generateListId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff).toString(36);
  return `list-${t}-${r}`;
}

// Case-insensitive equality for seed lookup. Excel matches its built-in
// lists case-insensitively ("monday" still triggers Monday/Tuesday/…), but
// the autofill OUTPUT preserves the list's canonical casing rather than
// the user's typed seed.
function ciEq(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * Find which list contains `seed` (case-insensitive match against any item)
 * and return the list together with the seed's 0-based index inside that
 * list. Returns null when no list contains the seed.
 *
 * Search order is the iteration order of `all` — callers that want
 * user-defined lists to win over built-ins should pass `[...user, ...BUILTIN_LISTS]`.
 */
export function findListForSeed(
  seed: string,
  all: CustomList[],
): { list: CustomList; index: number } | null {
  const s = seed.trim();
  if (!s) return null;
  for (const list of all) {
    for (let i = 0; i < list.items.length; i++) {
      if (ciEq(list.items[i], s)) {
        return { list, index: i };
      }
    }
  }
  return null;
}

/**
 * Produce `count` consecutive items beginning at the seed (inclusive) and
 * wrapping around the end of the matched list. When no list contains the
 * seed we fall back to repeating the seed itself so the caller still gets
 * a well-sized output array — keeps the caller's range-fill logic simple.
 *
 * Examples:
 *   expandFromSeed("Wed", 5, BUILTIN_LISTS) → ["Wed","Thu","Fri","Sat","Sun"]
 *   expandFromSeed("Sat", 4, BUILTIN_LISTS) → ["Sat","Sun","Mon","Tue"]   (wraps)
 *   expandFromSeed("xx",  3, [])            → ["xx","xx","xx"]
 */
export function expandFromSeed(
  seed: string,
  count: number,
  all: CustomList[],
): string[] {
  if (count <= 0) return [];
  const found = findListForSeed(seed, all);
  if (!found) return new Array(count).fill(seed);
  const { list, index } = found;
  const n = list.items.length;
  const out: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = list.items[(index + i) % n];
  }
  return out;
}

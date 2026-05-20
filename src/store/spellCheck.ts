// Pure helpers for the "Spell Check" tool. Walks every string-valued cell in
// a workbook snapshot, tokenises into A–Z words (>= 3 chars), and flags
// tokens that don't appear in either the built-in dictionary or the user's
// localStorage-backed custom list.
//
// Snapshot shape (Univer 0.5.x + Coco extension) the helpers walk:
//   {
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;       // computed / display value (only strings checked)
//               f?: string;        // formula text — skipped (we don't proof formulas)
//             }
//           }
//         }
//       }
//     },
//     sheetOrder?: string[];
//   }
//
// Scope (intentional MVP limitations):
//   - English only. Cells whose value contains any CJK character are skipped
//     entirely — Japanese has no word delimiters and would need a morphological
//     analyzer (Kuromoji etc.) which is out of scope.
//   - Words shorter than 3 letters are skipped (too noisy: "I", "to", "is",
//     plus acronyms and units).
//   - Formula cells (`f` set) are skipped — we don't proof formula syntax.
//   - Numbers/dates/booleans are skipped (typeof v !== "string").
//
// All exports are pure (no DOM, no Univer dependency) apart from the two
// dictionary persistence helpers which touch `localStorage` under a single
// stable key.

/** localStorage key for the user's custom dictionary (JSON string array). */
const USER_DICT_STORAGE_KEY = "coco.spellDict";

/**
 * A single misspelling the checker surfaced.
 *
 * `offset` is the character index within the cell value where `word` begins —
 * the dialog uses it to highlight the misspelled run in the surrounding
 * context without re-tokenising.
 */
export interface SpellIssue {
  sheetId: string;
  sheetName: string;
  /** A1 cell ref, e.g. "B12". Always uppercase column letters. */
  cellRef: string;
  /** The full cell value the issue was found in — used for context display. */
  cellValue: string;
  /** The misspelled word as it appears in the cell (original casing). */
  word: string;
  /** 0-based character offset of `word` within `cellValue`. */
  offset: number;
  /** Up to N suggestions (sorted: shorter Damerau-Levenshtein distance first,
   *  then alphabetical). May be empty when nothing close enough exists. */
  suggestions: string[];
}

/**
 * Compact built-in English dictionary. ~500 of the most common words plus a
 * batch of business/spreadsheet vocabulary so a typical workbook cell ("Total
 * sales", "Quarterly report", "Average price") doesn't flag false positives.
 *
 * Kept intentionally small: this is an MVP. Users grow it via "Add to
 * Dictionary" which writes into localStorage and is checked alongside this set.
 */
export const BUILTIN_DICTIONARY: ReadonlySet<string> = new Set<string>([
  // Articles / pronouns / common short words (kept even though tokenizer
  // filters < 3 chars — useful for future tweaks)
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
  "how", "man", "new", "now", "old", "see", "two", "way", "who", "boy",
  "did", "its", "let", "put", "say", "she", "too", "use", "any", "may",
  "yes", "off", "own", "end", "why", "try", "ask", "big", "few", "lot",
  // Common verbs
  "have", "this", "that", "with", "from", "they", "will", "would", "there",
  "their", "what", "about", "which", "when", "make", "like", "time", "just",
  "know", "take", "into", "year", "your", "some", "could", "them", "than",
  "then", "look", "only", "come", "over", "think", "also", "back", "after",
  "work", "first", "well", "want", "even", "want", "give", "most", "find",
  "tell", "does", "felt", "made", "went", "said", "told", "left", "kept",
  "send", "sent", "show", "shows", "shown", "showed", "read", "wrote",
  "write", "writing", "written", "draw", "drew", "drawn", "build", "built",
  "buy", "bought", "sell", "sold", "spend", "spent", "save", "saved",
  "run", "ran", "running", "walk", "walked", "talk", "talked", "meet",
  "met", "leave", "leaves", "stay", "stayed", "move", "moved", "moving",
  "open", "opened", "close", "closed", "start", "started", "stop", "stopped",
  "begin", "began", "begun", "finish", "finished", "complete", "completed",
  "create", "created", "creating", "delete", "deleted", "remove", "removed",
  "update", "updated", "change", "changed", "add", "added", "edit", "edited",
  "view", "viewed", "load", "loaded", "save", "saves", "use", "used", "using",
  // Nouns — everyday
  "people", "world", "house", "place", "thing", "name", "name", "word",
  "list", "line", "side", "head", "hand", "part", "case", "point", "fact",
  "group", "company", "country", "state", "school", "family", "system",
  "program", "question", "government", "number", "night", "right", "left",
  "lift", "life", "study", "money", "story", "month", "week", "today",
  "tomorrow", "yesterday", "morning", "evening", "hour", "minute", "second",
  "early", "late", "later", "soon", "again", "always", "never", "often",
  "sometimes", "usually", "really", "very", "much", "many", "more", "less",
  "fewer", "good", "better", "best", "worse", "worst", "high", "low",
  "small", "large", "long", "short", "great", "important", "different",
  "same", "next", "last", "other", "another", "every", "each", "either",
  "several", "general", "specific", "public", "private", "social", "national",
  "international", "local", "personal", "human", "natural",
  // Numbers / quantity
  "zero", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "hundred", "thousand", "million", "billion",
  "half", "double", "triple", "single", "pair",
  // Spreadsheet / business / Coco-specific vocab
  "workbook", "spreadsheet", "worksheet", "sheet", "sheets", "cell", "cells",
  "column", "columns", "row", "rows", "range", "ranges", "table", "tables",
  "chart", "charts", "graph", "graphs", "pivot", "pivots", "slicer", "slicers",
  "filter", "filters", "sort", "sorted", "sorting", "format", "formats",
  "formatting", "formatted", "style", "styles", "styled", "value", "values",
  "data", "datum", "input", "output", "import", "imported", "export",
  "exported", "calculate", "calculated", "calculation", "calculations",
  "formula", "formulas", "function", "functions", "argument", "arguments",
  "parameter", "parameters", "result", "results", "error", "errors",
  "warning", "warnings", "info", "information", "summary", "details",
  "report", "reports", "reporting", "dashboard", "preview", "previews",
  "print", "printed", "printing", "page", "pages", "header", "footer",
  "margin", "margins", "scale", "orientation", "portrait", "landscape",
  // Aggregations / stats
  "total", "totals", "subtotal", "subtotals", "sum", "sums", "average",
  "averages", "mean", "median", "mode", "count", "counts", "max", "maximum",
  "min", "minimum", "range", "stdev", "variance", "percentile", "quartile",
  "growth", "decline", "trend", "trends", "forecast", "forecasts", "projection",
  "actual", "actuals", "budget", "budgets", "estimate", "estimates",
  // Time / calendar
  "year", "years", "quarter", "quarters", "month", "months", "week", "weeks",
  "day", "days", "date", "dates", "annual", "monthly", "weekly", "daily",
  "quarterly", "yearly", "january", "february", "march", "april", "may",
  "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec", "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  // Money / commerce
  "price", "prices", "cost", "costs", "costing", "revenue", "revenues",
  "profit", "profits", "loss", "losses", "income", "expense", "expenses",
  "tax", "taxes", "fee", "fees", "discount", "discounts", "rate", "rates",
  "interest", "balance", "balances", "account", "accounts", "invoice",
  "invoices", "receipt", "receipts", "payment", "payments", "transaction",
  "transactions", "transfer", "transfers", "deposit", "deposits", "withdrawal",
  "currency", "dollar", "dollars", "yen", "euro", "euros", "pound", "pounds",
  "credit", "credits", "debit", "debits", "amount", "amounts", "quantity",
  "quantities", "unit", "units", "stock", "stocks", "share", "shares",
  "asset", "assets", "liability", "liabilities", "equity", "capital",
  // Org / roles
  "company", "companies", "business", "businesses", "client", "clients",
  "customer", "customers", "user", "users", "employee", "employees",
  "manager", "managers", "team", "teams", "department", "departments",
  "division", "divisions", "office", "offices", "branch", "branches",
  "region", "regions", "market", "markets", "industry", "industries",
  "sector", "sectors", "product", "products", "service", "services",
  "project", "projects", "task", "tasks", "deadline", "deadlines",
  "milestone", "milestones", "phase", "phases", "status", "progress",
  "complete", "incomplete", "pending", "approved", "rejected", "draft",
  // Geography (common)
  "north", "south", "east", "west", "central", "asia", "europe", "africa",
  "america", "japan", "china", "korea", "india", "germany", "france",
  "spain", "italy", "russia", "brazil", "canada", "mexico", "australia",
  "tokyo", "osaka", "kyoto", "seoul", "beijing", "shanghai", "london",
  "paris", "berlin", "madrid", "rome", "moscow", "york", "york",
  // Tech
  "computer", "computers", "software", "hardware", "system", "systems",
  "network", "networks", "internet", "website", "websites", "page",
  "email", "emails", "phone", "phones", "mobile", "desktop", "laptop",
  "tablet", "device", "devices", "screen", "screens", "monitor", "monitors",
  "keyboard", "mouse", "click", "clicks", "double", "tap", "taps", "type",
  "typed", "typing", "menu", "menus", "button", "buttons", "icon", "icons",
  "window", "windows", "panel", "panels", "tab", "tabs", "dialog", "dialogs",
  "popup", "modal", "modals", "toolbar", "ribbon", "sidebar", "navigation",
  "search", "searches", "find", "found", "select", "selected", "selection",
  "copy", "copied", "paste", "pasted", "cut", "undo", "redo",
  // Adjectives — common
  "new", "old", "young", "fast", "slow", "easy", "hard", "soft", "warm",
  "cold", "hot", "cool", "fresh", "clean", "dirty", "full", "empty", "open",
  "closed", "ready", "busy", "free", "true", "false", "real", "fake",
  "right", "wrong", "correct", "incorrect", "valid", "invalid", "active",
  "inactive", "available", "unavailable", "online", "offline", "visible",
  "hidden", "default", "custom", "standard", "advanced", "basic", "simple",
  "complex", "easy", "difficult", "possible", "impossible", "necessary",
  "optional", "required", "mandatory", "automatic", "manual", "digital",
  "physical", "virtual", "remote", "internal", "external", "primary",
  "secondary", "main", "auxiliary", "additional", "extra", "missing",
  "complete", "incomplete", "partial", "whole", "entire", "full", "empty",
  // Misc connectives / prepositions / common
  "before", "after", "during", "while", "since", "until", "within", "without",
  "through", "across", "around", "between", "among", "above", "below",
  "under", "over", "behind", "beyond", "near", "far", "here", "there",
  "where", "anywhere", "everywhere", "nowhere", "somewhere",
  // Coco-product
  "coco", "univer", "tauri", "react", "excel", "office",
]);

/** Load the user's custom dictionary from localStorage. Returns an empty set
 *  in any failure case (missing storage, JSON parse error, non-array payload)
 *  so the caller never has to handle errors. */
export function loadUserDictionary(): Set<string> {
  const out = new Set<string>();
  try {
    if (typeof localStorage === "undefined") return out;
    const raw = localStorage.getItem(USER_DICT_STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return out;
    for (const w of parsed) {
      if (typeof w === "string" && w.length > 0) out.add(w.toLowerCase());
    }
  } catch {
    // Swallow — best-effort, fall back to empty.
  }
  return out;
}

/** Append `word` to the user's localStorage dictionary. Lower-cased, idempotent. */
export function addToUserDictionary(word: string): void {
  if (!word) return;
  try {
    if (typeof localStorage === "undefined") return;
    const cur = loadUserDictionary();
    cur.add(word.toLowerCase());
    localStorage.setItem(USER_DICT_STORAGE_KEY, JSON.stringify([...cur].sort()));
  } catch {
    // Swallow — best-effort.
  }
}

/** Heuristic CJK detection: covers Hiragana, Katakana, CJK Unified
 *  Ideographs (incl. Extension A) and Halfwidth/Fullwidth forms. We don't
 *  attempt to spell-check anything that contains a CJK glyph. */
function containsCJK(s: string): boolean {
  // Hiragana 3040-309F, Katakana 30A0-30FF, CJK Ideographs 4E00-9FFF,
  // Extension A 3400-4DBF, Halfwidth/Fullwidth FF00-FFEF.
  return /[぀-ヿ㐀-䶿一-鿿＀-￯]/.test(s);
}

/**
 * Split a string into A–Z token runs (length >= 3). Apostrophes within a word
 * are preserved so "don't"/"can't" stay whole — they just won't match the
 * dictionary (it doesn't carry contractions); the dialog can still let the
 * user "Ignore All" them.
 *
 * Numbers and punctuation act as delimiters. Tokens of length < 3 are dropped
 * (too noisy — "to", "in", "or", and most acronyms aren't worth flagging).
 */
export function tokenize(text: string): Array<{ word: string; offset: number }> {
  const out: Array<{ word: string; offset: number }> = [];
  if (!text || typeof text !== "string") return out;
  // Match runs of letters with optional internal apostrophes (don't, it's).
  const re = /[A-Za-z]+(?:'[A-Za-z]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    if (word.length < 3) continue;
    out.push({ word, offset: m.index });
  }
  return out;
}

/** True when `word` is NOT in the dictionary (case-insensitive). Words
 *  containing digits are never misspelled (skipped by tokenizer anyway).
 *  Pure ALL-CAPS tokens >= 4 chars are also treated as acronyms and skipped. */
export function isMisspelled(word: string, dict: Set<string>): boolean {
  if (!word) return false;
  // ALL CAPS && >= 4 chars → treat as acronym; don't flag.
  if (word.length >= 4 && word === word.toUpperCase()) return false;
  return !dict.has(word.toLowerCase());
}

/**
 * Damerau-Levenshtein distance with early exit at `max + 1`. Once the
 * minimum value in the current dp row exceeds `max`, the true distance must
 * be > max so we return `max + 1` immediately — keeps suggestion lookup
 * across a ~500-word dictionary fast (most dictionary words are pruned in
 * the first row or two).
 */
export function levenshtein(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return Math.min(lb, max + 1);
  if (lb === 0) return Math.min(la, max + 1);

  // prev2: row i-2, prev: row i-1, curr: row i — three rolling rows enable
  // the Damerau transposition check (cheaper than a full matrix).
  let prev2: number[] = [];
  let prev: number[] = new Array(lb + 1);
  let curr: number[] = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(
        curr[j - 1] + 1,        // insert
        prev[j] + 1,            // delete
        prev[j - 1] + cost,     // substitute
      );
      // Damerau transposition: swap of adjacent chars costs 1.
      if (
        i > 1 && j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = curr;
    curr = new Array(lb + 1);
  }
  return prev[lb];
}

/**
 * Return up to `max` dictionary words whose Damerau-Levenshtein distance to
 * `word` is <= `maxDistance`, sorted by distance ascending then alphabetical.
 * Case-insensitive — input is lower-cased and dictionary entries are too.
 */
export function suggestCorrections(
  word: string,
  dict: Set<string>,
  maxDistance: number,
  max: number,
): string[] {
  if (!word) return [];
  const lower = word.toLowerCase();
  const scored: Array<{ w: string; d: number }> = [];
  for (const candidate of dict) {
    // Quick length filter — anything outside [len-max, len+max] can't qualify.
    if (Math.abs(candidate.length - lower.length) > maxDistance) continue;
    const d = levenshtein(lower, candidate, maxDistance);
    if (d <= maxDistance) scored.push({ w: candidate, d });
  }
  scored.sort((a, b) => (a.d - b.d) || a.w.localeCompare(b.w));
  return scored.slice(0, max).map((s) => s.w);
}

type Snapshot = {
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<
          string,
          Record<string, { v?: unknown; f?: unknown } | undefined>
        >;
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

function toA1Ref(row: number, col: number): string {
  const r = Math.max(0, Math.floor(row)) + 1;
  return `${colIndexToLetters(col)}${r}`;
}

/**
 * Walk every string-valued cell in every sheet of the snapshot and emit one
 * SpellIssue per misspelled token. Order: by sheet (snapshot `sheetOrder`
 * when present) then row-major, then by `offset` within the cell — so the
 * dialog's Next button advances in a visually sensible path.
 *
 * The combined dictionary used for the lookup is BUILTIN_DICTIONARY ∪ userDict.
 * `userDict` should be passed in (rather than reloaded here) so the dialog
 * can append "Add to Dictionary" entries without re-running collect.
 *
 * Suggestions are computed lazily — we only call `suggestCorrections` once
 * per unique misspelled word and cache the result for the rest of the walk
 * (typical workbooks repeat misspellings dozens of times; caching keeps the
 * scan near-instant).
 */
export function collectSpellIssues(
  snapshot: unknown,
  userDict: Set<string>,
): SpellIssue[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const snap = snapshot as Snapshot;
  const sheets = snap.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  // Combined dictionary for lookups + suggestion source.
  const combined = new Set<string>(BUILTIN_DICTIONARY);
  for (const w of userDict) combined.add(w);

  const suggestionCache = new Map<string, string[]>();
  const orderedIds = Array.isArray(snap.sheetOrder) && snap.sheetOrder.length > 0
    ? snap.sheetOrder.filter((id) => typeof id === "string" && id in sheets)
    : Object.keys(sheets);

  const out: SpellIssue[] = [];
  for (const sheetId of orderedIds) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const cellData = sheet.cellData;
    if (!cellData || typeof cellData !== "object") continue;
    const sheetName = typeof sheet.name === "string" && sheet.name.length > 0
      ? sheet.name
      : sheetId;

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
        // Skip formula cells — we don't proof formula syntax.
        if (cell.f !== undefined && cell.f !== null && cell.f !== "") continue;
        const v = cell.v;
        if (typeof v !== "string" || v.length === 0) continue;
        // Skip cells containing CJK — out of scope for English-only checker.
        if (containsCJK(v)) continue;

        const tokens = tokenize(v);
        if (tokens.length === 0) continue;

        for (const { word, offset } of tokens) {
          if (!isMisspelled(word, combined)) continue;
          const key = word.toLowerCase();
          let suggestions = suggestionCache.get(key);
          if (suggestions === undefined) {
            suggestions = suggestCorrections(key, combined, 2, 3);
            suggestionCache.set(key, suggestions);
          }
          out.push({
            sheetId,
            sheetName,
            cellRef: toA1Ref(row, col),
            cellValue: v,
            word,
            offset,
            suggestions,
          });
        }
      }
    }
  }
  return out;
}

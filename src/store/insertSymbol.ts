// Pure data + filter helpers for the Insert Symbol dialog (Excel's Insert →
// Symbol equivalent). Kept side-effect free so the catalog can be diffed in
// PRs and the filter is easy to unit-test without the React layer.
//
// `name` doubles as the search needle and the on-hover tooltip — we use
// English glyph names because Unicode's published names are English and
// translating them adds maintenance burden without helping discoverability
// (users searching for "yen" or "infinity" find what they expect).

export type SymbolCategory =
  | "currency"
  | "math"
  | "arrows"
  | "punctuation"
  | "greek"
  | "box"
  | "geometric"
  | "misc"
  | "emoji";

export interface SymbolEntry {
  /** The literal character(s) to insert. May be a surrogate pair for emoji. */
  char: string;
  /** Human-readable name (English, lowercase) — used for search + tooltip. */
  name: string;
  category: SymbolCategory;
}

export const CATEGORY_LABELS: Record<SymbolCategory, string> = {
  currency: "通貨 / Currency",
  math: "数学 / Math",
  arrows: "矢印 / Arrows",
  punctuation: "約物 / Punctuation",
  greek: "ギリシャ文字 / Greek",
  box: "罫線 / Box Drawing",
  geometric: "図形 / Geometric",
  misc: "記号 / Misc",
  emoji: "顔文字 / Emoji",
};

export const CATEGORY_ORDER: readonly SymbolCategory[] = [
  "currency",
  "math",
  "arrows",
  "punctuation",
  "greek",
  "box",
  "geometric",
  "misc",
  "emoji",
] as const;

export const SYMBOL_CATALOG: readonly SymbolEntry[] = [
  // --- Currency ---
  { char: "¥", name: "yen sign", category: "currency" },
  { char: "$", name: "dollar sign", category: "currency" },
  { char: "€", name: "euro sign", category: "currency" },
  { char: "£", name: "pound sign", category: "currency" },
  { char: "¢", name: "cent sign", category: "currency" },
  { char: "₹", name: "indian rupee sign", category: "currency" },
  { char: "₽", name: "ruble sign", category: "currency" },
  { char: "₩", name: "won sign", category: "currency" },
  { char: "₺", name: "turkish lira sign", category: "currency" },
  { char: "₪", name: "new sheqel sign", category: "currency" },
  { char: "₿", name: "bitcoin sign", category: "currency" },
  { char: "¤", name: "generic currency sign", category: "currency" },

  // --- Math ---
  { char: "±", name: "plus-minus sign", category: "math" },
  { char: "×", name: "multiplication sign", category: "math" },
  { char: "÷", name: "division sign", category: "math" },
  { char: "≠", name: "not equal to", category: "math" },
  { char: "≤", name: "less than or equal to", category: "math" },
  { char: "≥", name: "greater than or equal to", category: "math" },
  { char: "≈", name: "approximately equal to", category: "math" },
  { char: "∞", name: "infinity", category: "math" },
  { char: "∑", name: "n-ary summation", category: "math" },
  { char: "∏", name: "n-ary product", category: "math" },
  { char: "∫", name: "integral", category: "math" },
  { char: "√", name: "square root", category: "math" },
  { char: "∂", name: "partial differential", category: "math" },
  { char: "∆", name: "increment / delta", category: "math" },
  { char: "∇", name: "nabla", category: "math" },
  { char: "π", name: "pi", category: "math" },
  { char: "∝", name: "proportional to", category: "math" },
  { char: "∀", name: "for all", category: "math" },
  { char: "∃", name: "there exists", category: "math" },
  { char: "∈", name: "element of", category: "math" },
  { char: "∉", name: "not an element of", category: "math" },
  { char: "⊂", name: "subset of", category: "math" },
  { char: "⊃", name: "superset of", category: "math" },
  { char: "∪", name: "union", category: "math" },
  { char: "∩", name: "intersection", category: "math" },
  { char: "°", name: "degree sign", category: "math" },

  // --- Arrows ---
  { char: "→", name: "rightwards arrow", category: "arrows" },
  { char: "←", name: "leftwards arrow", category: "arrows" },
  { char: "↑", name: "upwards arrow", category: "arrows" },
  { char: "↓", name: "downwards arrow", category: "arrows" },
  { char: "↔", name: "left-right arrow", category: "arrows" },
  { char: "↕", name: "up-down arrow", category: "arrows" },
  { char: "⇒", name: "rightwards double arrow", category: "arrows" },
  { char: "⇐", name: "leftwards double arrow", category: "arrows" },
  { char: "⇑", name: "upwards double arrow", category: "arrows" },
  { char: "⇓", name: "downwards double arrow", category: "arrows" },
  { char: "⇔", name: "left-right double arrow", category: "arrows" },
  { char: "↗", name: "north east arrow", category: "arrows" },
  { char: "↘", name: "south east arrow", category: "arrows" },
  { char: "↙", name: "south west arrow", category: "arrows" },
  { char: "↖", name: "north west arrow", category: "arrows" },
  { char: "➜", name: "heavy round-tipped rightwards arrow", category: "arrows" },
  { char: "➝", name: "heavy rightwards arrow", category: "arrows" },

  // --- Punctuation ---
  { char: "“", name: "left double quotation mark", category: "punctuation" },
  { char: "”", name: "right double quotation mark", category: "punctuation" },
  { char: "‘", name: "left single quotation mark", category: "punctuation" },
  { char: "’", name: "right single quotation mark", category: "punctuation" },
  { char: "«", name: "left-pointing double angle quotation", category: "punctuation" },
  { char: "»", name: "right-pointing double angle quotation", category: "punctuation" },
  { char: "‹", name: "single left-pointing angle quotation", category: "punctuation" },
  { char: "›", name: "single right-pointing angle quotation", category: "punctuation" },
  { char: "–", name: "en dash", category: "punctuation" },
  { char: "—", name: "em dash", category: "punctuation" },
  { char: "…", name: "horizontal ellipsis", category: "punctuation" },
  { char: "‖", name: "double vertical line", category: "punctuation" },
  { char: "§", name: "section sign", category: "punctuation" },
  { char: "¶", name: "pilcrow sign", category: "punctuation" },
  { char: "†", name: "dagger", category: "punctuation" },
  { char: "‡", name: "double dagger", category: "punctuation" },
  { char: "※", name: "reference mark", category: "punctuation" },
  { char: "•", name: "bullet", category: "punctuation" },

  // --- Greek ---
  { char: "α", name: "greek small letter alpha", category: "greek" },
  { char: "β", name: "greek small letter beta", category: "greek" },
  { char: "γ", name: "greek small letter gamma", category: "greek" },
  { char: "δ", name: "greek small letter delta", category: "greek" },
  { char: "ε", name: "greek small letter epsilon", category: "greek" },
  { char: "ζ", name: "greek small letter zeta", category: "greek" },
  { char: "η", name: "greek small letter eta", category: "greek" },
  { char: "θ", name: "greek small letter theta", category: "greek" },
  { char: "ι", name: "greek small letter iota", category: "greek" },
  { char: "κ", name: "greek small letter kappa", category: "greek" },
  { char: "λ", name: "greek small letter lambda", category: "greek" },
  { char: "μ", name: "greek small letter mu", category: "greek" },
  { char: "ν", name: "greek small letter nu", category: "greek" },
  { char: "ξ", name: "greek small letter xi", category: "greek" },
  { char: "ο", name: "greek small letter omicron", category: "greek" },
  { char: "ρ", name: "greek small letter rho", category: "greek" },
  { char: "σ", name: "greek small letter sigma", category: "greek" },
  { char: "τ", name: "greek small letter tau", category: "greek" },
  { char: "υ", name: "greek small letter upsilon", category: "greek" },
  { char: "φ", name: "greek small letter phi", category: "greek" },
  { char: "χ", name: "greek small letter chi", category: "greek" },
  { char: "ψ", name: "greek small letter psi", category: "greek" },
  { char: "ω", name: "greek small letter omega", category: "greek" },

  // --- Box drawing ---
  { char: "─", name: "box drawings light horizontal", category: "box" },
  { char: "│", name: "box drawings light vertical", category: "box" },
  { char: "┌", name: "box drawings light down and right", category: "box" },
  { char: "┐", name: "box drawings light down and left", category: "box" },
  { char: "└", name: "box drawings light up and right", category: "box" },
  { char: "┘", name: "box drawings light up and left", category: "box" },
  { char: "├", name: "box drawings light vertical and right", category: "box" },
  { char: "┤", name: "box drawings light vertical and left", category: "box" },
  { char: "┬", name: "box drawings light down and horizontal", category: "box" },
  { char: "┴", name: "box drawings light up and horizontal", category: "box" },
  { char: "┼", name: "box drawings light vertical and horizontal", category: "box" },
  { char: "═", name: "box drawings double horizontal", category: "box" },
  { char: "║", name: "box drawings double vertical", category: "box" },
  { char: "╔", name: "box drawings double down and right", category: "box" },
  { char: "╗", name: "box drawings double down and left", category: "box" },
  { char: "╚", name: "box drawings double up and right", category: "box" },
  { char: "╝", name: "box drawings double up and left", category: "box" },

  // --- Geometric ---
  { char: "●", name: "black circle", category: "geometric" },
  { char: "○", name: "white circle", category: "geometric" },
  { char: "◯", name: "large circle", category: "geometric" },
  { char: "◌", name: "dotted circle", category: "geometric" },
  { char: "■", name: "black square", category: "geometric" },
  { char: "□", name: "white square", category: "geometric" },
  { char: "▪", name: "black small square", category: "geometric" },
  { char: "▫", name: "white small square", category: "geometric" },
  { char: "★", name: "black star", category: "geometric" },
  { char: "☆", name: "white star", category: "geometric" },
  { char: "◆", name: "black diamond", category: "geometric" },
  { char: "◇", name: "white diamond", category: "geometric" },
  { char: "▲", name: "black up-pointing triangle", category: "geometric" },
  { char: "△", name: "white up-pointing triangle", category: "geometric" },
  { char: "▼", name: "black down-pointing triangle", category: "geometric" },
  { char: "▽", name: "white down-pointing triangle", category: "geometric" },
  { char: "◀", name: "black left-pointing triangle", category: "geometric" },
  { char: "▶", name: "black right-pointing triangle", category: "geometric" },
  { char: "▴", name: "black up-pointing small triangle", category: "geometric" },
  { char: "▾", name: "black down-pointing small triangle", category: "geometric" },

  // --- Misc ---
  { char: "✓", name: "check mark", category: "misc" },
  { char: "✗", name: "ballot x", category: "misc" },
  { char: "☑", name: "ballot box with check", category: "misc" },
  { char: "☒", name: "ballot box with x", category: "misc" },
  { char: "☐", name: "ballot box", category: "misc" },
  { char: "ⓘ", name: "circled information source", category: "misc" },
  { char: "⚠", name: "warning sign", category: "misc" },
  { char: "⚡", name: "high voltage sign", category: "misc" },
  { char: "⌚", name: "watch", category: "misc" },
  { char: "☎", name: "black telephone", category: "misc" },
  { char: "✉", name: "envelope", category: "misc" },
  { char: "⏰", name: "alarm clock", category: "misc" },
  { char: "🔒", name: "lock", category: "misc" },
  { char: "🔓", name: "open lock", category: "misc" },
  { char: "🔑", name: "key", category: "misc" },
  { char: "©", name: "copyright sign", category: "misc" },
  { char: "®", name: "registered sign", category: "misc" },
  { char: "™", name: "trade mark sign", category: "misc" },

  // --- Faces / Emoji ---
  { char: "😀", name: "grinning face", category: "emoji" },
  { char: "😃", name: "smiling face with open mouth", category: "emoji" },
  { char: "😄", name: "smiling face with open mouth and smiling eyes", category: "emoji" },
  { char: "😅", name: "smiling face with sweat", category: "emoji" },
  { char: "😆", name: "smiling face with tightly-closed eyes", category: "emoji" },
  { char: "😉", name: "winking face", category: "emoji" },
  { char: "😍", name: "smiling face with heart-eyes", category: "emoji" },
  { char: "😎", name: "smiling face with sunglasses", category: "emoji" },
  { char: "🙂", name: "slightly smiling face", category: "emoji" },
  { char: "🙁", name: "slightly frowning face", category: "emoji" },
] as const;

/**
 * Filter the catalog by query (case-insensitive substring on `name` or exact
 * char match) and optional category. `null` category means "all".
 *
 * Empty query returns every entry in the chosen category — same behaviour as
 * InsertFunctionDialog so the dialog can render the full grid on open.
 */
export function filterSymbols(
  query: string,
  category: SymbolCategory | null,
): SymbolEntry[] {
  const q = query.trim().toLowerCase();
  return SYMBOL_CATALOG.filter((s) => {
    if (category !== null && s.category !== category) return false;
    if (!q) return true;
    // Allow matching by exact character paste too (handy for "I see this
    // glyph in another doc, what is it?" lookups).
    if (s.char === query) return true;
    return s.name.toLowerCase().includes(q);
  });
}

/**
 * Format a Unicode code point as "U+XXXX" for the preview pane. Returns the
 * first code point of the string (sufficient for our catalog — surrogate
 * pairs collapse to the supplementary code point).
 */
export function formatCodePoint(char: string): string {
  const cp = char.codePointAt(0);
  if (cp === undefined) return "";
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

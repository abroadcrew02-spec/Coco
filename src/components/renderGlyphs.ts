// Shared "known decoration" registry for snapshot-patch pipelines.
//
// Several snapshot-patch modules (sparklineRender, conditionalFormatRender,
// errorIndicatorRender, showAllCommentsRender, showFormulasRender) decorate
// the `cell.v` display value by prefixing or replacing it with a glyph or a
// formula string. Because the patches run in sequence inside the
// `EditorScreen.tsx` createUnit pipeline, a later patch can see the output
// of an earlier patch in `cell.v` and mistakenly stack another decoration
// on top — producing visible junk like "↑ 💬  ▁▃▆▇█ — note preview".
//
// To prevent collisions every render module imports the helpers here:
//   - `hasKnownDecoration(value)` — does `value` start with a glyph or
//     prefix written by any of the sibling render patches?
//   - `stripKnownDecorations(value)` — remove every leading known decoration
//     (looped, so stacked prefixes from older snapshots are normalized).
//
// The helpers are intentionally pure and self-contained: no Univer types,
// no imports from any of the render modules (to avoid circular deps), and
// every set / prefix is exported so individual patches can apply targeted
// logic (e.g. "this cell starts with my own glyph, OK to overwrite vs.
// this cell starts with someone else's glyph, skip").
//
// IMPORTANT: keep the glyph sets in sync with their source modules. When a
// new render module introduces a new decoration glyph, add it here and add
// a case to `stripKnownDecorations` so subsequent patches can recognize it.

/** Sparkline line/column glyphs — must match `LINE_BARS` in `store/sparklines.ts`. */
export const SPARKLINE_LINE_GLYPHS = new Set<string>([
  "▁", // ▁
  "▂", // ▂
  "▃", // ▃
  "▄", // ▄
  "▅", // ▅
  "▆", // ▆
  "▇", // ▇
  "█", // █
]);

/** Sparkline column glyphs — alias of line glyphs in the current MVP. */
export const SPARKLINE_COLUMN_GLYPHS = SPARKLINE_LINE_GLYPHS;

/** Sparkline win/loss glyphs — must match `renderWinLossSparkline` in `store/sparklines.ts`. */
export const SPARKLINE_WINLOSS_GLYPHS = new Set<string>([
  "▲", // ▲
  "▼", // ▼
  "─", // ─
  "…", // … (truncation marker)
]);

/** Union of every sparkline glyph (any type). */
export const SPARKLINE_GLYPHS_ALL = new Set<string>([
  ...SPARKLINE_LINE_GLYPHS,
  ...SPARKLINE_WINLOSS_GLYPHS,
]);

/** Conditional-formatting iconSet glyphs — must match `ICON_GLYPHS` in
 *  `conditionalFormatRender.ts`. Includes every glyph across every iconStyle so
 *  any of them is recognized as "already decorated". */
export const ICONSET_GLYPHS = new Set<string>([
  // 3arrows
  "↓", // ↓
  "→", // →
  "↑", // ↑
  // 3traffic
  "\u{1F534}", // 🔴
  "\u{1F7E1}", // 🟡
  "\u{1F7E2}", // 🟢
  // 5rating — these are 5-char strings, but their first character is the star
  // so we add the star glyph to the set and add the full multi-char strings to
  // a separate prefix-string list below.
  "★", // ★ (filled star)
  "☆", // ☆ (open star)
]);

/** Multi-character iconSet prefixes (e.g. "★☆☆☆☆ ") that need substring matching
 *  rather than single-codepoint detection. Order: longest first so a 5-star
 *  string is recognized before a 1-star substring. */
export const ICONSET_MULTI_PREFIXES: readonly string[] = [
  "★★★★★ ", // ★★★★★ + space
  "★★★★☆ ", // ★★★★☆ + space
  "★★★☆☆ ", // ★★★☆☆ + space
  "★★☆☆☆ ", // ★★☆☆☆ + space
  "★☆☆☆☆ ", // ★☆☆☆☆ + space
];

/** Error-cell display prefix written by `patchErrorIndicators`. */
export const ERROR_PREFIX = "⚠ "; // ⚠ + space

/** Show-all-comments prefix written by `patchShowAllCommentsView`. */
export const COMMENT_PREFIX = "\u{1F4AC} "; // 💬 + space

/** Single-codepoint glyphs that, when followed by a space, mean "this cell was
 *  decorated by one of the iconSet / error / comment patches". */
const SINGLE_GLYPH_DECORATION_SET: Set<string> = new Set<string>([
  ...ICONSET_GLYPHS,
]);

/**
 * Return true when `value` looks like a cell that was already decorated by
 * any of the known render patches:
 *   - starts with a sparkline glyph (line / column / win-loss),
 *   - starts with the comment prefix "💬 ",
 *   - starts with the error prefix "⚠ ",
 *   - starts with an iconSet glyph (single-codepoint or 5-rating multi-char) followed by a space,
 *   - starts with "=" (a show-formulas replacement).
 *
 * Non-string / empty values return false.
 */
export function hasKnownDecoration(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith(COMMENT_PREFIX)) return true;
  if (value.startsWith(ERROR_PREFIX)) return true;
  if (value.startsWith("=")) return true;
  // Multi-char iconSet prefixes (5-rating)
  for (const p of ICONSET_MULTI_PREFIXES) {
    if (value.startsWith(p)) return true;
  }
  // Single-codepoint iconSet glyphs followed by a space.
  // Iterate code points via [...value] so surrogate-pair emoji are handled.
  const first = value.codePointAt(0);
  if (first !== undefined) {
    const firstStr = String.fromCodePoint(first);
    if (SINGLE_GLYPH_DECORATION_SET.has(firstStr)) {
      // Require a trailing space — otherwise a user-typed "↑arrow" literal
      // would be mis-classified.
      if (value.slice(firstStr.length).startsWith(" ")) return true;
    }
    // Sparkline glyph at position 0 (no trailing space required — sparkline
    // strings are pure-glyph runs of up to 8 bars).
    if (SPARKLINE_GLYPHS_ALL.has(firstStr)) return true;
  }
  return false;
}

/**
 * Strip every leading known decoration from `value` and return the bare,
 * undecorated string. Looped so a cell carrying stacked prefixes from an
 * older snapshot (e.g. "💬 ⚠ value") normalizes back to "value".
 *
 * If `value` is not a string or carries no known decoration the original is
 * returned unchanged.
 */
export function stripKnownDecorations(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  let rest = value;
  let progressed = true;
  while (progressed) {
    progressed = false;
    if (rest.startsWith(COMMENT_PREFIX)) {
      rest = rest.slice(COMMENT_PREFIX.length);
      progressed = true;
      continue;
    }
    if (rest.startsWith(ERROR_PREFIX)) {
      rest = rest.slice(ERROR_PREFIX.length);
      progressed = true;
      continue;
    }
    // Multi-char iconSet prefixes — longest match first.
    let matched = false;
    for (const p of ICONSET_MULTI_PREFIXES) {
      if (rest.startsWith(p)) {
        rest = rest.slice(p.length);
        matched = true;
        progressed = true;
        break;
      }
    }
    if (matched) continue;
    // Single-codepoint iconSet glyph + space.
    const cp = rest.codePointAt(0);
    if (cp !== undefined) {
      const glyph = String.fromCodePoint(cp);
      if (SINGLE_GLYPH_DECORATION_SET.has(glyph) && rest.slice(glyph.length).startsWith(" ")) {
        rest = rest.slice(glyph.length + 1);
        progressed = true;
        continue;
      }
      // Strip a leading run of sparkline glyphs (no separator).
      if (SPARKLINE_GLYPHS_ALL.has(glyph)) {
        let i = 0;
        while (i < rest.length) {
          const c = rest.codePointAt(i);
          if (c === undefined) break;
          const g = String.fromCodePoint(c);
          if (!SPARKLINE_GLYPHS_ALL.has(g)) break;
          i += g.length;
        }
        if (i > 0) {
          rest = rest.slice(i);
          progressed = true;
          continue;
        }
      }
    }
  }
  return rest;
}

/**
 * True when `value` consists entirely of sparkline glyphs (any type). Used by
 * `sparklineRender.ts` to decide whether the anchor cell still carries a
 * previously-rendered sparkline that's safe to overwrite. An empty string
 * returns false so empty cells aren't treated as "rendered sparklines".
 */
export function isPureSparklineString(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const ch of value) {
    if (!SPARKLINE_GLYPHS_ALL.has(ch)) return false;
  }
  return true;
}

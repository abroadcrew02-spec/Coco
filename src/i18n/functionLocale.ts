// Japanese → canonical (English) spreadsheet function-name normalization.
//
// Excel's Japanese UI keeps function names in English (=SUM, =VLOOKUP), but
// JP knowledge workers frequently *think* in Japanese and some legacy
// material spells functions phonetically (合計 = SUM, 平均 = AVERAGE, ...).
// `normalizeFormula` rewrites those JA aliases back to the canonical English
// names the Univer formula engine understands, so a formula typed (or pasted)
// with JA names still evaluates.
//
// The rewrite is intentionally conservative:
//   - Only the *function-name* token immediately preceding "(" is rewritten.
//   - String literals ("...") are left untouched so JA text inside a formula
//     (e.g. =IF(A1>0,"合計",...)) is never corrupted.
//   - Non-formula input (no leading "=") is returned unchanged.
//
// This is a pure utility with no Univer dependency so it stays unit-testable.

/**
 * Map of Japanese function aliases to their canonical English names.
 * Keys are matched case-insensitively against the token before "(".
 */
export const JA_FUNCTION_ALIASES: Readonly<Record<string, string>> = {
  // aggregates
  合計: "SUM",
  平均: "AVERAGE",
  個数: "COUNT",
  数値の個数: "COUNT",
  データの個数: "COUNTA",
  最大: "MAX",
  最大値: "MAX",
  最小: "MIN",
  最小値: "MIN",
  積: "PRODUCT",
  中央値: "MEDIAN",
  // conditional aggregates
  条件付き合計: "SUMIF",
  条件付き平均: "AVERAGEIF",
  条件付き個数: "COUNTIF",
  // rounding / math
  四捨五入: "ROUND",
  切り上げ: "ROUNDUP",
  切り捨て: "ROUNDDOWN",
  整数: "INT",
  剰余: "MOD",
  絶対値: "ABS",
  べき乗: "POWER",
  平方根: "SQRT",
  // logical
  論理式: "IF",
  もし: "IF",
  かつ: "AND",
  または: "OR",
  否定: "NOT",
  // lookup
  検索: "VLOOKUP",
  垂直検索: "VLOOKUP",
  水平検索: "HLOOKUP",
  照合: "MATCH",
  // text
  文字数: "LEN",
  左: "LEFT",
  右: "RIGHT",
  中央: "MID",
  連結: "CONCAT",
  置換: "SUBSTITUTE",
  // date
  今日: "TODAY",
  現在: "NOW",
  年: "YEAR",
  月: "MONTH",
  日: "DAY",
};

// A formula token is a run of word characters OR Japanese script
// (Hiragana / Katakana / CJK ideographs / fullwidth forms) followed by "(".
// We capture the token so the replacer can look it up.
const FUNCTION_TOKEN_RE =
  /([A-Za-z_぀-ゟ゠-ヿ一-鿿ｦ-ﾟ][\w぀-ゟ゠-ヿ一-鿿ｦ-ﾟ.]*)\s*\(/g;

/**
 * Split a formula string into alternating segments, flagging which ones lie
 * inside a double-quoted string literal. The opening and closing quotes are
 * kept attached to the string segment so a re-join is loss-free. A doubled
 * quote ("") — Excel's in-string escape — toggles state twice, yielding an
 * empty non-string segment, which round-trips correctly.
 */
function splitOnStringLiterals(input: string): { text: string; isString: boolean }[] {
  const segments: { text: string; isString: boolean }[] = [];
  let buffer = "";
  let inString = false;
  for (const ch of input) {
    if (ch === '"') {
      if (inString) {
        // Closing quote — finish the string segment (quote included).
        buffer += '"';
        segments.push({ text: buffer, isString: true });
        buffer = "";
        inString = false;
      } else {
        // Opening quote — finish the non-string segment, start a string one.
        segments.push({ text: buffer, isString: false });
        buffer = '"';
        inString = true;
      }
      continue;
    }
    buffer += ch;
  }
  segments.push({ text: buffer, isString: inString });
  return segments;
}

/**
 * Rewrite Japanese function-name aliases inside a single non-string segment.
 */
function rewriteSegment(segment: string): string {
  return segment.replace(FUNCTION_TOKEN_RE, (match, token: string) => {
    const canonical = JA_FUNCTION_ALIASES[token];
    if (canonical) {
      // Preserve any whitespace the original had between token and "(".
      const open = match.slice(token.length);
      return canonical + open;
    }
    return match;
  });
}

/**
 * Normalize a formula by replacing Japanese function-name aliases with their
 * canonical English equivalents. Input that is not a formula (no leading "=")
 * is returned unchanged. String literals are preserved verbatim.
 *
 * @example
 * normalizeFormula("=合計(A1:A10)")        // "=SUM(A1:A10)"
 * normalizeFormula("=もし(A1>0,\"合計\",0)") // "=IF(A1>0,\"合計\",0)"
 * normalizeFormula("hello")                // "hello"
 */
export function normalizeFormula(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  if (!input.startsWith("=")) return input;

  const segments = splitOnStringLiterals(input);
  return segments
    .map((seg) => (seg.isString ? seg.text : rewriteSegment(seg.text)))
    .join("");
}

// Smart chips (#158 MVP, extended in #185) — pure detection helpers for
// in-cell rich-object hints. Unlike hyperlinks/comments, chips have *no*
// persistent metadata: a chip exists only as a view over the cell's literal
// `v` string. The detectors here run lazily — only on hover or right-click
// for a single cell — so even a 1M-row workbook pays nothing until the user
// interacts.
//
// Built-in kinds:
//   - "url"    → http(s) link, opened via the Tauri `open_url` command
//   - "email"  → routed through `mailto:` (also via `open_url`)
//   - "date"   → ISO / JA / Date.parse() fallback, opens a date picker
//
// User-extensible kind (#185):
//   - "custom" → matches a user-authored regex rule (see
//     customSmartChipRules.ts); activating it opens an http(s) URL expanded
//     from the rule's template. Rules live entirely in localStorage — no
//     backend, in line with the local-first / serverless policy.
//
// Still out of scope (need a directory/map backend → conflicts with the
// serverless policy): people, files, locations.
//
// The detector returns ALL chips it can find with their byte offsets inside
// the original text, plus a priority-resolved single chip per cell for the
// "first hit" use case (right-click action). Overlapping detections are
// resolved by priority: url > email > date > custom. Custom rules sit
// *below* the built-ins on purpose: a user pattern can never steal a span
// that is a genuine URL or email.

import {
  type CustomSmartChipRule,
  compileRule,
  expandUrlTemplate,
  loadCustomRules,
  MAX_MATCHES_PER_CELL,
} from "./customSmartChipRules";

export type SmartChipKind = "url" | "email" | "date" | "custom";

export interface SmartChip {
  kind: SmartChipKind;
  /** The matched substring (e.g. "https://...", "foo@bar", "2026-05-18"). */
  value: string;
  /** Inclusive start offset in the source text. */
  start: number;
  /** Exclusive end offset in the source text. */
  end: number;
  /** For "date" only: ISO 8601 (YYYY-MM-DD) representation we can hand to a
   *  picker. Omitted for url/email/custom. */
  iso?: string;
  /** For "custom" only: id of the matched rule. */
  ruleId?: string;
  /** For "custom" only: display name of the matched rule. */
  ruleName?: string;
  /** For "custom" only: the fully-expanded action URL (http(s)). */
  actionUrl?: string;
}

// URL: http(s) only for the MVP. We bound the match to a non-letter on the
// right edge so trailing punctuation (",", ".", ")") doesn't get absorbed
// into the link. The host is required to have at least one dot so bare
// "http://localhost" still works but stray "http://x" doesn't.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

// Email: RFC-5321-ish loose match. Same shape as hyperlinkManager.validateUrl
// but as a /g scanner so we can locate multiple in one cell.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Date forms we detect inline. Order: most-specific (YYYY-MM-DD with
// separators) first, then JA forms, then loose "M/D/YYYY". We deliberately
// don't try DD/MM/YYYY here because the ambiguity is unrecoverable without
// a locale, and inline detection has no locale knob — we'd rather miss a
// date than misinterpret one.
const DATE_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  parse: (m: RegExpExecArray) => { y: number; mo: number; d: number } | null;
}> = [
  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  {
    regex: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,
    parse: (m) => ({ y: +m[1], mo: +m[2], d: +m[3] }),
  },
  // YYYY年M月D日
  {
    regex: /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
    parse: (m) => ({ y: +m[1], mo: +m[2], d: +m[3] }),
  },
  // M月D日 — defaults to current year. JA-only-shape so safe to detect inline.
  {
    regex: /(?<!\d)(\d{1,2})月(\d{1,2})日(?!\d)/g,
    parse: (m) => ({
      y: new Date().getFullYear(),
      mo: +m[1],
      d: +m[2],
    }),
  },
  // M/D/YYYY (US convention). We require 4-digit year on the trailing side
  // so we don't grab fractions like "3/4" or "1/2/3".
  {
    regex: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    parse: (m) => ({ y: +m[3], mo: +m[1], d: +m[2] }),
  },
];

// Priority matrix — higher wins on overlap. Custom rules sit strictly below
// every built-in so a user pattern can never hijack a span that is a real
// URL, email or date.
const CHIP_PRIORITY: Record<SmartChipKind, number> = {
  url: 4,
  email: 3,
  date: 2,
  custom: 1,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toIsoOrNull(y: number, mo: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Build via UTC and reject calendar roll-over (Feb 30 → Mar 2 etc).
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/**
 * Detect every smart-chip candidate in the source text. Returns matches in
 * left-to-right order with overlaps removed by priority: url > email > date
 * > custom.
 *
 * Designed to be cheap on cold cells: returns [] immediately for non-string
 * inputs, empty strings, or strings without any chip-shaped substring (we
 * still pay the regex scan but each `.exec` early-exits on no match).
 *
 * Bounded at MAX_CHIPS to keep pathological inputs (e.g. a CSV of 5000
 * URLs in one cell) from blowing up the popover.
 *
 * `rules` (#185) is an optional list of user-authored custom rules. When
 * omitted the detector behaves exactly like the #158 MVP, which keeps the
 * pure detector unit-testable without touching localStorage. `chipsForCell`
 * loads the persisted rules and passes them in.
 */
export const MAX_CHIPS = 16;

export function detectSmartChips(
  text: unknown,
  rules?: ReadonlyArray<CustomSmartChipRule>,
): SmartChip[] {
  if (typeof text !== "string" || text.length === 0) return [];
  // Skip very long cells — the popover wouldn't be useful and the per-cell
  // detection cost shouldn't grow with cell size. 8 KB is well above any
  // realistic single-cell text.
  if (text.length > 8192) return [];

  const raw: SmartChip[] = [];

  // URL — highest priority.
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    // Trim trailing punctuation that's almost never part of a URL.
    let end = m.index + m[0].length;
    while (end > m.index + 1) {
      const ch = text.charCodeAt(end - 1);
      // ) ] } , . ; : ! ? " '
      if (
        ch === 41 || ch === 93 || ch === 125 ||
        ch === 44 || ch === 46 || ch === 59 ||
        ch === 58 || ch === 33 || ch === 63 ||
        ch === 34 || ch === 39
      ) {
        end--;
      } else break;
    }
    raw.push({
      kind: "url",
      value: text.slice(m.index, end),
      start: m.index,
      end,
    });
    if (raw.length >= MAX_CHIPS) break;
  }

  // Email — priority 2.
  if (raw.length < MAX_CHIPS) {
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(text)) !== null) {
      raw.push({
        kind: "email",
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
      });
      if (raw.length >= MAX_CHIPS) break;
    }
  }

  // Dates — priority 3.
  if (raw.length < MAX_CHIPS) {
    for (const pat of DATE_PATTERNS) {
      pat.regex.lastIndex = 0;
      while ((m = pat.regex.exec(text)) !== null) {
        const parsed = pat.parse(m);
        if (!parsed) continue;
        const iso = toIsoOrNull(parsed.y, parsed.mo, parsed.d);
        if (!iso) continue;
        raw.push({
          kind: "date",
          value: m[0],
          start: m.index,
          end: m.index + m[0].length,
          iso,
        });
        if (raw.length >= MAX_CHIPS) break;
      }
      if (raw.length >= MAX_CHIPS) break;
    }
  }

  // Date.parse() fallback: if no chips matched at all and the *whole*
  // trimmed cell looks like a date the native parser understands, surface
  // it. We gate on "whole cell only" so that arbitrary substrings (like a
  // log timestamp inside paragraph text) don't trigger false positives.
  //
  // Importantly we also gate on "doesn't match any of our primary date
  // shapes" — otherwise an impossible date like "2026-02-30" that our
  // strict regex rejects would silently fall through to the lenient native
  // parser (which would roll it to Mar 2). The bare regex .test() ignores
  // its lastIndex so this is independent of the /g scans above.
  if (raw.length === 0) {
    const trimmed = text.trim();
    if (trimmed.length >= 4 && trimmed.length <= 64) {
      const matchesPrimaryShape = DATE_PATTERNS.some((pat) => {
        // Build a non-global anchored test so we don't share lastIndex
        // state with the /g scans above.
        const src = pat.regex.source;
        const anchored = new RegExp(`^(?:${src})$`);
        return anchored.test(trimmed);
      });
      if (!matchesPrimaryShape) {
        const t = Date.parse(trimmed);
        if (Number.isFinite(t)) {
          // Use *local* components, not UTC: "May 18, 2026" parses to a
          // local-midnight Date, and the user means the calendar day they
          // typed, not its UTC-shifted neighbour.
          const d = new Date(t);
          const iso = toIsoOrNull(
            d.getFullYear(),
            d.getMonth() + 1,
            d.getDate(),
          );
          if (iso) {
            // Use original-text offsets so the popover can highlight the
            // matched span — Date.parse() consumed the whole trimmed value.
            const lead = text.indexOf(trimmed);
            raw.push({
              kind: "date",
              value: trimmed,
              start: lead >= 0 ? lead : 0,
              end: (lead >= 0 ? lead : 0) + trimmed.length,
              iso,
            });
          }
        }
      }
    }
  }

  // Custom rules (#185) — lowest priority. Each enabled rule is compiled to
  // a fresh global regex (compileRule re-runs validateRulePattern so a
  // corrupted localStorage payload can't smuggle a ReDoS pattern past us).
  // We cap matches per rule via MAX_MATCHES_PER_CELL and the whole pass via
  // MAX_CHIPS so a greedy pattern can't flood the popover.
  if (rules && rules.length > 0 && raw.length < MAX_CHIPS) {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const re = compileRule(rule);
      if (!re) continue;
      re.lastIndex = 0;
      let ruleMatches = 0;
      while ((m = re.exec(text)) !== null) {
        // Guard against a zero-width match looping forever.
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const actionUrl = expandUrlTemplate(rule.urlTemplate, m);
        if (actionUrl) {
          raw.push({
            kind: "custom",
            value: m[0],
            start: m.index,
            end: m.index + m[0].length,
            ruleId: rule.id,
            ruleName: rule.name,
            actionUrl,
          });
        }
        ruleMatches += 1;
        if (ruleMatches >= MAX_MATCHES_PER_CELL) break;
        if (raw.length >= MAX_CHIPS) break;
      }
      if (raw.length >= MAX_CHIPS) break;
    }
  }

  if (raw.length === 0) return raw;

  // Sort by (start, -priority) then drop any chip whose span overlaps a
  // higher-priority chip we've already kept. This is what enforces the
  // url > email > date > custom precedence: when "https://example.com/2026"
  // matches both URL and date, we keep only the URL.
  raw.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return CHIP_PRIORITY[b.kind] - CHIP_PRIORITY[a.kind];
  });

  const kept: SmartChip[] = [];
  for (const chip of raw) {
    const overlap = kept.some(
      (k) =>
        chip.start < k.end &&
        chip.end > k.start &&
        CHIP_PRIORITY[k.kind] >= CHIP_PRIORITY[chip.kind],
    );
    if (overlap) continue;
    // Also drop any *already-kept* chip that this higher-priority chip
    // overlaps with. Order-wise we visit in (start, prio desc), so this
    // case only happens when an equal-start chip outranks one we kept;
    // we'd already have rejected the lower-prio in the loop above. Belt-
    // and-suspenders is cheap here.
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      if (
        chip.start < k.end &&
        chip.end > k.start &&
        CHIP_PRIORITY[chip.kind] > CHIP_PRIORITY[k.kind]
      ) {
        kept.splice(i, 1);
      }
    }
    kept.push(chip);
  }
  // Sort final list by start offset so callers can render left-to-right.
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

interface ChipsSnapshot {
  sheets?: Record<
    string,
    | {
        cellData?: Record<
          string,
          Record<string, { v?: unknown; f?: unknown } | undefined> | undefined
        >;
      }
    | undefined
  >;
}

/**
 * Lazy chip lookup for a single (sheetId, row, col). Reads the cell's `v`
 * directly out of the snapshot, runs detectSmartChips, returns the result.
 *
 * - Returns [] for any cell that's empty, has a formula (we don't want
 *   chips on `=HYPERLINK(...)` results — confusing UX overlap with the
 *   built-in hyperlink path), or whose snapshot is malformed.
 * - Accepts either a JSON string or pre-parsed snapshot so callers can
 *   skip a re-parse when they already have the object.
 * - Loads the user's custom rules (#185) from localStorage. An explicit
 *   `rules` argument overrides that (used by tests for a deterministic
 *   rule set without touching storage).
 */
export function chipsForCell(
  snapshot: string | object | null | undefined,
  sheetId: string,
  row: number,
  col: number,
  rules?: ReadonlyArray<CustomSmartChipRule>,
): SmartChip[] {
  if (!snapshot) return [];
  let parsed: ChipsSnapshot | null = null;
  if (typeof snapshot === "string") {
    try {
      parsed = JSON.parse(snapshot) as ChipsSnapshot;
    } catch {
      return [];
    }
  } else if (typeof snapshot === "object") {
    parsed = snapshot as ChipsSnapshot;
  }
  if (!parsed || typeof parsed !== "object") return [];
  const cell = parsed.sheets?.[sheetId]?.cellData?.[String(row)]?.[String(col)];
  if (!cell || typeof cell !== "object") return [];
  // Skip formula-driven cells — they're computed, the chip would point at
  // an artifact of the formula rather than user-entered data.
  const f = (cell as { f?: unknown }).f;
  if (f !== undefined && f !== null && f !== "") return [];
  const v = (cell as { v?: unknown }).v;
  return detectSmartChips(v, rules ?? loadCustomRules());
}

/**
 * Pick the single chip a single click should act on. Highest priority wins;
 * within the same kind, the earliest occurrence wins. Returns null when the
 * cell has no chips.
 */
export function primaryChip(chips: SmartChip[]): SmartChip | null {
  if (!Array.isArray(chips) || chips.length === 0) return null;
  let best: SmartChip | null = null;
  for (const c of chips) {
    if (!best) {
      best = c;
      continue;
    }
    if (CHIP_PRIORITY[c.kind] > CHIP_PRIORITY[best.kind]) {
      best = c;
    } else if (
      CHIP_PRIORITY[c.kind] === CHIP_PRIORITY[best.kind] &&
      c.start < best.start
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Build the URL the OS shell should open for a chip. URLs pass through;
 * emails are wrapped in `mailto:`; custom chips use their pre-expanded
 * `actionUrl`. Returns null for `date` chips (they open a picker, not a
 * URL) and for any malformed input.
 */
export function chipActionUrl(chip: SmartChip): string | null {
  if (!chip || typeof chip !== "object") return null;
  if (chip.kind === "url") {
    const t = chip.value.trim();
    return t || null;
  }
  if (chip.kind === "email") {
    const t = chip.value.trim();
    if (!t) return null;
    return `mailto:${t}`;
  }
  if (chip.kind === "custom") {
    const t = chip.actionUrl?.trim();
    return t || null;
  }
  return null;
}

// User-extensible smart-chip rules (#185) — fully local, no backend.
//
// A custom rule pairs a user-authored regex pattern with an action-URL
// template. When a cell's text matches the pattern, a "custom" chip is
// surfaced; activating it expands the template (`$0` = whole match,
// `$1`..`$9` = capture groups) into an http(s) URL handed to `open_url`.
//
// Example: pattern `JIRA-\d+` + template
// `https://my.atlassian.net/browse/$0` turns "JIRA-1234" into a clickable
// chip that opens the ticket.
//
// Local-first / serverless policy: rules live entirely in localStorage.
// There is no sync, no directory backend, nothing leaves the machine.
//
// SECURITY — the regex comes from the user, so it is treated as untrusted
// input even though "the user" authored it (a malicious .coco/.xlsx can't
// inject rules, but a pasted pattern from the web can still be a ReDoS
// landmine). `validateRulePattern` rejects:
//   - patterns over MAX_PATTERN_LEN characters,
//   - catastrophic-backtracking shapes — an unbounded-quantified group with
//     an ambiguous body, e.g. `(a+)+`, `(a*)*`, `([a-z]+)*`, `(a|aa)+`,
//     `(a+|b)+`, `((a+))+` — detected by a bracket-aware scan
//     (`hasCatastrophicBacktracking`),
//   - any pattern `new RegExp` itself refuses to compile,
//   - flags outside a tiny allowlist.
// At match time we additionally cap the number of matches per cell.

export interface CustomSmartChipRule {
  /** Stable id (also the React key). */
  id: string;
  /** Human label shown in Settings and as the chip's action title. */
  name: string;
  /** Raw regex source (no surrounding slashes). User-authored. */
  pattern: string;
  /** Regex flags — subset of "gimsu". `g` is always applied at scan time
   *  regardless; storing it here is harmless. */
  flags: string;
  /** Action-URL template. `$0` = whole match, `$1`..`$9` = groups. Must
   *  expand to an http(s) URL (open_url rejects other schemes). */
  urlTemplate: string;
  /** Disabled rules are kept but skipped by the detector. */
  enabled: boolean;
}

export const STORAGE_KEY = "coco.smartChips.customRules";

/** Hard cap on pattern source length — long patterns are both a ReDoS
 *  surface and a sign of a copy-paste accident. */
export const MAX_PATTERN_LEN = 200;

/** Flags the user is allowed to set. `g`/`y` are excluded: the detector
 *  manages global scanning itself, and sticky `y` would break it. */
export const ALLOWED_FLAGS = ["i", "m", "s", "u"] as const;

/** Per-cell match cap — even a "safe" pattern shouldn't be allowed to emit
 *  thousands of chips from one pathological cell. */
export const MAX_MATCHES_PER_CELL = 32;

export type RuleValidationError =
  | "EMPTY_PATTERN"
  | "PATTERN_TOO_LONG"
  | "REDOS_RISK"
  | "INVALID_REGEX"
  | "INVALID_FLAGS"
  | "EMPTY_NAME"
  | "EMPTY_TEMPLATE"
  | "TEMPLATE_NOT_HTTP";

export interface RuleValidationResult {
  ok: boolean;
  error?: RuleValidationError;
}

/**
 * Catastrophic-backtracking detector.
 *
 * We can't decide ReDoS in general, so we reject the well-known dangerous
 * *shape*: a group that is itself unbounded-quantified and whose body can
 * match the same input in more than one way. That ambiguity is what makes
 * the engine explore exponentially many paths on a near-match.
 *
 * Instead of a fragile single regex (the old `[^()]*`-based heuristic, which
 * couldn't see inside nested parens and so missed `(a|aa)+`, `((a+))+`,
 * `(a+|b)+`, ...), this walks the pattern with a real, bracket-aware parser:
 *
 *   1. Scan left-to-right, correctly skipping escapes (`\(`, `\|`, ...) and
 *      character classes `[...]` (whose internal `(`/`)`/`|` are literal).
 *   2. Track `(...)` group nesting and record each group's body range.
 *   3. For each group, check whether the very next token is an unbounded
 *      quantifier (`+`, `*`, `{n,}`), optionally lazy (`+?` etc.).
 *   4. If a group IS unbounded-quantified, inspect its body for any of:
 *        (a) a nested unbounded quantifier,
 *        (b) a top-level alternation `|`,
 *        (c) a nested unbounded-quantified group,
 *      any of which makes the body ambiguous → reject.
 *   5. Also reject two adjacent unbounded quantifiers (`a+*`, `a*+`).
 *
 * This errs toward rejecting some safe patterns, which is the right
 * trade-off for an untrusted-input field — the user can simplify.
 */

/** True if `re[i]` begins an unbounded quantifier (`+`, `*`, or `{n,}`).
 *  `{n}` and `{n,m}` are bounded and therefore safe. */
function isUnboundedQuantifierAt(re: string, i: number): boolean {
  const ch = re[i];
  if (ch === "+" || ch === "*") return true;
  if (ch === "{") {
    // `{n,}` is unbounded; `{n}` / `{n,m}` are bounded.
    const close = re.indexOf("}", i);
    if (close < 0) return false;
    const inner = re.slice(i + 1, close);
    return /^\d*,\s*$/.test(inner) && /\d/.test(inner);
  }
  return false;
}

/** Length of the quantifier token starting at `re[i]`, or 0 if none.
 *  Consumes a trailing `?` (lazy) as part of the token. */
function quantifierLengthAt(re: string, i: number): number {
  const ch = re[i];
  let len = 0;
  if (ch === "+" || ch === "*" || ch === "?") {
    len = 1;
  } else if (ch === "{") {
    const close = re.indexOf("}", i);
    if (close >= 0 && /^\d+(,\d*)?$/.test(re.slice(i + 1, close))) {
      len = close - i + 1;
    }
  }
  if (len > 0 && re[i + len] === "?") len += 1; // lazy modifier
  return len;
}

/** Scan a group body (already stripped of its outer parens) and report
 *  whether it is "ambiguous" enough to be dangerous under an outer
 *  unbounded quantifier: a nested unbounded quantifier, a top-level
 *  alternation, or a nested unbounded-quantified group. */
function bodyIsAmbiguous(body: string): boolean {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i += 1; // skip the escaped char
      continue;
    }
    if (ch === "[") {
      // Skip a character class — its contents are all literal.
      i += 1;
      if (body[i] === "^") i += 1;
      if (body[i] === "]") i += 1; // leading `]` is literal
      while (i < body.length && body[i] !== "]") {
        if (body[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    // (b) a top-level alternation makes the body match ambiguously.
    if (ch === "|" && depth === 0) return true;
    // (a)/(c) any unbounded quantifier inside the body — whether on a bare
    // atom or on a nested group — is enough to flag it.
    if (isUnboundedQuantifierAt(body, i)) return true;
  }
  return false;
}

/**
 * Pure, testable catastrophic-backtracking shape detector. Returns true if
 * the pattern contains an unbounded-quantified group with an ambiguous body
 * (the exponential-blowup shape), or two adjacent unbounded quantifiers.
 */
export function hasCatastrophicBacktracking(pattern: string): boolean {
  // Stack of opening-paren indices for the groups currently open.
  const openStack: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1; // escaped char — never structural
      continue;
    }
    if (ch === "[") {
      // Skip a character class wholesale.
      i += 1;
      if (pattern[i] === "^") i += 1;
      if (pattern[i] === "]") i += 1;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "(") {
      openStack.push(i);
      continue;
    }
    if (ch === ")") {
      const open = openStack.pop();
      if (open === undefined) continue; // unbalanced — `new RegExp` will reject
      // Is this group immediately followed by an unbounded quantifier?
      if (isUnboundedQuantifierAt(pattern, i + 1)) {
        // Body excludes the parens. A leading `?:` / `?<name>` / lookaround
        // prefix is harmless to keep — alternation/quantifier scanning is
        // unaffected by it.
        const body = pattern.slice(open + 1, i);
        if (bodyIsAmbiguous(body)) return true;
      }
      continue;
    }
    // Two adjacent unbounded quantifiers on the same atom (`a+*`, `a*+`).
    if (isUnboundedQuantifierAt(pattern, i)) {
      const q = quantifierLengthAt(pattern, i);
      if (q > 0 && isUnboundedQuantifierAt(pattern, i + q)) return true;
    }
  }
  return false;
}

/**
 * Validate just the regex pattern + flags. Returns ok:false with a specific
 * error code so the Settings UI can show a targeted message.
 */
export function validateRulePattern(
  pattern: string,
  flags: string,
): RuleValidationResult {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, error: "EMPTY_PATTERN" };
  }
  if (pattern.length > MAX_PATTERN_LEN) {
    return { ok: false, error: "PATTERN_TOO_LONG" };
  }
  // Flags must all be in the allowlist (and not repeated — RegExp throws on
  // duplicates anyway, but we surface a clean error first).
  if (typeof flags !== "string") {
    return { ok: false, error: "INVALID_FLAGS" };
  }
  const seen = new Set<string>();
  for (const ch of flags) {
    if (!(ALLOWED_FLAGS as readonly string[]).includes(ch) || seen.has(ch)) {
      return { ok: false, error: "INVALID_FLAGS" };
    }
    seen.add(ch);
  }
  if (hasCatastrophicBacktracking(pattern)) {
    return { ok: false, error: "REDOS_RISK" };
  }
  // Final gate: does the engine accept it at all? Compile with the user's
  // flags plus `g` (the detector needs `g`; `g` never changes acceptance).
  // A throw here means a malformed pattern.
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, `${flags}g`);
  } catch {
    return { ok: false, error: "INVALID_REGEX" };
  }
  return { ok: true };
}

/**
 * Validate a whole rule (name, pattern, flags, template). Used by the
 * Settings CRUD UI before persisting.
 */
export function validateRule(
  rule: Pick<CustomSmartChipRule, "name" | "pattern" | "flags" | "urlTemplate">,
): RuleValidationResult {
  if (typeof rule.name !== "string" || rule.name.trim().length === 0) {
    return { ok: false, error: "EMPTY_NAME" };
  }
  const patternResult = validateRulePattern(rule.pattern, rule.flags);
  if (!patternResult.ok) return patternResult;
  if (
    typeof rule.urlTemplate !== "string" ||
    rule.urlTemplate.trim().length === 0
  ) {
    return { ok: false, error: "EMPTY_TEMPLATE" };
  }
  // The template must start with http:// or https:// — `open_url` (shell.rs)
  // rejects every other scheme, so a non-http template would silently never
  // open. Reject it up-front instead.
  const t = rule.urlTemplate.trim().toLowerCase();
  if (!t.startsWith("http://") && !t.startsWith("https://")) {
    return { ok: false, error: "TEMPLATE_NOT_HTTP" };
  }
  return { ok: true };
}

/**
 * Compile a validated rule into a fresh global RegExp ready for scanning.
 * Returns null if the rule is somehow invalid (defends the detector against
 * a corrupted localStorage payload). Always produces a `g`-flagged regex
 * with a reset lastIndex.
 */
export function compileRule(rule: CustomSmartChipRule): RegExp | null {
  const result = validateRulePattern(rule.pattern, rule.flags);
  if (!result.ok) return null;
  try {
    const flags = rule.flags.includes("g") ? rule.flags : `${rule.flags}g`;
    return new RegExp(rule.pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Expand a rule's URL template against a match. `$0` → whole match,
 * `$1`..`$9` → capture groups (encodeURIComponent'd so a match containing
 * spaces / `#` / `&` can't break the URL or smuggle a second query param).
 * `$$` → literal `$`. Returns null when the result isn't an http(s) URL.
 */
export function expandUrlTemplate(
  template: string,
  match: RegExpExecArray,
): string | null {
  if (typeof template !== "string") return null;
  const expanded = template.replace(/\$(\$|\d)/g, (_whole, token: string) => {
    if (token === "$") return "$";
    const idx = Number(token);
    const group = match[idx];
    return typeof group === "string" ? encodeURIComponent(group) : "";
  });
  const lower = expanded.trim().toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    return null;
  }
  return expanded.trim();
}

// ---- localStorage persistence -------------------------------------------

function isRule(value: unknown): value is CustomSmartChipRule {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.pattern === "string" &&
    typeof r.flags === "string" &&
    typeof r.urlTemplate === "string" &&
    typeof r.enabled === "boolean"
  );
}

/**
 * Read all persisted rules. Returns [] on any parse/shape failure so a
 * corrupted payload degrades gracefully instead of crashing the detector.
 */
export function loadCustomRules(): CustomSmartChipRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRule);
  } catch {
    return [];
  }
}

/** Persist the full rule list. Best-effort — a full/blocked localStorage
 *  surfaces as a console warning rather than throwing into the UI. */
export function saveCustomRules(rules: CustomSmartChipRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("custom smart-chip rules save failed:", err);
  }
}

function newId(): string {
  // crypto.randomUUID is available in the Tauri webview; fall back to a
  // timestamp+random combo for non-secure-context test environments.
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Append a validated rule and persist. Returns the created rule, or a
 * validation error. The caller (Settings UI) shows the error inline.
 */
export function addCustomRule(
  draft: Pick<CustomSmartChipRule, "name" | "pattern" | "flags" | "urlTemplate"> & {
    enabled?: boolean;
  },
): { ok: true; rule: CustomSmartChipRule } | { ok: false; error: RuleValidationError } {
  const result = validateRule(draft);
  if (!result.ok) return { ok: false, error: result.error! };
  const rule: CustomSmartChipRule = {
    id: newId(),
    name: draft.name.trim(),
    pattern: draft.pattern,
    flags: draft.flags,
    urlTemplate: draft.urlTemplate.trim(),
    enabled: draft.enabled ?? true,
  };
  const rules = loadCustomRules();
  rules.push(rule);
  saveCustomRules(rules);
  return { ok: true, rule };
}

/**
 * Replace an existing rule by id with a validated patch and persist.
 * Returns the updated list, or a validation error.
 */
export function updateCustomRule(
  id: string,
  patch: Partial<Omit<CustomSmartChipRule, "id">>,
): { ok: true; rules: CustomSmartChipRule[] } | { ok: false; error: RuleValidationError } {
  const rules = loadCustomRules();
  const idx = rules.findIndex((r) => r.id === id);
  if (idx < 0) return { ok: true, rules };
  const merged: CustomSmartChipRule = { ...rules[idx], ...patch, id };
  const result = validateRule(merged);
  if (!result.ok) return { ok: false, error: result.error! };
  rules[idx] = merged;
  saveCustomRules(rules);
  return { ok: true, rules };
}

/** Delete a rule by id and persist. Returns the surviving rules. */
export function deleteCustomRule(id: string): CustomSmartChipRule[] {
  const rules = loadCustomRules().filter((r) => r.id !== id);
  saveCustomRules(rules);
  return rules;
}

/** Toggle a rule's enabled flag and persist. Returns the updated rules. */
export function toggleCustomRule(id: string): CustomSmartChipRule[] {
  const rules = loadCustomRules();
  const idx = rules.findIndex((r) => r.id === id);
  if (idx >= 0) {
    rules[idx] = { ...rules[idx], enabled: !rules[idx].enabled };
    saveCustomRules(rules);
  }
  return rules;
}

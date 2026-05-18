// Pure helpers for Excel/Sheets-style Flash Fill (Ctrl+E).
//
// Given a source column (e.g. A) and a target column (B) that the user has
// partially filled with a few example values, we infer the transformation
// taking each `A[i]` to `B[i]` and apply that transformation to the empty
// rows below. We support the small Excel-style vocabulary used by the MVP:
//   - substring extract (everything before / after / between delimiters)
//   - case conversion (lower / upper / title)
//   - digit extract
//   - literal substring replace
//   - a one-level `compose` so e.g. "lower(before(@))" can match emails
//
// The algorithm enumerates a small candidate set, then accepts the first
// candidate whose `applyTransform` reproduces every example exactly. This
// keeps inference deterministic and side-effect free so it can be unit
// tested without Univer.

export type FlashFillTransform =
  | { kind: "before"; sep: string }
  | { kind: "after"; sep: string }
  | { kind: "lower" }
  | { kind: "upper" }
  | { kind: "title" }
  | { kind: "extractDigits" }
  | { kind: "between"; start: string; end: string }
  | { kind: "replace"; from: string; to: string }
  | { kind: "compose"; ops: FlashFillTransform[] };

// Convert a single token to "Title Case": first letter upper, rest lower.
// We split on whitespace boundaries only — punctuation joiners ("o'brien")
// keep their original interior casing per Excel's behaviour.
function titleCase(input: string): string {
  return input.replace(/\S+/g, (word) =>
    word.length === 0 ? word : word[0].toUpperCase() + word.slice(1).toLowerCase(),
  );
}

/** Apply a single transformation to one input string. */
export function applyTransform(input: string, t: FlashFillTransform): string {
  switch (t.kind) {
    case "before": {
      const i = input.indexOf(t.sep);
      return i < 0 ? input : input.slice(0, i);
    }
    case "after": {
      const i = input.indexOf(t.sep);
      return i < 0 ? input : input.slice(i + t.sep.length);
    }
    case "lower":
      return input.toLowerCase();
    case "upper":
      return input.toUpperCase();
    case "title":
      return titleCase(input);
    case "extractDigits": {
      const m = input.match(/\d+/g);
      return m ? m.join("") : "";
    }
    case "between": {
      const i = input.indexOf(t.start);
      if (i < 0) return "";
      const rest = input.slice(i + t.start.length);
      const j = rest.indexOf(t.end);
      return j < 0 ? "" : rest.slice(0, j);
    }
    case "replace":
      // Replace every occurrence, not just the first. `t.from === ""` would
      // hang the JS engine on `split("")`, so guard against it.
      if (t.from === "") return input;
      return input.split(t.from).join(t.to);
    case "compose": {
      let out = input;
      for (const op of t.ops) out = applyTransform(out, op);
      return out;
    }
  }
}

// True iff `applyTransform` produces every example's `to` exactly.
function matchesAll(
  examples: ReadonlyArray<{ from: string; to: string }>,
  t: FlashFillTransform,
): boolean {
  for (const ex of examples) {
    if (applyTransform(ex.from, t) !== ex.to) return false;
  }
  return true;
}

// Collect every single-character delimiter that appears in *all* of the
// `from` strings — those are the only viable separators for before/after.
function commonSingleCharDelimiters(
  examples: ReadonlyArray<{ from: string; to: string }>,
): string[] {
  if (examples.length === 0) return [];
  // Common ASCII delimiters in real-world data; extend on demand.
  const candidates = ["@", ".", " ", ",", ";", ":", "-", "_", "/", "\\", "|", "\t"];
  return candidates.filter((c) => examples.every((ex) => ex.from.includes(c)));
}

// Pairs of delimiters whose order is `start ... end` in every example. Used
// for the `between` candidate (e.g. "(123) 4567" with start="(" end=")").
function commonDelimiterPairs(
  examples: ReadonlyArray<{ from: string; to: string }>,
): Array<{ start: string; end: string }> {
  const singles = ["(", "[", "{", "<", '"', "'"];
  const closes: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    "<": ">",
    '"': '"',
    "'": "'",
  };
  const out: Array<{ start: string; end: string }> = [];
  for (const s of singles) {
    const e = closes[s];
    const ok = examples.every((ex) => {
      const i = ex.from.indexOf(s);
      if (i < 0) return false;
      return ex.from.indexOf(e, i + s.length) > i;
    });
    if (ok) out.push({ start: s, end: e });
  }
  return out;
}

// Look at the first example to propose a literal `replace` candidate. We
// find the longest substring of `from` that has been replaced by some other
// substring in `to` — limited heuristic, but covers cases like
// "Acme Corp" → "Acme Corporation" (replace "Corp" → "Corporation").
function replaceCandidates(
  examples: ReadonlyArray<{ from: string; to: string }>,
): FlashFillTransform[] {
  if (examples.length === 0) return [];
  const first = examples[0];
  const out: FlashFillTransform[] = [];
  // Try every contiguous substring of `from` (length ≥ 1) and see if removing
  // it from `from` reveals the same prefix/suffix in `to`.
  for (let i = 0; i < first.from.length; i++) {
    for (let j = i + 1; j <= first.from.length; j++) {
      const sub = first.from.slice(i, j);
      const prefix = first.from.slice(0, i);
      const suffix = first.from.slice(j);
      if (!first.to.startsWith(prefix) || !first.to.endsWith(suffix)) continue;
      const replacement = first.to.slice(prefix.length, first.to.length - suffix.length);
      // Skip the no-op and any candidate where `from` and `to` are identical
      // (the `lower`/`upper`/etc. candidates will catch pure case changes).
      if (sub === replacement) continue;
      out.push({ kind: "replace", from: sub, to: replacement });
    }
  }
  return out;
}

/**
 * Try every candidate transformation in priority order and return the first
 * one that maps each example's `from` to its `to` exactly. Returns null when
 * no candidate fits — caller surfaces "Flash Fill could not detect a pattern".
 *
 * Priority bias: pure single-op transforms first (smaller, more general),
 * then compositions like `lower(before(@))`. Within a category we keep the
 * order the candidates were emitted so the result is stable across runs.
 */
export function inferTransform(
  examples: ReadonlyArray<{ from: string; to: string }>,
): FlashFillTransform | null {
  if (examples.length < 1) return null;

  // The single-op candidate set — order matters: tighter / more specific
  // first so we prefer "before('@')" over "replace" when both fit.
  const singles: FlashFillTransform[] = [];
  for (const sep of commonSingleCharDelimiters(examples)) {
    singles.push({ kind: "before", sep });
    singles.push({ kind: "after", sep });
  }
  for (const pair of commonDelimiterPairs(examples)) {
    singles.push({ kind: "between", start: pair.start, end: pair.end });
  }
  singles.push({ kind: "lower" }, { kind: "upper" }, { kind: "title" });
  singles.push({ kind: "extractDigits" });
  for (const rep of replaceCandidates(examples)) singles.push(rep);

  for (const cand of singles) {
    if (matchesAll(examples, cand)) return cand;
  }

  // Two-step compositions: a substring extract followed by a case change. We
  // intentionally do not enumerate every Cartesian product — only the
  // combinations that arise in practice (extract → casing).
  const casings: FlashFillTransform[] = [
    { kind: "lower" },
    { kind: "upper" },
    { kind: "title" },
  ];
  const extracts: FlashFillTransform[] = [];
  for (const sep of commonSingleCharDelimiters(examples)) {
    extracts.push({ kind: "before", sep });
    extracts.push({ kind: "after", sep });
  }
  for (const pair of commonDelimiterPairs(examples)) {
    extracts.push({ kind: "between", start: pair.start, end: pair.end });
  }
  for (const extract of extracts) {
    for (const casing of casings) {
      const composed: FlashFillTransform = {
        kind: "compose",
        ops: [extract, casing],
      };
      if (matchesAll(examples, composed)) return composed;
    }
  }

  return null;
}

/**
 * Run Flash Fill end-to-end:
 *   - `sourceCol`        — every row of the column to the left (A).
 *   - `exampleTargetCol` — same length as `sourceCol`; the first N entries
 *                          are the user's example values, the rest are
 *                          empty strings (or null/undefined) for the rows
 *                          we should fill.
 *
 * Returns the filled column (preserves the example rows verbatim) plus the
 * inferred transform, or null when:
 *   - fewer than 1 example is provided, OR
 *   - source column is empty, OR
 *   - no candidate transform reproduces every example exactly.
 */
export function runFlashFill(
  sourceCol: ReadonlyArray<string>,
  exampleTargetCol: ReadonlyArray<string | null | undefined>,
): { filled: string[]; transform: FlashFillTransform } | null {
  if (sourceCol.length === 0) return null;
  // Build example pairs from rows where both source and target are non-empty.
  const examples: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < sourceCol.length; i++) {
    const target = exampleTargetCol[i];
    if (target === null || target === undefined || target === "") continue;
    examples.push({ from: sourceCol[i] ?? "", to: target });
  }
  if (examples.length === 0) return null;
  const transform = inferTransform(examples);
  if (!transform) return null;
  const filled: string[] = [];
  for (let i = 0; i < sourceCol.length; i++) {
    const existing = exampleTargetCol[i];
    if (existing !== null && existing !== undefined && existing !== "") {
      // Preserve user-typed examples verbatim — don't second-guess them.
      filled.push(existing);
    } else {
      filled.push(applyTransform(sourceCol[i] ?? "", transform));
    }
  }
  return { filled, transform };
}

/** Human-readable English/Japanese-friendly summary of a transform.
 *  Used by the confirmation dialog so the user can verify intent before
 *  committing the fill. */
export function describeTransform(t: FlashFillTransform): string {
  switch (t.kind) {
    case "before":
      return `Extract everything before "${t.sep}"`;
    case "after":
      return `Extract everything after "${t.sep}"`;
    case "lower":
      return "Convert to lowercase";
    case "upper":
      return "Convert to UPPERCASE";
    case "title":
      return "Convert to Title Case";
    case "extractDigits":
      return "Extract digits";
    case "between":
      return `Extract text between "${t.start}" and "${t.end}"`;
    case "replace":
      return `Replace "${t.from}" with "${t.to}"`;
    case "compose":
      return t.ops.map(describeTransform).join(" → ");
  }
}

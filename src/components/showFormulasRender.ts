// Show-Formulas view patch (Excel "Ctrl+`" / "Show Formulas" toggle).
//
// When the toolbar/menu toggle is on, every formula cell should display
// its source formula text (e.g. "=SUM(A1:A10)") instead of the computed
// value. Univer 0.5.x has no built-in toggle for this, so we apply the
// effect at the snapshot-patch layer: rewrite each cell's `v` from
// `cell.f` before handing the snapshot to `univer.createUnit`.
//
// Mirrors the `patchHyperlinkRenders` / `patchCfRenders` contract:
//   - Pure: input is structurally cloned, never mutated.
//   - Idempotent: re-applying produces the same output (we always derive
//     the next `v` from `cell.f`, not from the previous `v`).
//   - Fail-soft: returns the input untouched on serialization errors.
//
// When `enabled` is false the patch is a true no-op — we return the
// snapshot reference unchanged so the integrator can skip a clone in
// the common "feature off" path.

type SnapshotShape = {
  sheets?: Record<
    string,
    {
      cellData?: Record<
        string,
        Record<string, { v?: unknown; f?: unknown; s?: unknown } | undefined>
      >;
    } | undefined
  >;
};

// Glyph prefixes written by sibling view-patches (`patchShowAllCommentsView`
// writes "💬 ", `patchErrorIndicators` writes "⚠ "). When Show-Formulas runs
// after one of those patches we must preserve the leading glyph(s) so the
// comment/error markers don't disappear when the user toggles formulas on.
// CF iconSet glyphs and sparkline glyphs are intentionally NOT preserved —
// those decorations were derived from `cell.v`'s old value and would be
// stale once we replace `v` with the formula text. (The cell's iconSet
// style still re-renders on the next pipeline pass when show-formulas is
// off again.)
const COMMENT_GLYPH_PREFIX = "\u{1F4AC} "; // 💬 (U+1F4AC + space)
const ERROR_GLYPH_PREFIX = "⚠ "; // ⚠  (U+26A0 + space)
const KNOWN_GLYPH_PREFIXES = [COMMENT_GLYPH_PREFIX, ERROR_GLYPH_PREFIX] as const;

/**
 * Strip any leading known glyph prefixes ("💬 ", "⚠ ") off `value` and return
 * `{ prefix, rest }` where `prefix` is the concatenation of the prefixes we
 * found (in order) and `rest` is whatever remained. Idempotent — calling on
 * an already-stripped value returns `{ prefix: "", rest: value }`. Order of
 * the prefixes in the input is preserved in the output `prefix`. We loop so
 * a cell that's been marked by both patches (`💬 ⚠ ...`) still strips both.
 */
export function extractKnownPrefixes(value: string): { prefix: string; rest: string } {
  let prefix = "";
  let rest = value;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const glyph of KNOWN_GLYPH_PREFIXES) {
      if (rest.startsWith(glyph)) {
        prefix += glyph;
        rest = rest.slice(glyph.length);
        progressed = true;
        break;
      }
    }
  }
  return { prefix, rest };
}

/**
 * Return a snapshot with every formula cell's display value replaced by
 * its formula text (prefixed `=`) when `enabled` is true. When `enabled`
 * is false the original snapshot reference is returned unchanged — this
 * is the common path and we don't want to pay the clone cost.
 *
 * Behavior on a formula cell:
 *   - `cell.f` truthy, non-empty string → `cell.v` becomes `"=" + cell.f`
 *     (unless `cell.f` already starts with `=`, in which case it's used
 *     verbatim — round-trips that store the leading `=` stay correct).
 *   - `cell.f` missing / empty → cell is left alone.
 *
 * The patch never deletes `cell.f` itself — the formula text remains
 * available for the round-trip writer and for the inverse toggle.
 */
export function patchShowFormulasView<T>(snapshot: T, enabled: boolean): T {
  if (!enabled) return snapshot;
  if (!snapshot || typeof snapshot !== "object") return snapshot;

  let cloned: SnapshotShape;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as SnapshotShape;
  } catch {
    return snapshot;
  }

  const sheets = cloned.sheets;
  if (!sheets) return cloned as unknown as T;

  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId];
    const cellData = sheet?.cellData;
    if (!cellData || typeof cellData !== "object") continue;

    for (const rowKey of Object.keys(cellData)) {
      const rowObj = cellData[rowKey];
      if (!rowObj || typeof rowObj !== "object") continue;
      for (const colKey of Object.keys(rowObj)) {
        const cell = rowObj[colKey];
        if (!cell || typeof cell !== "object") continue;
        const f = cell.f;
        if (typeof f !== "string" || f.length === 0) continue;
        // Allow round-tripped formulas that already carry a leading "=" —
        // don't double it.
        const formula = f.startsWith("=") ? f : `=${f}`;
        // Preserve any leading 💬 / ⚠ glyphs that the comments / error
        // patches wrote BEFORE us — otherwise toggling Show-Formulas
        // clobbers those markers (#112). We strip the existing prefix
        // off the current `v` first so re-applying this patch doesn't
        // double-prepend, then re-emit `<prefix><=formula>`. Pure
        // function of `cell.f` + `cell.v`'s prefix, so idempotent.
        const currentV = typeof cell.v === "string" ? cell.v : "";
        const { prefix } = extractKnownPrefixes(currentV);
        cell.v = `${prefix}${formula}`;
        // We deliberately do NOT touch `cell.s` here: ErrorIndicators may
        // have set `cl: { rgb: "#C00000" }` and we want the red font to
        // remain when the user toggles Show-Formulas on top of an error.
      }
    }
  }

  return cloned as unknown as T;
}

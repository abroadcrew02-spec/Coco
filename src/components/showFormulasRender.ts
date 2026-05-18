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
      cellData?: Record<string, Record<string, { v?: unknown; f?: unknown } | undefined>>;
    } | undefined
  >;
};

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
        const display = f.startsWith("=") ? f : `=${f}`;
        // Replace v unconditionally — we derive purely from f so the
        // result is idempotent even after multiple applications.
        cell.v = display;
      }
    }
  }

  return cloned as unknown as T;
}

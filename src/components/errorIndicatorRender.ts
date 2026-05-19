// Error-indicator highlighting (Excel's "green triangle on error cells").
//
// Univer 0.5.x exposes no public API for injecting a cell-overlay glyph
// (the green triangle Excel paints in the top-left of error cells lives
// inside the canvas renderer's private decoration pipeline). To get an
// equivalent "this cell has a problem" signal we patch the snapshot
// before handing it to `univer.createUnit`:
//
//   1. Set a red font color on the cell (`cl: { rgb: ERROR_FONT_COLOR }`).
//   2. Prefix the cell display value `v` with a small "⚠ " glyph so the
//      marker is visible even when the cell uses default styling.
//
// Mirrors the `patchHyperlinkRenders` / `patchCfRenders` contract:
//   - Pure: input is structurally cloned.
//   - Idempotent: re-applying the patch does not double-prefix the glyph
//     and does not overwrite an existing red `cl` with a fresh object.
//   - Fail-soft: returns the input untouched on serialization errors.
//
// The marker only applies to cells whose `v` matches one of the eight
// Excel error tokens (see `ERROR_VALUES` in `store/formulaAudit`). This
// keeps the patch from accidentally restyling text cells that happen to
// contain the substring "#REF!" inside a sentence — we match the entire
// value.

import { ERROR_FONT_COLOR, ERROR_PREFIX, isErrorValue } from "../store/formulaAudit";
import { hasKnownDecoration, stripKnownDecorations } from "./renderGlyphs";

type SnapshotShape = {
  sheets?: Record<
    string,
    {
      cellData?: Record<string, Record<string, Record<string, unknown> | undefined>>;
    } | undefined
  >;
};

/**
 * Return a snapshot with every error-valued cell marked (red font + "⚠ "
 * prefix). Pure clone; safe to re-apply. Cells without an error value are
 * left untouched.
 */
export function patchErrorIndicators<T>(snapshot: T): T {
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
        // isErrorValue tolerates the "⚠ " prefix so a second pass over a
        // patched snapshot still classifies the cell as an error. To also
        // tolerate sibling-patch decorations (CF iconSet glyph, sparkline
        // bars, "💬 ", "=formula") we strip every known decoration first.
        const rawV = cell.v;
        const checkV = typeof rawV === "string" && hasKnownDecoration(rawV)
          ? stripKnownDecorations(rawV)
          : rawV;
        if (!isErrorValue(checkV)) continue;

        // Idempotent prefix — skip when the marker is already present, and
        // peel off any other sibling-patch decoration (iconSet / sparkline /
        // comment / formula prefix) before re-prefixing so we don't stack.
        const text = typeof cell.v === "string" ? cell.v : String(cell.v ?? "");
        let body = text;
        if (body.startsWith(ERROR_PREFIX)) {
          // Already marked — leave the existing prefix in place but strip any
          // additional decoration that may have stacked on top of US in a
          // later pipeline pass before this re-application.
          body = ERROR_PREFIX + (
            hasKnownDecoration(body.slice(ERROR_PREFIX.length))
              ? stripKnownDecorations(body.slice(ERROR_PREFIX.length))
              : body.slice(ERROR_PREFIX.length)
          );
        } else if (hasKnownDecoration(body)) {
          // Sibling patch decorated the cell first — strip it so the error
          // marker is the only prefix on the bare value.
          body = ERROR_PREFIX + stripKnownDecorations(body);
        } else {
          body = ERROR_PREFIX + body;
        }
        const prefixed = body;

        // Merge the red font color into the existing inline style. We
        // only set `cl` when the cell doesn't already carry our marker
        // color — preserves a user-applied red font from being needlessly
        // re-objectified, and keeps the patch idempotent against itself.
        const baseStyle =
          typeof cell.s === "object" && cell.s !== null
            ? (cell.s as Record<string, unknown>)
            : {};
        const existingCl = baseStyle.cl as { rgb?: unknown } | undefined;
        const alreadyMarked =
          existingCl !== null &&
          existingCl !== undefined &&
          typeof existingCl === "object" &&
          existingCl.rgb === ERROR_FONT_COLOR;
        const nextStyle: Record<string, unknown> = alreadyMarked
          ? baseStyle
          : { ...baseStyle, cl: { rgb: ERROR_FONT_COLOR } };

        rowObj[colKey] = {
          ...cell,
          v: prefixed,
          s: nextStyle,
        };
      }
    }
  }

  return cloned as unknown as T;
}

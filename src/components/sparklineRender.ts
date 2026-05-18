// In-grid sparkline rendering (Phase 2).
//
// Mirrors `patchHyperlinkRenders` and `patchCfRenders`: pure, idempotent
// snapshot patch that turns the structured `_sparklines` array on each
// sheet into a visible cell value + style on the anchor cell. The
// raw `_sparklines` array is preserved unchanged so the round-trip
// writer can re-emit the metadata.
//
// MVP rendering strategy: unicode-art block characters. Each sparkline's
// anchor cell `v` is overwritten with a bar/wins-losses string, and the
// cell `s` gets a monospace font + the sparkline color so the bars line
// up visually inside the cell.
//
// Cross-sheet source ranges (e.g. `Sheet1!A5:C5`) are resolved by looking
// up the referenced sheet by its `name` field — same convention Univer
// uses for cross-sheet formula refs in 0.5.x.
//
// Pipeline ordering: this patch should run BEFORE `patchCfRenders` so
// conditional-formatting rules can still re-style sparkline cells if a
// user has set them up (e.g. red fill on a row containing the sparkline).

import {
  parseA1Cell,
  parseA1Range,
  readRangeValues,
  renderColumnSparkline,
  renderLineSparkline,
  renderWinLossSparkline,
  DEFAULT_SPARKLINE_COLOR,
  type SparklineEntry,
  type SparklineSheet,
  type SparklineSnapshot,
} from "../store/sparklines";

const MONOSPACE_FONT = "Consolas, 'Courier New', monospace";

function pickRender(entry: SparklineEntry, values: number[]): string {
  switch (entry.type) {
    case "line":
      return renderLineSparkline(values);
    case "column":
      return renderColumnSparkline(values);
    case "winloss":
      return renderWinLossSparkline(values);
    default:
      return "";
  }
}

/**
 * Find the (clone of the) source sheet for a sparkline. When the range
 * carries a `Sheet1!` qualifier we look the referenced sheet up by name;
 * otherwise the source defaults to the anchor's own sheet.
 */
function resolveSourceSheet(
  sheets: Record<string, SparklineSheet | undefined>,
  anchorSheetId: string,
  range: string,
): SparklineSheet | undefined {
  const parsed = parseA1Range(range);
  if (!parsed) return undefined;
  if (!parsed.sheetName) return sheets[anchorSheetId];
  for (const sid of Object.keys(sheets)) {
    const sheet = sheets[sid];
    if (sheet && sheet.name === parsed.sheetName) return sheet;
  }
  return undefined;
}

/**
 * Return a *new* snapshot with every sparkline rendered into its anchor
 * cell. Pure — input is structurally cloned. Skips malformed entries
 * silently (no anchor, no source range, source range doesn't parse) so a
 * bad metadata entry never blocks the rest of the render.
 */
export function patchSparklineRenders<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  let cloned: SparklineSnapshot;
  try {
    cloned = JSON.parse(JSON.stringify(snapshot)) as SparklineSnapshot;
  } catch {
    return snapshot;
  }
  const sheets = cloned.sheets;
  if (!sheets) return cloned as unknown as T;

  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId];
    const sparklines = sheet?._sparklines;
    if (!Array.isArray(sparklines) || sparklines.length === 0) continue;
    if (!sheet) continue;

    const cellData = (sheet.cellData ?? (sheet.cellData = {})) as Record<
      string,
      Record<string, unknown>
    >;

    for (const entry of sparklines) {
      if (
        !entry ||
        typeof entry.cell !== "string" ||
        typeof entry.sourceRange !== "string"
      ) {
        continue;
      }
      const anchor = parseA1Cell(entry.cell);
      if (!anchor) continue;

      const sourceSheet = resolveSourceSheet(sheets, sheetId, entry.sourceRange);
      const values = readRangeValues(sourceSheet, entry.sourceRange);
      const display = pickRender(entry, values);
      if (!display) continue;

      const rowKey = String(anchor.row);
      const colKey = String(anchor.col);
      const rowMap = (cellData[rowKey] ?? (cellData[rowKey] = {})) as Record<
        string,
        unknown
      >;
      const existing = (rowMap[colKey] as Record<string, unknown> | undefined) ?? {};
      const baseStyle =
        typeof existing.s === "object" && existing.s !== null
          ? (existing.s as Record<string, unknown>)
          : {};
      const color = entry.color && entry.color.trim() ? entry.color : DEFAULT_SPARKLINE_COLOR;
      const mergedStyle: Record<string, unknown> = {
        ...baseStyle,
        ff: MONOSPACE_FONT,
        cl: { rgb: color },
      };
      rowMap[colKey] = {
        ...existing,
        v: display,
        s: mergedStyle,
      };
    }
  }

  return cloned as unknown as T;
}

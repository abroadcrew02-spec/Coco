// Pure helpers for the "Quick Print" feature (Ctrl+P).
//
// Builds a self-contained HTML document from a workbook snapshot that the
// QuickPrintDialog injects into a hidden iframe and prints via
// `iframe.contentWindow.print()`. The output intentionally mirrors the
// structure produced by the Rust-side `workbook_export_html` command
// (`src-tauri/src/commands/html_export.rs`) — one `<table class="sheet-table">`
// per sheet, inline cell styles, an `@media print` block — so a user can save
// the print preview as a PDF and get the same visual result they'd see in the
// "HTML エクスポート" path. We render in the renderer (no round-trip through
// Tauri) so the print preview is instant: the snapshot is already in memory
// and there's no need to write a temp file.
//
// Snapshot shape (Univer 0.5.x + Coco extension):
//   {
//     name?: string,
//     sheetOrder: string[],
//     styles?: Record<string, StyleObject>,
//     sheets: Record<sheetId, {
//       name?: string,
//       cellData?: Record<rowIndex, Record<colIndex, ICellData>>,
//       columnData?: Record<colIndex, { w?: number }>,
//       rowData?: Record<rowIndex, { h?: number }>,
//       _pageSetup?: { header?: string, footer?: string },
//     }>,
//   }
//
// Where ICellData is `{ v?: primitive, f?: string, s?: styleId }` and
// StyleObject is `{ font?: { bold?, italic?, color? }, fill?: { color? },
// alignment?: { horizontal?, vertical? }, borders?: { top/bottom/left/right:
// { style?, color? } } }`. We tolerate every field being absent so a
// malformed snapshot just renders empty cells rather than throwing.

export type QuickPrintScope = "activeSheet" | "allSheets";

export interface QuickPrintParams {
  scope: QuickPrintScope;
  /** Required when scope === "activeSheet"; ignored for "allSheets". */
  activeSheetId?: string;
}

interface StyleFont {
  bold?: boolean;
  italic?: boolean;
  color?: string;
}
interface StyleFill {
  color?: string;
}
interface StyleAlign {
  horizontal?: string;
  vertical?: string;
}
interface StyleBorderSide {
  style?: string;
  color?: string;
}
interface StyleBorders {
  top?: StyleBorderSide;
  bottom?: StyleBorderSide;
  left?: StyleBorderSide;
  right?: StyleBorderSide;
}
interface StyleObject {
  font?: StyleFont;
  fill?: StyleFill;
  alignment?: StyleAlign;
  borders?: StyleBorders;
}

interface CellData {
  v?: unknown;
  f?: string;
  s?: string;
}

interface MergeEntry {
  startRow?: number;
  endRow?: number;
  startCol?: number;
  endCol?: number;
}

interface SheetSnapshot {
  name?: string;
  cellData?: Record<string, Record<string, CellData> | undefined>;
  columnData?: Record<string, { w?: number } | undefined>;
  rowData?: Record<string, { h?: number } | undefined>;
  mergeData?: MergeEntry[];
  _pageSetup?: { header?: string; footer?: string };
}

interface WorkbookSnapshot {
  name?: string;
  sheetOrder?: string[];
  styles?: Record<string, StyleObject | undefined>;
  sheets?: Record<string, SheetSnapshot | undefined>;
}

const MAX_CELLS_PER_SHEET = 1_000_000;

function escapeHtml(s: string): string {
  let out = "";
  for (const c of s) {
    switch (c) {
      case "&": out += "&amp;"; break;
      case "<": out += "&lt;"; break;
      case ">": out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case "'": out += "&#39;"; break;
      case "\n": out += "<br>"; break;
      default: out += c;
    }
  }
  return out;
}

// Match the backend's color guard: only `#RGB` / `#RRGGBB` / `#RRGGBBAA`
// flow through to inline style strings. Anything else is dropped to avoid
// CSS injection from a hostile snapshot.
function isSafeColor(s: string): boolean {
  if (!s || s[0] !== "#") return false;
  const hex = s.slice(1);
  if (hex.length !== 3 && hex.length !== 6 && hex.length !== 8) return false;
  return /^[0-9a-fA-F]+$/.test(hex);
}

function computeUsedExtent(
  cellData: SheetSnapshot["cellData"],
): { rows: number; cols: number } {
  if (!cellData) return { rows: 0, cols: 0 };
  let maxRow = -1;
  let maxCol = -1;
  for (const rKey of Object.keys(cellData)) {
    const r = Number(rKey);
    if (!Number.isInteger(r) || r < 0) continue;
    const cols = cellData[rKey];
    if (!cols) continue;
    for (const cKey of Object.keys(cols)) {
      const c = Number(cKey);
      if (!Number.isInteger(c) || c < 0) continue;
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }
  }
  if (maxRow < 0 || maxCol < 0) return { rows: 0, cols: 0 };
  return { rows: maxRow + 1, cols: maxCol + 1 };
}

function renderCellText(cell: CellData): string {
  if (cell.v !== undefined && cell.v !== null) {
    const v = cell.v;
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") {
      if (Number.isFinite(v) && Math.floor(v) === v && Math.abs(v) < 1e15) {
        return String(Math.trunc(v));
      }
      return String(v);
    }
    return String(v);
  }
  if (typeof cell.f === "string" && cell.f.length > 0) {
    // Formula with no cached value — show the formula so the cell isn't blank.
    return `=${cell.f}`;
  }
  return "";
}

function renderCell(
  out: string[],
  cell: CellData | undefined,
  styles: Record<string, StyleObject | undefined> | undefined,
  colspan?: number,
  rowspan?: number,
): void {
  if (!cell) {
    if ((colspan && colspan > 1) || (rowspan && rowspan > 1)) {
      out.push("<td");
      if (colspan && colspan > 1) out.push(` colspan="${colspan}"`);
      if (rowspan && rowspan > 1) out.push(` rowspan="${rowspan}"`);
      out.push("></td>");
      return;
    }
    out.push("<td></td>");
    return;
  }
  const text = renderCellText(cell);
  const style = cell.s ? styles?.[cell.s] : undefined;
  let styleStr = "";
  let wrapBold = false;
  let wrapItalic = false;

  if (style) {
    if (style.font) {
      if (style.font.bold) wrapBold = true;
      if (style.font.italic) wrapItalic = true;
      if (style.font.color && isSafeColor(style.font.color)) {
        styleStr += `color:${style.font.color};`;
      }
    }
    if (style.fill?.color && isSafeColor(style.fill.color)) {
      styleStr += `background-color:${style.fill.color};`;
    }
    if (style.alignment) {
      const h = style.alignment.horizontal;
      if (h === "left" || h === "center" || h === "right" || h === "justify") {
        styleStr += `text-align:${h};`;
      }
      const v = style.alignment.vertical;
      if (v === "top" || v === "middle" || v === "bottom") {
        styleStr += `vertical-align:${v};`;
      }
    }
    if (style.borders) {
      const sides: Array<[keyof StyleBorders, string]> = [
        ["top", "border-top"],
        ["bottom", "border-bottom"],
        ["left", "border-left"],
        ["right", "border-right"],
      ];
      for (const [key, cssKey] of sides) {
        const side = style.borders[key];
        if (!side) continue;
        const bstyle = side.style ?? "thin";
        const bcolor =
          side.color && isSafeColor(side.color) ? side.color : "#000000";
        let widthPx = "1px";
        let cssStyle = "solid";
        switch (bstyle) {
          case "thick": widthPx = "2px"; cssStyle = "solid"; break;
          case "medium": widthPx = "1.5px"; cssStyle = "solid"; break;
          case "dotted": widthPx = "1px"; cssStyle = "dotted"; break;
          case "dashed": widthPx = "1px"; cssStyle = "dashed"; break;
          case "double": widthPx = "3px"; cssStyle = "double"; break;
          default: widthPx = "1px"; cssStyle = "solid";
        }
        styleStr += `${cssKey}:${widthPx} ${cssStyle} ${bcolor};`;
      }
    }
  }

  out.push("<td");
  if (colspan && colspan > 1) out.push(` colspan="${colspan}"`);
  if (rowspan && rowspan > 1) out.push(` rowspan="${rowspan}"`);
  if (styleStr) {
    out.push(` style="${styleStr}"`);
  }
  out.push(">");
  if (wrapBold) out.push("<b>");
  if (wrapItalic) out.push("<i>");
  out.push(escapeHtml(text));
  if (wrapItalic) out.push("</i>");
  if (wrapBold) out.push("</b>");
  out.push("</td>");
}

// Build a merge lookup keyed by `r,c`. Each (r,c) cell that's a merge anchor
// (top-left) maps to {anchor: true, colspan, rowspan}. Every other cell
// inside a merge rectangle maps to {anchor: false}. Cells outside any merge
// are absent. Tolerates malformed entries (non-integer indices, inverted
// rects) by silently dropping them — a hostile snapshot must not crash
// print preview.
type MergeMapEntry = { anchor: true; colspan: number; rowspan: number } | { anchor: false };

function buildMergeMap(merges: MergeEntry[] | undefined): Map<string, MergeMapEntry> {
  const map = new Map<string, MergeMapEntry>();
  if (!Array.isArray(merges)) return map;
  for (const m of merges) {
    if (!m || typeof m !== "object") continue;
    const sr = m.startRow;
    const er = m.endRow;
    const sc = m.startCol;
    const ec = m.endCol;
    if (!Number.isInteger(sr) || !Number.isInteger(er) || !Number.isInteger(sc) || !Number.isInteger(ec)) continue;
    if (sr! < 0 || sc! < 0 || er! < sr! || ec! < sc!) continue;
    const rowspan = (er as number) - (sr as number) + 1;
    const colspan = (ec as number) - (sc as number) + 1;
    for (let r = sr as number; r <= (er as number); r++) {
      for (let c = sc as number; c <= (ec as number); c++) {
        if (r === sr && c === sc) {
          // Don't overwrite an existing anchor — if a later merge covers the
          // same anchor, keep the first one (Excel's last-write-wins is hard
          // to reason about; first-wins is deterministic and safe).
          if (!map.has(`${r},${c}`)) {
            map.set(`${r},${c}`, { anchor: true, colspan, rowspan });
          }
        } else {
          if (!map.has(`${r},${c}`)) {
            map.set(`${r},${c}`, { anchor: false });
          }
        }
      }
    }
  }
  return map;
}

function renderSheetTable(
  out: string[],
  sheet: SheetSnapshot,
  styles: Record<string, StyleObject | undefined> | undefined,
): void {
  const { rows, cols } = computeUsedExtent(sheet.cellData);
  if (rows === 0 || cols === 0) {
    out.push('<p class="qp-empty">（空のシート）</p>\n');
    return;
  }
  if (rows * cols > MAX_CELLS_PER_SHEET) {
    out.push(
      '<p class="qp-truncated">（シートが大きすぎるため省略しました）</p>\n',
    );
    return;
  }

  out.push('<table class="sheet-table">\n');
  if (sheet.columnData) {
    out.push("<colgroup>\n");
    for (let c = 0; c < cols; c++) {
      const w = sheet.columnData[String(c)]?.w;
      if (typeof w === "number" && w > 0) {
        const clamped = Math.max(8, Math.min(2000, w));
        out.push(`<col style="width:${clamped.toFixed(1)}px">\n`);
      } else {
        out.push("<col>\n");
      }
    }
    out.push("</colgroup>\n");
  }

  // Build merge lookup so the cell loop can emit colspan/rowspan on anchors
  // and skip the covered cells. Mirrors what Excel's print preview shows.
  const mergeMap = buildMergeMap(sheet.mergeData);

  out.push("<tbody>\n");
  for (let r = 0; r < rows; r++) {
    const h = sheet.rowData?.[String(r)]?.h;
    if (typeof h === "number" && h > 0) {
      const clamped = Math.max(4, Math.min(2000, h));
      out.push(`<tr style="height:${clamped.toFixed(1)}px">\n`);
    } else {
      out.push("<tr>\n");
    }
    const rowObj = sheet.cellData?.[String(r)];
    for (let c = 0; c < cols; c++) {
      const me = mergeMap.get(`${r},${c}`);
      if (me && !me.anchor) {
        // Covered by a merge but not the anchor — skip emitting a <td> so the
        // anchor's colspan/rowspan can claim this slot.
        continue;
      }
      if (me && me.anchor) {
        renderCell(out, rowObj?.[String(c)], styles, me.colspan, me.rowspan);
      } else {
        renderCell(out, rowObj?.[String(c)], styles);
      }
    }
    out.push("</tr>\n");
  }
  out.push("</tbody>\n</table>\n");
}

const EMBEDDED_CSS = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif; margin: 0; padding: 24px; background: #f7f7f8; color: #1a1a1a; }
.workbook-header { margin-bottom: 24px; }
.workbook-header h1 { font-size: 20px; font-weight: 600; margin: 0; }
.sheet { margin-bottom: 32px; background: white; padding: 16px; border: 1px solid #e2e2e6; border-radius: 4px; page-break-after: always; }
.sheet h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: #333; }
.page-header, .page-footer { color: #555; font-size: 11px; margin: 8px 0; text-align: center; }
.sheet-table { border-collapse: collapse; font-size: 12px; }
.sheet-table td { border: 1px solid #d4d4d8; padding: 2px 6px; min-width: 64px; vertical-align: bottom; }
.qp-empty, .qp-truncated { color: #999; font-size: 12px; font-style: italic; }
@media print {
  body { background: white; padding: 0; }
  .sheet { border: none; border-radius: 0; padding: 0; margin: 0; box-shadow: none; }
  .sheet-table td { border-color: #888; }
}
`;

/**
 * Build a standalone HTML document for the print preview iframe.
 * Always returns a complete `<!DOCTYPE html>` page so the iframe `srcdoc`
 * boots into a fresh document with no shared CSS scope. Tolerates a
 * non-object snapshot by rendering an empty workbook.
 */
export function buildPrintHtml(
  snapshot: object,
  params: QuickPrintParams,
): string {
  const wb = (snapshot ?? {}) as WorkbookSnapshot;
  const name = typeof wb.name === "string" && wb.name ? wb.name : "Workbook";
  const styles = wb.styles;
  const sheetOrder = Array.isArray(wb.sheetOrder) ? wb.sheetOrder : [];
  const sheets = wb.sheets ?? {};

  // For "activeSheet" scope we filter the order to just the active id (if
  // we can find it). Falling back to the first sheet preserves "always
  // print something" UX over showing a blank preview if the caller forgot
  // to pass activeSheetId.
  let renderOrder: string[];
  if (params.scope === "activeSheet") {
    if (params.activeSheetId && sheets[params.activeSheetId]) {
      renderOrder = [params.activeSheetId];
    } else if (sheetOrder.length > 0) {
      renderOrder = [sheetOrder[0]];
    } else {
      renderOrder = [];
    }
  } else {
    renderOrder = sheetOrder.filter((id) => typeof id === "string");
  }

  const out: string[] = [];
  out.push('<!DOCTYPE html>\n<html lang="ja">\n<head>\n');
  out.push('<meta charset="UTF-8">\n');
  out.push('<meta name="viewport" content="width=device-width,initial-scale=1">\n');
  out.push(`<title>${escapeHtml(name)}</title>\n`);
  out.push(`<style>${EMBEDDED_CSS}</style>\n`);
  out.push("</head>\n<body>\n");
  out.push(`<header class="workbook-header"><h1>${escapeHtml(name)}</h1></header>\n`);
  out.push("<main>\n");

  for (const sheetId of renderOrder) {
    const sheet = sheets[sheetId];
    if (!sheet) continue;
    const sheetName =
      typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    out.push('<section class="sheet">\n');
    out.push(`<h2>${escapeHtml(sheetName)}</h2>\n`);
    const header = sheet._pageSetup?.header;
    if (typeof header === "string" && header) {
      out.push(`<div class="page-header">${escapeHtml(header)}</div>\n`);
    }
    renderSheetTable(out, sheet, styles);
    const footer = sheet._pageSetup?.footer;
    if (typeof footer === "string" && footer) {
      out.push(`<div class="page-footer">${escapeHtml(footer)}</div>\n`);
    }
    out.push("</section>\n");
  }

  out.push("</main>\n</body>\n</html>\n");
  return out.join("");
}

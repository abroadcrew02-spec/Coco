// Pure helpers for the workbook-wide "Number Format Manager" dialog. Excel's
// own Number Format manager surfaces every custom format code used across the
// workbook so users can audit, rename, or strip them in bulk — without that,
// inherited xlsx files quickly accumulate dozens of near-duplicate codes
// ("#,##0", "#,##0_)", "#,##0_-") with no easy way to consolidate.
//
// This module walks the Coco snapshot, dedupes by code, and exposes mutation
// helpers that rewrite every matching `_fmt` field in one pass. Kept entirely
// framework-free so unit tests don't need Univer in scope.
//
// Snapshot shape (Univer 0.5.x + Coco extension) — only the fields we touch:
//   {
//     sheetOrder?: string[],
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         cellData?: {
//           <row>: {
//             <col>: {
//               _fmt?: string,          // Coco-managed per-cell format code
//               s?: { n?: { pattern?: string } },  // Univer's style-table form
//               ...
//             } | undefined
//           } | undefined
//         } | undefined
//       } | undefined
//     }
//   }
//
// Both `_fmt` and `s.n.pattern` are checked so codes that round-tripped via
// the Univer style table are surfaced too. Mutations only ever write `_fmt`
// (matching applyNumberFormat / quickNumberFormat) — `s.n.pattern` is
// cleared on rename/delete to avoid leaving the old code behind.

export interface FormatCodeEntry {
  /** The unique format code (e.g. "#,##0", "yyyy/m/d"). Empty codes are skipped. */
  code: string;
  /** Sample rendering of the code against a fixed value, for the listing UI. */
  sampleRender: string;
  /** Total number of cells across the workbook using this exact code. */
  cellCount: number;
  /** Sheet ids that contain at least one cell with this code (in sheetOrder). */
  sheetIds: string[];
}

interface FmtCell {
  _fmt?: string;
  s?: { n?: { pattern?: string } } | string;
  [k: string]: unknown;
}

interface FmtSnapshot {
  sheetOrder?: string[];
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<string, Record<string, FmtCell | undefined> | undefined>;
      }
    | undefined
  >;
}

function deepClone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function readCellCode(cell: FmtCell | undefined): string | null {
  if (!cell || typeof cell !== "object") return null;
  if (typeof cell._fmt === "string" && cell._fmt.trim() !== "") return cell._fmt;
  // s may be either the style-table id (string) or the inline style object;
  // only the object form carries a pattern we can read directly.
  if (cell.s && typeof cell.s === "object") {
    const pattern = (cell.s as { n?: { pattern?: string } }).n?.pattern;
    if (typeof pattern === "string" && pattern.trim() !== "") return pattern;
  }
  return null;
}

/** Walk every cell across every sheet, dedupe by format code, and return one
 *  entry per unique code. Stable order: codes are returned in the order they
 *  were first seen during sheet-then-row-then-col traversal. */
export function listAllFormatCodes(
  snapshot: FmtSnapshot | string | null | undefined,
): FormatCodeEntry[] {
  let parsed: FmtSnapshot | null;
  if (typeof snapshot === "string") {
    try {
      parsed = JSON.parse(snapshot) as FmtSnapshot;
    } catch {
      return [];
    }
  } else {
    parsed = snapshot ?? null;
  }
  if (!parsed || typeof parsed !== "object") return [];
  const sheets = parsed.sheets;
  if (!sheets || typeof sheets !== "object") return [];

  const order: string[] =
    Array.isArray(parsed.sheetOrder) && parsed.sheetOrder.length > 0
      ? parsed.sheetOrder.filter((s): s is string => typeof s === "string")
      : Object.keys(sheets);

  // Map by code so we can accumulate counts + sheet ids before constructing
  // the final array. Using a Map preserves insertion order for stable output.
  const byCode = new Map<string, { count: number; sheets: Set<string> }>();
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || !sheet.cellData) continue;
    const rows = sheet.cellData;
    for (const rowKey of Object.keys(rows)) {
      const row = rows[rowKey];
      if (!row) continue;
      for (const colKey of Object.keys(row)) {
        const code = readCellCode(row[colKey]);
        if (!code) continue;
        let entry = byCode.get(code);
        if (!entry) {
          entry = { count: 0, sheets: new Set() };
          byCode.set(code, entry);
        }
        entry.count += 1;
        entry.sheets.add(sheetId);
      }
    }
  }

  const result: FormatCodeEntry[] = [];
  for (const [code, info] of byCode) {
    result.push({
      code,
      sampleRender: sampleRender(code, 1234.5),
      cellCount: info.count,
      // Preserve sheetOrder order in the per-entry list for predictable UI.
      sheetIds: order.filter((id) => info.sheets.has(id)),
    });
  }
  return result;
}

/** Replace every `_fmt` (and inline `s.n.pattern`) matching `oldCode` with
 *  `newCode`. Returns the mutated snapshot + count of cells updated. Empty
 *  `newCode` is treated as "delete" — equivalent to deleteFormatCode. */
export function renameFormatCode(
  snapshot: FmtSnapshot | string | null | undefined,
  oldCode: string,
  newCode: string,
): { snapshotMutated: FmtSnapshot; changedCount: number } {
  const base: FmtSnapshot = parseSnapshot(snapshot);
  if (!oldCode || newCode === oldCode) {
    return { snapshotMutated: base, changedCount: 0 };
  }
  if (!newCode || !newCode.trim()) {
    const deleted = deleteFormatCode(base, oldCode);
    return { snapshotMutated: deleted.snapshotMutated, changedCount: deleted.clearedCount };
  }
  const next = deepClone(base);
  let changed = 0;
  forEachCell(next, (cell) => {
    const current = readCellCode(cell);
    if (current !== oldCode) return;
    cell._fmt = newCode;
    // Clear any inline-style pattern so the rename is canonical.
    if (cell.s && typeof cell.s === "object") {
      const styleObj = cell.s as { n?: { pattern?: string } };
      if (styleObj.n && typeof styleObj.n === "object") {
        delete styleObj.n.pattern;
      }
    }
    changed += 1;
  });
  return { snapshotMutated: next, changedCount: changed };
}

/** Strip every `_fmt` (and inline `s.n.pattern`) matching `code`. Returns the
 *  mutated snapshot + count of cells cleared. */
export function deleteFormatCode(
  snapshot: FmtSnapshot | string | null | undefined,
  code: string,
): { snapshotMutated: FmtSnapshot; clearedCount: number } {
  const base: FmtSnapshot = parseSnapshot(snapshot);
  if (!code) return { snapshotMutated: base, clearedCount: 0 };
  const next = deepClone(base);
  let cleared = 0;
  forEachCell(next, (cell) => {
    const current = readCellCode(cell);
    if (current !== code) return;
    delete cell._fmt;
    if (cell.s && typeof cell.s === "object") {
      const styleObj = cell.s as { n?: { pattern?: string } };
      if (styleObj.n && typeof styleObj.n === "object") {
        delete styleObj.n.pattern;
      }
    }
    cleared += 1;
  });
  return { snapshotMutated: next, clearedCount: cleared };
}

function parseSnapshot(input: FmtSnapshot | string | null | undefined): FmtSnapshot {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as FmtSnapshot;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return input && typeof input === "object" ? input : {};
}

function forEachCell(snapshot: FmtSnapshot, fn: (cell: FmtCell) => void): void {
  const sheets = snapshot.sheets;
  if (!sheets || typeof sheets !== "object") return;
  for (const sheetId of Object.keys(sheets)) {
    const sheet = sheets[sheetId];
    if (!sheet || !sheet.cellData) continue;
    const rows = sheet.cellData;
    for (const rowKey of Object.keys(rows)) {
      const row = rows[rowKey];
      if (!row) continue;
      for (const colKey of Object.keys(row)) {
        const cell = row[colKey];
        if (cell && typeof cell === "object") fn(cell);
      }
    }
  }
}

// --- Sample rendering -------------------------------------------------------
//
// Excel's format-code grammar is huge; we only need enough to give users a
// recognisable preview ("1,234" beats showing the raw code). Anything we
// can't classify cleanly falls back to "N/A" rather than guessing wrong.

const CURRENCY_PREFIXES: ReadonlyArray<{ test: RegExp; symbol: string }> = [
  { test: /\[\$¥/, symbol: "¥" },
  { test: /\[\$\$/, symbol: "$" },
  { test: /\[\$€/, symbol: "€" },
  { test: /\[\$£/, symbol: "£" },
  { test: /^¥/, symbol: "¥" },
  { test: /^\$/, symbol: "$" },
  { test: /^€/, symbol: "€" },
  { test: /^£/, symbol: "£" },
];

function isDateCode(code: string): boolean {
  // Tokens y/m/d/h/s in non-bracket regions imply date/time. We strip
  // bracketed locale segments first (e.g. "[$-411]") so we don't match the
  // "m" inside them.
  const stripped = code.replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(stripped);
}

function renderDate(code: string, valueDate: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const y = valueDate.getFullYear();
  const mo = valueDate.getMonth() + 1;
  const d = valueDate.getDate();
  const h = valueDate.getHours();
  const s = valueDate.getSeconds();
  // Strip locale tags before substitution so they don't pollute the output.
  let out = code.replace(/\[[^\]]*\]/g, "");
  // Longest tokens first so "yyyy" isn't eaten by "yy".
  out = out
    .replace(/yyyy/gi, String(y))
    .replace(/yy/gi, pad(y % 100))
    .replace(/mmmm/g, String(mo))
    .replace(/mmm/g, String(mo))
    .replace(/mm/g, pad(mo))
    .replace(/m/g, String(mo))
    .replace(/dddd/gi, pad(d))
    .replace(/ddd/gi, pad(d))
    .replace(/dd/gi, pad(d))
    .replace(/d/gi, String(d))
    .replace(/hh/gi, pad(h))
    .replace(/h/gi, String(h))
    .replace(/ss/gi, pad(s))
    .replace(/s/gi, String(s));
  // Minute marker `mm` between `h` and `s` shares a letter with month — we
  // accept the simplified collision here; a fuller implementation would
  // need a tokeniser. For a preview rendering the trade-off is acceptable.
  out = out.replace(/(\d):(\d)/g, (_m, a, b) => `${a}:${pad(Number(b))}`);
  return out.trim() || "N/A";
}

function renderNumber(code: string, value: number): string {
  // Detect a percent format → multiply by 100 and append %.
  const isPercent = /%/.test(code);
  const isThousands = /#,##/.test(code) || /0,0/.test(code);
  const decimalMatch = /\.([0#]+)/.exec(code);
  const decimals = decimalMatch ? decimalMatch[1].length : 0;
  let n = value;
  if (isPercent) n = value * 100;
  // Build the bare number portion.
  let body = isThousands
    ? n.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    : n.toFixed(decimals);
  // Strip a trailing ".0" if the code didn't ask for fixed decimals.
  if (!decimalMatch && Number.isInteger(n)) body = body.replace(/\.0+$/, "");
  if (isPercent) body = `${body}%`;
  for (const { test, symbol } of CURRENCY_PREFIXES) {
    if (test.test(code)) return `${symbol}${body}`;
  }
  return body;
}

/** Best-effort rendering of `value` through `code`. Returns "N/A" when the
 *  code looks valid but isn't in our handled subset — the caller surfaces
 *  this as a sample column, not as the actual on-grid render path. */
export function sampleRender(code: string, value: number): string {
  if (!code || typeof code !== "string") return "N/A";
  const trimmed = code.trim();
  if (!trimmed) return "N/A";
  // Treat the literal "General" code (and Excel's @ for text) as no format.
  if (/^general$/i.test(trimmed) || trimmed === "@") return String(value);
  if (isDateCode(trimmed)) {
    // Sample date = 2024-03-15 — distinctive enough to read all components.
    return renderDate(trimmed, new Date(2024, 2, 15, 14, 30, 0));
  }
  // Number-ish codes contain at least one 0 or # placeholder.
  if (/[0#]/.test(trimmed)) {
    try {
      return renderNumber(trimmed, value);
    } catch {
      return "N/A";
    }
  }
  return "N/A";
}

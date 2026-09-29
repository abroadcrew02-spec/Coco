// Pure helpers for the workbook-wide "Number Format Manager" dialog. Excel's
// own Number Format manager surfaces every custom format code used across the
// workbook so users can audit, rename, or strip them in bulk — without that,
// inherited xlsx files quickly accumulate dozens of near-duplicate codes
// ("#,##0", "#,##0_)", "#,##0_-") with no easy way to consolidate.
//
// This module walks the Nicel snapshot and dedupes by code. Rename / delete
// don't mutate the snapshot: they return numfmt jobs (numberFormat.ts) that
// EditorScreen runs through Univer, so the grid repaints and Univer keeps the
// undo entry. Kept entirely framework-free so unit tests don't need Univer.
//
// Snapshot shape (Univer 0.24 + Nicel extension) — only the fields we read:
//   {
//     sheetOrder?: string[],
//     styles?: { <styleId>: { n?: { pattern?: string }, ... } },
//     sheets: {
//       <sheetId>: {
//         name?: string,
//         cellData?: {
//           <row>: {
//             <col>: {
//               s?: string | object,    // style id (or inline style object)
//               _fmt?: string,          // Nicel per-cell sidecar (xlsx import)
//               ...
//             } | undefined
//           } | undefined
//         } | undefined
//       } | undefined
//     }
//   }
//
// A cell's code is resolved by resolveCellNumberFormat: a resolvable style id
// decides (what the grid renders); `_fmt` only counts for cells without one.

import {
  resolveCellNumberFormat,
  styleLookupFromTable,
  normalizeNumberFormatCode,
  type NumberFormatJob,
  type NumberFormatWrite,
  type StyleLookup,
} from "./numberFormat";

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
  styles?: Record<string, Record<string, unknown> | undefined>;
  sheets?: Record<
    string,
    | {
        name?: string;
        cellData?: Record<string, Record<string, FmtCell | undefined> | undefined>;
      }
    | undefined
  >;
}

function readCellCode(cell: FmtCell | undefined, lookup: StyleLookup): string | null {
  const code = resolveCellNumberFormat(cell, lookup);
  return code === "" ? null : code;
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

  const lookup = styleLookupFromTable(parsed.styles);
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
        const code = readCellCode(row[colKey], lookup);
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

/** Plan replacing `oldCode` with `newCode` on every cell whose current code
 *  is `oldCode`. Returns one sparse job per affected sheet plus the number of
 *  cells targeted. A blank / "General" `newCode` is a delete — same as
 *  planFormatCodeDelete. The snapshot itself is not modified. */
export function planFormatCodeRename(
  snapshot: FmtSnapshot | string | null | undefined,
  oldCode: string,
  newCode: string,
): { jobs: NumberFormatJob[]; changedCount: number } {
  if (!oldCode || newCode === oldCode) return { jobs: [], changedCount: 0 };
  return planReplace(parseSnapshot(snapshot), oldCode, normalizeNumberFormatCode(newCode));
}

/** Plan removing the format from every cell whose current code is `code`.
 *  Returns one sparse job per affected sheet plus the number of cells. */
export function planFormatCodeDelete(
  snapshot: FmtSnapshot | string | null | undefined,
  code: string,
): { jobs: NumberFormatJob[]; changedCount: number } {
  if (!code) return { jobs: [], changedCount: 0 };
  return planReplace(parseSnapshot(snapshot), code, "");
}

function planReplace(
  snapshot: FmtSnapshot,
  match: string,
  pattern: string,
): { jobs: NumberFormatJob[]; changedCount: number } {
  const sheets = snapshot.sheets;
  if (!sheets || typeof sheets !== "object") return { jobs: [], changedCount: 0 };
  const lookup = styleLookupFromTable(snapshot.styles);
  const jobs: NumberFormatJob[] = [];
  let changedCount = 0;
  for (const sheetId of Object.keys(sheets)) {
    const rows = sheets[sheetId]?.cellData;
    if (!rows || typeof rows !== "object") continue;
    const writes: NumberFormatWrite[] = [];
    for (const rowKey of Object.keys(rows)) {
      const row = rows[rowKey];
      if (!row) continue;
      for (const colKey of Object.keys(row)) {
        if (readCellCode(row[colKey], lookup) !== match) continue;
        const r = Number(rowKey);
        const c = Number(colKey);
        if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
        writes.push({ row: r, col: c, pattern });
      }
    }
    if (writes.length === 0) continue;
    jobs.push({ kind: "cells", sheetId, writes });
    changedCount += writes.length;
  }
  return { jobs, changedCount };
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

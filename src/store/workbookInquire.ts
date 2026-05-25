// #245 — Workbook Inquire / Statistics (Excel-parity diagnostic).
// Pure analyzer that takes a workbook snapshot and returns a structured
// report: sheet/cell/formula counts, top-used functions, formula error tally,
// external-link list, embedded-object counts. Read-only — never mutates.
//
// Distinct from `workbookStats.ts` (the per-tab dashboard): this is the
// File → Info → Inspect Document analogue, designed for the user to quickly
// understand "what's in this workbook" before sharing or editing.

import type { InspectorSnapshot } from "./documentInspector";

export interface InquireTopFunction {
  name: string;
  count: number;
}

export interface InquireFormulaError {
  code: string;
  count: number;
  firstAt: string;
}

export interface InquireExternalLink {
  ref: string;
  target: string;
}

export interface WorkbookInquireReport {
  sheets: number;
  hiddenSheets: number;
  totalCells: number;
  formulaCells: number;
  valueCells: number;
  emptyCells: number;
  namedRanges: number;
  topFunctions: InquireTopFunction[];
  formulaDepthHistogram: Array<{ depth: number; count: number }>;
  formulaErrors: InquireFormulaError[];
  externalLinks: InquireExternalLink[];
  comments: number;
  images: number;
  charts: number;
  pivots: number;
  conditionalFormatRules: number;
  dataValidationRules: number;
  hyperlinks: number;
}

const EMPTY_REPORT: WorkbookInquireReport = {
  sheets: 0,
  hiddenSheets: 0,
  totalCells: 0,
  formulaCells: 0,
  valueCells: 0,
  emptyCells: 0,
  namedRanges: 0,
  topFunctions: [],
  formulaDepthHistogram: [],
  formulaErrors: [],
  externalLinks: [],
  comments: 0,
  images: 0,
  charts: 0,
  pivots: 0,
  conditionalFormatRules: 0,
  dataValidationRules: 0,
  hyperlinks: 0,
};

const FORMULA_ERROR_CODES = [
  "#REF!",
  "#VALUE!",
  "#DIV/0!",
  "#NAME?",
  "#N/A",
  "#NULL!",
  "#NUM!",
  "#GETTING_DATA",
  "#SPILL!",
  "#CALC!",
] as const;

function parseInput(
  input: string | InspectorSnapshot | null | undefined,
): InspectorSnapshot | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "object") return input;
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as InspectorSnapshot;
  } catch {
    return null;
  }
}

function colIndexToA1(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellRef(sheetName: string, rowIdx: number, colIdx: number): string {
  return `${sheetName}!${colIndexToA1(colIdx)}${rowIdx + 1}`;
}

// Strip string literals so function-name regex doesn't match inside them.
function stripStrings(formula: string): string {
  return formula.replace(/"(?:""|[^"])*"/g, '""');
}

// Extract function names: NAME( where NAME is uppercase + digits + dot/underscore.
// Filter cell-ref-shaped tokens (A1, B12, AA999) — they look function-like
// when followed by `(` in =A1(but-not-a-call).
const FN_NAME_RE = /\b([A-Z][A-Z0-9_.]*)\s*\(/g;
const CELL_REF_RE = /^[A-Z]+\d+$/;

function extractFunctionNames(formula: string): string[] {
  const clean = stripStrings(formula);
  const names: string[] = [];
  let m: RegExpExecArray | null;
  FN_NAME_RE.lastIndex = 0;
  while ((m = FN_NAME_RE.exec(clean)) !== null) {
    const name = m[1];
    if (CELL_REF_RE.test(name)) continue;
    names.push(name);
  }
  return names;
}

function formulaMaxDepth(formula: string): number {
  const clean = stripStrings(formula);
  let depth = 0;
  let max = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "(") {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === ")") {
      depth--;
    }
  }
  return max;
}

// External-link patterns (substring or HYPERLINK):
//   `[Book2.xlsx]Sheet1!A1`, `='C:\path\[Book.xlsx]Sheet1'!A1`, `=HYPERLINK("http://...")`
const HYPERLINK_RE = /HYPERLINK\s*\(\s*"([^"]+)"/i;
const EXTERN_FILE_RE = /\[([^\]]+\.xlsx?)\]/i;

function classifyExternalLink(formula: string): InquireExternalLink | null {
  const clean = stripStrings(formula);
  const fileMatch = EXTERN_FILE_RE.exec(formula);
  if (fileMatch) {
    return { ref: "", target: fileMatch[1] };
  }
  if (/HYPERLINK\s*\(/i.test(clean)) {
    const hm = HYPERLINK_RE.exec(formula);
    const target = hm ? hm[1] : "";
    if (/^(https?|ftp):\/\//i.test(target) || /^mailto:/i.test(target)) {
      return { ref: "", target };
    }
  }
  return null;
}

function detectErrorCode(text: string): string | null {
  for (const code of FORMULA_ERROR_CODES) {
    if (text === code) return code;
  }
  return null;
}

export function computeWorkbookInquire(
  input: string | InspectorSnapshot | null | undefined,
): WorkbookInquireReport {
  const snap = parseInput(input);
  if (!snap) return { ...EMPTY_REPORT };

  const report: WorkbookInquireReport = {
    ...EMPTY_REPORT,
    topFunctions: [],
    formulaDepthHistogram: [],
    formulaErrors: [],
    externalLinks: [],
  };

  const fnCounts = new Map<string, number>();
  const depthCounts = new Map<number, number>();
  const errors = new Map<string, { count: number; firstAt: string }>();
  const links: InquireExternalLink[] = [];

  const sheets = snap.sheets ?? {};
  const sheetOrder = snap.sheetOrder ?? Object.keys(sheets);
  report.sheets = sheetOrder.length;

  for (const sheetId of sheetOrder) {
    const sheet = sheets[sheetId];
    if (!sheet) continue;
    const sheetName = sheet.name ?? sheetId;
    if (sheet._sheetState === "hidden" || sheet._sheetState === "veryHidden") {
      report.hiddenSheets++;
    }

    // Comments
    if (Array.isArray(sheet._comments)) {
      report.comments += sheet._comments.length;
    }

    // CF / DV / hyperlinks — read-loose property names that exist in the wild
    const sheetUnknown = sheet as Record<string, unknown>;
    const cfRules = sheetUnknown._cfRules ?? sheetUnknown._conditionalFormatting;
    if (Array.isArray(cfRules)) report.conditionalFormatRules += cfRules.length;
    const dvRules = sheetUnknown._dataValidations;
    if (Array.isArray(dvRules)) report.dataValidationRules += dvRules.length;
    const hyperlinks = sheetUnknown._hyperlinks;
    if (Array.isArray(hyperlinks)) report.hyperlinks += hyperlinks.length;
    const charts = sheetUnknown._charts;
    if (Array.isArray(charts)) report.charts += charts.length;

    // Cells
    const cellData = sheet.cellData ?? {};
    for (const rowKey of Object.keys(cellData)) {
      const row = cellData[rowKey];
      if (!row) continue;
      const rowIdx = Number(rowKey);
      for (const colKey of Object.keys(row)) {
        const cell = row[colKey];
        if (!cell) continue;
        report.totalCells++;
        const colIdx = Number(colKey);
        const f = (cell as { f?: unknown }).f;
        const v = (cell as { v?: unknown }).v;
        if (typeof f === "string" && f.length > 0) {
          report.formulaCells++;
          const fnames = extractFunctionNames(f);
          for (const name of fnames) {
            fnCounts.set(name, (fnCounts.get(name) ?? 0) + 1);
          }
          const depth = formulaMaxDepth(f);
          depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);

          // External link detection
          const link = classifyExternalLink(f);
          if (link) {
            links.push({ ref: cellRef(sheetName, rowIdx, colIdx), target: link.target });
          }

          // Error detection — both in computed value and in formula text
          if (typeof v === "string") {
            const code = detectErrorCode(v);
            if (code) {
              const prev = errors.get(code);
              if (prev) {
                prev.count++;
              } else {
                errors.set(code, {
                  count: 1,
                  firstAt: cellRef(sheetName, rowIdx, colIdx),
                });
              }
            }
          }
        } else if (v !== undefined && v !== null && v !== "") {
          report.valueCells++;
        } else {
          report.emptyCells++;
        }
      }
    }
  }

  // Named ranges
  const named = (snap as { namedRanges?: unknown }).namedRanges;
  if (Array.isArray(named)) report.namedRanges = named.length;
  else if (named && typeof named === "object") {
    report.namedRanges = Object.keys(named).length;
  }

  // Preserved-parts breakdown for images/pivots
  const pp = snap._preservedParts ?? {};
  const partsBag = ((pp as { parts?: Record<string, unknown> }).parts) ?? pp;
  if (partsBag && typeof partsBag === "object") {
    for (const key of Object.keys(partsBag)) {
      if (/^xl\/media\/.+$/.test(key)) report.images++;
      else if (/^xl\/pivotTables\/.+\.xml$/.test(key)) report.pivots++;
    }
  }

  // Sort top functions
  report.topFunctions = Array.from(fnCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 20);

  // Depth histogram ascending
  report.formulaDepthHistogram = Array.from(depthCounts.entries())
    .map(([depth, count]) => ({ depth, count }))
    .sort((a, b) => a.depth - b.depth);

  // Errors
  report.formulaErrors = Array.from(errors.entries())
    .map(([code, info]) => ({ code, count: info.count, firstAt: info.firstAt }))
    .sort((a, b) => b.count - a.count);

  report.externalLinks = links;
  return report;
}

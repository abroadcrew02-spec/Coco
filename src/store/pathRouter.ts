// Centralized extension routing for "open path" entry points
// (keyboard shortcut, menu, drag-drop). Keeps the three callers aligned so
// adding a new supported extension touches one place.

export type PathRoute =
  | { kind: "coco"; path: string }
  | { kind: "xlsx"; path: string }
  | { kind: "csv"; path: string }
  | { kind: "unsupported"; path: string; extension: string | null };

const NICEL_EXT = [".coco"];
// .xls (Excel 97-2003) also routes as "xlsx": the open-path callers all send
// it to `importXlsx`, which picks the Rust command via `excelImportCommand`.
// `endsWith(".xls")` never matches ".xlsx" / ".xlsm", so the lists don't overlap.
const XLSX_EXT = [".xlsx", ".xlsm", ".xls"];
// .tsv routes through the same import path as .csv — the Rust side picks the
// right delimiter from the extension.
const CSV_EXT = [".csv", ".tsv"];

function endsWithAny(lower: string, exts: string[]): boolean {
  return exts.some((e) => lower.endsWith(e));
}

function extractExtension(lower: string): string | null {
  // Strip trailing path separator if present so "/foo/" doesn't return "".
  const trimmed = lower.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? "";
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return null;
  return base.slice(idx);
}

export function routeOpenPath(path: string): PathRoute {
  const lower = path.toLowerCase();
  if (endsWithAny(lower, NICEL_EXT)) return { kind: "coco", path };
  if (endsWithAny(lower, XLSX_EXT)) return { kind: "xlsx", path };
  if (endsWithAny(lower, CSV_EXT)) return { kind: "csv", path };
  return { kind: "unsupported", path, extension: extractExtension(lower) };
}

export type ExcelImportCommand = "workbook_import_xls" | "workbook_import_xlsx";

/** Rust command that imports an Excel-family path. Only a trailing ".xls"
 *  (case-insensitive) selects the legacy reader; everything else keeps the
 *  existing xlsx importer. */
export function excelImportCommand(path: string): ExcelImportCommand {
  return path.toLowerCase().endsWith(".xls") ? "workbook_import_xls" : "workbook_import_xlsx";
}

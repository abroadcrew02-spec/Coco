// #248 JSON / JSONL import MVP. Pure parsing — file I/O happens at the
// call-site (HomeScreen / EditorScreen) via Tauri fs.
//
// Strategy:
//   - JSON: must parse to an array of objects (each object → one row, keys
//     across all objects → column union in first-seen order).
//   - JSONL: one JSON object per line; empty lines skipped; malformed lines
//     surfaced as a warning but don't abort the import.
//   - Nested values stringified to JSON for the cell (Excel-like behavior).
//
// Output:
//   { headers: string[], rows: Array<Record<string, unknown>>, warnings: string[] }
// Caller turns this into a Coco snapshot fragment via `buildSnapshotFromJson`.

export interface JsonImportResult {
  headers: string[];
  rows: Array<Record<string, unknown>>;
  warnings: string[];
}

type JsonRecord = Record<string, unknown>;

function isPlainRecord(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function collectHeaders(rows: ReadonlyArray<JsonRecord>): string[] {
  const seen = new Set<string>();
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

/** Parse a UTF-8 JSON document expected to be an array of objects. */
export function parseJson(input: string): JsonImportResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return {
      headers: [],
      rows: [],
      warnings: [`JSON のパースに失敗しました: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      headers: [],
      rows: [],
      warnings: [
        "JSON はオブジェクトの配列である必要があります (例: [{\"name\": \"...\", \"qty\": 1}, ...])",
      ],
    };
  }
  const rows: JsonRecord[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!isPlainRecord(entry)) {
      warnings.push(`要素 ${i + 1} はオブジェクトではないためスキップしました`);
      continue;
    }
    rows.push(entry);
  }
  return { headers: collectHeaders(rows), rows, warnings };
}

/** Parse JSON Lines (.jsonl): one object per non-empty line. */
export function parseJsonLines(input: string): JsonImportResult {
  const warnings: string[] = [];
  const rows: JsonRecord[] = [];
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      warnings.push(
        `行 ${i + 1} のパースに失敗: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!isPlainRecord(parsed)) {
      warnings.push(`行 ${i + 1} はオブジェクトではないためスキップしました`);
      continue;
    }
    rows.push(parsed);
  }
  return { headers: collectHeaders(rows), rows, warnings };
}

/**
 * Auto-detect JSON vs JSONL based on the input's first non-whitespace char.
 * `[` → JSON array; otherwise JSONL.
 */
export function parseAuto(input: string): JsonImportResult {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("[")) return parseJson(input);
  return parseJsonLines(input);
}

type CellValue = string | number | boolean | null;
type Cell = { v?: CellValue; s?: Record<string, unknown> };
type CellData = Record<string, Record<string, Cell>>;

interface SnapshotSheet {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: CellData;
}

export interface SnapshotJson {
  id: string;
  name: string;
  appVersion: string;
  locale: string;
  styles: Record<string, unknown>;
  sheetOrder: string[];
  sheets: Record<string, SnapshotSheet>;
}

const HEADER_STYLE: Record<string, unknown> = {
  bg: { rgb: "#217346" },
  cl: { rgb: "#FFFFFF" },
  bl: 1,
  ht: 2,
};

function normaliseCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  // Nested arrays / objects → JSON-stringify (Excel parity: such cells get
  // the literal text rendering, not nested grids).
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Build a fresh Coco snapshot from a parsed JSON import. The caller wires
 * the resulting JSON string into `updateSnapshot` via `applyMutatedSnapshot`
 * so the Coco undo stack captures the previous state.
 *
 * `appVersion` and `id` are placeholders — the load path can replace them
 * post-mutation with whatever the backend stamps.
 */
export function buildSnapshotFromJson(
  result: JsonImportResult,
  options: { sheetName?: string } = {},
): SnapshotJson {
  const sheetId = "sheet-1";
  const sheetName = options.sheetName ?? "JSON データ";
  const headers = result.headers;
  const cellData: CellData = {};

  // Header row
  if (headers.length > 0) {
    const row0: Record<string, Cell> = {};
    headers.forEach((h, i) => {
      row0[String(i)] = { v: h, s: HEADER_STYLE };
    });
    cellData["0"] = row0;
  }

  // Data rows
  result.rows.forEach((rec, rowIdx) => {
    const r: Record<string, Cell> = {};
    headers.forEach((h, col) => {
      const v = normaliseCellValue(rec[h]);
      if (v !== null) {
        r[String(col)] = { v };
      }
    });
    if (Object.keys(r).length > 0) {
      cellData[String(rowIdx + 1)] = r;
    }
  });

  const rowCount = Math.max(1000, result.rows.length + 50);
  const columnCount = Math.max(26, headers.length + 5);

  return {
    id: "json-import",
    name: "Untitled",
    appVersion: "json-import",
    locale: "enUS",
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: sheetName,
        rowCount,
        columnCount,
        cellData,
      },
    },
  };
}

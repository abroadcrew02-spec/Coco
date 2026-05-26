// #239 — Convert an Excel-style worksheet table into a Data Model ModelTable.
//
// Pure / framework-free helper. No side effects.

import type { ModelColumn, ModelTable } from "./daxEngine";
import type { WorkbookTableSnapshot } from "./tables";

// ---------------------------------------------------------------------------
// Column type inference
// ---------------------------------------------------------------------------

function inferColumnType(values: unknown[]): ModelColumn["type"] {
  const nonEmpty = values.filter((v) => v !== undefined && v !== null);
  if (nonEmpty.length === 0) return "string";

  let allNumber = true;
  let allBoolean = true;
  let allDate = true;

  for (const v of nonEmpty) {
    if (typeof v !== "number") allNumber = false;
    if (typeof v !== "boolean") allBoolean = false;
    if (allDate) {
      const s = String(v);
      const parsed = Date.parse(s);
      if (!Number.isFinite(parsed) || Number.isFinite(Number(s))) {
        allDate = false;
      }
    }
  }

  if (allBoolean) return "boolean";
  if (allNumber) return "number";
  if (allDate) return "date";
  return "string";
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Convert an Excel-style worksheet table (from `_tables`) into a Data Model
 * ModelTable. Reads cell values from the snapshot's cellData under the
 * table's range, using the table's columns[].name as field names.
 *
 * Returns null when:
 *   - The sheet does not exist in the snapshot
 *   - No table with that name is found on that sheet
 */
export function excelTableToModelTable(
  snapshot: WorkbookTableSnapshot,
  sheetId: string,
  tableName: string,
): ModelTable | null {
  const sheet = snapshot.sheets?.[sheetId];
  if (!sheet) return null;

  const tableEntry = (sheet._tables ?? []).find((t) => t.name === tableName);
  if (!tableEntry) return null;

  const { range, headerRow, columns: tableColumns } = tableEntry;
  const cellData = sheet.cellData;

  const dataRowStart = headerRow ? range.r1 + 1 : range.r1;

  // Build column name list: use tableEntry.columns[i].name or synthesise.
  const colNames: string[] = tableColumns.map((c, i) =>
    c.name ? c.name : `Column${i + 1}`,
  );

  // Collect per-column raw values for type inference.
  const colValues: unknown[][] = colNames.map(() => []);
  const rows: Array<Record<string, unknown>> = [];

  for (let r = dataRowStart; r <= range.r2; r++) {
    const rowData = cellData?.[String(r)];
    const rowObj: Record<string, unknown> = {};
    for (let ci = 0; ci < colNames.length; ci++) {
      const c = range.c1 + ci;
      const cell = rowData?.[String(c)];
      const v = cell?.v ?? null;
      rowObj[colNames[ci]] = v;
      colValues[ci].push(v);
    }
    rows.push(rowObj);
  }

  const modelColumns: ModelColumn[] = colNames.map((name, i) => ({
    name,
    type: inferColumnType(colValues[i]),
  }));

  return { name: tableName, columns: modelColumns, rows };
}

// Pure helpers for the "Snapshot Diff" feature — comparing two saved
// snapshots from .coco history and surfacing per-cell added / removed /
// changed entries. Excel itself doesn't ship this in the box (the closest
// is the Inquire add-in's Compare Workbooks); Coco's twist is that the
// inputs are always two snapshots from the same workbook's history, so the
// diff list jumps you straight to the cell in the currently-open file.
//
// Snapshot shape (Univer 0.5.x + Coco extension) the helpers walk — same
// shape consumed by formulaAudit.ts so the cell-traversal pattern matches:
//   {
//     sheets: {
//       <sheetId>: {
//         name?: string;
//         cellData?: {
//           [row: string]: {
//             [col: string]: {
//               v?: unknown;       // computed / display value
//               f?: string;        // formula text (without leading "=")
//               s?: ...            // style ref or inline IStyleData
//               p?: ...            // rich-text paragraph
//             }
//           }
//         }
//       }
//     },
//     sheetOrder?: string[]
//   }
//
// All exports here are pure (no DOM, no Univer, no Tauri dependency) so
// the dialog can call them on parsed JSON without any render-time state.

export interface DiffEntry {
  sheetId: string;
  sheetName: string;
  row: number;
  col: number;
  /** A1 cell ref, e.g. "B12". Always uppercase column letters. */
  cellRef: string;
  kind: "added" | "removed" | "changed";
  /** Value in snapshot A (the "before"). Undefined when kind === "added". */
  oldValue?: unknown;
  /** Value in snapshot B (the "after"). Undefined when kind === "removed". */
  newValue?: unknown;
}

type CellLike = { v?: unknown; f?: unknown } | undefined;

type SheetShape = {
  name?: string;
  cellData?: Record<string, Record<string, CellLike> | undefined>;
};

type Snapshot = {
  sheets?: Record<string, SheetShape | undefined>;
  sheetOrder?: string[];
};

/** 0-based column index → A1 column letters ("A", "AA", "AAA", ...). */
function colIndexToLetters(col: number): string {
  if (!Number.isFinite(col) || col < 0) return "A";
  let n = Math.floor(col) + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Compose an A1 ref from 0-based (row, col). */
export function cellRefToA1(row: number, col: number): string {
  const r = Math.max(0, Math.floor(row)) + 1;
  return `${colIndexToLetters(col)}${r}`;
}

function parseSnapshot(input: string | object): Snapshot {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === "object" ? (parsed as Snapshot) : {};
    } catch {
      return {};
    }
  }
  if (input && typeof input === "object") return input as Snapshot;
  return {};
}

/** Pull the user-facing value from a cell envelope. Formulas (`f`) take
 *  precedence over their cached `v` so two snapshots whose formulas match
 *  but whose recalced values drift aren't spuriously flagged as "changed". */
function cellSignature(cell: CellLike): { hasValue: boolean; value: unknown } {
  if (cell === undefined || cell === null) return { hasValue: false, value: undefined };
  if (typeof cell !== "object") return { hasValue: true, value: cell };
  const f = (cell as { f?: unknown }).f;
  if (typeof f === "string" && f.length > 0) {
    return { hasValue: true, value: `=${f}` };
  }
  const v = (cell as { v?: unknown }).v;
  if (v === undefined || v === null || v === "") return { hasValue: false, value: undefined };
  return { hasValue: true, value: v };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Treat numeric strings and numbers loosely so a snapshot that stored
  // 42 vs "42" doesn't blow up the changed list. Beyond that, fall back
  // to JSON for objects (rich text, arrays).
  if (typeof a === "number" && typeof b === "string") return String(a) === b.trim();
  if (typeof a === "string" && typeof b === "number") return a.trim() === String(b);
  if (a && b && typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function collectSheetIds(a: Snapshot, b: Snapshot): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const pushFrom = (snap: Snapshot) => {
    const order = Array.isArray(snap.sheetOrder)
      ? snap.sheetOrder.filter((id): id is string => typeof id === "string")
      : [];
    for (const id of order) {
      if (snap.sheets?.[id] && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    if (snap.sheets && typeof snap.sheets === "object") {
      for (const id of Object.keys(snap.sheets)) {
        if (!seen.has(id) && snap.sheets[id]) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }
  };
  pushFrom(a);
  pushFrom(b);
  return ordered;
}

function sheetName(snap: Snapshot, sheetId: string, fallback: string): string {
  const sheet = snap.sheets?.[sheetId];
  if (sheet && typeof sheet.name === "string" && sheet.name.length > 0) return sheet.name;
  return fallback;
}

function collectCellKeys(
  sheet: SheetShape | undefined,
): Map<number, Map<number, CellLike>> {
  const out = new Map<number, Map<number, CellLike>>();
  const cellData = sheet?.cellData;
  if (!cellData || typeof cellData !== "object") return out;
  for (const rowKey of Object.keys(cellData)) {
    const row = Number.parseInt(rowKey, 10);
    if (!Number.isFinite(row) || row < 0) continue;
    const rowObj = cellData[rowKey];
    if (!rowObj || typeof rowObj !== "object") continue;
    let rowMap = out.get(row);
    if (!rowMap) {
      rowMap = new Map<number, CellLike>();
      out.set(row, rowMap);
    }
    for (const colKey of Object.keys(rowObj)) {
      const col = Number.parseInt(colKey, 10);
      if (!Number.isFinite(col) || col < 0) continue;
      rowMap.set(col, rowObj[colKey]);
    }
  }
  return out;
}

/**
 * Compare two snapshots (raw JSON or already-parsed object) cell by cell.
 * Returns a flat list of DiffEntry rows sorted by sheet, then row, then
 * column so the dialog can present them in a stable, scannable order.
 *
 * Tolerates malformed input (empty arms / partial objects) — returns []
 * for either side being unparsable. Mirrors collectAuditIssues' best-effort
 * stance from formulaAudit.ts.
 */
export function diffSnapshots(a: string | object, b: string | object): DiffEntry[] {
  const snapA = parseSnapshot(a);
  const snapB = parseSnapshot(b);
  const sheetIds = collectSheetIds(snapA, snapB);
  const out: DiffEntry[] = [];

  for (const sheetId of sheetIds) {
    const aSheet = snapA.sheets?.[sheetId];
    const bSheet = snapB.sheets?.[sheetId];
    // Prefer the name from whichever side has it — B (the "after") wins on
    // a rename so the diff list reflects the user's most-recent label.
    const name = sheetName(snapB, sheetId, sheetName(snapA, sheetId, sheetId));

    const aCells = collectCellKeys(aSheet);
    const bCells = collectCellKeys(bSheet);

    const rowSet = new Set<number>([...aCells.keys(), ...bCells.keys()]);
    const rows = Array.from(rowSet).sort((x, y) => x - y);

    for (const row of rows) {
      const aRow = aCells.get(row);
      const bRow = bCells.get(row);
      const colSet = new Set<number>([
        ...(aRow ? aRow.keys() : []),
        ...(bRow ? bRow.keys() : []),
      ]);
      const cols = Array.from(colSet).sort((x, y) => x - y);

      for (const col of cols) {
        const aSig = cellSignature(aRow?.get(col));
        const bSig = cellSignature(bRow?.get(col));

        if (!aSig.hasValue && !bSig.hasValue) continue;
        if (!aSig.hasValue && bSig.hasValue) {
          out.push({
            sheetId,
            sheetName: name,
            row,
            col,
            cellRef: cellRefToA1(row, col),
            kind: "added",
            newValue: bSig.value,
          });
          continue;
        }
        if (aSig.hasValue && !bSig.hasValue) {
          out.push({
            sheetId,
            sheetName: name,
            row,
            col,
            cellRef: cellRefToA1(row, col),
            kind: "removed",
            oldValue: aSig.value,
          });
          continue;
        }
        if (!valuesEqual(aSig.value, bSig.value)) {
          out.push({
            sheetId,
            sheetName: name,
            row,
            col,
            cellRef: cellRefToA1(row, col),
            kind: "changed",
            oldValue: aSig.value,
            newValue: bSig.value,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Roll up a diff list into headline counts for the dialog's summary band.
 * `sheets` is the count of distinct sheets that contain at least one diff
 * entry (not the count of sheets in either snapshot).
 */
export function summarizeDiff(diffs: DiffEntry[]): {
  added: number;
  removed: number;
  changed: number;
  sheets: number;
} {
  let added = 0;
  let removed = 0;
  let changed = 0;
  const sheets = new Set<string>();
  for (const d of diffs) {
    sheets.add(d.sheetId);
    if (d.kind === "added") added++;
    else if (d.kind === "removed") removed++;
    else changed++;
  }
  return { added, removed, changed, sheets: sheets.size };
}

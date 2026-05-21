// Pure helpers for cell-level checkboxes (#150).
//
// MVP design — Google Sheets parity:
//
//   Snapshot shape (Univer 0.5.x + Coco extension):
//     { sheets: { <sheetId>: { _checkboxes?: Array<{ cell: "A1" }> } } }
//
// The cell's underlying value (`cellData[row][col].v`) is a literal JS boolean
// so existing formula-engine references like `=A1`, `=IF(A1,...)`, `=COUNTIF(...)`
// pick it up as TRUE/FALSE without any extra plumbing. The `_checkboxes`
// array is purely a *flag* — "render this cell as a checkbox glyph and let
// click/space toggle it". This matches Google's behaviour: the cell IS a
// boolean; the checkbox decoration is metadata layered on top.
//
// Round-trip: the boolean value round-trips through xlsx natively via Univer's
// own cell-data writer (`<c t="b"><v>1</v></c>`), so Excel reading the file
// sees TRUE/FALSE in the cell. The `_checkboxes` metadata is preserved through
// the .coco JSON snapshot. Opening such an xlsx in Excel loses the visual
// checkbox decoration but retains the underlying boolean — a follow-up issue
// covers `<formControlPr objectType="CheckBox"/>` for full Excel fidelity.
//
// All mutators return a fresh snapshot object (never mutate the input) so the
// caller can JSON.stringify the result back into the workbook store while
// retaining the previous snapshot for undo / diff. Kept side-effect free so
// it can be unit-tested without Univer.

export interface CheckboxEntry {
  /** A1-style single-cell ref, e.g. "B12". */
  cell: string;
}

export interface CellCoord {
  row: number;
  col: number;
}

export interface CheckboxSheet {
  cellData?: Record<string, Record<string, unknown>>;
  _checkboxes?: CheckboxEntry[];
}

export interface CheckboxSnapshot {
  sheets?: Record<string, CheckboxSheet | undefined>;
}

/**
 * Parse a single-cell A1 ref ("A1", "AA42") to 0-based (row, col). Returns
 * null on malformed input — callers treat the entry as unprocessable rather
 * than throwing, matching the rest of Coco's best-effort snapshot patching.
 */
export function parseA1(cell: string): CellCoord | null {
  const m = /^([A-Z]+)(\d+)$/.exec(cell.trim().toUpperCase());
  if (!m) return null;
  const letters = m[1];
  const rowNum = Number.parseInt(m[2], 10);
  if (!Number.isFinite(rowNum) || rowNum < 1) return null;
  let col = 0;
  for (const ch of letters) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: rowNum - 1, col: col - 1 };
}

/** Inverse of parseA1. col is 0-based. */
export function toA1(row: number, col: number): string {
  if (row < 0 || col < 0) return "";
  let n = col;
  let letters = "";
  // Excel-style base-26 (A..Z, AA..AZ, ...).
  while (true) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    const next = Math.floor(n / 26) - 1;
    if (next < 0) break;
    n = next;
  }
  return `${letters}${row + 1}`;
}

function parseSnapshot(input: unknown): CheckboxSnapshot | null {
  if (input && typeof input === "object") return input as CheckboxSnapshot;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as CheckboxSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Shallow-clone the snapshot's sheets map so mutators can re-assign
 * `_checkboxes` / `cellData` without leaking changes back to the caller's
 * reference. Returns a synthetic empty snapshot when the input doesn't parse,
 * so all mutators degrade to no-ops on bad input.
 */
function ensureSnapshot(
  snapshot: string | CheckboxSnapshot | null | undefined,
): CheckboxSnapshot {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || typeof parsed !== "object") return { sheets: {} };
  return { ...parsed, sheets: { ...(parsed.sheets ?? {}) } };
}

/**
 * True when (sheetId, row, col) is decorated as a checkbox in the snapshot.
 * Tolerates malformed input, missing sheets, missing array (returns false).
 */
export function hasCheckbox(
  snapshot: string | CheckboxSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): boolean {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return false;
  const arr = parsed.sheets?.[sheetId]?._checkboxes;
  if (!Array.isArray(arr)) return false;
  for (const entry of arr) {
    if (!entry || typeof entry.cell !== "string") continue;
    const coord = parseA1(entry.cell);
    if (!coord) continue;
    if (coord.row === row && coord.col === col) return true;
  }
  return false;
}

/**
 * Read the boolean value currently stored at (sheetId, row, col) in the
 * snapshot's cellData. Returns false when the cell is empty / non-boolean —
 * a freshly-inserted checkbox starts out unchecked.
 *
 * We accept both literal booleans and the common xlsx round-trip forms
 * (number 0/1, string "TRUE"/"FALSE") so a checkbox added to a cell that
 * already holds one of those reads its initial state correctly.
 */
export function readCheckboxValue(
  snapshot: string | CheckboxSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): boolean {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return false;
  const cellData = parsed.sheets?.[sheetId]?.cellData;
  if (!cellData) return false;
  const cell = cellData[String(row)]?.[String(col)];
  if (!cell || typeof cell !== "object") return false;
  const v = (cell as { v?: unknown }).v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toUpperCase();
    return t === "TRUE" || t === "1";
  }
  return false;
}

/**
 * Decorate (sheetId, cellRef) as a checkbox. If the cell already carries a
 * checkbox flag, the call is idempotent — we never append a duplicate entry.
 * The cell's underlying value is normalized to a boolean (defaults to `false`
 * when the cell was empty); cells that already hold a boolean / numeric truth
 * value keep their effective state.
 *
 * Returns a fresh snapshot. Bad input (malformed ref / missing sheet) yields
 * a structurally-equivalent no-op snapshot so the caller can diff without
 * special-casing the miss.
 */
export function addCheckbox(
  snapshot: string | CheckboxSnapshot | null | undefined,
  sheetId: string,
  cellRef: string,
): CheckboxSnapshot {
  const out = ensureSnapshot(snapshot);
  const coord = parseA1(cellRef);
  if (!coord) return out;
  const sheet = out.sheets?.[sheetId];
  if (!sheet) return out;
  const existing = Array.isArray(sheet._checkboxes) ? sheet._checkboxes : [];

  // Normalize cell value to a literal boolean so formula refs see TRUE/FALSE.
  const cellData = (sheet.cellData ?? {}) as Record<string, Record<string, unknown>>;
  const rowKey = String(coord.row);
  const colKey = String(coord.col);
  const row = (cellData[rowKey] ?? {}) as Record<string, unknown>;
  const existingCell = (row[colKey] as Record<string, unknown> | undefined) ?? {};
  const currentVal = existingCell.v;
  let nextBool: boolean;
  if (typeof currentVal === "boolean") nextBool = currentVal;
  else if (typeof currentVal === "number") nextBool = currentVal !== 0;
  else if (typeof currentVal === "string") {
    const t = currentVal.trim().toUpperCase();
    nextBool = t === "TRUE" || t === "1";
  } else {
    nextBool = false;
  }

  const nextSheet: CheckboxSheet = { ...sheet };
  // Avoid duplicates on the same cell ref (case-insensitive A1 match).
  const filtered = existing.filter((e) => {
    if (!e || typeof e.cell !== "string") return false;
    const c = parseA1(e.cell);
    return !(c && c.row === coord.row && c.col === coord.col);
  });
  nextSheet._checkboxes = [...filtered, { cell: cellRef.toUpperCase() }];
  nextSheet.cellData = {
    ...cellData,
    [rowKey]: { ...row, [colKey]: { ...existingCell, v: nextBool } },
  };
  out.sheets![sheetId] = nextSheet;
  return out;
}

/**
 * Remove the checkbox decoration at (sheetId, cellRef). Leaves the cell's
 * underlying boolean value in place — the cell becomes a plain TRUE/FALSE,
 * matching Excel's "Delete" on a form control which strips the control
 * without touching the linked cell.
 *
 * Returns a fresh snapshot. Missing target → no-op snapshot.
 */
export function removeCheckbox(
  snapshot: string | CheckboxSnapshot | null | undefined,
  sheetId: string,
  cellRef: string,
): CheckboxSnapshot {
  const out = ensureSnapshot(snapshot);
  const coord = parseA1(cellRef);
  if (!coord) return out;
  const sheet = out.sheets?.[sheetId];
  if (!sheet || !Array.isArray(sheet._checkboxes)) return out;
  const kept = sheet._checkboxes.filter((e) => {
    if (!e || typeof e.cell !== "string") return true;
    const c = parseA1(e.cell);
    return !(c && c.row === coord.row && c.col === coord.col);
  });
  if (kept.length === sheet._checkboxes.length) return out;
  out.sheets![sheetId] = { ...sheet, _checkboxes: kept };
  return out;
}

/**
 * Toggle the boolean value at (sheetId, row, col). No-op when the cell isn't
 * decorated as a checkbox — the click handler relies on this to ignore
 * regular cells that happen to hold a boolean.
 *
 * Returns a fresh snapshot, the next boolean value (for the caller to feed
 * an imperative facade update), and a flag indicating whether anything
 * actually changed.
 */
export interface ToggleResult {
  snapshot: CheckboxSnapshot;
  /** The post-toggle boolean. False when there was no checkbox to toggle. */
  nextValue: boolean;
  changed: boolean;
}

export function toggleCheckbox(
  snapshot: string | CheckboxSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): ToggleResult {
  const out = ensureSnapshot(snapshot);
  if (!hasCheckbox(out, sheetId, row, col)) {
    return { snapshot: out, nextValue: false, changed: false };
  }
  const sheet = out.sheets![sheetId]!;
  const cellData = (sheet.cellData ?? {}) as Record<string, Record<string, unknown>>;
  const rowKey = String(row);
  const colKey = String(col);
  const rowObj = (cellData[rowKey] ?? {}) as Record<string, unknown>;
  const existingCell = (rowObj[colKey] as Record<string, unknown> | undefined) ?? {};
  const cur = readCheckboxValue(out, sheetId, row, col);
  const next = !cur;
  out.sheets![sheetId] = {
    ...sheet,
    cellData: {
      ...cellData,
      [rowKey]: { ...rowObj, [colKey]: { ...existingCell, v: next } },
    },
  };
  return { snapshot: out, nextValue: next, changed: true };
}

/**
 * List every checkbox across every sheet for callers that want to enumerate
 * (e.g. a "remove all checkboxes" admin path). Returns [] for malformed input.
 */
export interface CheckboxListing {
  sheetId: string;
  cellRef: string;
  row: number;
  col: number;
  value: boolean;
}

export function listAllCheckboxes(
  snapshot: string | CheckboxSnapshot | null | undefined,
): CheckboxListing[] {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || !parsed.sheets) return [];
  const out: CheckboxListing[] = [];
  for (const sheetId of Object.keys(parsed.sheets)) {
    const sheet = parsed.sheets[sheetId];
    if (!sheet || !Array.isArray(sheet._checkboxes)) continue;
    for (const entry of sheet._checkboxes) {
      if (!entry || typeof entry.cell !== "string") continue;
      const coord = parseA1(entry.cell);
      if (!coord) continue;
      out.push({
        sheetId,
        cellRef: entry.cell.toUpperCase(),
        row: coord.row,
        col: coord.col,
        value: readCheckboxValue(parsed, sheetId, coord.row, coord.col),
      });
    }
  }
  return out;
}

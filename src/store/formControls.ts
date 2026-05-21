// Pure helpers for form controls — radio buttons, spin buttons, scroll bars
// (#183, follow-up to the #150 cell-checkbox MVP).
//
// Design — same philosophy as src/store/checkbox.ts:
//
//   Snapshot shape (Univer 0.5.x + Coco extension):
//     { sheets: { <sheetId>: { _formControls?: FormControlEntry[] } } }
//
// A form control is anchored to a single cell (the cell that visually hosts
// the control glyph) and drives a *linked cell* whose `.v` holds the control's
// current value as a literal number / string. Keeping the linked value in a
// plain cell means existing formula references (`=A1`, `=IF(...)`) pick it up
// for free, and the linked value round-trips through xlsx natively as a
// number — exactly like the checkbox MVP keeps the boolean in `.v`.
//
// The `_formControls` array is purely metadata: "this cell hosts a control of
// kind K bound to linkedCell L with these min/max/step params". It is
// preserved Coco↔Coco through the .coco JSON snapshot and round-trips through
// xlsx via the `xl/cocoExtensions/formControls.json` part (see xlsx_io.rs),
// mirroring how `_tables` / `_slicers` / `_sparklines` survive xlsx.
//
// All mutators return a fresh snapshot object (never mutate the input) so the
// caller can JSON.stringify the result into the workbook store while keeping
// the previous snapshot for undo / diff. Side-effect free for unit testing.

import { parseA1, toA1, type CellCoord } from "./checkbox";

export type FormControlKind = "radio" | "spin" | "scroll";

/**
 * A single form control. `cell` is the host cell (A1 ref) where the glyph is
 * painted; `linkedCell` is the A1 ref of the cell whose `.v` holds the live
 * value. For radio buttons the live value is the *selected option value*; for
 * spin / scroll it is the current numeric position.
 */
export interface FormControlEntry {
  /** A1-style host cell, e.g. "B12". Unique per sheet. */
  cell: string;
  kind: FormControlKind;
  /** A1-style linked cell holding the value. Defaults to `cell` when omitted. */
  linkedCell?: string;

  // --- radio ---
  /** Radio group id — radios sharing a group are mutually exclusive. */
  group?: string;
  /** This radio option's value, written to linkedCell when selected. */
  optionValue?: string | number;
  /** Human label shown next to the radio glyph. */
  label?: string;

  // --- spin / scroll ---
  min?: number;
  max?: number;
  step?: number;
  /** scroll bar only: large-change increment (page up / page down). */
  page?: number;
}

export interface FormControlSheet {
  cellData?: Record<string, Record<string, unknown>>;
  _formControls?: FormControlEntry[];
  /**
   * Sibling cell-glyph feature buckets. Declared (loosely typed) so the
   * cell-occupancy guard can inspect them without a cast; their full shapes
   * live in store/sparklines.ts and store/checkbox.ts.
   */
  _sparklines?: Array<{ cell?: unknown }>;
  _checkboxes?: Array<{ cell?: unknown }>;
}

export interface FormControlSnapshot {
  sheets?: Record<string, FormControlSheet | undefined>;
}

/** Defaults applied when a spin / scroll control omits a numeric param. */
export const SPIN_DEFAULTS = { min: 0, max: 100, step: 1 } as const;
export const SCROLL_DEFAULTS = { min: 0, max: 100, step: 1, page: 10 } as const;

function parseSnapshot(input: unknown): FormControlSnapshot | null {
  if (input && typeof input === "object") return input as FormControlSnapshot;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as FormControlSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Shallow-clone the snapshot's sheets map so mutators can re-assign
 * `_formControls` / `cellData` without leaking changes back to the caller.
 * Returns a synthetic empty snapshot when the input doesn't parse, so all
 * mutators degrade to no-ops on bad input.
 */
function ensureSnapshot(
  snapshot: string | FormControlSnapshot | null | undefined,
): FormControlSnapshot {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || typeof parsed !== "object") return { sheets: {} };
  return { ...parsed, sheets: { ...(parsed.sheets ?? {}) } };
}

/** Same-cell test that tolerates case + whitespace differences in A1 refs. */
function sameCell(a: string, b: string): boolean {
  const ca = parseA1(a);
  const cb = parseA1(b);
  return !!ca && !!cb && ca.row === cb.row && ca.col === cb.col;
}

/**
 * The form control hosted at (sheetId, row, col), or null. Tolerates
 * malformed input, missing sheets, missing array.
 */
export function getFormControlAt(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): FormControlEntry | null {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return null;
  const arr = parsed.sheets?.[sheetId]?._formControls;
  if (!Array.isArray(arr)) return null;
  for (const entry of arr) {
    if (!entry || typeof entry.cell !== "string") continue;
    const coord = parseA1(entry.cell);
    if (coord && coord.row === row && coord.col === col) return entry;
  }
  return null;
}

/** True when (sheetId, row, col) hosts any form control. */
export function hasFormControl(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): boolean {
  return getFormControlAt(snapshot, sheetId, row, col) !== null;
}

/**
 * True when (sheetId, row, col) is already decorated by *any* cell-glyph
 * feature — a sparkline, a cell checkbox, or a form control. Callers use this
 * to refuse stacking a second glyph onto a cell (the glyphs all overwrite the
 * cell's `p` paragraph and would visually collide). Tolerates malformed input
 * and missing arrays; checks `_sparklines` / `_checkboxes` / `_formControls`.
 */
export function isCellOccupied(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): boolean {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return false;
  const sheet = parsed.sheets?.[sheetId];
  if (!sheet) return false;
  for (const key of ["_sparklines", "_checkboxes", "_formControls"] as const) {
    const arr = sheet[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      const cellRef = (entry as { cell?: unknown } | null)?.cell;
      if (typeof cellRef !== "string") continue;
      const coord = parseA1(cellRef);
      if (coord && coord.row === row && coord.col === col) return true;
    }
  }
  return false;
}

/** Effective linked cell for an entry — `linkedCell` or, failing that, `cell`. */
export function linkedCellOf(entry: FormControlEntry): string {
  return (entry.linkedCell ?? entry.cell).toUpperCase();
}

/**
 * Read the raw value stored in a cell's `.v`. Returns undefined for an empty
 * / missing cell so callers can distinguish "no value yet" from a literal 0.
 */
function readCellValue(
  snapshot: FormControlSnapshot,
  sheetId: string,
  ref: string,
): unknown {
  const coord = parseA1(ref);
  if (!coord) return undefined;
  const cell = snapshot.sheets?.[sheetId]?.cellData?.[String(coord.row)]?.[
    String(coord.col)
  ];
  if (!cell || typeof cell !== "object") return undefined;
  return (cell as { v?: unknown }).v;
}

/** Coerce an arbitrary cell value to a finite number, or null. */
export function coerceNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Write `value` into the cell at `ref` in the snapshot, returning a fresh
 * snapshot. Used to drive a control's linked cell. Preserves any other cell
 * keys (style, paragraph). No-op on a malformed ref / missing sheet.
 */
function writeCellValue(
  snapshot: FormControlSnapshot,
  sheetId: string,
  ref: string,
  value: number | string,
): FormControlSnapshot {
  const coord = parseA1(ref);
  if (!coord) return snapshot;
  const sheet = snapshot.sheets?.[sheetId];
  if (!sheet) return snapshot;
  const cellData = (sheet.cellData ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const rowKey = String(coord.row);
  const colKey = String(coord.col);
  const rowObj = (cellData[rowKey] ?? {}) as Record<string, unknown>;
  const existingCell =
    (rowObj[colKey] as Record<string, unknown> | undefined) ?? {};
  const out: FormControlSnapshot = {
    ...snapshot,
    sheets: {
      ...snapshot.sheets,
      [sheetId]: {
        ...sheet,
        cellData: {
          ...cellData,
          [rowKey]: { ...rowObj, [colKey]: { ...existingCell, v: value } },
        },
      },
    },
  };
  return out;
}

/**
 * Clamp `n` into [min, max] then snap to the nearest `step` boundary measured
 * from `min`. Mirrors how Excel's spin / scroll controls quantize their value.
 */
export function clampToStep(
  n: number,
  min: number,
  max: number,
  step: number,
): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const s = step > 0 ? step : 1;
  const clamped = Math.min(Math.max(n, lo), hi);
  const snapped = lo + Math.round((clamped - lo) / s) * s;
  // Guard against floating-point drift pushing us a hair past the bound.
  const result = Math.min(Math.max(snapped, lo), hi);
  // Trim FP noise (e.g. 0.30000000000000004) to a sane precision.
  return Number(result.toFixed(10));
}

/**
 * Add a form control to (sheetId, cellRef). Idempotent on the host cell —
 * re-adding the same cell replaces the prior entry. For spin / scroll the
 * linked cell is initialized to `min` when it has no numeric value yet; for
 * radio nothing is written until the user selects.
 *
 * Returns a fresh snapshot. Bad input (malformed ref / missing sheet) yields a
 * structurally-equivalent no-op snapshot.
 */
export function addFormControl(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  cellRef: string,
  spec: Omit<FormControlEntry, "cell">,
): FormControlSnapshot {
  let out = ensureSnapshot(snapshot);
  const coord = parseA1(cellRef);
  if (!coord) return out;
  const sheet = out.sheets?.[sheetId];
  if (!sheet) return out;

  const entry: FormControlEntry = {
    ...spec,
    cell: cellRef.toUpperCase(),
    linkedCell: (spec.linkedCell ?? cellRef).toUpperCase(),
  };

  const existing = Array.isArray(sheet._formControls)
    ? sheet._formControls
    : [];
  const filtered = existing.filter(
    (e) => !(e && typeof e.cell === "string" && sameCell(e.cell, cellRef)),
  );
  out.sheets![sheetId] = { ...sheet, _formControls: [...filtered, entry] };

  // Initialize the linked cell for spin / scroll so a freshly-inserted
  // control reads a sane starting value rather than blank.
  if (entry.kind === "spin" || entry.kind === "scroll") {
    const defaults = entry.kind === "spin" ? SPIN_DEFAULTS : SCROLL_DEFAULTS;
    const min = entry.min ?? defaults.min;
    const max = entry.max ?? defaults.max;
    const step = entry.step ?? defaults.step;
    const linked = linkedCellOf(entry);
    const current = coerceNumber(readCellValue(out, sheetId, linked));
    if (current === null) {
      out = writeCellValue(
        out,
        sheetId,
        linked,
        clampToStep(min, min, max, step),
      );
    }
  }
  return out;
}

/**
 * Remove the form control hosted at (sheetId, cellRef). Leaves the linked
 * cell's value untouched — matches Excel's "Delete" on a form control which
 * strips the control without clearing the linked cell.
 *
 * Returns a fresh snapshot. Missing target → no-op snapshot.
 */
export function removeFormControl(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  cellRef: string,
): FormControlSnapshot {
  const out = ensureSnapshot(snapshot);
  const coord = parseA1(cellRef);
  if (!coord) return out;
  const sheet = out.sheets?.[sheetId];
  if (!sheet || !Array.isArray(sheet._formControls)) return out;
  const kept = sheet._formControls.filter(
    (e) => !(e && typeof e.cell === "string" && sameCell(e.cell, cellRef)),
  );
  if (kept.length === sheet._formControls.length) return out;
  out.sheets![sheetId] = { ...sheet, _formControls: kept };
  return out;
}

export interface ControlActionResult {
  snapshot: FormControlSnapshot;
  /** The value now stored in the linked cell. */
  nextValue: number | string;
  changed: boolean;
}

const NO_CHANGE = (snap: FormControlSnapshot): ControlActionResult => ({
  snapshot: snap,
  nextValue: 0,
  changed: false,
});

/**
 * Select the radio control hosted at (sheetId, row, col). Writes the option's
 * value to its linked cell AND, for every *other* radio in the same group,
 * leaves their linked cells alone (Excel parity: all radios in a group share
 * one linked cell, so writing it once is the whole selection).
 *
 * No-op when the target cell hosts no radio.
 */
export function selectRadio(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): ControlActionResult {
  const out = ensureSnapshot(snapshot);
  const entry = getFormControlAt(out, sheetId, row, col);
  if (!entry || entry.kind !== "radio") return NO_CHANGE(out);
  const value = entry.optionValue ?? entry.label ?? entry.cell;
  // Re-clicking the already-selected radio is a no-op: report changed:false so
  // callers skip pushing an identical snapshot onto the undo stack.
  const currentVal = readCellValue(out, sheetId, linkedCellOf(entry));
  if (String(currentVal) === String(value)) {
    return { snapshot: out, nextValue: value, changed: false };
  }
  const next = writeCellValue(out, sheetId, linkedCellOf(entry), value);
  return { snapshot: next, nextValue: value, changed: true };
}

/**
 * True when the radio at (sheetId, row, col) is the currently-selected option
 * in its group — i.e. its linked cell holds this radio's optionValue.
 */
export function isRadioSelected(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): boolean {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return false;
  const entry = getFormControlAt(parsed, sheetId, row, col);
  if (!entry || entry.kind !== "radio") return false;
  const linkedVal = readCellValue(parsed, sheetId, linkedCellOf(entry));
  const optionVal = entry.optionValue ?? entry.label ?? entry.cell;
  // Loose equality across number/string forms ("1" === 1) for xlsx tolerance.
  return String(linkedVal) === String(optionVal);
}

/**
 * Step a spin OR scroll control by `direction` (+1 / -1) large-change units.
 * `large` selects the page increment (scroll bar only); when false a single
 * `step` is applied. The linked cell value is clamped + snapped.
 *
 * No-op when the target hosts no spin / scroll control.
 */
export function stepControl(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
  direction: 1 | -1,
  large = false,
): ControlActionResult {
  const out = ensureSnapshot(snapshot);
  const entry = getFormControlAt(out, sheetId, row, col);
  if (!entry || (entry.kind !== "spin" && entry.kind !== "scroll")) {
    return NO_CHANGE(out);
  }
  const defaults = entry.kind === "spin" ? SPIN_DEFAULTS : SCROLL_DEFAULTS;
  const min = entry.min ?? defaults.min;
  const max = entry.max ?? defaults.max;
  const step = entry.step ?? defaults.step;
  const page =
    entry.kind === "scroll"
      ? entry.page ?? SCROLL_DEFAULTS.page
      : step;
  const delta = (large ? page : step) * direction;
  const linked = linkedCellOf(entry);
  const current = coerceNumber(readCellValue(out, sheetId, linked)) ?? min;
  const next = clampToStep(current + delta, min, max, step);
  if (next === clampToStep(current, min, max, step)) {
    // Already at the bound — report no change so callers skip a snapshot push.
    return { snapshot: out, nextValue: next, changed: false };
  }
  return {
    snapshot: writeCellValue(out, sheetId, linked, next),
    nextValue: next,
    changed: true,
  };
}

/**
 * Set a spin / scroll control to an absolute value (clamped + snapped). Used
 * by the scroll-bar drag interaction which jumps straight to a position.
 */
export function setControlValue(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
  value: number,
): ControlActionResult {
  const out = ensureSnapshot(snapshot);
  const entry = getFormControlAt(out, sheetId, row, col);
  if (!entry || (entry.kind !== "spin" && entry.kind !== "scroll")) {
    return NO_CHANGE(out);
  }
  const defaults = entry.kind === "spin" ? SPIN_DEFAULTS : SCROLL_DEFAULTS;
  const min = entry.min ?? defaults.min;
  const max = entry.max ?? defaults.max;
  const step = entry.step ?? defaults.step;
  const next = clampToStep(value, min, max, step);
  const linked = linkedCellOf(entry);
  const current = coerceNumber(readCellValue(out, sheetId, linked));
  if (current !== null && clampToStep(current, min, max, step) === next) {
    return { snapshot: out, nextValue: next, changed: false };
  }
  return {
    snapshot: writeCellValue(out, sheetId, linked, next),
    nextValue: next,
    changed: true,
  };
}

/**
 * Current numeric value of a spin / scroll control (reads its linked cell).
 * Returns the control's `min` when the linked cell is empty / non-numeric.
 */
export function readControlValue(
  snapshot: string | FormControlSnapshot | null | undefined,
  sheetId: string,
  row: number,
  col: number,
): number {
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return 0;
  const entry = getFormControlAt(parsed, sheetId, row, col);
  if (!entry) return 0;
  const defaults = entry.kind === "spin" ? SPIN_DEFAULTS : SCROLL_DEFAULTS;
  const min = entry.min ?? defaults.min;
  const v = coerceNumber(readCellValue(parsed, sheetId, linkedCellOf(entry)));
  return v ?? min;
}

export interface FormControlListing extends FormControlEntry {
  sheetId: string;
  row: number;
  col: number;
}

/** Enumerate every form control across every sheet. [] on malformed input. */
export function listAllFormControls(
  snapshot: string | FormControlSnapshot | null | undefined,
): FormControlListing[] {
  const parsed = parseSnapshot(snapshot);
  if (!parsed || !parsed.sheets) return [];
  const out: FormControlListing[] = [];
  for (const sheetId of Object.keys(parsed.sheets)) {
    const sheet = parsed.sheets[sheetId];
    if (!sheet || !Array.isArray(sheet._formControls)) continue;
    for (const entry of sheet._formControls) {
      if (!entry || typeof entry.cell !== "string") continue;
      const coord = parseA1(entry.cell);
      if (!coord) continue;
      out.push({ ...entry, sheetId, row: coord.row, col: coord.col });
    }
  }
  return out;
}

// Re-export the A1 helpers so call sites can import from one place.
export { parseA1, toA1, type CellCoord };

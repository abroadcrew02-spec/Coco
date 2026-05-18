// Pure helpers for the per-sheet free-form Markdown note feature.
//
// Snapshot shape (per sheet, additive — single optional `_note` object
// alongside other Coco extensions like `_comments`, `_dataValidations`):
//
//   sheets: {
//     <sheetId>: {
//       name?: string;
//       _note?: {
//         text: string;       // Markdown body (free-form, no length limit)
//         updatedAt: string;  // ISO-8601 timestamp; refreshed on every set
//         author?: string;    // optional — author from the dialog input
//       }
//     }
//   }
//
// A `_note` with an empty/whitespace-only body is treated as absent: the
// setter writes the object as-is, but the dialog's onSave path is expected
// to call deleteSheetNote when the text is empty (mirroring how Excel
// drops zero-length comments).
//
// All helpers are pure (no I/O, no Univer references) so they can be
// unit-tested in isolation and shared between the dialog component and
// any future snapshot-rewriting code in EditorScreen / useMenuActions.
// They never mutate the input snapshot — every "write" returns a new
// snapshot object with the affected sheet shallow-copied, so React state
// observers see a fresh reference.
//
// Backward compatibility: sheets missing `_note` simply yield null from
// `getSheetNote`. Workbooks predating this feature deserialise unchanged.

/** Canonical in-memory shape of a sheet note. `updatedAt` is always set
 *  on insert/update by {@link setSheetNote}; callers should not need to
 *  stamp it themselves. */
export interface SheetNote {
  text: string;
  updatedAt: string;
  author?: string;
}

/** Subset of the workbook snapshot relevant to sheet notes. Callers
 *  typically parse the full snapshot JSON then narrow it to this shape
 *  before touching `_note`. */
export interface WorkbookNotesSnapshot {
  sheetOrder?: string[];
  sheets?: Record<string, SheetWithNote | undefined>;
}

/** Per-sheet slice that the note helpers care about. The `[k: string]`
 *  index signature lets callers pass through their full sheet object
 *  (with `_comments`, `_dataValidations`, etc.) without having to strip
 *  unrelated keys — we only read/write `name` and `_note`. */
export interface SheetWithNote {
  name?: string;
  _note?: SheetNote;
  [k: string]: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Read the note for a sheet. Returns null when the snapshot is malformed,
 *  the sheet is missing, the `_note` key is absent, or the stored object
 *  doesn't have a string `text` field. Never throws — bad data is treated
 *  as "no note" so the dialog can still open and let the user write one. */
export function getSheetNote(
  snapshot: WorkbookNotesSnapshot | null | undefined,
  sheetId: string | null | undefined,
): SheetNote | null {
  if (!snapshot || !sheetId) return null;
  const sheet = snapshot.sheets?.[sheetId];
  if (!sheet || typeof sheet !== "object") return null;
  const raw = sheet._note;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.text !== "string") return null;
  const out: SheetNote = {
    text: raw.text,
    updatedAt:
      typeof raw.updatedAt === "string" && raw.updatedAt
        ? raw.updatedAt
        : nowIso(),
  };
  if (typeof raw.author === "string" && raw.author) out.author = raw.author;
  return out;
}

/** Insert or update the note for a sheet. Always stamps `updatedAt` with
 *  the current time. Returns a new snapshot object with the affected
 *  sheet shallow-copied so React state observers re-render.
 *
 *  Tolerates a snapshot missing `sheets` / a sheet missing entirely — in
 *  those cases the helper creates the necessary structure. The author
 *  field is omitted when empty/whitespace so we don't persist noisy data. */
export function setSheetNote<S extends WorkbookNotesSnapshot>(
  snapshot: S,
  sheetId: string,
  text: string,
  author?: string,
): S {
  const sheets: Record<string, SheetWithNote | undefined> = {
    ...(snapshot.sheets ?? {}),
  };
  const existing = sheets[sheetId];
  const next: SheetWithNote = { ...(existing ?? {}) };
  const trimmedAuthor = author && author.trim() ? author.trim() : undefined;
  const note: SheetNote = {
    text,
    updatedAt: nowIso(),
  };
  if (trimmedAuthor) note.author = trimmedAuthor;
  next._note = note;
  sheets[sheetId] = next;
  return { ...snapshot, sheets } as S;
}

/** Remove the note from a sheet. Returns a new snapshot object with the
 *  affected sheet shallow-copied and `_note` deleted. No-op (returns a
 *  fresh shallow copy regardless, to keep callers' diff logic predictable)
 *  when the sheet is missing or has no note. */
export function deleteSheetNote<S extends WorkbookNotesSnapshot>(
  snapshot: S,
  sheetId: string,
): S {
  const sheets: Record<string, SheetWithNote | undefined> = {
    ...(snapshot.sheets ?? {}),
  };
  const existing = sheets[sheetId];
  if (!existing) return { ...snapshot, sheets } as S;
  const { _note: _drop, ...rest } = existing;
  void _drop;
  sheets[sheetId] = rest as SheetWithNote;
  return { ...snapshot, sheets } as S;
}

/** Enumerate every sheet that has a note attached, preserving the
 *  workbook's `sheetOrder` when present (so a future "notes overview"
 *  view lists them in tab order). Sheets without a note, or with a
 *  malformed `_note` shape, are skipped silently. */
export function listSheetsWithNotes(
  snapshot: WorkbookNotesSnapshot | null | undefined,
): Array<{ sheetId: string; sheetName: string; note: SheetNote }> {
  if (!snapshot || !snapshot.sheets) return [];
  const sheets = snapshot.sheets;
  const order = Array.isArray(snapshot.sheetOrder) && snapshot.sheetOrder.length > 0
    ? snapshot.sheetOrder.filter((id) => typeof id === "string" && id in sheets)
    : Object.keys(sheets);
  const out: Array<{ sheetId: string; sheetName: string; note: SheetNote }> = [];
  for (const sheetId of order) {
    const sheet = sheets[sheetId];
    if (!sheet || typeof sheet !== "object") continue;
    const note = getSheetNote(snapshot, sheetId);
    if (!note) continue;
    const sheetName =
      typeof sheet.name === "string" && sheet.name ? sheet.name : sheetId;
    out.push({ sheetId, sheetName, note });
  }
  return out;
}

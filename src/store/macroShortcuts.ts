// #186 (scope 2) — global shortcut binding for saved macros.
//
// Lets the user bind one saved macro to a Ctrl+Shift+1..9 chord. The binding
// table lives in localStorage (`coco.macroShortcuts`) independently of the
// macro payload (`coco.macros`) so editing a binding never rewrites — and
// never has to decrypt — the macro store.
//
// Pure / framework-free: the React hook (`useGlobalShortcuts`) and the
// MacroDialog UI both consume these helpers; this file owns no React.
//
// Slot model: the only chords we expose are Ctrl+Shift+1 .. Ctrl+Shift+9.
// They're a safe, finite namespace — Univer claims none of them, and a digit
// row is the Excel-ish "quick macro" convention. A slot maps to at most one
// macro id; a macro id may appear in at most one slot (a re-bind moves it).

export type MacroShortcutSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** All assignable slots, in display order. */
export const MACRO_SHORTCUT_SLOTS: readonly MacroShortcutSlot[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
];

export const LOCAL_STORAGE_KEY = "coco.macroShortcuts";
const STORAGE_VERSION = 1;

/** Map of slot number -> macro id. A slot with no binding is simply absent. */
export type ShortcutBindings = Partial<Record<MacroShortcutSlot, string>>;

interface StoredEnvelope {
  version: number;
  bindings: ShortcutBindings;
}

/** Human-readable chord label for a slot, e.g. `Ctrl+Shift+1`. */
export function slotLabel(slot: MacroShortcutSlot): string {
  return `Ctrl+Shift+${slot}`;
}

function isSlot(value: unknown): value is MacroShortcutSlot {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 9
  );
}

/** Parse a persisted bindings envelope, tolerating malformed input. */
export function parseBindings(json: string | null | undefined): ShortcutBindings {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const raw = (parsed as Record<string, unknown>).bindings;
  if (!raw || typeof raw !== "object") return {};
  const out: ShortcutBindings = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = Number(key);
    if (isSlot(slot) && typeof value === "string" && value !== "") {
      out[slot] = value;
    }
  }
  return out;
}

export function serializeBindings(bindings: ShortcutBindings): string {
  const env: StoredEnvelope = { version: STORAGE_VERSION, bindings };
  return JSON.stringify(env);
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Read the binding table from localStorage; `{}` on any failure. */
export function loadBindings(): ShortcutBindings {
  const ls = safeLocalStorage();
  if (!ls) return {};
  try {
    return parseBindings(ls.getItem(LOCAL_STORAGE_KEY));
  } catch {
    return {};
  }
}

/** Persist the binding table. Best-effort — silently no-ops on quota errors. */
export function saveBindings(bindings: ShortcutBindings): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(LOCAL_STORAGE_KEY, serializeBindings(bindings));
  } catch {
    // quota / private mode — drop silently, matching macroRecord.saveAll.
  }
}

/**
 * Assign `macroId` to `slot`, returning a NEW binding map. Because a slot
 * holds at most one macro and a macro lives in at most one slot, this:
 *   1. clears any other slot currently holding `macroId` (move semantics), and
 *   2. overwrites whatever was in `slot`.
 * Pass `macroId = null` to clear the slot.
 */
export function assignShortcut(
  bindings: ShortcutBindings,
  slot: MacroShortcutSlot,
  macroId: string | null,
): ShortcutBindings {
  const next: ShortcutBindings = {};
  for (const [key, value] of Object.entries(bindings)) {
    const s = Number(key) as MacroShortcutSlot;
    if (s === slot) continue; // dropped / replaced below
    if (macroId !== null && value === macroId) continue; // move semantics
    next[s] = value;
  }
  if (macroId !== null) next[slot] = macroId;
  return next;
}

/** Remove a macro from whatever slot (if any) holds it. Used when the macro
 *  itself is deleted so we never leave a dangling binding. */
export function clearMacroBinding(
  bindings: ShortcutBindings,
  macroId: string,
): ShortcutBindings {
  const next: ShortcutBindings = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (value === macroId) continue;
    next[Number(key) as MacroShortcutSlot] = value;
  }
  return next;
}

/** The slot a macro is bound to, or null when it has none. */
export function slotForMacro(
  bindings: ShortcutBindings,
  macroId: string,
): MacroShortcutSlot | null {
  for (const slot of MACRO_SHORTCUT_SLOTS) {
    if (bindings[slot] === macroId) return slot;
  }
  return null;
}

/**
 * Detect conflicts: a macro id mapped to more than one slot (should be
 * impossible via `assignShortcut`, but a hand-edited localStorage payload or a
 * stale binding could produce one). Returns a map of macroId -> slots[] for
 * every macro appearing in 2+ slots. Empty map means no conflict.
 */
export function findConflicts(
  bindings: ShortcutBindings,
): Record<string, MacroShortcutSlot[]> {
  const bySlot: Record<string, MacroShortcutSlot[]> = {};
  for (const slot of MACRO_SHORTCUT_SLOTS) {
    const id = bindings[slot];
    if (!id) continue;
    (bySlot[id] ??= []).push(slot);
  }
  const conflicts: Record<string, MacroShortcutSlot[]> = {};
  for (const [id, slots] of Object.entries(bySlot)) {
    if (slots.length > 1) conflicts[id] = slots;
  }
  return conflicts;
}

/**
 * Drop bindings whose macro id no longer exists in the supplied id set.
 * Returns a new map; callers persist the result so the table self-heals after
 * a macro is deleted outside the dialog.
 */
export function pruneBindings(
  bindings: ShortcutBindings,
  existingMacroIds: ReadonlySet<string>,
): ShortcutBindings {
  const next: ShortcutBindings = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (value && existingMacroIds.has(value)) {
      next[Number(key) as MacroShortcutSlot] = value;
    }
  }
  return next;
}

/**
 * Resolve a keyboard event to the bound macro id, or null. The chord is
 * Ctrl(or Cmd)+Shift+<digit 1-9> with no Alt. Used by `useGlobalShortcuts`.
 */
export function matchShortcut(
  e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key">,
  bindings: ShortcutBindings,
): string | null {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return null;
  // `e.key` for Ctrl+Shift+1 is "1" on most layouts; "!" on some. Accept the
  // digit form only — the shifted symbol form is layout-dependent and unsafe.
  const digit = Number(e.key);
  if (!isSlot(digit)) return null;
  return bindings[digit] ?? null;
}

/** Event name fired on `window` when bindings change so the global-shortcut
 *  hook can re-read localStorage without a shared store. */
export const MACRO_SHORTCUTS_CHANGED_EVENT = "coco:macro-shortcuts-changed";

export function notifyShortcutsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MACRO_SHORTCUTS_CHANGED_EVENT));
}

export function onShortcutsChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MACRO_SHORTCUTS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(MACRO_SHORTCUTS_CHANGED_EVENT, listener);
}

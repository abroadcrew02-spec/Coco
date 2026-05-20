import { flattenBlocks } from "./macroDsl";

// #131 MVP — operation macro record / replay.
//
// Subscribes to Univer's high-level COMMAND stream via `FUniver.onCommandExecuted`
// from EditorScreen and stores whitelisted events as JSON in localStorage. A
// recorded macro is a flat list of `{ id, params, timestamp }` entries that can
// be replayed in order via `fUniver.executeCommand`.
//
// Design notes:
//   * We only record CommandType.COMMAND (Univer's user-facing layer). Replaying
//     a COMMAND re-generates the corresponding MUTATION + undo MUTATION, which
//     is exactly the same path a real keystroke takes — so the workbook's
//     existing Undo stack and Coco's snapshot sync still work after playback.
//   * Recording observes only — it does NOT mutate Univer state, so we don't
//     need to suppress autosave during recording. Playback DOES mutate, and
//     each replayed COMMAND already drives the usual markDirty path; that is
//     the desired Excel-like behaviour (playback is itself an edit session).
//   * Playback toggles a `state: "playing"` flag so the recording listener
//     ignores commands that are themselves replays — without it, "record →
//     play once → re-record" would inadvertently duplicate every event.
//   * `fromCollab` is filtered (defensive — Coco is local-only today but the
//     option exists in IExecutionOptions and we want to be future-proof).
//   * Undo/redo commands are explicitly EXCLUDED from the whitelist. The user
//     intent of recording is "the net effect of my edits"; capturing undo
//     would replay the wrong shape.
//   * Storage key: `coco.macros`. Shape:
//        { version: 1, items: [ { id, name, createdAt, events: [...] } ] }
//     We tolerate older / malformed payloads by falling back to an empty list.
//
// OUT OF SCOPE (follow-up issue):
//   * Editable script DSL — events are raw JSON.
//   * Global shortcut binding to a specific macro.
//   * Encryption / signing.

export type MacroRecorderState = "idle" | "recording" | "playing";

export interface MacroEvent {
  /** Univer command id, e.g. `sheet.command.set-range-values`. */
  id: string;
  /** Command params as captured at recording time. We deep-clone via
   *  JSON to detach from Univer's internal references. */
  params: unknown;
  /** ms since epoch — useful for future "playback at original speed"
   *  modes; currently unused but kept for forward compatibility. */
  timestamp: number;
}

export interface SavedMacro {
  id: string;
  name: string;
  createdAt: number;
  events: MacroEvent[];
}

export const LOCAL_STORAGE_KEY = "coco.macros";
const STORAGE_VERSION = 1;

// Whitelist of Univer COMMAND ids we treat as macro-worthy. Kept conservative
// for MVP — every entry below corresponds to a user-visible cell-level
// operation that round-trips cleanly through executeCommand. Anything that
// requires a live UI selection (range/clipboard) or pops a dialog is intentionally
// omitted; the user can still drive those via the command palette during
// playback if needed.
//
// Source: Univer 0.5.x SetRangeValuesCommand etc. — these ids are stable per
// the Univer 0.5 line.
export const RECORDABLE_COMMAND_IDS: ReadonlySet<string> = new Set([
  // Selection — #186 DSL `range` keyword targets this. Selecting a range is a
  // replayable operation in its own right and a precondition for the
  // clear-selection-* commands below.
  "sheet.command.set-selection",
  // Cell content / formula
  "sheet.command.set-range-values",
  "sheet.command.clear-selection-content",
  "sheet.command.clear-selection-all",
  "sheet.command.clear-selection-format",
  // Style / format
  "sheet.command.set-style",
  "sheet.command.set-range-bold",
  "sheet.command.set-range-italic",
  "sheet.command.set-range-underline",
  "sheet.command.set-range-strick-through",
  "sheet.command.set-range-fontFamily",
  "sheet.command.set-range-fontSize",
  "sheet.command.set-range-textColor",
  "sheet.command.set-background-color",
  "sheet.command.set-horizontal-text-align",
  "sheet.command.set-vertical-text-align",
  "sheet.command.set-text-wrap",
  "sheet.command.set-text-rotation",
  "sheet.command.set-border-command",
  "sheet.command.set-border-basic",
  // Rows / columns
  "sheet.command.insert-row",
  "sheet.command.insert-col",
  "sheet.command.remove-row",
  "sheet.command.remove-col",
  "sheet.command.set-row-height",
  "sheet.command.set-col-width",
  "sheet.command.set-row-hide",
  "sheet.command.set-row-show",
  "sheet.command.set-col-hide",
  "sheet.command.set-col-show",
  // Sheet structure
  "sheet.command.set-worksheet-name",
  "sheet.command.set-worksheet-order",
  "sheet.command.insert-sheet",
  // Number format
  "sheet.command.numfmt.set.numfmt",
]);

// Univer's own undo/redo COMMAND ids. Re-recording these during playback (or
// recording them at all) leads to confusing semantics — Excel macros don't
// capture undo either. Listed here so we can guard against accidental future
// additions to the whitelist.
const UNDO_REDO_IDS: ReadonlySet<string> = new Set([
  "univer.command.undo",
  "univer.command.redo",
]);

export function isRecordableCommand(id: string): boolean {
  if (UNDO_REDO_IDS.has(id)) return false;
  return RECORDABLE_COMMAND_IDS.has(id);
}

/**
 * Mutable recorder kept in module scope (singleton). Held outside of the
 * Zustand store because (a) it must survive React remounts without losing
 * an in-progress recording, and (b) the only thing the UI reads is `state`
 * + `events.length`, which is fine to expose via callbacks.
 */
interface Recorder {
  state: MacroRecorderState;
  events: MacroEvent[];
  startedAt: number;
}

const recorder: Recorder = {
  state: "idle",
  events: [],
  startedAt: 0,
};

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // A subscriber throwing must not break recording.
    }
  });
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): MacroRecorderState {
  return recorder.state;
}

export function getEventCount(): number {
  return recorder.events.length;
}

export function startRecording(): boolean {
  if (recorder.state !== "idle") return false;
  recorder.state = "recording";
  recorder.events = [];
  recorder.startedAt = Date.now();
  notify();
  return true;
}

export interface StoppedRecording {
  events: MacroEvent[];
  startedAt: number;
}

/** Stops recording and returns the captured events. The recorder resets to
 *  idle; the caller decides whether to persist them. */
export function stopRecording(): StoppedRecording | null {
  if (recorder.state !== "recording") return null;
  const result: StoppedRecording = {
    events: recorder.events.slice(),
    startedAt: recorder.startedAt,
  };
  recorder.state = "idle";
  recorder.events = [];
  recorder.startedAt = 0;
  notify();
  return result;
}

export function cancelRecording(): void {
  if (recorder.state !== "recording") return;
  recorder.state = "idle";
  recorder.events = [];
  recorder.startedAt = 0;
  notify();
}

/** Observer entry point. EditorScreen wires this to FUniver.onCommandExecuted.
 *  Returns true when an event was appended (useful for tests). */
export function observeCommand(
  id: string,
  params: unknown,
  options?: { fromCollab?: boolean },
): boolean {
  if (recorder.state !== "recording") return false;
  if (options?.fromCollab) return false;
  if (!isRecordableCommand(id)) return false;
  // JSON round-trip detaches Univer's params from our store and trims any
  // non-serialisable cruft. If it throws (cyclic), drop the event.
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(params ?? null));
  } catch {
    return false;
  }
  recorder.events.push({ id, params: cloned, timestamp: Date.now() });
  notify();
  return true;
}

export function markPlaybackStart(): void {
  recorder.state = "playing";
  notify();
}

export function markPlaybackEnd(): void {
  if (recorder.state === "playing") {
    recorder.state = "idle";
    notify();
  }
}

// Heuristic flag — UI surfaces a warning before saving a recording that
// includes potentially destructive commands. The list intentionally mirrors
// the Excel "Are you sure?" UX for delete-sheet / remove-row etc.
const DESTRUCTIVE_IDS: ReadonlySet<string> = new Set([
  "sheet.command.remove-row",
  "sheet.command.remove-col",
  "sheet.command.remove-sheet",
]);

export function summariseDestructive(events: readonly MacroEvent[]): string[] {
  const seen = new Set<string>();
  for (const e of events) {
    if (DESTRUCTIVE_IDS.has(e.id)) seen.add(e.id);
  }
  return [...seen];
}

// ---- persistence ---------------------------------------------------------

interface StoredEnvelope {
  version: number;
  items: SavedMacro[];
}

function isMacroEvent(v: unknown): v is MacroEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.timestamp === "number" &&
    "params" in o
  );
}

function isSavedMacro(v: unknown): v is SavedMacro {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.createdAt === "number" &&
    Array.isArray(o.events) &&
    o.events.every(isMacroEvent)
  );
}

export function parse(json: string | null | undefined): SavedMacro[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const items = (parsed as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter(isSavedMacro);
}

export function serialize(items: readonly SavedMacro[]): string {
  const env: StoredEnvelope = { version: STORAGE_VERSION, items: [...items] };
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

export function loadAll(): SavedMacro[] {
  const ls = safeLocalStorage();
  if (!ls) return [];
  try {
    return parse(ls.getItem(LOCAL_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveAll(items: readonly SavedMacro[]): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(LOCAL_STORAGE_KEY, serialize(items));
  } catch {
    // Quota exceeded / private mode — silently drop. The MVP doesn't
    // surface a save-failure UI; localStorage is best-effort.
  }
}

let macroSeq = 0;

export function generateMacroId(): string {
  // Caller may pass deterministic ids in tests via `addMacro` directly; for
  // UI-driven saves we just need uniqueness within the local list.
  return `macro-${Date.now().toString(36)}-${(macroSeq++).toString(36)}`;
}

export function addMacro(
  items: readonly SavedMacro[],
  name: string,
  events: readonly MacroEvent[],
  now: number = Date.now(),
  id: string = generateMacroId(),
): SavedMacro[] {
  const trimmed = name.trim() || `マクロ ${items.length + 1}`;
  const macro: SavedMacro = {
    id,
    name: trimmed,
    createdAt: now,
    events: events.map((e) => ({ ...e })),
  };
  return [...items, macro];
}

export function removeMacro(
  items: readonly SavedMacro[],
  id: string,
): SavedMacro[] {
  return items.filter((m) => m.id !== id);
}

// ---- playback ------------------------------------------------------------

export interface MacroExecutor {
  executeCommand: (id: string, params?: unknown) => Promise<unknown>;
}

export interface PlaybackResult {
  ran: number;
  skipped: number;
  errors: { id: string; error: unknown }[];
}

/**
 * Replays a macro through the supplied executor. Each event is awaited so
 * Univer can apply MUTATIONs in order — running them in parallel would
 * race the snapshot. We tolerate per-command failures (record them and
 * continue) rather than aborting on the first error; aborting partway
 * leaves the workbook in a weird half-state with no easy recovery, while
 * "best-effort + report" matches what other apps do with macros.
 *
 * #186: a macro authored via the DSL editor may contain synthetic `for` / `if`
 * block markers. `flattenBlocks` expands `for` loops and strips the markers so
 * playback always sees a flat, real-command list.
 */
export async function playback(
  events: readonly MacroEvent[],
  executor: MacroExecutor,
): Promise<PlaybackResult> {
  const result: PlaybackResult = { ran: 0, skipped: 0, errors: [] };
  const flat = flattenBlocks(events);
  markPlaybackStart();
  try {
    for (const event of flat) {
      if (!isRecordableCommand(event.id)) {
        result.skipped += 1;
        continue;
      }
      try {
        await executor.executeCommand(
          event.id,
          (event.params ?? undefined) as object | undefined,
        );
        result.ran += 1;
      } catch (err) {
        result.errors.push({ id: event.id, error: err });
      }
    }
  } finally {
    markPlaybackEnd();
  }
  return result;
}

// ---- test helpers --------------------------------------------------------

/** Resets the singleton recorder. ONLY for unit tests. */
export function __resetForTests(): void {
  recorder.state = "idle";
  recorder.events = [];
  recorder.startedAt = 0;
  listeners.clear();
  macroSeq = 0;
}

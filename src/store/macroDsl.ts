// #186 (scope 1) — editable script DSL for recorded macros.
//
// The MVP (#131) stored a macro purely as `MacroEvent[]` — raw Univer command
// ids + opaque JSON params. That round-trips perfectly but is unreadable and
// uneditable by a human. This module adds a bidirectional projection between
// `MacroEvent[]` and a small line-oriented text DSL so the user can review and
// hand-tweak a macro in a textarea.
//
// Design constraints:
//   * Lossless round-trip. `dslToEvents(eventsToDsl(x))` MUST deep-equal `x`
//     for every macro the recorder can produce. To guarantee that without
//     enumerating every Univer command, any event whose params don't fit a
//     known high-level keyword falls back to a generic `cmd <id> <json>` line
//     that carries the params verbatim. The friendly keywords (`range`,
//     `value`, `if`, `for`) are sugar layered on top — they never lose data.
//   * Pure / framework-free — no React, no Univer imports — so it is trivially
//     unit-testable and reusable.
//   * The DSL is deliberately tiny. It is NOT a general scripting language: it
//     is a serialisation format that happens to be human-friendly. `if` / `for`
//     blocks are recorded as structural markers (the recorder never emits them
//     today) so the grammar is forward-compatible if a future recorder learns
//     to capture control flow; for now they parse + serialise round-trip but
//     `flattenBlocks` expands them away before playback.
//
// Grammar (one statement per line; blank lines and `# comments` ignored):
//
//   range <A1:B2>                 -> cmd sheet.command.set-selection ...
//   value <A1> = <json>           -> cmd sheet.command.set-range-values ...
//   cmd <command-id> <json?>      -> generic passthrough for any event
//   for <n>                       -> repeat the block <n> times
//   end                           -> closes a for / if block
//   if <json-predicate>           -> conditional block (structural only)
//
// `range` and `value` are recognised sugar for the two most common recorded
// commands; everything else is emitted as `cmd`. On parse we accept all four
// forms. The `for`/`if`/`end` block markers are encoded into the event stream
// as synthetic `MacroEvent`s with reserved ids so a saved macro is still just
// a `MacroEvent[]`.

import type { MacroEvent } from "./macroRecord";

// Reserved synthetic command ids used to encode DSL control-flow markers
// inside a `MacroEvent[]`. They are NOT real Univer commands — `flattenBlocks`
// (and the recorder whitelist) treat them specially.
export const MACRO_BLOCK_FOR = "coco.macro.block.for";
export const MACRO_BLOCK_IF = "coco.macro.block.if";
export const MACRO_BLOCK_END = "coco.macro.block.end";

const BLOCK_IDS: ReadonlySet<string> = new Set([
  MACRO_BLOCK_FOR,
  MACRO_BLOCK_IF,
  MACRO_BLOCK_END,
]);

/** True when an event is a synthetic DSL block marker rather than a real
 *  Univer command. Playback must expand / skip these (see `flattenBlocks`). */
export function isBlockMarker(event: MacroEvent): boolean {
  return BLOCK_IDS.has(event.id);
}

// Univer command ids that the DSL surfaces with friendly keyword sugar.
const CMD_SET_RANGE_VALUES = "sheet.command.set-range-values";
const CMD_SET_SELECTION = "sheet.command.set-selection";

export interface DslParseError {
  /** 1-based line number the error was found on. */
  line: number;
  message: string;
}

export interface DslParseResult {
  events: MacroEvent[];
  errors: DslParseError[];
}

// ---- serialisation: MacroEvent[] -> DSL text -----------------------------

function jsonInline(value: unknown): string {
  // Single-line JSON so each statement stays on one line. `undefined` params
  // serialise to nothing (the keyword forms allow an omitted payload).
  if (value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * Project a `range` keyword line out of a set-selection event when the params
 * carry a plain A1 string; otherwise returns null so the caller falls back to
 * the generic `cmd` form (lossless).
 */
function tryRangeLine(event: MacroEvent): string | null {
  if (event.id !== CMD_SET_SELECTION) return null;
  const p = event.params as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return null;
  const a1 = p.a1;
  // We only use the sugar when the params are EXACTLY `{ a1: string }` — any
  // extra key means we'd lose data, so fall back to `cmd`.
  if (typeof a1 === "string" && Object.keys(p).length === 1) {
    return `range ${a1}`;
  }
  return null;
}

/**
 * Project a `value` keyword line out of a set-range-values event when the
 * params are exactly `{ a1: string, value: <json> }`; else null.
 */
function tryValueLine(event: MacroEvent): string | null {
  if (event.id !== CMD_SET_RANGE_VALUES) return null;
  const p = event.params as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return null;
  const keys = Object.keys(p).sort();
  if (keys.length === 2 && keys[0] === "a1" && keys[1] === "value" && typeof p.a1 === "string") {
    return `value ${p.a1} = ${jsonInline(p.value)}`;
  }
  return null;
}

/** Serialise a single event to one DSL line. */
function eventToLine(event: MacroEvent): string {
  if (event.id === MACRO_BLOCK_FOR) {
    const count = (event.params as { count?: unknown })?.count;
    return `for ${typeof count === "number" ? count : 1}`;
  }
  if (event.id === MACRO_BLOCK_IF) {
    return `if ${jsonInline((event.params as { predicate?: unknown })?.predicate)}`.trimEnd();
  }
  if (event.id === MACRO_BLOCK_END) {
    return "end";
  }
  const range = tryRangeLine(event);
  if (range) return range;
  const value = tryValueLine(event);
  if (value) return value;
  const payload = jsonInline(event.params);
  return payload ? `cmd ${event.id} ${payload}` : `cmd ${event.id}`;
}

/**
 * Serialise an event list to indented DSL text. `for` / `if` open a block and
 * `end` closes one; lines inside a block are indented by two spaces per depth
 * so the text is readable. Indentation is cosmetic — the parser ignores it.
 */
export function eventsToDsl(events: readonly MacroEvent[]): string {
  const lines: string[] = [];
  let depth = 0;
  for (const event of events) {
    if (event.id === MACRO_BLOCK_END && depth > 0) depth -= 1;
    const indent = "  ".repeat(Math.max(0, depth));
    lines.push(indent + eventToLine(event));
    if (event.id === MACRO_BLOCK_FOR || event.id === MACRO_BLOCK_IF) depth += 1;
  }
  return lines.join("\n");
}

// ---- parsing: DSL text -> MacroEvent[] -----------------------------------

/** Splits a line into its leading keyword and the remainder (trimmed). */
function splitKeyword(line: string): { keyword: string; rest: string } {
  const trimmed = line.trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { keyword: trimmed, rest: "" };
  return {
    keyword: trimmed.slice(0, spaceIdx),
    rest: trimmed.slice(spaceIdx + 1).trim(),
  };
}

function parseJsonOrError(
  raw: string,
  lineNo: number,
  errors: DslParseError[],
): { ok: true; value: unknown } | { ok: false } {
  if (raw === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    errors.push({ line: lineNo, message: `JSON が不正です: ${raw}` });
    return { ok: false };
  }
}

/**
 * Parse DSL text into a `MacroEvent[]` plus a list of per-line errors. The
 * timestamp is synthetic (DSL text carries no timing) — playback ignores it,
 * and a re-serialise drops it again, so round-trip equality is preserved when
 * compared with `timestamp` normalised (see `dslToEvents`).
 */
export function parseDsl(text: string): DslParseResult {
  const events: MacroEvent[] = [];
  const errors: DslParseError[] = [];
  const lines = text.split(/\r?\n/);
  let depth = 0;

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;

    const { keyword, rest } = splitKeyword(line);

    switch (keyword) {
      case "range": {
        if (rest === "") {
          errors.push({ line: lineNo, message: "range には A1 参照が必要です" });
          return;
        }
        events.push({
          id: CMD_SET_SELECTION,
          params: { a1: rest },
          timestamp: 0,
        });
        return;
      }
      case "value": {
        // `value <A1> = <json>`
        const eq = rest.indexOf("=");
        if (eq === -1) {
          errors.push({ line: lineNo, message: "value 文には '=' が必要です" });
          return;
        }
        const a1 = rest.slice(0, eq).trim();
        const jsonRaw = rest.slice(eq + 1).trim();
        if (a1 === "") {
          errors.push({ line: lineNo, message: "value には A1 参照が必要です" });
          return;
        }
        const parsed = parseJsonOrError(jsonRaw, lineNo, errors);
        if (!parsed.ok) return;
        events.push({
          id: CMD_SET_RANGE_VALUES,
          params: { a1, value: parsed.value },
          timestamp: 0,
        });
        return;
      }
      case "cmd": {
        const { keyword: cmdId, rest: jsonRaw } = splitKeyword(rest);
        if (cmdId === "") {
          errors.push({ line: lineNo, message: "cmd にはコマンド ID が必要です" });
          return;
        }
        const parsed = parseJsonOrError(jsonRaw, lineNo, errors);
        if (!parsed.ok) return;
        events.push({ id: cmdId, params: parsed.value, timestamp: 0 });
        return;
      }
      case "for": {
        const count = Number(rest);
        if (!Number.isInteger(count) || count < 0) {
          errors.push({ line: lineNo, message: `for の回数が不正です: ${rest}` });
          return;
        }
        events.push({ id: MACRO_BLOCK_FOR, params: { count }, timestamp: 0 });
        depth += 1;
        return;
      }
      case "if": {
        const parsed = parseJsonOrError(rest, lineNo, errors);
        if (!parsed.ok) return;
        events.push({
          id: MACRO_BLOCK_IF,
          params: { predicate: parsed.value },
          timestamp: 0,
        });
        depth += 1;
        return;
      }
      case "end": {
        if (depth === 0) {
          errors.push({ line: lineNo, message: "対応する for / if のない end です" });
          return;
        }
        events.push({ id: MACRO_BLOCK_END, params: null, timestamp: 0 });
        depth -= 1;
        return;
      }
      default:
        errors.push({ line: lineNo, message: `未知のキーワード: ${keyword}` });
    }
  });

  if (depth > 0) {
    errors.push({
      line: lines.length,
      message: `閉じられていない for / if ブロックが ${depth} 個あります`,
    });
  }

  return { events, errors };
}

/**
 * Convenience wrapper: parse DSL and return just the events, throwing if the
 * text has any error. Use `parseDsl` directly when you want to surface errors
 * in the UI without an exception.
 */
export function dslToEvents(text: string): MacroEvent[] {
  const { events, errors } = parseDsl(text);
  if (errors.length > 0) {
    throw new Error(`DSL parse failed: ${errors[0].message} (line ${errors[0].line})`);
  }
  return events;
}

/**
 * Expand `for` blocks and strip `if` markers so playback sees a flat command
 * list. `for <n>` repeats its block body `n` times; `if` is treated as
 * always-true for MVP (the recorder never emits a real predicate yet) so its
 * body runs once. Block markers themselves are removed from the output.
 *
 * Unbalanced markers are tolerated (a stray `end` is ignored) — the parser
 * already reports those as errors; this function must not throw at playback.
 */
export function flattenBlocks(events: readonly MacroEvent[]): MacroEvent[] {
  // Recursive descent over the marker-bracketed structure.
  let i = 0;

  function parseSequence(stopAtEnd: boolean): MacroEvent[] {
    const out: MacroEvent[] = [];
    while (i < events.length) {
      const event = events[i];
      if (event.id === MACRO_BLOCK_END) {
        i += 1;
        if (stopAtEnd) return out;
        // stray end at top level — skip it
        continue;
      }
      if (event.id === MACRO_BLOCK_FOR) {
        const count = (event.params as { count?: unknown })?.count;
        const reps = typeof count === "number" && count >= 0 ? count : 0;
        i += 1;
        const body = parseSequence(true);
        for (let r = 0; r < reps; r += 1) out.push(...body);
        continue;
      }
      if (event.id === MACRO_BLOCK_IF) {
        i += 1;
        const body = parseSequence(true);
        // MVP: predicate is unconditionally true, run the body once.
        out.push(...body);
        continue;
      }
      out.push(event);
      i += 1;
    }
    return out;
  }

  return parseSequence(false);
}

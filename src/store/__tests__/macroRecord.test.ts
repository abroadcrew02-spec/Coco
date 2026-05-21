// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetForTests,
  addMacro,
  cancelRecording,
  generateMacroId,
  getEventCount,
  getState,
  isRecordableCommand,
  loadAll,
  observeCommand,
  parse,
  playback,
  removeMacro,
  RECORDABLE_COMMAND_IDS,
  saveAll,
  serialize,
  startRecording,
  stopRecording,
  subscribe,
  summariseDestructive,
  type MacroEvent,
  type SavedMacro,
} from "../macroRecord";

beforeEach(() => {
  __resetForTests();
  try {
    localStorage.clear();
  } catch {
    // jsdom-only API; ignore in non-DOM environments.
  }
});

describe("recorder state machine", () => {
  it("starts idle and accepts no events", () => {
    expect(getState()).toBe("idle");
    const appended = observeCommand("sheet.command.set-range-values", { foo: 1 });
    expect(appended).toBe(false);
    expect(getEventCount()).toBe(0);
  });

  it("appends only whitelisted commands while recording", () => {
    expect(startRecording()).toBe(true);
    expect(getState()).toBe("recording");

    // Whitelisted — captured.
    expect(observeCommand("sheet.command.set-range-values", { a: 1 })).toBe(true);
    // Not on the whitelist — dropped.
    expect(observeCommand("doc.command.foo", { a: 2 })).toBe(false);
    // Undo is explicitly excluded even though it is a known COMMAND.
    expect(observeCommand("univer.command.undo", undefined)).toBe(false);
    // fromCollab events are filtered as a defensive measure.
    expect(
      observeCommand("sheet.command.set-range-values", {}, { fromCollab: true }),
    ).toBe(false);

    expect(getEventCount()).toBe(1);
  });

  it("startRecording is a no-op when already recording", () => {
    startRecording();
    expect(startRecording()).toBe(false);
  });

  it("stopRecording returns the captured events and resets to idle", () => {
    startRecording();
    observeCommand("sheet.command.set-range-values", { v: 1 });
    observeCommand("sheet.command.set-style", { color: "red" });

    const stopped = stopRecording();
    expect(stopped).not.toBeNull();
    expect(stopped!.events).toHaveLength(2);
    expect(stopped!.events[0].id).toBe("sheet.command.set-range-values");
    expect(stopped!.events[0].params).toEqual({ v: 1 });
    expect(getState()).toBe("idle");
  });

  it("cancelRecording drops events without returning them", () => {
    startRecording();
    observeCommand("sheet.command.set-range-values", { v: 1 });
    cancelRecording();
    expect(getState()).toBe("idle");
    expect(getEventCount()).toBe(0);
  });

  it("deep-clones params via JSON to detach from caller references", () => {
    startRecording();
    const mutable = { range: [1, 2, 3] };
    observeCommand("sheet.command.set-range-values", mutable);
    mutable.range.push(4);
    const stopped = stopRecording();
    expect((stopped!.events[0].params as { range: number[] }).range).toEqual([1, 2, 3]);
  });

  it("drops events whose params are not JSON-serialisable", () => {
    startRecording();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(observeCommand("sheet.command.set-range-values", cyclic)).toBe(false);
    expect(getEventCount()).toBe(0);
  });

  it("notifies subscribers on state transitions and event appends", () => {
    const fn = vi.fn();
    const unsub = subscribe(fn);
    startRecording();
    observeCommand("sheet.command.set-range-values", { v: 1 });
    stopRecording();
    expect(fn).toHaveBeenCalled();
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
    unsub();
  });
});

describe("whitelist", () => {
  it("treats set-range-values and friends as recordable", () => {
    expect(isRecordableCommand("sheet.command.set-range-values")).toBe(true);
    expect(isRecordableCommand("sheet.command.set-style")).toBe(true);
    expect(isRecordableCommand("sheet.command.insert-row")).toBe(true);
  });

  it("rejects undo/redo even though COMMANDs", () => {
    expect(isRecordableCommand("univer.command.undo")).toBe(false);
    expect(isRecordableCommand("univer.command.redo")).toBe(false);
  });

  it("rejects unknown ids", () => {
    expect(isRecordableCommand("sheet.command.bogus-thing")).toBe(false);
  });

  it("RECORDABLE_COMMAND_IDS exposes a non-empty readonly set", () => {
    expect(RECORDABLE_COMMAND_IDS.size).toBeGreaterThan(0);
  });
});

describe("serialise / parse round-trip", () => {
  it("round-trips a list of saved macros", () => {
    const macros: SavedMacro[] = [
      {
        id: "m1",
        name: "セル A1 を赤く",
        createdAt: 12345,
        events: [
          { id: "sheet.command.set-range-values", params: { v: 1 }, timestamp: 1 },
        ],
      },
    ];
    const json = serialize(macros);
    const back = parse(json);
    expect(back).toEqual(macros);
  });

  it("parse tolerates null / empty / malformed input", () => {
    expect(parse(null)).toEqual([]);
    expect(parse("")).toEqual([]);
    expect(parse("not json")).toEqual([]);
    expect(parse("{}")).toEqual([]);
    expect(parse('{"items":"nope"}')).toEqual([]);
  });

  it("parse drops entries missing required fields", () => {
    const bad = JSON.stringify({
      version: 1,
      items: [
        { id: "ok", name: "ok", createdAt: 1, events: [] },
        { name: "no id" },
        { id: "x", name: "y", createdAt: 2 }, // missing events
      ],
    });
    expect(parse(bad)).toHaveLength(1);
  });
});

describe("localStorage persistence", () => {
  it("saveAll then loadAll returns the same items", () => {
    const macros: SavedMacro[] = [
      {
        id: "m1",
        name: "test",
        createdAt: 1,
        events: [{ id: "sheet.command.set-style", params: { c: "red" }, timestamp: 0 }],
      },
    ];
    saveAll(macros);
    expect(loadAll()).toEqual(macros);
  });

  it("loadAll returns [] when storage is empty", () => {
    expect(loadAll()).toEqual([]);
  });

  it("addMacro appends with trimmed name and auto fallback", () => {
    const items: SavedMacro[] = [];
    const next = addMacro(items, "  名前  ", [], 99, "m-1");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "m-1", name: "名前", createdAt: 99 });
  });

  it("addMacro falls back to default name when blank", () => {
    const next = addMacro([], "   ", [], 1, "m-1");
    expect(next[0].name).toBe("マクロ 1");
  });

  it("removeMacro filters by id", () => {
    const items: SavedMacro[] = [
      { id: "a", name: "A", createdAt: 1, events: [] },
      { id: "b", name: "B", createdAt: 2, events: [] },
    ];
    expect(removeMacro(items, "a")).toEqual([items[1]]);
  });

  it("generateMacroId returns unique strings", () => {
    const a = generateMacroId();
    const b = generateMacroId();
    expect(a).not.toEqual(b);
  });
});

describe("destructive command warnings", () => {
  it("flags remove-row / remove-col / remove-sheet", () => {
    const events: MacroEvent[] = [
      { id: "sheet.command.set-range-values", params: {}, timestamp: 0 },
      { id: "sheet.command.remove-row", params: {}, timestamp: 1 },
      { id: "sheet.command.remove-row", params: {}, timestamp: 2 },
      { id: "sheet.command.remove-sheet", params: {}, timestamp: 3 },
    ];
    const summary = summariseDestructive(events);
    expect(summary.sort()).toEqual(
      ["sheet.command.remove-row", "sheet.command.remove-sheet"].sort(),
    );
  });

  it("returns [] when no destructive commands present", () => {
    expect(summariseDestructive([])).toEqual([]);
  });
});

describe("playback", () => {
  it("invokes executor for each whitelisted event in order", async () => {
    const calls: string[] = [];
    const executor = {
      executeCommand: vi.fn(async (id: string) => {
        calls.push(id);
        return true;
      }),
    };
    const events: MacroEvent[] = [
      { id: "sheet.command.set-range-values", params: { a: 1 }, timestamp: 0 },
      { id: "sheet.command.set-style", params: { b: 2 }, timestamp: 1 },
    ];
    const result = await playback(events, executor);
    expect(result.ran).toBe(2);
    expect(result.skipped).toBe(0);
    expect(calls).toEqual([
      "sheet.command.set-range-values",
      "sheet.command.set-style",
    ]);
  });

  it("skips events that no longer match the whitelist (forward-compat)", async () => {
    const executor = { executeCommand: vi.fn(async () => true) };
    const events: MacroEvent[] = [
      { id: "sheet.command.set-range-values", params: {}, timestamp: 0 },
      { id: "doc.command.removed-in-future", params: {}, timestamp: 1 },
    ];
    const result = await playback(events, executor);
    expect(result.ran).toBe(1);
    expect(result.skipped).toBe(1);
    expect(executor.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("records per-event errors without aborting playback", async () => {
    const executor = {
      executeCommand: vi.fn(async (id: string) => {
        if (id === "sheet.command.set-style") throw new Error("boom");
        return true;
      }),
    };
    const events: MacroEvent[] = [
      { id: "sheet.command.set-range-values", params: {}, timestamp: 0 },
      { id: "sheet.command.set-style", params: {}, timestamp: 1 },
      { id: "sheet.command.set-range-values", params: {}, timestamp: 2 },
    ];
    const result = await playback(events, executor);
    expect(result.ran).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe("sheet.command.set-style");
  });

  it("sets state to 'playing' during replay and resets to idle after", async () => {
    let stateDuring: string | null = null;
    const executor = {
      executeCommand: vi.fn(async () => {
        stateDuring = getState();
        return true;
      }),
    };
    await playback(
      [{ id: "sheet.command.set-range-values", params: {}, timestamp: 0 }],
      executor,
    );
    expect(stateDuring).toBe("playing");
    expect(getState()).toBe("idle");
  });

  it("playback events fired during replay are NOT recorded (no feedback loop)", async () => {
    // Simulates: user has recording stopped, but a stale subscriber tries
    // to observe commands the playback itself dispatches. The recorder
    // state during playback is 'playing', not 'recording', so observeCommand
    // returns false.
    startRecording();
    stopRecording();
    const executor = {
      executeCommand: vi.fn(async (id: string, params?: unknown) => {
        // mimic Univer re-emitting the command on its own bus
        observeCommand(id, params);
        return true;
      }),
    };
    await playback(
      [{ id: "sheet.command.set-range-values", params: { v: 1 }, timestamp: 0 }],
      executor,
    );
    expect(getState()).toBe("idle");
    // Starting a fresh recording session must show zero events from the
    // previous playback.
    startRecording();
    expect(getEventCount()).toBe(0);
  });
});

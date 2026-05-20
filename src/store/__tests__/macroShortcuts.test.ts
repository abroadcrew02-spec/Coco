// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  assignShortcut,
  clearMacroBinding,
  findConflicts,
  loadBindings,
  matchShortcut,
  notifyShortcutsChanged,
  onShortcutsChanged,
  parseBindings,
  pruneBindings,
  saveBindings,
  serializeBindings,
  slotForMacro,
  slotLabel,
  type ShortcutBindings,
} from "../macroShortcuts";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // non-DOM env — ignore
  }
});

describe("slotLabel", () => {
  it("formats the chord", () => {
    expect(slotLabel(1)).toBe("Ctrl+Shift+1");
    expect(slotLabel(9)).toBe("Ctrl+Shift+9");
  });
});

describe("parse / serialize round-trip", () => {
  it("round-trips a binding map", () => {
    const bindings: ShortcutBindings = { 1: "macro-a", 5: "macro-b" };
    expect(parseBindings(serializeBindings(bindings))).toEqual(bindings);
  });

  it("tolerates null / malformed input", () => {
    expect(parseBindings(null)).toEqual({});
    expect(parseBindings("")).toEqual({});
    expect(parseBindings("not json")).toEqual({});
    expect(parseBindings("{}")).toEqual({});
    expect(parseBindings('{"bindings":"nope"}')).toEqual({});
  });

  it("drops out-of-range slots and non-string ids", () => {
    const raw = JSON.stringify({
      version: 1,
      bindings: { 1: "ok", 0: "bad-slot", 10: "bad-slot", 2: 99, 3: "" },
    });
    expect(parseBindings(raw)).toEqual({ 1: "ok" });
  });
});

describe("localStorage persistence", () => {
  it("saveBindings then loadBindings round-trips", () => {
    const bindings: ShortcutBindings = { 3: "macro-x" };
    saveBindings(bindings);
    expect(loadBindings()).toEqual(bindings);
  });

  it("loadBindings returns {} when empty", () => {
    expect(loadBindings()).toEqual({});
  });
});

describe("assignShortcut", () => {
  it("assigns a macro to a slot", () => {
    expect(assignShortcut({}, 1, "macro-a")).toEqual({ 1: "macro-a" });
  });

  it("moves a macro when re-assigned to a different slot (no duplicate)", () => {
    const start: ShortcutBindings = { 1: "macro-a" };
    const next = assignShortcut(start, 4, "macro-a");
    expect(next).toEqual({ 4: "macro-a" });
    // macro-a must NOT remain in slot 1.
    expect(slotForMacro(next, "macro-a")).toBe(4);
  });

  it("overwrites whatever macro previously held the slot", () => {
    const start: ShortcutBindings = { 2: "old-macro" };
    expect(assignShortcut(start, 2, "new-macro")).toEqual({ 2: "new-macro" });
  });

  it("clears a slot when macroId is null", () => {
    const start: ShortcutBindings = { 2: "macro-a", 5: "macro-b" };
    expect(assignShortcut(start, 2, null)).toEqual({ 5: "macro-b" });
  });

  it("does not mutate the input map", () => {
    const start: ShortcutBindings = { 1: "macro-a" };
    assignShortcut(start, 2, "macro-b");
    expect(start).toEqual({ 1: "macro-a" });
  });
});

describe("clearMacroBinding", () => {
  it("removes a macro from whatever slot holds it", () => {
    const start: ShortcutBindings = { 1: "macro-a", 3: "macro-b" };
    expect(clearMacroBinding(start, "macro-a")).toEqual({ 3: "macro-b" });
  });

  it("is a no-op when the macro is unbound", () => {
    const start: ShortcutBindings = { 1: "macro-a" };
    expect(clearMacroBinding(start, "macro-z")).toEqual({ 1: "macro-a" });
  });
});

describe("slotForMacro", () => {
  it("returns the slot or null", () => {
    const bindings: ShortcutBindings = { 7: "macro-a" };
    expect(slotForMacro(bindings, "macro-a")).toBe(7);
    expect(slotForMacro(bindings, "macro-b")).toBeNull();
  });
});

describe("findConflicts — duplicate-assignment detection", () => {
  it("returns {} for a clean binding map", () => {
    expect(findConflicts({ 1: "a", 2: "b" })).toEqual({});
  });

  it("flags a macro mapped to multiple slots", () => {
    // This shape can't be produced via assignShortcut, but a hand-edited
    // localStorage payload could; findConflicts must catch it.
    const conflicted: ShortcutBindings = { 1: "dup", 4: "dup", 6: "solo" };
    const conflicts = findConflicts(conflicted);
    expect(Object.keys(conflicts)).toEqual(["dup"]);
    expect(conflicts.dup.sort()).toEqual([1, 4]);
  });
});

describe("pruneBindings", () => {
  it("drops bindings for macros no longer present", () => {
    const bindings: ShortcutBindings = { 1: "alive", 2: "dead" };
    const pruned = pruneBindings(bindings, new Set(["alive"]));
    expect(pruned).toEqual({ 1: "alive" });
  });

  it("keeps everything when all macros exist", () => {
    const bindings: ShortcutBindings = { 1: "a", 2: "b" };
    expect(pruneBindings(bindings, new Set(["a", "b"]))).toEqual(bindings);
  });
});

describe("matchShortcut", () => {
  const bindings: ShortcutBindings = { 1: "macro-a", 9: "macro-b" };

  it("resolves Ctrl+Shift+1 to the bound macro", () => {
    expect(
      matchShortcut(
        { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "1" },
        bindings,
      ),
    ).toBe("macro-a");
  });

  it("resolves Cmd+Shift+9 (macOS) too", () => {
    expect(
      matchShortcut(
        { ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, key: "9" },
        bindings,
      ),
    ).toBe("macro-b");
  });

  it("returns null without Shift", () => {
    expect(
      matchShortcut(
        { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: "1" },
        bindings,
      ),
    ).toBeNull();
  });

  it("returns null when Alt is held", () => {
    expect(
      matchShortcut(
        { ctrlKey: true, metaKey: false, shiftKey: true, altKey: true, key: "1" },
        bindings,
      ),
    ).toBeNull();
  });

  it("returns null for an unbound slot", () => {
    expect(
      matchShortcut(
        { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "5" },
        bindings,
      ),
    ).toBeNull();
  });

  it("returns null for a non-digit key", () => {
    expect(
      matchShortcut(
        { ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "a" },
        bindings,
      ),
    ).toBeNull();
  });
});

describe("change notification", () => {
  it("onShortcutsChanged fires when notifyShortcutsChanged is called", () => {
    const fn = vi.fn();
    const unsub = onShortcutsChanged(fn);
    notifyShortcutsChanged();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    notifyShortcutsChanged();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

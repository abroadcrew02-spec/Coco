// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  eventsToDsl,
  parseDsl,
  dslToEvents,
  flattenBlocks,
  isBlockMarker,
  MACRO_BLOCK_FOR,
  MACRO_BLOCK_IF,
  MACRO_BLOCK_END,
} from "../macroDsl";
import type { MacroEvent } from "../macroRecord";

/** Strip the synthetic timestamp so round-trip comparisons ignore timing
 *  (the DSL text format carries no timestamp — that is by design). */
function normalize(events: readonly MacroEvent[]): MacroEvent[] {
  return events.map((e) => ({ ...e, timestamp: 0 }));
}

describe("eventsToDsl — keyword sugar", () => {
  it("projects set-selection { a1 } as a `range` line", () => {
    const events: MacroEvent[] = [
      { id: "sheet.command.set-selection", params: { a1: "A1:B2" }, timestamp: 0 },
    ];
    expect(eventsToDsl(events)).toBe("range A1:B2");
  });

  it("projects set-range-values { a1, value } as a `value` line", () => {
    const events: MacroEvent[] = [
      {
        id: "sheet.command.set-range-values",
        params: { a1: "A1", value: 42 },
        timestamp: 0,
      },
    ];
    expect(eventsToDsl(events)).toBe("value A1 = 42");
  });

  it("falls back to `cmd` for events without recognised sugar", () => {
    const events: MacroEvent[] = [
      { id: "sheet.command.set-style", params: { bold: true }, timestamp: 0 },
    ];
    expect(eventsToDsl(events)).toBe('cmd sheet.command.set-style {"bold":true}');
  });

  it("emits `cmd <id>` with no payload when params are undefined", () => {
    const events: MacroEvent[] = [
      { id: "sheet.command.clear-selection-all", params: undefined, timestamp: 0 },
    ];
    expect(eventsToDsl(events)).toBe("cmd sheet.command.clear-selection-all");
  });

  it("does NOT use sugar when params carry extra keys (lossless)", () => {
    // { a1, value, extra } cannot be a `value` line without losing `extra`.
    const events: MacroEvent[] = [
      {
        id: "sheet.command.set-range-values",
        params: { a1: "A1", value: 1, extra: true },
        timestamp: 0,
      },
    ];
    expect(eventsToDsl(events).startsWith("cmd ")).toBe(true);
  });
});

describe("round-trip: JSON -> DSL -> JSON", () => {
  const cases: { name: string; events: MacroEvent[] }[] = [
    {
      name: "range + value sugar",
      events: [
        { id: "sheet.command.set-selection", params: { a1: "A1" }, timestamp: 0 },
        {
          id: "sheet.command.set-range-values",
          params: { a1: "A1", value: "hello" },
          timestamp: 0,
        },
      ],
    },
    {
      name: "generic cmd with nested params",
      events: [
        {
          id: "sheet.command.set-style",
          params: { style: { bl: 1, fs: 12, cl: { rgb: "#ff0000" } } },
          timestamp: 0,
        },
      ],
    },
    {
      name: "value with object payload",
      events: [
        {
          id: "sheet.command.set-range-values",
          params: { a1: "B2", value: { v: 3, t: 2 } },
          timestamp: 0,
        },
      ],
    },
    {
      name: "value with null payload",
      events: [
        {
          id: "sheet.command.set-range-values",
          params: { a1: "C3", value: null },
          timestamp: 0,
        },
      ],
    },
    {
      name: "cmd with null params",
      events: [
        { id: "sheet.command.insert-row", params: null, timestamp: 0 },
      ],
    },
  ];

  for (const c of cases) {
    it(`preserves ${c.name}`, () => {
      const dsl = eventsToDsl(c.events);
      const back = dslToEvents(dsl);
      expect(normalize(back)).toEqual(normalize(c.events));
    });
  }

  it("round-trips a control-flow block", () => {
    const events: MacroEvent[] = [
      { id: MACRO_BLOCK_FOR, params: { count: 3 }, timestamp: 0 },
      { id: "sheet.command.set-range-values", params: { a1: "A1", value: 1 }, timestamp: 0 },
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
    ];
    const dsl = eventsToDsl(events);
    expect(dsl).toContain("for 3");
    expect(dsl).toContain("end");
    expect(normalize(dslToEvents(dsl))).toEqual(normalize(events));
  });

  it("round-trips an if block", () => {
    const events: MacroEvent[] = [
      { id: MACRO_BLOCK_IF, params: { predicate: { gt: 5 } }, timestamp: 0 },
      { id: "sheet.command.set-range-values", params: { a1: "A1", value: 9 }, timestamp: 0 },
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
    ];
    expect(normalize(dslToEvents(eventsToDsl(events)))).toEqual(normalize(events));
  });
});

describe("parseDsl — errors", () => {
  it("flags an unknown keyword", () => {
    const { errors } = parseDsl("frobnicate A1");
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(1);
    expect(errors[0].message).toContain("未知のキーワード");
  });

  it("flags a value line without '='", () => {
    const { errors } = parseDsl("value A1 42");
    expect(errors[0].message).toContain("'='");
  });

  it("flags malformed JSON", () => {
    const { errors } = parseDsl("value A1 = {not json");
    expect(errors[0].message).toContain("JSON");
  });

  it("flags an unbalanced for block", () => {
    const { errors } = parseDsl("for 2\nvalue A1 = 1");
    expect(errors.some((e) => e.message.includes("閉じられていない"))).toBe(true);
  });

  it("flags a stray end", () => {
    const { errors } = parseDsl("end");
    expect(errors[0].message).toContain("対応する");
  });

  it("flags a non-integer for count", () => {
    const { errors } = parseDsl("for abc\nend");
    expect(errors[0].message).toContain("回数");
  });

  it("ignores blank lines and # comments", () => {
    const { events, errors } = parseDsl("# a comment\n\nrange A1\n  \n# another");
    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(1);
  });
});

describe("isBlockMarker", () => {
  it("recognises the three synthetic block ids", () => {
    expect(isBlockMarker({ id: MACRO_BLOCK_FOR, params: {}, timestamp: 0 })).toBe(true);
    expect(isBlockMarker({ id: MACRO_BLOCK_IF, params: {}, timestamp: 0 })).toBe(true);
    expect(isBlockMarker({ id: MACRO_BLOCK_END, params: {}, timestamp: 0 })).toBe(true);
  });

  it("returns false for a real command", () => {
    expect(
      isBlockMarker({ id: "sheet.command.set-range-values", params: {}, timestamp: 0 }),
    ).toBe(false);
  });
});

describe("flattenBlocks", () => {
  it("expands a for loop body N times", () => {
    const inner: MacroEvent = {
      id: "sheet.command.set-range-values",
      params: { a1: "A1", value: 1 },
      timestamp: 0,
    };
    const events: MacroEvent[] = [
      { id: MACRO_BLOCK_FOR, params: { count: 3 }, timestamp: 0 },
      inner,
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
    ];
    const flat = flattenBlocks(events);
    expect(flat).toHaveLength(3);
    expect(flat.every((e) => e.id === inner.id)).toBe(true);
  });

  it("runs an if body once and strips the markers", () => {
    const events: MacroEvent[] = [
      { id: MACRO_BLOCK_IF, params: { predicate: true }, timestamp: 0 },
      { id: "sheet.command.set-style", params: {}, timestamp: 0 },
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
    ];
    const flat = flattenBlocks(events);
    expect(flat).toHaveLength(1);
    expect(flat[0].id).toBe("sheet.command.set-style");
  });

  it("handles nested for loops (multiplicative)", () => {
    const events: MacroEvent[] = [
      { id: MACRO_BLOCK_FOR, params: { count: 2 }, timestamp: 0 },
      { id: MACRO_BLOCK_FOR, params: { count: 3 }, timestamp: 0 },
      { id: "sheet.command.set-range-values", params: {}, timestamp: 0 },
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
    ];
    expect(flattenBlocks(events)).toHaveLength(6);
  });

  it("for 0 produces an empty body", () => {
    const events: MacroEvent[] = [
      { id: MACRO_BLOCK_FOR, params: { count: 0 }, timestamp: 0 },
      { id: "sheet.command.set-style", params: {}, timestamp: 0 },
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
    ];
    expect(flattenBlocks(events)).toHaveLength(0);
  });

  it("leaves a flat (no-marker) list unchanged", () => {
    const events: MacroEvent[] = [
      { id: "sheet.command.set-range-values", params: {}, timestamp: 0 },
      { id: "sheet.command.set-style", params: {}, timestamp: 0 },
    ];
    expect(flattenBlocks(events)).toEqual(events);
  });

  it("tolerates a stray end without throwing", () => {
    const events: MacroEvent[] = [
      { id: "sheet.command.set-style", params: {}, timestamp: 0 },
      { id: MACRO_BLOCK_END, params: null, timestamp: 0 },
    ];
    expect(flattenBlocks(events)).toHaveLength(1);
  });
});

describe("dslToEvents", () => {
  it("throws on a macro with parse errors", () => {
    expect(() => dslToEvents("bogus line")).toThrow(/DSL parse failed/);
  });
});

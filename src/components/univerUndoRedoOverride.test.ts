// FR-011: assert that CappedUndoRedoService keeps at most 100 undo entries
// per unit (Univer's stock cap is 20).
//
// Constructing the real service would pull in IUniverInstanceService /
// ICommandService / IContextService, all wired through redi. The cap lives
// in `pushUndoRedo`, which only touches stack state — so we instantiate the
// subclass via `Object.create` (skipping the parent constructor) and seed
// the protected/private fields by hand. That keeps the test independent of
// Univer's DI container while still exercising the real method.

import { describe, it, expect, beforeEach } from "vitest";
import type { IUndoRedoItem } from "@univerjs/core";
import {
  CappedUndoRedoService,
  UNDO_STACK_CAP,
} from "./univerUndoRedoOverride";

interface ServiceInternals {
  _undoStacks: Map<string, IUndoRedoItem[]>;
  _redoStacks: Map<string, IUndoRedoItem[]>;
  _batchingStatus: Map<string, 0 | 1>;
  _updateStatus(): void;
}

const UNIT = "test-unit";

function makeItem(i: number): IUndoRedoItem {
  return {
    unitID: UNIT,
    undoMutations: [{ id: `undo-${i}` } as unknown as IUndoRedoItem["undoMutations"][number]],
    redoMutations: [{ id: `redo-${i}` } as unknown as IUndoRedoItem["redoMutations"][number]],
  };
}

function newService(): { svc: CappedUndoRedoService; internals: ServiceInternals } {
  // Skip the LocalUndoRedoService constructor (which pulls in 3 DI deps)
  // and hand-seed the fields it would otherwise initialize. `_updateStatus`
  // is stubbed to a no-op because it normally reads from the context
  // service and broadcasts on a BehaviorSubject — both irrelevant here.
  const svc = Object.create(CappedUndoRedoService.prototype) as CappedUndoRedoService;
  const internals = svc as unknown as ServiceInternals;
  internals._undoStacks = new Map();
  internals._redoStacks = new Map();
  internals._batchingStatus = new Map();
  internals._updateStatus = () => {};
  return { svc, internals };
}

describe("CappedUndoRedoService (FR-011)", () => {
  let svc: CappedUndoRedoService;
  let internals: ServiceInternals;

  beforeEach(() => {
    ({ svc, internals } = newService());
  });

  it("exposes a cap of 100 (matches FR-011 requirements)", () => {
    expect(UNDO_STACK_CAP).toBe(100);
  });

  it("keeps the latest 100 entries when more than 100 are pushed", () => {
    for (let i = 0; i < 150; i++) svc.pushUndoRedo(makeItem(i));
    const stack = internals._undoStacks.get(UNIT)!;
    expect(stack).toHaveLength(100);
    // FIFO eviction: the oldest 50 should be gone; entries 50..149 retained.
    expect(stack[0]!.undoMutations[0]).toMatchObject({ id: "undo-50" });
    expect(stack[99]!.undoMutations[0]).toMatchObject({ id: "undo-149" });
  });

  it("retains exactly 100 entries at the cap (Univer's default 20 would fail this)", () => {
    for (let i = 0; i < 100; i++) svc.pushUndoRedo(makeItem(i));
    expect(internals._undoStacks.get(UNIT)).toHaveLength(100);
  });

  it("clears the redo stack on each push (matches stock semantics)", () => {
    internals._redoStacks.set(UNIT, [makeItem(999), makeItem(998)]);
    svc.pushUndoRedo(makeItem(0));
    expect(internals._redoStacks.get(UNIT)).toHaveLength(0);
  });

  it("retains fewer than the cap when fewer items are pushed", () => {
    for (let i = 0; i < 25; i++) svc.pushUndoRedo(makeItem(i));
    // Univer's stock 20-cap would have trimmed this to 20; ours keeps all 25.
    expect(internals._undoStacks.get(UNIT)).toHaveLength(25);
  });
});

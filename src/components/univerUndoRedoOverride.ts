// FR-011: Univer's stock LocalUndoRedoService caps the per-unit undo stack
// at 20 entries (CE = 20 in @univerjs/core), but requirements §4.1 mandate
// 100. We subclass LocalUndoRedoService and replace pushUndoRedo with a
// version that uses our higher cap while preserving batching semantics
// (the deprecated __tempBatchingUndoRedo path is used by
// @univerjs/sheets-find-replace, so we can't drop it).
//
// The override is wired into Univer through its `override` constructor
// field, which redi resolves as a DependencyOverride: replacing the binding
// for IUndoRedoService with our subclass means every consumer that injects
// the identifier picks up the bumped cap automatically.

import {
  type DependencyOverride,
  type IUndoRedoItem,
  IUndoRedoService,
  LocalUndoRedoService,
} from "@univerjs/core";

export const UNDO_STACK_CAP = 100;

// LocalUndoRedoService's `_batchingStatus` and `_tryBatchingElements` are
// declared `private` in the .d.ts, so we narrow them via a structural type
// instead of `as any` to keep the cast local and reviewable. The internal
// enum is { WAITING: 0, CREATED: 1 } — only WAITING(0) matters here, and a
// numeric literal type keeps it self-documenting.
interface LocalUndoRedoInternals {
  _undoStacks: Map<string, IUndoRedoItem[]>;
  _redoStacks: Map<string, IUndoRedoItem[]>;
  _batchingStatus: Map<string, 0 | 1>;
  _pitchUndoElement(unitId: string): IUndoRedoItem | null | undefined;
  _tryBatchingElements(target: IUndoRedoItem, incoming: IUndoRedoItem): void;
  _updateStatus(): void;
  _getUndoStack(unitId: string, createAsNeeded: true): IUndoRedoItem[];
  _getRedoStack(unitId: string, createAsNeeded: true): IUndoRedoItem[];
}

export class CappedUndoRedoService extends LocalUndoRedoService {
  pushUndoRedo(item: IUndoRedoItem): void {
    const self = this as unknown as LocalUndoRedoInternals;
    const { unitID } = item;
    const redoStack = self._getRedoStack(unitID, true);
    const undoStack = self._getUndoStack(unitID, true);

    // New action invalidates any pending redo.
    redoStack.length = 0;

    const push = (entry: IUndoRedoItem): void => {
      undoStack.push(entry);
      if (undoStack.length > UNDO_STACK_CAP) {
        undoStack.splice(0, 1);
      }
    };

    if (self._batchingStatus.has(unitID)) {
      const status = self._batchingStatus.get(unitID);
      const top = self._pitchUndoElement(unitID);
      if (status === 0 /* WAITING */ || !top) {
        push(item);
        self._batchingStatus.set(unitID, 1 /* CREATED */);
      } else {
        self._tryBatchingElements(top, item);
      }
    } else {
      push(item);
    }

    self._updateStatus();
  }
}

/**
 * DependencyOverride entries suitable for passing to `new Univer({ override })`.
 * Swaps the default LocalUndoRedoService for the capped subclass.
 */
export const undoRedoOverride: DependencyOverride = [
  [IUndoRedoService, { useClass: CappedUndoRedoService }],
];

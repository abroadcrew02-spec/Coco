import { useWorkbookStore } from "./useWorkbookStore";
import type { SaveStatus } from "../types/workbook";

/** Single source of truth for "user is trying to leave/replace the current
 *  workbook — should we warn?" Returns true to proceed, false to abort.
 *  Behavior:
 *  - On the home screen: always proceed silently.
 *  - On the editor with no unsaved changes: proceed silently.
 *  - On the editor with unsaved changes: prompt via `window.confirm`.
 *
 *  Centralized here so the three entry points (keyboard shortcuts, drag-drop,
 *  menu) share one prompt instead of drifting. The CloseConfirmDialog used at
 *  window-exit time is intentionally separate — it has three options (save /
 *  discard / cancel) where this gate has only two.
 */
export function isDirtySaveStatus(saveStatus: SaveStatus): boolean {
  return saveStatus === "unsaved" || saveStatus === "save_failed";
}

export function confirmDiscardIfUnsaved(message?: string): boolean {
  const { screen, saveStatus } = useWorkbookStore.getState();
  if (screen !== "editor") return true;
  if (!isDirtySaveStatus(saveStatus)) return true;
  return window.confirm(
    message ?? "未保存の変更があります。破棄して続行しますか？"
  );
}

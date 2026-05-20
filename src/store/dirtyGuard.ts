import { useWorkbookStore } from "./useWorkbookStore";
import { t } from "../i18n/locale";
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

/** True iff there are unsaved changes worth warning about. Considers both the
 *  current saveStatus *and* the `wasDirtyBeforeExport` carry-over, so that an
 *  export_done / export_failed transition cannot silently consume dirty state.
 */
export function isWorkbookDirty(): boolean {
  const { saveStatus, wasDirtyBeforeExport } = useWorkbookStore.getState();
  if (isDirtySaveStatus(saveStatus)) return true;
  if ((saveStatus === "export_done" || saveStatus === "export_failed") && wasDirtyBeforeExport) {
    return true;
  }
  return false;
}

export function confirmDiscardIfUnsaved(message?: string): boolean {
  const { screen } = useWorkbookStore.getState();
  if (screen !== "editor") return true;
  if (!isWorkbookDirty()) return true;
  return window.confirm(
    message ?? t("confirm.discardUnsaved.continue")
  );
}

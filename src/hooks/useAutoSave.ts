import { useEffect, useRef } from "react";
import { useWorkbookStore } from "../store/useWorkbookStore";

// req 5.4.3: auto-save within the configured interval. Interval is read from
// the store so a Settings panel change takes effect on the next tick without
// remounting consumers. Setting the interval to 0 disables auto-save entirely.
//
// Uses `autoSave` (silent) instead of `save` so unsaved workbooks fall back to
// a temp .coco rather than prompting a Save As dialog mid-edit.
export function useAutoSave() {
  const saveStatus = useWorkbookStore((s) => s.saveStatus);
  const autoSave = useWorkbookStore((s) => s.autoSave);
  const intervalMs = useWorkbookStore((s) => s.autoSaveIntervalMs);
  const dirtyRevision = useWorkbookStore((s) => s.dirtyRevision);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (saveStatus === "unsaved") {
      dirtyRef.current = true;
    } else if (saveStatus === "saved" || saveStatus === "auto_saved") {
      // Manual save (or successful prior autosave) caught up — no need to
      // re-save on the next tick. Without this reset, the autosave timer
      // would fire redundantly seconds after a manual Ctrl+S.
      dirtyRef.current = false;
    }
  }, [dirtyRevision, saveStatus]);

  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const id = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        autoSave();
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [autoSave, intervalMs]);
}

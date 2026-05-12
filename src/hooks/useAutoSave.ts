import { useEffect, useRef } from "react";
import { useWorkbookStore } from "../store/useWorkbookStore";

// Requirement 5.4.3: auto-save within 30s of edit. Uses `autoSave` (silent) instead of
// `save` to avoid prompting the user with a Save As dialog mid-edit.
export function useAutoSave(intervalMs = 30000) {
  const saveStatus = useWorkbookStore((s) => s.saveStatus);
  const autoSave = useWorkbookStore((s) => s.autoSave);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (saveStatus === "unsaved") dirtyRef.current = true;
  }, [saveStatus]);

  useEffect(() => {
    const id = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        autoSave();
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [autoSave, intervalMs]);
}

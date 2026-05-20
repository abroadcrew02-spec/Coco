import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isDirtySaveStatus, isWorkbookDirty } from "../store/dirtyGuard";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { t } from "../i18n/locale";

/** req 5.4.2: when the user attempts to close the window with an unsaved
 *  workbook, intercept and show the close-confirmation dialog instead of
 *  letting the OS terminate the process. Returns a `pendingClose` flag the
 *  App can use to render the dialog. */
type Listener = (resolve: (choice: "save" | "discard" | "cancel") => void) => void;
const closeListeners = new Set<Listener>();

export function onCloseRequest(fn: Listener): () => void {
  closeListeners.add(fn);
  return () => closeListeners.delete(fn);
}

export function useCloseGuard() {
  const saveStatus = useWorkbookStore((s) => s.saveStatus);
  const save = useWorkbookStore((s) => s.save);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        // We can't read the store via hooks inside the closure (it captures
        // the saveStatus from when the listener was registered). Use getState.
        // `isWorkbookDirty` also considers wasDirtyBeforeExport so an
        // export_done transition doesn't smuggle dirty state past the guard.
        if (!isWorkbookDirty()) return; // allow normal close

        event.preventDefault();
        const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
          if (closeListeners.size === 0) {
            // No dialog mounted — fail-safe: ask the user via window.confirm.
            const ok = window.confirm(
              t("confirm.discardUnsaved.exit")
            );
            resolve(ok ? "discard" : "cancel");
            return;
          }
          closeListeners.forEach((fn) => fn(resolve));
        });

        if (choice === "cancel") return;

        if (choice === "save") {
          await save();
          // If save failed (e.g. user cancelled Save As dialog), stay open.
          const status = useWorkbookStore.getState().saveStatus;
          if (isDirtySaveStatus(status)) return;
        }
        await getCurrentWindow().destroy();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // saveStatus is intentionally not a dep — we always read via getState
  }, [save, saveStatus]);
}

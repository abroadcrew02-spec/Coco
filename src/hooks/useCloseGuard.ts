import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkbookStore } from "../store/useWorkbookStore";

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
        const dirty = useWorkbookStore.getState().saveStatus === "unsaved";
        if (!dirty) return; // allow normal close

        event.preventDefault();
        const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
          if (closeListeners.size === 0) {
            // No dialog mounted — fail-safe: ask the user via window.confirm.
            const ok = window.confirm(
              "未保存の変更があります。破棄して終了しますか？"
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
          if (status === "save_failed" || status === "unsaved") return;
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

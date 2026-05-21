import { useEffect } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { confirmDiscardIfUnsaved } from "../store/dirtyGuard";
import { routeOpenPath } from "../store/pathRouter";
import { loadBindings, matchShortcut } from "../store/macroShortcuts";

/** Module-level emitter for non-store UI events (e.g. help dialog). Keeps the
 *  store free of pure-UI flags. App-level listeners subscribe. */
type Listener = () => void;
const helpListeners = new Set<Listener>();
const settingsListeners = new Set<Listener>();

/** #186 — emitter for "play macro <id>" requests fired by a global shortcut.
 *  EditorScreen (which owns the Univer executor) subscribes and runs playback;
 *  this hook lives at App level and has no engine handle of its own. */
type MacroListener = (macroId: string) => void;
const macroPlayListeners = new Set<MacroListener>();

export function onHelpRequested(fn: Listener): () => void {
  helpListeners.add(fn);
  return () => helpListeners.delete(fn);
}

export function onSettingsRequested(fn: Listener): () => void {
  settingsListeners.add(fn);
  return () => settingsListeners.delete(fn);
}

/** Subscribe to macro-playback requests from global shortcuts. */
export function onMacroPlayRequested(fn: MacroListener): () => void {
  macroPlayListeners.add(fn);
  return () => macroPlayListeners.delete(fn);
}

export function requestSettings() {
  settingsListeners.forEach((fn) => fn());
}

export function requestHelp() {
  helpListeners.forEach((fn) => fn());
}

// Global keyboard shortcuts active on every screen.
// - Ctrl/Cmd+N: new workbook
// - Ctrl/Cmd+O: open file dialog
//
// Discard-confirmation for unsaved edits is delegated to
// `confirmDiscardIfUnsaved` so the three entry points (this hook, useFileDrop,
// useMenuActions) all share one prompt and stay aligned.
export function useGlobalShortcuts() {
  const newWorkbook = useWorkbookStore((s) => s.newWorkbook);
  const openCoco = useWorkbookStore((s) => s.openCoco);
  const importXlsx = useWorkbookStore((s) => s.importXlsx);
  const importCsv = useWorkbookStore((s) => s.importCsv);
  const cocoUndo = useWorkbookStore((s) => s.cocoUndo);
  const cocoRedo = useWorkbookStore((s) => s.cocoRedo);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      // F1 = help — handled regardless of modifiers.
      if (e.key === "F1") {
        e.preventDefault();
        helpListeners.forEach((fn) => fn());
        return;
      }

      // #97: Ctrl/Cmd+Alt+Z / Ctrl/Cmd+Alt+Shift+Z = Coco snapshot undo/redo.
      // Sits next to (not on top of) Univer's native Ctrl+Z, which still owns
      // cell-typing undo. This pair rolls back apply-style mutations (AutoSum,
      // format painter, hyperlink, CF, DV, chart, image, comment) that
      // bypass Univer's commandService.
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          cocoRedo();
        } else {
          cocoUndo();
        }
        return;
      }

      // #186 — Ctrl/Cmd+Shift+1..9 plays the macro bound to that slot. Checked
      // before the `!shiftKey` gate below because this chord deliberately uses
      // Shift. Bindings are re-read from localStorage on each press (cheap), so
      // a fresh assignment from MacroDialog takes effect immediately.
      const boundMacroId = matchShortcut(e, loadBindings());
      if (boundMacroId !== null) {
        e.preventDefault();
        macroPlayListeners.forEach((fn) => fn(boundMacroId));
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return;

      // Ctrl/Cmd+, opens Settings (macOS convention extended cross-platform).
      // Univer doesn't claim this combo, so it's safe on the editor too.
      if (e.key === ",") {
        e.preventDefault();
        settingsListeners.forEach((fn) => fn());
        return;
      }
      // Ctrl/Cmd+/ opens Help — easier than F1 on laptops that overlay F-keys.
      if (e.key === "/") {
        e.preventDefault();
        helpListeners.forEach((fn) => fn());
        return;
      }

      const key = e.key.toLowerCase();

      if (key === "n") {
        e.preventDefault();
        if (!confirmDiscardIfUnsaved()) return;
        await newWorkbook();
      } else if (key === "o") {
        e.preventDefault();
        if (!confirmDiscardIfUnsaved()) return;
        const selected = await openFileDialog({
          multiple: false,
          filters: [
            { name: "Excel / CSV / TSV", extensions: ["xlsx", "xlsm", "csv", "tsv"] },
            { name: "Excel Files", extensions: ["xlsx", "xlsm"] },
            { name: "CSV / TSV Files", extensions: ["csv", "tsv"] },
          ],
        });
        if (!selected) return;
        const path = typeof selected === "string" ? selected : selected[0];
        const route = routeOpenPath(path);
        if (route.kind === "coco") await openCoco(route.path);
        else if (route.kind === "csv") await importCsv(route.path);
        else if (route.kind === "xlsx") await importXlsx(route.path);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newWorkbook, openCoco, importXlsx, importCsv, cocoUndo, cocoRedo]);
}

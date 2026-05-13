import { useEffect } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { confirmDiscardIfUnsaved } from "../store/dirtyGuard";
import { routeOpenPath } from "../store/pathRouter";
import { requestHelp, requestSettings } from "./useGlobalShortcuts";

// req 7.2: native menu bar emits "menu-action" events with the item id. Route
// them to the existing store actions / module emitters here so the menu and
// keyboard shortcuts share one implementation surface.
export function useMenuActions() {
  const newWorkbook = useWorkbookStore((s) => s.newWorkbook);
  const openCoco = useWorkbookStore((s) => s.openCoco);
  const importXlsx = useWorkbookStore((s) => s.importXlsx);
  const importCsv = useWorkbookStore((s) => s.importCsv);
  const save = useWorkbookStore((s) => s.save);
  const promptSaveAs = useWorkbookStore((s) => s.promptSaveAs);
  const exportXlsx = useWorkbookStore((s) => s.exportXlsx);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const handleOpen = async () => {
      if (!confirmDiscardIfUnsaved()) return;
      const selected = await openFileDialog({
        multiple: false,
        filters: [
          { name: "Excel / Coco / CSV / TSV", extensions: ["xlsx", "xlsm", "coco", "csv", "tsv"] },
          { name: "Excel Files", extensions: ["xlsx", "xlsm"] },
          { name: "Coco Files", extensions: ["coco"] },
          { name: "CSV / TSV Files", extensions: ["csv", "tsv"] },
        ],
      });
      if (!selected) return;
      const path = typeof selected === "string" ? selected : selected[0];
      const route = routeOpenPath(path);
      if (route.kind === "coco") await openCoco(route.path);
      else if (route.kind === "csv") await importCsv(route.path);
      else if (route.kind === "xlsx") await importXlsx(route.path);
    };

    const handleCsvExport = async () => {
      // CSV export needs a sheet picker; the EditorScreen owns that flow.
      // Bounce via a window event so EditorScreen can react.
      window.dispatchEvent(new CustomEvent("coco:menu-csv-export"));
    };

    const dispatch = async (id: string) => {
      switch (id) {
        case "new":
          if (!confirmDiscardIfUnsaved()) return;
          await newWorkbook();
          break;
        case "open":
          await handleOpen();
          break;
        case "save":
          await save();
          break;
        case "save-as":
          await promptSaveAs();
          break;
        case "export-xlsx":
          await exportXlsx();
          break;
        case "export-csv":
          await handleCsvExport();
          break;
        case "settings":
          requestSettings();
          break;
        case "help":
          requestHelp();
          break;
        case "close":
          // Triggers onCloseRequested which our close-guard intercepts.
          await getCurrentWindow().close();
          break;
      }
    };

    getCurrentWindow()
      .listen<string>("menu-action", (event) => {
        if (cancelled) return;
        void dispatch(event.payload);
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
  }, [newWorkbook, openCoco, importXlsx, importCsv, save, promptSaveAs, exportXlsx]);
}

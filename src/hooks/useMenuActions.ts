import { useEffect } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { confirmDiscardIfUnsaved } from "../store/dirtyGuard";
import { routeOpenPath } from "../store/pathRouter";
import { requestHelp, requestSettings } from "./useGlobalShortcuts";

const EDITOR_COMMAND_IDS = new Set([
  "edit-command-palette",
  "view-snapshots",
  "insert-hyperlink",
  "insert-comment",
  "insert-chart",
  "insert-image",
  "insert-table",
  "insert-sparkline",
  "format-number",
  "format-currency",
  "format-percent",
  "format-conditional",
  "format-cell-styles",
  "format-painter",
  "format-tab-color",
  "data-sort",
  "data-validation",
  "data-named-ranges",
  "data-autosum",
  "data-outline-groups",
  "tools-sheet-protection",
  "tools-goal-seek",
  "tools-error-checking",
  "file-page-setup",
  "view-tables-panel",
  "view-sparklines-panel",
  "view-errors-panel",
  "view-show-formulas",
]);

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
  const exportHtml = useWorkbookStore((s) => s.exportHtml);
  const exportPdf = useWorkbookStore((s) => s.exportPdf);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const handleOpen = async () => {
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
    };

    const handleCsvExport = async () => {
      // CSV export needs a sheet picker; the EditorScreen owns that flow.
      // Bounce via a window event so EditorScreen can react.
      window.dispatchEvent(new CustomEvent("coco:menu-csv-export"));
    };

    const dispatch = async (id: string) => {
      if (EDITOR_COMMAND_IDS.has(id)) {
        window.dispatchEvent(new CustomEvent("coco:editor-command", { detail: id }));
        return;
      }

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
        case "export-html":
          await exportHtml();
          break;
        case "export-pdf":
          await exportPdf();
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
  }, [newWorkbook, openCoco, importXlsx, importCsv, save, promptSaveAs, exportXlsx, exportHtml, exportPdf]);
}

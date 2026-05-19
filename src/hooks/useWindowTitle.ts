import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { isDirtySaveStatus } from "../store/dirtyGuard";

// Mirror the current workbook + dirty state into the OS window title.
// Matches Excel-style "AppName — filename •" convention.
export function useWindowTitle() {
  const screen = useWorkbookStore((s) => s.screen);
  const currentHandle = useWorkbookStore((s) => s.currentHandle);
  const saveStatus = useWorkbookStore((s) => s.saveStatus);
  const wasDirtyBeforeExport = useWorkbookStore((s) => s.wasDirtyBeforeExport);

  useEffect(() => {
    const fileName = currentHandle?.path
      ? currentHandle.path.split(/[\\/]/).pop() ?? "Untitled"
      : screen === "editor"
      ? "Untitled"
      : null;
    // #76: mirror the close-guard's notion of dirty. Otherwise save_failed
    // and dirty-after-export states look clean in the title bar even though
    // closeGuard prompts for them.
    const dirty =
      isDirtySaveStatus(saveStatus) ||
      ((saveStatus === "export_done" || saveStatus === "export_failed") && wasDirtyBeforeExport);
    const title =
      fileName === null
        ? "Coco"
        : dirty
        ? `Coco — ${fileName} •`
        : `Coco — ${fileName}`;
    // setTitle is async but we don't await — failures (missing permission, etc.)
    // are non-critical and shouldn't block the UI.
    getCurrentWindow()
      .setTitle(title)
      .catch(() => undefined);
  }, [screen, currentHandle, saveStatus, wasDirtyBeforeExport]);
}

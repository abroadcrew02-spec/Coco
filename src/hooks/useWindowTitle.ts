import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkbookStore } from "../store/useWorkbookStore";

// Mirror the current workbook + dirty state into the OS window title.
// Matches Excel-style "AppName — filename •" convention.
export function useWindowTitle() {
  const screen = useWorkbookStore((s) => s.screen);
  const currentHandle = useWorkbookStore((s) => s.currentHandle);
  const saveStatus = useWorkbookStore((s) => s.saveStatus);

  useEffect(() => {
    const fileName = currentHandle?.path
      ? currentHandle.path.split(/[\\/]/).pop() ?? "Untitled"
      : screen === "editor"
      ? "Untitled"
      : null;
    const dirty = saveStatus === "unsaved";
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
  }, [screen, currentHandle, saveStatus]);
}

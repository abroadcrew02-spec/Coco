import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkbookStore } from "../store/useWorkbookStore";
import { confirmDiscardIfUnsaved } from "../store/dirtyGuard";
import { routeOpenPath } from "../store/pathRouter";

// Drag-and-drop file open. Excel parity. Drops outside the editor (e.g. on the
// home screen) open just the same way as clicking "ファイルを開く".
// Multiple files dropped at once: take the first one and ignore the rest.
//
// Returns whether a drag is currently hovering the window so the App can render
// an overlay.
export function useFileDrop(): { isHovering: boolean } {
  const openCoco = useWorkbookStore((s) => s.openCoco);
  const importXlsx = useWorkbookStore((s) => s.importXlsx);
  const importCsv = useWorkbookStore((s) => s.importCsv);

  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const dispatch = async (path: string) => {
      // #78: ignore the drop while any modal dialog is mounted — otherwise
      // the file replaces the workbook while a (now-stale) dialog stays
      // floating over the new editor, hiding the just-loaded grid and
      // discarding any dialog-local edits the user was making.
      if (document.querySelector('[role="dialog"], .modal-backdrop, .snapshot-backdrop, .close-confirm-backdrop, .iimg-backdrop, .help-backdrop')) {
        useWorkbookStore.setState({
          lastError: "別のダイアログが開いています。閉じてからファイルをドロップしてください。",
        });
        return;
      }
      const route = routeOpenPath(path);
      if (route.kind === "unsupported") {
        // Show a short hint instead of silently swallowing the drop — without
        // it the user can't tell whether the app received the file at all.
        const ext = route.extension ?? "（拡張子なし）";
        useWorkbookStore.setState({
          lastError: `対応していない形式です（${ext}）。.xlsx / .xlsm / .csv のみ受け付けます。`,
        });
        return;
      }
      if (
        !confirmDiscardIfUnsaved(
          "未保存の変更があります。破棄してドロップしたファイルを開きますか？"
        )
      ) {
        return;
      }
      if (route.kind === "coco") await openCoco(route.path);
      else if (route.kind === "csv") await importCsv(route.path);
      else if (route.kind === "xlsx") await importXlsx(route.path);
    };

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setIsHovering(true);
        } else if (payload.type === "leave") {
          setIsHovering(false);
        } else if (payload.type === "drop") {
          setIsHovering(false);
          const path = payload.paths[0];
          if (!path) return;
          void dispatch(path);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [openCoco, importXlsx, importCsv]);

  return { isHovering };
}

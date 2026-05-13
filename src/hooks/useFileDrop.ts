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
      const route = routeOpenPath(path);
      if (route.kind === "unsupported") return; // silently ignore (e.g. .png drop)
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

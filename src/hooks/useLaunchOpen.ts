import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getOpenSeq, useWorkbookStore } from "../store/useWorkbookStore";
import { routeOpenPath } from "../store/pathRouter";

// Opens the file named on this process's command line (Explorer "Open with"
// runs `"<exe>" "%1"`). The Rust side hands the path over exactly once per
// process; this module opens it through the same store actions as Ctrl+O.

let startPromise: Promise<void> | null = null;

/** Opens one path through the same store actions as Ctrl+O, but only while the
 *  user has not started opening anything since startup (`seqAtStart` is the
 *  store's open counter taken before the first await) and the home screen is
 *  idle. The counter also moves on "new workbook" and template / JSON imports,
 *  which do not set `saveStatus: "loading"`; without it a late-arriving launch
 *  file would replace a workbook the user has just started, or be written over
 *  by the caller's follow-up `updateSnapshot`. */
export async function openLaunchedPath(path: string, seqAtStart: number): Promise<void> {
  const { screen, blockingImport } = useWorkbookStore.getState();
  if (getOpenSeq() !== seqAtStart || screen !== "home" || blockingImport !== null) {
    console.warn("[launch] skipped: another workbook is being opened");
    return;
  }
  const route = routeOpenPath(path);
  const store = useWorkbookStore.getState();
  switch (route.kind) {
    case "coco":
      await store.openNicel(route.path);
      return;
    case "csv":
      await store.importCsv(route.path);
      return;
    case "xlsx":
      await store.importXlsx(route.path);
      return;
    case "unsupported":
      // Not an error: an unsupported file just leaves the home screen as is.
      return;
    default: {
      const exhaustive: never = route;
      void exhaustive;
    }
  }
}

/** Reads the launch file and opens it. Runs once per JS context; later calls
 *  return the first call's promise (React StrictMode runs effects twice in
 *  development). */
export function startLaunchOpen(): Promise<void> {
  if (startPromise) return startPromise;
  // Taken before any await: anything the user opens after this point wins.
  const seqAtStart = getOpenSeq();
  startPromise = (async () => {
    try {
      // The CSV encoding and PoC-warning settings must be loaded before an
      // import starts, or importCsv runs with the default "auto" encoding.
      const s = useWorkbookStore.getState();
      await Promise.allSettled([s.loadCsvImportEncoding(), s.loadSuppressCsvPocWarning()]);
      let paths: string[];
      try {
        paths = await invoke<string[]>("take_launch_paths");
      } catch (e) {
        console.warn("[launch] take_launch_paths failed", e);
        return;
      }
      if (!Array.isArray(paths) || paths.length === 0) return;
      // Only the first file; the rest are dropped.
      await openLaunchedPath(paths[0], seqAtStart);
    } catch (e) {
      console.warn("[launch] could not open the launch file", e);
    }
  })();
  return startPromise;
}

export function useLaunchOpen(): void {
  useEffect(() => {
    void startLaunchOpen();
  }, []);
}

/** Test only. */
export function __resetLaunchOpenForTests(): void {
  startPromise = null;
}

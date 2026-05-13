import { useEffect } from "react";

// Once Home has painted and the main thread is idle, fire the dynamic import
// for EditorScreen so that Univer is already parsed by the time the user
// clicks "新規ワークブック" or a recent file. The lazy() chunk is cached after
// first fetch — this is a free latency win.
//
// Mount on HomeScreen only (it remounts when user goes back to home, but the
// import promise is memoized by Vite so subsequent calls are no-ops).
export function useEditorPreload() {
  useEffect(() => {
    type IdleCallback = (cb: () => void) => number | undefined;
    type CancelIdleCallback = (h: number) => void;
    const w = window as unknown as {
      requestIdleCallback?: IdleCallback;
      cancelIdleCallback?: CancelIdleCallback;
    };

    let cancelled = false;
    const fire = () => {
      if (cancelled) return;
      // Discard the promise — we just want the module evaluated.
      void import("../components/EditorScreen");
    };

    const handle = w.requestIdleCallback?.(fire);
    // Safety net: even without rIC support, fire after a short delay.
    const fallback = window.setTimeout(fire, 800);

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      if (handle !== undefined) w.cancelIdleCallback?.(handle);
    };
  }, []);
}

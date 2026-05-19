// Thin wrapper around `@tauri-apps/plugin-updater` (and a small slice of
// `@tauri-apps/plugin-process` for relaunch). This module is the single
// source of truth for our auto-update state machine and the
// localStorage-backed user preferences that drive it.
//
// Snapshot shape:
//   localStorage["coco.updater.checkOnLaunch"] = "true" | "false"
//     - default ON; explicit "false" disables the launch-time check
//   localStorage["coco.updater.skipVersion"]    = "<version string>" | absent
//     - if equal to the latest version returned by check(), the launcher
//       suppresses the dialog (the user can still trigger Help → Check for
//       Updates manually)
//   localStorage["coco.updater.lastChecked"]    = ISO-8601 timestamp | absent
//     - written on every successful check() to support a "last checked at"
//       display in Settings
//
// All localStorage access is wrapped in try/catch because the renderer may
// run with storage disabled (private mode, sandboxed iframe in tests, etc.).
//
// Tauri-plugin imports are deferred to call-time so that unit tests and
// type-checking can import this module without the Tauri runtime shim.

export type UpdaterCheckResult =
  | { available: false }
  | {
      available: true;
      version: string;
      currentVersion: string;
      notes: string;
      pubDate: string | null;
    };

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "available";
      version: string;
      currentVersion: string;
      notes: string;
      pubDate: string | null;
    }
  | {
      kind: "downloading";
      version: string;
      progress: number /* 0..1 */;
      downloaded: number;
      total: number | null;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

export const SKIP_VERSION_KEY = "coco.updater.skipVersion";
export const CHECK_ON_LAUNCH_KEY = "coco.updater.checkOnLaunch";
export const LAST_CHECKED_KEY = "coco.updater.lastChecked";

// ---------------------------------------------------------------------------
// localStorage helpers — sync, defensive (try/catch around every access).
// ---------------------------------------------------------------------------

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* swallow — private mode, quota, etc. */
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* swallow */
  }
}

/** Whether the launcher should check for updates at startup. Default ON. */
export function isAutoCheckEnabled(): boolean {
  return safeGet(CHECK_ON_LAUNCH_KEY) !== "false";
}

export function setAutoCheckEnabled(v: boolean): void {
  safeSet(CHECK_ON_LAUNCH_KEY, v ? "true" : "false");
}

export function getSkippedVersion(): string | null {
  return safeGet(SKIP_VERSION_KEY);
}

export function skipVersion(v: string): void {
  safeSet(SKIP_VERSION_KEY, v);
}

export function clearSkippedVersion(): void {
  safeRemove(SKIP_VERSION_KEY);
}

export function getLastCheckedAt(): string | null {
  return safeGet(LAST_CHECKED_KEY);
}

export function markCheckedNow(): void {
  safeSet(LAST_CHECKED_KEY, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Tauri-plugin wrappers — lazy-imported so this file is safe to import in
// node-side test runners and to type-check before the plugin is installed.
// ---------------------------------------------------------------------------

// Minimal shapes we need from the plugin so callers don't need to import its
// types. We rely on duck typing rather than `import type` so tsc does not
// require the package to be present at compile time.
interface UpdateHandleLike {
  version: string;
  currentVersion: string;
  body?: string | null;
  date?: string | null;
  downloadAndInstall: (
    onEvent: (event: DownloadEvent) => void,
  ) => Promise<void>;
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

// Cache the last positive check() so downloadAndInstall() can reuse it
// without a second network round-trip. Cleared when the user dismisses or
// when a fresh check() runs.
let cachedUpdate: UpdateHandleLike | null = null;

/**
 * Probe GitHub Releases (via the configured updater endpoint) for a newer
 * version. On success records `lastChecked`. Caches the resulting Update
 * handle so the subsequent `downloadAndInstall()` call can reuse it.
 *
 * Throws on network failure, malformed manifest, or signature errors — the
 * caller is responsible for surfacing the message to the user.
 */
export async function checkForUpdate(): Promise<UpdaterCheckResult> {
  const mod = await import("@tauri-apps/plugin-updater");
  // The plugin exposes a free function `check()` that returns Update | null.
  const update = (await mod.check()) as unknown as UpdateHandleLike | null;
  markCheckedNow();
  if (!update) {
    cachedUpdate = null;
    return { available: false };
  }
  cachedUpdate = update;
  return {
    available: true,
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? "",
    pubDate: update.date ?? null,
  };
}

/**
 * Download and stage the cached update. If no check() has run in this
 * session (or the cache was invalidated) we re-probe before installing.
 *
 * Progress callback fires repeatedly while bytes stream in; `total` is
 * `null` if the server omitted Content-Length.
 */
export async function downloadAndInstall(
  onProgress: (state: { downloaded: number; total: number | null }) => void,
): Promise<void> {
  let update = cachedUpdate;
  if (!update) {
    const mod = await import("@tauri-apps/plugin-updater");
    update = (await mod.check()) as unknown as UpdateHandleLike | null;
    if (!update) {
      throw new Error("No update available to install.");
    }
    cachedUpdate = update;
  }

  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total =
          typeof event.data.contentLength === "number"
            ? event.data.contentLength
            : null;
        onProgress({ downloaded, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
        break;
      case "Finished":
        onProgress({ downloaded, total });
        break;
    }
  });
}

/** Restart the application after a staged install. */
export async function relaunchApp(): Promise<void> {
  const mod = await import("@tauri-apps/plugin-process");
  await mod.relaunch();
}

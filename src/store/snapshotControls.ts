// Pure helpers for the explicit "Snapshot Schedule" / "Force Snapshot" UI.
//
// The canonical autosave interval lives in the workbook store
// (`autoSaveIntervalMs`, persisted via the Tauri `set_setting` backend at key
// `coco.autoSaveMs`). This module provides a *parallel*, lightweight,
// localStorage-backed accessor expressed in the discrete "user-friendly"
// buckets the new SnapshotControlsDialog exposes (15s / 30s / 1m / 5m /
// disabled), so the dialog can read and write a setting without taking a
// dependency on the store layer or the Tauri runtime.
//
// Why a separate accessor:
// - The Settings dialog already owns the canonical numeric interval and
//   persists it through the backend setting store.
// - The new "Snapshot Now / Schedule" surface wants a tiny, side-effect-free
//   read/write that pure unit tests can hit without mocking Tauri.
// - The two surfaces are kept in sync by callers (the dialog, when wired in
//   by EditorScreen, mirrors the chosen interval into the workbook store).
//
// All functions are SSR / non-browser safe — they no-op if `localStorage` is
// not available so they remain importable from environments without a DOM
// (vitest jsdom is fine; pure Node would also be fine).

export type SnapshotIntervalSetting = 15 | 30 | 60 | 300 | "disabled";

export const LOCAL_STORAGE_KEY = "coco.autoSaveInterval";

export const SNAPSHOT_INTERVAL_OPTIONS: readonly SnapshotIntervalSetting[] = [
  15,
  30,
  60,
  300,
  "disabled",
] as const;

const DEFAULT_INTERVAL: SnapshotIntervalSetting = 30;

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function parseStored(raw: string | null): SnapshotIntervalSetting | null {
  if (raw === null) return null;
  if (raw === "disabled") return "disabled";
  const n = Number.parseInt(raw, 10);
  if (n === 15 || n === 30 || n === 60 || n === 300) return n;
  return null;
}

/**
 * Read the currently persisted snapshot interval bucket. Falls back to the
 * default (30s) when nothing is persisted or the stored value is malformed.
 * Never throws — a thrown SecurityError from `localStorage` access is
 * treated as "no persisted value".
 */
export function getAutoSaveInterval(): SnapshotIntervalSetting {
  if (!hasLocalStorage()) return DEFAULT_INTERVAL;
  try {
    const parsed = parseStored(window.localStorage.getItem(LOCAL_STORAGE_KEY));
    return parsed ?? DEFAULT_INTERVAL;
  } catch {
    return DEFAULT_INTERVAL;
  }
}

/**
 * Persist a new snapshot interval bucket. Rejects values outside the
 * supported set (defensive: TS strict already constrains the type, but JS
 * callers / runtime data could pass anything). Silently no-ops if
 * localStorage is unavailable so call sites don't need to guard.
 */
export function setAutoSaveInterval(interval: SnapshotIntervalSetting): void {
  if (
    interval !== "disabled" &&
    interval !== 15 &&
    interval !== 30 &&
    interval !== 60 &&
    interval !== 300
  ) {
    return;
  }
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, String(interval));
  } catch {
    // Quota / private-mode failure — interval stays in memory only on the
    // caller side. Non-critical.
  }
}

/**
 * Convert a bucket to milliseconds for use with `setInterval` / store
 * sync. Returns 0 for "disabled" so callers can do
 * `if (ms > 0) setInterval(...)`.
 */
export function snapshotIntervalToMs(interval: SnapshotIntervalSetting): number {
  if (interval === "disabled") return 0;
  return interval * 1000;
}

/**
 * Human-readable Japanese label for a given bucket — used by the dialog
 * radio list. Kept here so unit tests can lock the formatting.
 */
export function snapshotIntervalLabelJa(interval: SnapshotIntervalSetting): string {
  switch (interval) {
    case 15:
      return "15秒";
    case 30:
      return "30秒";
    case 60:
      return "1分";
    case 300:
      return "5分";
    case "disabled":
      return "無効";
  }
}

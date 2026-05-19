// Calculation-mode helpers for Excel-style "Calculation Options" (auto /
// auto-except-tables / manual). MVP scope: persist the selected mode in
// localStorage so the status-bar indicator and the dialog stay in sync across
// reloads. The actual suppression of Univer's automatic recalc when the user
// picks "manual" — and the F9 / Shift+F9 force-recalc hook — live in the
// integrator (EditorScreen + useMenuActions) and are documented as TODOs
// against Univer 0.5.x's formula-engine internals.
//
// Pure / framework-free so the file is trivially testable without Univer.

export type CalcMode = "auto" | "autoNoTables" | "manual";

export const LOCAL_STORAGE_KEY = "coco.calcMode";

const DEFAULT_MODE: CalcMode = "auto";

const VALID_MODES: ReadonlySet<CalcMode> = new Set<CalcMode>([
  "auto",
  "autoNoTables",
  "manual",
]);

/** Read the persisted calc mode; falls back to "auto" on missing / malformed
 *  values or when localStorage is unavailable (e.g. SSR, private mode). */
export function getCalcMode(): CalcMode {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw && VALID_MODES.has(raw as CalcMode)) {
      return raw as CalcMode;
    }
  } catch {
    // ignore — fall through to default
  }
  return DEFAULT_MODE;
}

/** Persist the calc mode. Silently no-ops when storage is unavailable. */
export function setCalcMode(mode: CalcMode): void {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, mode);
  } catch {
    // ignore — read path falls back to default
  }
}

/** Human-readable labels for each mode, ja / en. Used by the dialog radio
 *  group and the status-bar indicator badge. */
export const CALC_MODE_LABELS: Record<CalcMode, { ja: string; en: string }> = {
  auto: {
    ja: "自動",
    en: "Automatic",
  },
  autoNoTables: {
    ja: "データ テーブル以外自動",
    en: "Automatic except for data tables",
  },
  manual: {
    ja: "手動",
    en: "Manual",
  },
};

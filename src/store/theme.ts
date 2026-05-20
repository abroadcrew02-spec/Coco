// Theme helpers for the light / dark / system color scheme (issue #191).
//
// MVP scope: persist the user's chosen mode in localStorage and resolve it to
// an "effective" theme (light or dark) — `system` defers to the OS via
// `prefers-color-scheme`. The resolved theme is applied to the document by
// setting a `data-theme` attribute on <html>, which the CSS token layer
// (src/styles/theme.css) keys off of.
//
// Pure / framework-free so the file is trivially testable without React or a
// DOM-heavy harness. The matchMedia-dependent functions degrade gracefully
// when `window` / `matchMedia` are unavailable (SSR, sandboxed contexts).

export type ThemeMode = "light" | "dark" | "system";

/** The concrete theme actually rendered — `system` is always resolved away. */
export type EffectiveTheme = "light" | "dark";

export const LOCAL_STORAGE_KEY = "coco.theme";

const DEFAULT_MODE: ThemeMode = "system";

const VALID_MODES: ReadonlySet<ThemeMode> = new Set<ThemeMode>([
  "light",
  "dark",
  "system",
]);

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** Type guard for an unknown value being a valid `ThemeMode`. */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && VALID_MODES.has(value as ThemeMode);
}

/** Read the persisted theme mode; falls back to "system" on missing /
 *  malformed values or when localStorage is unavailable. */
export function getThemeMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (isThemeMode(raw)) {
      return raw;
    }
  } catch {
    // ignore — fall through to default
  }
  return DEFAULT_MODE;
}

/** Persist the theme mode. Silently no-ops when storage is unavailable. */
export function setThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, mode);
  } catch {
    // ignore — read path falls back to default
  }
}

/** True when the OS currently prefers a dark color scheme. Defaults to
 *  `false` when `matchMedia` is unavailable. */
export function prefersDark(): boolean {
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

/** Resolve a `ThemeMode` to the concrete theme to render. `system` is
 *  resolved against the OS preference; an explicit mode is returned as-is. */
export function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === "system") {
    return prefersDark() ? "dark" : "light";
  }
  return mode;
}

/** Convenience: resolve the currently persisted mode to an effective theme. */
export function getEffectiveTheme(): EffectiveTheme {
  return resolveEffectiveTheme(getThemeMode());
}

/** Apply an effective theme to the document by setting `data-theme` on the
 *  root <html> element. The CSS token layer keys off this attribute.
 *  No-ops when there is no document (non-browser context). */
export function applyTheme(theme: EffectiveTheme): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  document.documentElement.setAttribute("data-theme", theme);
}

/** Resolve the persisted mode and apply it to the document in one call.
 *  Returns the effective theme that was applied. */
export function applyThemeMode(mode: ThemeMode): EffectiveTheme {
  const effective = resolveEffectiveTheme(mode);
  applyTheme(effective);
  return effective;
}

/** Subscribe to OS color-scheme changes. The listener is invoked with the new
 *  effective theme whenever `prefers-color-scheme` flips. Returns an
 *  unsubscribe function. No-ops (returns a noop cleanup) when `matchMedia` is
 *  unavailable. Callers should only subscribe while the mode is "system".  */
export function subscribeSystemTheme(
  listener: (theme: EffectiveTheme) => void,
): () => void {
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(DARK_MEDIA_QUERY);
  } catch {
    return () => {};
  }
  const handler = (e: MediaQueryListEvent) => {
    listener(e.matches ? "dark" : "light");
  };
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}

/** Event name dispatched on `window` when the theme mode is changed (e.g. via
 *  the Settings dialog) so listeners can re-apply without a shared store. */
export const THEME_CHANGED_EVENT = "coco:theme-changed";

/** Notify listeners that the persisted theme mode has changed. The caller is
 *  expected to have already called `setThemeMode`. */
export function notifyThemeChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
}

/** Subscribe to theme-mode changes dispatched via `notifyThemeChanged`.
 *  Returns an unsubscribe function. */
export function onThemeChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(THEME_CHANGED_EVENT, listener);
  return () => window.removeEventListener(THEME_CHANGED_EVENT, listener);
}

/** Human-readable labels for each mode, ja / en. Used by the Settings
 *  dialog radio group. */
export const THEME_MODE_LABELS: Record<ThemeMode, { ja: string; en: string }> = {
  light: {
    ja: "ライト",
    en: "Light",
  },
  dark: {
    ja: "ダーク",
    en: "Dark",
  },
  system: {
    ja: "システム設定に従う",
    en: "Match system",
  },
};

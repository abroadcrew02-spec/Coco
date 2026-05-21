// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LOCAL_STORAGE_KEY,
  isThemeMode,
  getThemeMode,
  setThemeMode,
  prefersDark,
  resolveEffectiveTheme,
  getEffectiveTheme,
  applyTheme,
  applyThemeMode,
  subscribeSystemTheme,
  THEME_MODE_LABELS,
  type ThemeMode,
} from "./theme";

/** Install a matchMedia stub that reports the given dark-mode preference and
 *  records change listeners so tests can fire them. Returns helpers. */
function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let matches = initialDark;
  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    },
  };
  vi.stubGlobal("matchMedia", () => mql as unknown as MediaQueryList);
  // matchMedia must also resolve via window.matchMedia in the store code.
  (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
    (() => mql) as unknown as typeof window.matchMedia;
  return {
    fire(dark: boolean) {
      matches = dark;
      for (const cb of listeners) {
        cb({ matches: dark } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
}

describe("theme store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("isThemeMode", () => {
    it("accepts the three valid modes", () => {
      expect(isThemeMode("light")).toBe(true);
      expect(isThemeMode("dark")).toBe(true);
      expect(isThemeMode("system")).toBe(true);
    });

    it("rejects unknown / non-string values", () => {
      expect(isThemeMode("blue")).toBe(false);
      expect(isThemeMode("")).toBe(false);
      expect(isThemeMode(null)).toBe(false);
      expect(isThemeMode(undefined)).toBe(false);
      expect(isThemeMode(42)).toBe(false);
    });
  });

  describe("getThemeMode", () => {
    it("returns the persisted mode when valid", () => {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, "dark");
      expect(getThemeMode()).toBe("dark");
    });

    it("falls back to system when nothing is stored", () => {
      expect(getThemeMode()).toBe("system");
    });

    it("falls back to system on a malformed stored value", () => {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, "neon");
      expect(getThemeMode()).toBe("system");
    });
  });

  describe("setThemeMode", () => {
    it("persists the mode under the coco.theme key", () => {
      setThemeMode("light");
      expect(window.localStorage.getItem(LOCAL_STORAGE_KEY)).toBe("light");
    });

    it("round-trips through getThemeMode", () => {
      for (const mode of ["light", "dark", "system"] as ThemeMode[]) {
        setThemeMode(mode);
        expect(getThemeMode()).toBe(mode);
      }
    });
  });

  describe("prefersDark", () => {
    it("reflects the OS preference", () => {
      stubMatchMedia(true);
      expect(prefersDark()).toBe(true);
      stubMatchMedia(false);
      expect(prefersDark()).toBe(false);
    });
  });

  describe("resolveEffectiveTheme", () => {
    it("returns explicit modes verbatim", () => {
      stubMatchMedia(true); // OS prefers dark; explicit modes must ignore it
      expect(resolveEffectiveTheme("light")).toBe("light");
      expect(resolveEffectiveTheme("dark")).toBe("dark");
    });

    it("resolves system to dark when the OS prefers dark", () => {
      stubMatchMedia(true);
      expect(resolveEffectiveTheme("system")).toBe("dark");
    });

    it("resolves system to light when the OS prefers light", () => {
      stubMatchMedia(false);
      expect(resolveEffectiveTheme("system")).toBe("light");
    });
  });

  describe("getEffectiveTheme", () => {
    it("combines the persisted mode with the OS preference", () => {
      stubMatchMedia(true);
      window.localStorage.setItem(LOCAL_STORAGE_KEY, "system");
      expect(getEffectiveTheme()).toBe("dark");
      window.localStorage.setItem(LOCAL_STORAGE_KEY, "light");
      expect(getEffectiveTheme()).toBe("light");
    });
  });

  describe("applyTheme", () => {
    it("sets the data-theme attribute on <html>", () => {
      applyTheme("dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      applyTheme("light");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  describe("applyThemeMode", () => {
    it("resolves and applies the mode, returning the effective theme", () => {
      stubMatchMedia(true);
      expect(applyThemeMode("system")).toBe("dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(applyThemeMode("light")).toBe("light");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  describe("subscribeSystemTheme", () => {
    it("invokes the listener with the new theme on a color-scheme flip", () => {
      const media = stubMatchMedia(false);
      const seen: string[] = [];
      const unsub = subscribeSystemTheme((t) => seen.push(t));
      expect(media.listenerCount()).toBe(1);
      media.fire(true);
      media.fire(false);
      expect(seen).toEqual(["dark", "light"]);
      unsub();
      expect(media.listenerCount()).toBe(0);
    });

    it("returns a noop cleanup when matchMedia is unavailable", () => {
      vi.stubGlobal("matchMedia", undefined);
      (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
      const unsub = subscribeSystemTheme(() => {});
      expect(() => unsub()).not.toThrow();
    });
  });

  describe("THEME_MODE_LABELS", () => {
    it("has ja / en labels for every mode", () => {
      for (const mode of ["light", "dark", "system"] as ThemeMode[]) {
        expect(THEME_MODE_LABELS[mode].ja.length).toBeGreaterThan(0);
        expect(THEME_MODE_LABELS[mode].en.length).toBeGreaterThan(0);
      }
    });
  });
});

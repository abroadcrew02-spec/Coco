// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLocale, setLocale, strings, t, LOCALE_STORAGE_KEY } from "./locale";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("locale strings", () => {
  it("returns the ja-JP value when locale is ja-JP", () => {
    setLocale("ja-JP");
    expect(t("toolbar.save")).toBe("保存");
    expect(t("dialog.settings")).toBe("設定");
  });

  it("returns the en-US value when locale is en-US", () => {
    setLocale("en-US");
    expect(t("toolbar.save")).toBe("Save");
    expect(t("dialog.settings")).toBe("Settings");
  });

  it("keeps ja-JP and en-US bundles in sync on all keys", () => {
    const ja = Object.keys(strings["ja-JP"]).sort();
    const en = Object.keys(strings["en-US"]).sort();
    expect(en).toEqual(ja);
  });
});

describe("getLocale", () => {
  it("honours the localStorage override", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en-US");
    expect(getLocale()).toBe("en-US");
    localStorage.setItem(LOCALE_STORAGE_KEY, "ja-JP");
    expect(getLocale()).toBe("ja-JP");
  });

  it("ignores junk values in localStorage and falls back to navigator", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr-FR");
    vi.spyOn(navigator, "language", "get").mockReturnValue("ja-JP");
    expect(getLocale()).toBe("ja-JP");
  });

  it("falls back to en-US for non-Japanese browser languages", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
    expect(getLocale()).toBe("en-US");
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    expect(getLocale()).toBe("en-US");
  });

  it("returns ja-JP when navigator reports a Japanese variant", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("ja");
    expect(getLocale()).toBe("ja-JP");
  });
});

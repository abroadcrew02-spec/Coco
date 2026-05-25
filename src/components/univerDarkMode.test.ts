// Unit test for the Univer 0.8 dark-mode helper.
//
// We don't drive the real Univer renderer here — that's a CDP smoke-test
// concern. We just assert the helper:
//   - resolves the ThemeService from the injector,
//   - calls `setDarkMode(true)` for "dark" / `setDarkMode(false)` for "light",
//   - returns true on success and false when the injector/service fails,
//   - swallows exceptions so a transient failure can't crash the editor.

import { describe, it, expect, vi } from "vitest";
import { ThemeService, type Univer } from "@univerjs/core";
import { setUniverDarkMode } from "./univerDarkMode";

function makeFakeUniver(service: { setDarkMode: (b: boolean) => void } | null) {
  const get = vi.fn((token: unknown) => {
    if (token === ThemeService) {
      if (service === null) throw new Error("not registered");
      return service;
    }
    throw new Error("unexpected token");
  });
  const univer = {
    __getInjector: () => ({ get }),
  } as unknown as Univer;
  return { univer, get };
}

describe("setUniverDarkMode", () => {
  it("calls setDarkMode(true) for 'dark' theme", () => {
    const setDarkMode = vi.fn();
    const { univer } = makeFakeUniver({ setDarkMode });
    const ok = setUniverDarkMode(univer, "dark");
    expect(ok).toBe(true);
    expect(setDarkMode).toHaveBeenCalledTimes(1);
    expect(setDarkMode).toHaveBeenCalledWith(true);
  });

  it("calls setDarkMode(false) for 'light' theme", () => {
    const setDarkMode = vi.fn();
    const { univer } = makeFakeUniver({ setDarkMode });
    const ok = setUniverDarkMode(univer, "light");
    expect(ok).toBe(true);
    expect(setDarkMode).toHaveBeenCalledWith(false);
  });

  it("returns false when ThemeService cannot be resolved", () => {
    const { univer } = makeFakeUniver(null);
    const ok = setUniverDarkMode(univer, "dark");
    expect(ok).toBe(false);
  });

  it("returns false when setDarkMode throws", () => {
    const setDarkMode = vi.fn(() => {
      throw new Error("boom");
    });
    const { univer } = makeFakeUniver({ setDarkMode });
    const ok = setUniverDarkMode(univer, "dark");
    expect(ok).toBe(false);
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import {
  onHelpRequested,
  onSettingsRequested,
  requestHelp,
  requestSettings,
} from "./useGlobalShortcuts";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("help emitter", () => {
  it("fires registered listeners on requestHelp()", () => {
    const fn = vi.fn();
    const unsub = onHelpRequested(fn);
    requestHelp();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("supports multiple listeners", () => {
    const a = vi.fn();
    const b = vi.fn();
    const u1 = onHelpRequested(a);
    const u2 = onHelpRequested(b);
    requestHelp();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it("unsubscribe stops firing", () => {
    const fn = vi.fn();
    const unsub = onHelpRequested(fn);
    requestHelp();
    unsub();
    requestHelp();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not throw with zero listeners", () => {
    // No listeners registered (or all unsubscribed).
    expect(() => requestHelp()).not.toThrow();
  });
});

describe("settings emitter", () => {
  it("fires registered listeners on requestSettings()", () => {
    const fn = vi.fn();
    const unsub = onSettingsRequested(fn);
    requestSettings();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("help and settings emitters are independent", () => {
    const helpFn = vi.fn();
    const settingsFn = vi.fn();
    const uh = onHelpRequested(helpFn);
    const us = onSettingsRequested(settingsFn);
    requestHelp();
    expect(helpFn).toHaveBeenCalledTimes(1);
    expect(settingsFn).toHaveBeenCalledTimes(0);
    requestSettings();
    expect(helpFn).toHaveBeenCalledTimes(1);
    expect(settingsFn).toHaveBeenCalledTimes(1);
    uh();
    us();
  });
});

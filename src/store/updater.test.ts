// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { invokeMock, checkMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  checkMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

import {
  ROLLOUT_HELD,
  checkForUpdate,
  downloadAndInstall,
  isInRolloutBucket,
} from "./updater";

function fakeUpdate(version = "0.8.5") {
  return {
    version,
    currentVersion: "0.8.4",
    body: "notes",
    date: null,
    downloadAndInstall: vi.fn(async (onEvent: (e: { event: string; data?: unknown }) => void) => {
      onEvent({ event: "Started", data: { contentLength: 10 } });
      onEvent({ event: "Progress", data: { chunkLength: 10 } });
      onEvent({ event: "Finished" });
    }),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
  checkMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchSpy = vi.fn(async () => {
    throw new Error("renderer fetch must not be used for the manifest");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
});

describe("checkForUpdate — manifest through updater_fetch_manifest (#359)", () => {
  it("reads rollout, min_required_version and channel when the manifest matches", async () => {
    checkMock.mockResolvedValue(fakeUpdate("0.8.5"));
    invokeMock.mockResolvedValue(
      JSON.stringify({
        version: "0.8.5",
        min_required_version: "0.8.0",
        rollout: { percent: 100, seed: "v0.8.5" },
        channel: "stable",
      }),
    );
    const r = await checkForUpdate();
    expect(invokeMock).toHaveBeenCalledWith("updater_fetch_manifest");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.rollout).toEqual({ percent: 100, seed: "v0.8.5" });
    expect(r.rollout).not.toBe(ROLLOUT_HELD);
    expect(isInRolloutBucket(r.rollout)).toBe(true);
    expect(r.minRequiredVersion).toBe("0.8.0");
    expect(r.isForced).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a leading v on the manifest version", async () => {
    checkMock.mockResolvedValue(fakeUpdate("0.8.5"));
    invokeMock.mockResolvedValue(JSON.stringify({ version: "v0.8.5" }));
    const r = await checkForUpdate();
    if (!r.available) throw new Error("expected an update");
    expect(r.rollout).toBeNull();
    expect(isInRolloutBucket(r.rollout)).toBe(true);
  });

  it.each([
    ["the fetch fails", () => invokeMock.mockRejectedValue("network unreachable"), /manifest fetch failed/],
    ["the body is not JSON", () => invokeMock.mockResolvedValue("<html>"), /not valid JSON/],
    [
      "the version differs from the update",
      () => invokeMock.mockResolvedValue(JSON.stringify({ version: "0.8.4", rollout: { percent: 100, seed: "x" } })),
      /does not match/,
    ],
  ])("holds the automatic update and warns when %s", async (_label, arrange, reason) => {
    checkMock.mockResolvedValue(fakeUpdate("0.8.5"));
    arrange();
    const r = await checkForUpdate();
    if (!r.available) throw new Error("expected an update");
    expect(r.rollout).toBe(ROLLOUT_HELD);
    expect(isInRolloutBucket(r.rollout)).toBe(false);
    expect(r.isForced).toBe(false);
    expect(r.minRequiredVersion).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(reason));
    expect(warn.mock.calls[0][0]).toMatch(/\[updater\] staged rollout held/);

    // The automatic path (no override) refuses to install.
    await expect(downloadAndInstall(() => {})).rejects.toThrow(/staged rollout/);
  });

  it("a manual check still installs while the rollout is held", async () => {
    const update = fakeUpdate("0.8.5");
    checkMock.mockResolvedValue(update);
    invokeMock.mockRejectedValue(new Error("offline"));
    const r = await checkForUpdate();
    if (!r.available) throw new Error("expected an update");
    expect(r.rollout).toBe(ROLLOUT_HELD);

    const progress = vi.fn();
    await downloadAndInstall(progress, true);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith({ downloaded: 10, total: 10 });
  });

  it("does not read the manifest when there is no update", async () => {
    checkMock.mockResolvedValue(null);
    expect(await checkForUpdate()).toEqual({ available: false });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

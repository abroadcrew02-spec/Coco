// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  autoIntervalMinutes,
  connectionSignature,
  isAutoOnOpen,
  isAutoRefreshConnection,
  normalizeIntervalMinutesInput,
  startDataConnectionSchedule,
  type ConnectionGuard,
} from "./dataConnectionSchedule";
import { issueGrant, revokeSessionGrants, type ScriptExecutionGrant } from "./scriptGrant";
import type { DataConnection } from "./dataConnections";

function conn(overrides: Partial<DataConnection> = {}): DataConnection {
  return {
    id: "c1",
    name: "conn",
    type: "csv",
    sourcePath: "C:\\data\\a.csv",
    targetSheetId: null,
    targetSheetName: "A",
    lastRefreshedAt: null,
    ...overrides,
  };
}

let seq = 0;
function grantFor(conns: DataConnection[], key = `sched-${++seq}`): ScriptExecutionGrant {
  return issueGrant(key, "sha256:sched", "session", {
    sources: [],
    connectionSignatures: conns.map(connectionSignature),
  });
}

/** Refresh stub that behaves like EditorScreen: checks the guard on the
 *  connection it would load, and only then counts a load. */
function refreshStub(live: () => DataConnection[]) {
  const loads: string[] = [];
  const refresh = vi.fn(async (id: string, guard: ConnectionGuard) => {
    const c = live().find((x) => x.id === id);
    if (!c) throw new Error("gone");
    if (!guard(c)) throw new Error("not allowed");
    loads.push(id);
  });
  return { refresh, loads };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-refresh predicates", () => {
  it("recognizes on-open and positive finite intervals only", () => {
    expect(isAutoOnOpen(conn({ schedule: { onOpen: true, intervalMinutes: 0 } }))).toBe(true);
    expect(isAutoOnOpen(conn({ schedule: { onOpen: "yes" as unknown as boolean, intervalMinutes: 0 } }))).toBe(false);
    expect(autoIntervalMinutes(conn({ schedule: { onOpen: false, intervalMinutes: 5 } }))).toBe(5);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      expect(autoIntervalMinutes(conn({ schedule: { onOpen: false, intervalMinutes: bad } }))).toBe(0);
    }
    expect(isAutoRefreshConnection(conn())).toBe(false);
  });

  it("rejects non-number intervals of every shape (#355)", () => {
    for (const bad of ["5", true, [5], { m: 5 }, null] as unknown[]) {
      const c = conn({ schedule: { onOpen: false, intervalMinutes: bad as number } });
      expect(autoIntervalMinutes(c)).toBe(0);
      expect(isAutoRefreshConnection(c)).toBe(false);
    }
  });

  it("accepts only intervals the timer can represent (#355)", () => {
    const at = (m: number) =>
      autoIntervalMinutes(conn({ schedule: { onOpen: false, intervalMinutes: m } }));
    expect(MAX_INTERVAL_MINUTES).toBe(35791);
    expect(MAX_INTERVAL_MINUTES * 60_000).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(at(MIN_INTERVAL_MINUTES)).toBe(1);
    expect(at(1.5)).toBe(1.5);
    expect(at(MAX_INTERVAL_MINUTES)).toBe(MAX_INTERVAL_MINUTES);
    expect(at(0.5)).toBe(0);
    expect(at(0.00001)).toBe(0);
    expect(at(MAX_INTERVAL_MINUTES + 1)).toBe(0);
    expect(at(1e9)).toBe(0);
  });

  it("normalizes form input to a value the scheduler accepts", () => {
    expect(normalizeIntervalMinutesInput(5)).toBe(5);
    expect(normalizeIntervalMinutesInput(5.9)).toBe(5);
    expect(normalizeIntervalMinutesInput("7")).toBe(7);
    expect(normalizeIntervalMinutesInput(0)).toBe(0);
    expect(normalizeIntervalMinutesInput(0.5)).toBe(0);
    expect(normalizeIntervalMinutesInput(-3)).toBe(0);
    expect(normalizeIntervalMinutesInput(Number.NaN)).toBe(0);
    expect(normalizeIntervalMinutesInput("abc")).toBe(0);
    expect(normalizeIntervalMinutesInput(99_999)).toBe(MAX_INTERVAL_MINUTES);
    for (const v of [5, 5.9, "7", 99_999, 1]) {
      const n = normalizeIntervalMinutesInput(v);
      expect(autoIntervalMinutes(conn({ schedule: { onOpen: false, intervalMinutes: n } }))).toBe(n);
    }
  });

  it("does not schedule an out-of-range interval even with a grant", async () => {
    const huge = conn({ id: "huge", schedule: { onOpen: false, intervalMinutes: 50_000 } });
    const tiny = conn({ id: "tiny", sourcePath: "C:\\t.csv", schedule: { onOpen: false, intervalMinutes: 0.001 } });
    const { refresh } = refreshStub(() => [huge, tiny]);
    const handle = startDataConnectionSchedule({
      connections: [huge, tiny],
      getGrant: () => grantFor([huge, tiny]),
      onOpenPending: true,
      refresh,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
    handle.stop();
  });

  it("signature ignores display fields and header order", () => {
    const base = conn({
      type: "web",
      web: { url: "https://x.test/", format: "json", headers: { A: "1", B: "2" } },
      schedule: { onOpen: true, intervalMinutes: 0 },
    });
    const display = {
      ...base,
      name: "renamed",
      targetSheetName: "Z",
      lastRefreshedAt: 5,
      web: { url: "https://x.test/", format: "json" as const, headers: { B: "2", A: "1" } },
    };
    expect(connectionSignature(display)).toBe(connectionSignature(base));
    expect(connectionSignature({ ...base, web: { ...base.web!, url: "https://y.test/" } })).not.toBe(
      connectionSignature(base),
    );
  });
});

describe("startDataConnectionSchedule — without a grant", () => {
  it("neither fires on open nor arms intervals", async () => {
    const conns = [
      conn({ id: "open", schedule: { onOpen: true, intervalMinutes: 0 } }),
      conn({ id: "tick", schedule: { onOpen: false, intervalMinutes: 1 } }),
    ];
    const { refresh } = refreshStub(() => conns);
    const handle = startDataConnectionSchedule({
      connections: conns,
      getGrant: () => null,
      onOpenPending: true,
      refresh,
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(handle.firedOnOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    handle.stop();
  });

  it("ignores forged grants and connections outside the grant", async () => {
    const approved = conn({ id: "ok", schedule: { onOpen: true, intervalMinutes: 0 } });
    const other = conn({ id: "no", sourcePath: "C:\\x.csv", schedule: { onOpen: true, intervalMinutes: 1 } });
    const grant = grantFor([approved]);
    const { refresh, loads } = refreshStub(() => [approved, other]);

    const forged = startDataConnectionSchedule({
      connections: [approved, other],
      getGrant: () => ({ ...grant }),
      onOpenPending: true,
      refresh,
    });
    expect(forged.firedOnOpen).toBe(false);
    expect(refresh).not.toHaveBeenCalled();

    const real = startDataConnectionSchedule({
      connections: [approved, other],
      getGrant: () => grant,
      onOpenPending: true,
      refresh,
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(real.firedOnOpen).toBe(true);
    expect(loads).toEqual(["ok"]);
    real.stop();
  });
});

describe("startDataConnectionSchedule — with a grant", () => {
  it("fires on-open once and ticks intervals", async () => {
    const open = conn({ id: "open", schedule: { onOpen: true, intervalMinutes: 0 } });
    const tick = conn({ id: "tick", sourcePath: "C:\\t.csv", schedule: { onOpen: false, intervalMinutes: 2 } });
    const grant = grantFor([open, tick]);
    const { refresh, loads } = refreshStub(() => [open, tick]);
    const handle = startDataConnectionSchedule({
      connections: [open, tick],
      getGrant: () => grant,
      onOpenPending: true,
      refresh,
    });
    expect(handle.firedOnOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
    expect(loads).toEqual(["open", "tick", "tick"]);
    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(loads).toEqual(["open", "tick", "tick"]);
  });

  it("does not fire on-open when already fired for this handle", async () => {
    const open = conn({ id: "open", schedule: { onOpen: true, intervalMinutes: 0 } });
    const { refresh } = refreshStub(() => [open]);
    const handle = startDataConnectionSchedule({
      connections: [open],
      getGrant: () => grantFor([open]),
      onOpenPending: false,
      refresh,
    });
    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
    expect(handle.firedOnOpen).toBe(false);
  });

  it("stops loading at the next tick once the grant is revoked or replaced", async () => {
    const tick = conn({ id: "tick", schedule: { onOpen: false, intervalMinutes: 1 } });
    const key = `sched-revoke-${++seq}`;
    let current: unknown = grantFor([tick], key);
    const { refresh, loads } = refreshStub(() => [tick]);
    const handle = startDataConnectionSchedule({
      connections: [tick],
      getGrant: () => current,
      onOpenPending: false,
      refresh,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loads).toEqual(["tick"]);

    revokeSessionGrants(key);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loads).toEqual(["tick"]);

    current = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loads).toEqual(["tick"]);
    handle.stop();
  });

  it("re-checks the live connection: a changed URL is not loaded", async () => {
    const approved = conn({
      id: "w",
      type: "web",
      web: { url: "https://ok.test/", format: "json", headers: {} },
      schedule: { onOpen: false, intervalMinutes: 1 },
    });
    let live = approved;
    const grant = grantFor([approved]);
    const { refresh, loads } = refreshStub(() => [live]);
    const handle = startDataConnectionSchedule({
      connections: [approved],
      getGrant: () => grant,
      onOpenPending: false,
      refresh,
    });
    live = { ...approved, web: { url: "https://changed.test/", format: "json", headers: {} } };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(loads).toEqual([]);
    handle.stop();
  });

  it("swallows refresh failures", async () => {
    const open = conn({ id: "open", schedule: { onOpen: true, intervalMinutes: 0 } });
    const refresh = vi.fn(async () => {
      throw new Error("network");
    });
    expect(() =>
      startDataConnectionSchedule({
        connections: [open],
        getGrant: () => grantFor([open]),
        onOpenPending: true,
        refresh,
      }),
    ).not.toThrow();
    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

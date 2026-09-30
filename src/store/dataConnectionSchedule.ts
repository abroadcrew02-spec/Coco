// #190 Phase 5 / #355 — scheduled data-connection refresh, behind the trust gate.
//
// Connections with `schedule.onOpen === true` refresh once when the workbook
// opens and connections with a valid `schedule.intervalMinutes` (see
// `autoIntervalMinutes`) refresh periodically. Both
// run without a user action, so they only run when the current execution grant
// covers the connection's signature.
//
// The same predicates and the same signature are used by the trust fingerprint
// (`scriptTrust.ts`), so "what the user approved" and "what the scheduler runs"
// cannot drift apart. The connections dialog also reads the schedule through
// these predicates (badge and edit form), so what the user sees and saves is
// what actually runs. Manual refresh from the dialog is not gated here.

import { checkConnectionGrant } from "./scriptGrant";
import type { DataConnection } from "./dataConnections";

/** Shortest accepted refresh interval, in minutes. */
export const MIN_INTERVAL_MINUTES = 1;
/**
 * Longest accepted refresh interval, in minutes. Larger values overflow the
 * 32-bit `setInterval` delay (2^31 - 1 ms) and would fire almost immediately.
 */
export const MAX_INTERVAL_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);

/** True when the connection refreshes by itself when the workbook opens. */
export function isAutoOnOpen(c: DataConnection): boolean {
  return c.schedule?.onOpen === true;
}

/**
 * Interval in minutes when the connection refreshes periodically, else 0.
 * Only a finite number within [MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES]
 * counts; anything else (strings, booleans, arrays, out-of-range numbers)
 * means "no periodic refresh".
 */
export function autoIntervalMinutes(c: DataConnection): number {
  const m: unknown = c.schedule?.intervalMinutes;
  return typeof m === "number" &&
    Number.isFinite(m) &&
    m >= MIN_INTERVAL_MINUTES &&
    m <= MAX_INTERVAL_MINUTES
    ? m
    : 0;
}

/**
 * Convert a value typed into the edit form into a stored interval: whole
 * minutes, 0 for "none", capped at MAX_INTERVAL_MINUTES. The result always
 * satisfies `autoIntervalMinutes` (or is 0).
 */
export function normalizeIntervalMinutesInput(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.floor(n);
  if (whole < MIN_INTERVAL_MINUTES) return 0;
  return Math.min(whole, MAX_INTERVAL_MINUTES);
}

/** True when the connection runs without a user action. */
export function isAutoRefreshConnection(c: DataConnection): boolean {
  return isAutoOnOpen(c) || autoIntervalMinutes(c) > 0;
}

function canonicalHeaders(headers: unknown): unknown {
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const h = headers as Record<string, unknown>;
    const keys = Object.keys(h).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return ["obj", keys.map((k) => [k, h[k]])];
  }
  return ["raw", headers ?? null];
}

/**
 * Canonical tuple for a connection: everything that decides what is fetched
 * and when. Display-only fields (name, target sheet, last refresh time, ETL
 * steps) are excluded.
 */
export function connectionTuple(c: DataConnection): unknown[] {
  const web = c.web as DataConnection["web"] | undefined;
  const sqlite = c.sqlite as DataConnection["sqlite"] | undefined;
  return [
    c.id,
    c.type,
    c.sourcePath ?? null,
    web ? [web.url ?? null, web.format ?? null, canonicalHeaders(web.headers)] : null,
    sqlite ? [sqlite.dbPath ?? null, sqlite.query ?? null] : null,
    isAutoOnOpen(c),
    autoIntervalMinutes(c),
  ];
}

/** Signature string a grant must contain for the connection to auto-refresh. */
export function connectionSignature(c: DataConnection): string {
  return JSON.stringify(connectionTuple(c));
}

/** Predicate the refresh routine evaluates on the exact connection it loads. */
export type ConnectionGuard = (conn: DataConnection) => boolean;

export interface DataConnectionScheduleOptions {
  connections: readonly DataConnection[];
  /** Returns the current grant. Read at start and again on every tick. */
  getGrant: () => unknown;
  /** True while on-open refreshes have not fired for this workbook handle. */
  onOpenPending: boolean;
  /**
   * Refresh one connection. Implementations must call `guard` on the
   * connection they are about to load and abort when it returns false.
   */
  refresh: (connectionId: string, guard: ConnectionGuard) => Promise<unknown>;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (id: unknown) => void;
}

export interface DataConnectionScheduleHandle {
  /** True when at least one on-open refresh was started. */
  firedOnOpen: boolean;
  stop: () => void;
}

/**
 * Start on-open refreshes and interval timers for the connections the current
 * grant covers. Without a covering grant nothing is started.
 */
export function startDataConnectionSchedule(
  opts: DataConnectionScheduleOptions,
): DataConnectionScheduleHandle {
  const setIntervalFn =
    opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn =
    opts.clearIntervalFn ??
    ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));

  const guard: ConnectionGuard = (conn) =>
    isAutoRefreshConnection(conn) &&
    checkConnectionGrant(opts.getGrant(), connectionSignature(conn)).ok;

  const runRefresh = (id: string) => {
    void opts.refresh(id, guard).catch(() => {
      // Background refresh failures are non-fatal; the dialog shows the
      // connection state the next time it opens.
    });
  };

  let firedOnOpen = false;
  if (opts.onOpenPending) {
    for (const c of opts.connections) {
      if (isAutoOnOpen(c) && guard(c)) {
        firedOnOpen = true;
        runRefresh(c.id);
      }
    }
  }

  const timers: unknown[] = [];
  for (const c of opts.connections) {
    const minutes = autoIntervalMinutes(c);
    if (minutes <= 0 || !guard(c)) continue;
    const id = c.id;
    timers.push(
      setIntervalFn(() => {
        runRefresh(id);
      }, minutes * 60_000),
    );
  }

  return {
    firedOnOpen,
    stop: () => {
      for (const t of timers.splice(0)) clearIntervalFn(t);
    },
  };
}

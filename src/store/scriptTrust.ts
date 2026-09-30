// #355 — Trust decisions for content that runs by itself when a workbook opens:
// embedded scripts (`_scripts`) and auto-refreshing data connections
// (`_connections` entries with a schedule).
//
// The store answers one question per document session: may this exact content
// run? Answers come from, in order:
//   1. what was decided earlier in this session ("allow once", "always",
//      content the user wrote in the app), kept in memory per session key;
//   2. a persisted "always trust" record for the workbook path (or, for a
//      restored copy / history snapshot, the path it came from), matched on
//      the content fingerprint.
// Anything else is untrusted. Errors (hashing, storage, corrupt records) are
// treated as untrusted as well.
//
// Trust is never read from the workbook itself. Grants (see `scriptGrant.ts`)
// are issued only here.

import {
  issueGrant,
  revokeSessionGrants,
  type GrantScope,
  type ScriptExecutionGrant,
} from "./scriptGrant";
import { scriptsFromSnapshotObject } from "./scriptRuntime";
import { listConnections, type DataConnection } from "./dataConnections";
import {
  connectionSignature,
  connectionTuple,
  isAutoRefreshConnection,
} from "./dataConnectionSchedule";

// ---------- types -------------------------------------------------------------

export type TrustScope = "session" | "always";

export interface TrustSubject {
  /** Random key issued each time a document is opened. */
  sessionKey: string;
  /** Path the document is saved at. Required for "always". */
  path: string | null;
  /** Path used only to look up an existing record (restore / history). */
  lookupPath: string | null;
}

export interface ActiveContent {
  /** "sha256:<hex>" of the canonical form, or "none" when empty. */
  fingerprint: string;
  scriptSources: readonly string[];
  connectionSignatures: readonly string[];
  scriptCount: number;
  autoConnectionCount: number;
  isEmpty: boolean;
}

export type TrustState =
  | { kind: "none" }
  | { kind: "evaluating" }
  | { kind: "untrusted"; reason: "new" | "changed"; canAlways: boolean }
  | { kind: "trusted"; scope: GrantScope };

export interface TrustRecord {
  v: 1;
  path: string;
  pathNorm: string;
  fingerprint: string;
  trustedAt: string;
  summary: { scripts: number; autoConnections: number };
}

/** Key/value backend for "always trust" records. */
export interface TrustPersistence {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  list(): Promise<{ key: string; value: string }[]>;
  delete(key: string): Promise<void>;
}

export interface TrustEvaluation {
  state: TrustState;
  content: ActiveContent;
  grant: ScriptExecutionGrant | null;
}

export interface ScriptTrustStore {
  isTrusted(subject: TrustSubject, fingerprint: string): Promise<boolean>;
  /**
   * `content` must come from `evaluate` for the same session. "always"
   * rejects without a path. A failed save falls back to "session".
   */
  trust(
    subject: TrustSubject,
    content: ActiveContent,
    scope: TrustScope,
  ): Promise<{ grant: ScriptExecutionGrant; degraded: boolean }>;
  /**
   * Delete the record for `path`. Open documents at that path (or trusted
   * through it) lose every decision of their session, including "allow once"
   * and in-app edits, and become untrusted immediately.
   */
  revoke(path: string): Promise<void>;
  list(): Promise<TrustRecord[]>;
  evaluate(subject: TrustSubject, snapshotJson: string | null): Promise<TrustEvaluation>;
  /** Mark `next` as written in the app when `prev` was trusted or empty. */
  adoptLocalEdit(
    subject: TrustSubject,
    prevSnapshotJson: string | null,
    nextSnapshotJson: string | null,
  ): Promise<void>;
  endSession(sessionKey: string): void;
  /** Called after any change that can alter an evaluation result. */
  subscribe(listener: () => void): () => void;
}

// ---------- identifiers ---------------------------------------------------------

/** Prefix of persisted trust record keys. Kept in one place on purpose. */
export const SCRIPT_TRUST_KEY_PREFIX = "script_trust.v1.";

const EMPTY_FINGERPRINT = "none";
const UNAVAILABLE_FINGERPRINT = "unavailable";
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto is not available");
  return c.subtle;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await getSubtle().digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function isWindowsStylePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//");
}

/**
 * Normalize a path for record lookup: trim, use "/" separators, collapse
 * repeated separators, lower-case Windows paths. Short names and links are
 * not resolved; a mismatch only means the user is asked again.
 */
export function normalizeTrustPath(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed) return "";
  const windows = isWindowsStylePath(trimmed);
  const slashed = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return windows ? slashed.toLowerCase() : slashed;
}

/** Persisted key for a normalized path. */
export async function trustRecordKey(pathNorm: string): Promise<string> {
  return SCRIPT_TRUST_KEY_PREFIX + (await sha256Hex(pathNorm));
}

// ---------- fingerprint ---------------------------------------------------------

function freezeContent(c: ActiveContent): ActiveContent {
  return Object.freeze({
    ...c,
    scriptSources: Object.freeze([...c.scriptSources]),
    connectionSignatures: Object.freeze([...c.connectionSignatures]),
  });
}

const EMPTY_CONTENT: ActiveContent = freezeContent({
  fingerprint: EMPTY_FINGERPRINT,
  scriptSources: [],
  connectionSignatures: [],
  scriptCount: 0,
  autoConnectionCount: 0,
  isEmpty: true,
});

// Returned when evaluation failed. Never bound to a session by `evaluate`, so
// it can never be trusted.
const UNAVAILABLE_CONTENT: ActiveContent = Object.freeze({
  fingerprint: UNAVAILABLE_FINGERPRINT,
  scriptSources: Object.freeze([]) as readonly string[],
  connectionSignatures: Object.freeze([]) as readonly string[],
  scriptCount: 0,
  autoConnectionCount: 0,
  isEmpty: false,
});

/**
 * True when the evaluation behind `content` failed (or there is no content
 * yet for an untrusted state). Such content can never be trusted; the UI
 * asks the user to reopen the workbook instead of offering to enable it.
 */
export function isContentUnavailable(content: ActiveContent | null): boolean {
  return content === null || content.fingerprint === UNAVAILABLE_FINGERPRINT;
}

/**
 * Cheap pre-check that lets snapshots without scripts or connections skip the
 * full parse. A JSON key can be spelled with \u escapes, so any "\u" forces
 * the parse as well; otherwise an escaped key could hide content from this
 * check while the runtime's JSON.parse still sees it.
 */
function mayContainActiveContent(json: string): boolean {
  return (
    json.includes('"_scripts"') ||
    json.includes('"_connections"') ||
    json.includes("\\u")
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compute the content that would run by itself, and its fingerprint.
 * Throws when the snapshot cannot be parsed or hashing is unavailable.
 */
export async function computeActiveContent(
  snapshotJson: string | null,
): Promise<ActiveContent> {
  if (!snapshotJson || !mayContainActiveContent(snapshotJson)) return EMPTY_CONTENT;
  const obj: unknown = JSON.parse(snapshotJson);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return EMPTY_CONTENT;

  const scripts = scriptsFromSnapshotObject(obj);
  const autoConns: DataConnection[] = listConnections(
    obj as Parameters<typeof listConnections>[0],
  ).filter(isAutoRefreshConnection);
  if (scripts.length === 0 && autoConns.length === 0) return EMPTY_CONTENT;

  const scriptPairs = scripts
    .map((s) => [s.id, s.source] as [string, string])
    .sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  const connEntries = autoConns
    .map((c) => ({ id: c.id, tuple: connectionTuple(c), sig: connectionSignature(c) }))
    .sort((a, b) => compareStrings(a.id, b.id) || compareStrings(a.sig, b.sig));
  const canonical = JSON.stringify({
    v: 1,
    scripts: scriptPairs,
    connections: connEntries.map((e) => e.tuple),
  });

  return freezeContent({
    fingerprint: "sha256:" + (await sha256Hex(canonical)),
    scriptSources: [...new Set(scripts.map((s) => s.source))],
    connectionSignatures: [...new Set(connEntries.map((e) => e.sig))],
    scriptCount: scripts.length,
    autoConnectionCount: autoConns.length,
    isEmpty: false,
  });
}

// ---------- records ----------------------------------------------------------------

function parseRecord(raw: string | null, expectedPathNorm: string): TrustRecord | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<TrustRecord>;
  if (r.v !== 1) return null;
  if (typeof r.path !== "string" || typeof r.pathNorm !== "string") return null;
  if (r.pathNorm !== expectedPathNorm) return null;
  if (typeof r.fingerprint !== "string" || !FINGERPRINT_RE.test(r.fingerprint)) return null;
  if (typeof r.trustedAt !== "string") return null;
  const s = r.summary as Partial<TrustRecord["summary"]> | undefined;
  const summary = {
    scripts: typeof s?.scripts === "number" ? s.scripts : 0,
    autoConnections: typeof s?.autoConnections === "number" ? s.autoConnections : 0,
  };
  return {
    v: 1,
    path: r.path,
    pathNorm: r.pathNorm,
    fingerprint: r.fingerprint,
    trustedAt: r.trustedAt,
    summary,
  };
}

// ---------- store --------------------------------------------------------------------

interface TrustedEntry {
  scope: GrantScope;
  /** For "always": the normalized path whose record granted it. */
  fromPathNorm: string | null;
}

interface SessionMemory {
  trusted: Map<string, TrustedEntry>;
  /** Recently issued grants by fingerprint, so re-evaluation returns the same object. */
  grants: Map<string, ScriptExecutionGrant>;
  /** Pending local-edit adoptions; evaluate waits for them. */
  pending: Promise<void>;
  /** Normalized path / lookup path of the document as last seen, used to
   *  find the open documents a revoked path applies to. */
  pathNorms: string[];
}

const GRANT_CACHE_SIZE = 8;
const SCOPE_RANK: Record<GrantScope, number> = { self: 0, session: 1, always: 2 };

function assertSubject(subject: TrustSubject): void {
  if (!subject || typeof subject.sessionKey !== "string" || subject.sessionKey.length === 0) {
    throw new Error("Trust subject requires a session key");
  }
}

function subjectPathNorms(subject: TrustSubject): string[] {
  const out: string[] = [];
  for (const p of [subject.path, subject.lookupPath]) {
    if (typeof p !== "string") continue;
    const n = normalizeTrustPath(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function hasSavedPath(subject: TrustSubject): boolean {
  return typeof subject.path === "string" && normalizeTrustPath(subject.path) !== "";
}

export function createScriptTrustStore(persistence: TrustPersistence): ScriptTrustStore {
  const sessions = new Map<string, SessionMemory>();
  const endedSessions = new Set<string>();
  const listeners = new Set<() => void>();
  // Content returned by `evaluate`, mapped to the session it was evaluated
  // for. `trust()` only accepts content evaluated by this store for the same
  // session, so neither a hand-made approval list nor content from another
  // document can be trusted.
  const evaluatedFor = new WeakMap<ActiveContent, string>();
  let revocations = 0;

  const bindToSession = (content: ActiveContent, key: string): ActiveContent => {
    if (!content.isEmpty) evaluatedFor.set(content, key);
    return content;
  };

  const touchSubject = (s: SessionMemory, subject: TrustSubject) => {
    s.pathNorms = subjectPathNorms(subject);
  };

  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // A failing listener must not block the others.
      }
    }
  };

  const sessionFor = (key: string): SessionMemory | null => {
    if (endedSessions.has(key)) return null;
    let s = sessions.get(key);
    if (!s) {
      s = { trusted: new Map(), grants: new Map(), pending: Promise.resolve(), pathNorms: [] };
      sessions.set(key, s);
    }
    return s;
  };

  const isAlive = (key: string, s: SessionMemory) => sessions.get(key) === s;

  const remember = (s: SessionMemory, fingerprint: string, entry: TrustedEntry) => {
    const prev = s.trusted.get(fingerprint);
    if (!prev || SCOPE_RANK[entry.scope] >= SCOPE_RANK[prev.scope]) {
      s.trusted.set(fingerprint, entry);
    }
  };

  const grantFor = (
    key: string,
    s: SessionMemory,
    content: ActiveContent,
    scope: GrantScope,
  ): ScriptExecutionGrant => {
    const cached = s.grants.get(content.fingerprint);
    if (cached && cached.scope === scope) {
      s.grants.delete(content.fingerprint);
      s.grants.set(content.fingerprint, cached);
      return cached;
    }
    const grant = issueGrant(key, content.fingerprint, scope, {
      sources: content.scriptSources,
      connectionSignatures: content.connectionSignatures,
    });
    s.grants.set(content.fingerprint, grant);
    while (s.grants.size > GRANT_CACHE_SIZE) {
      const oldest = s.grants.keys().next().value;
      if (oldest === undefined) break;
      s.grants.delete(oldest);
    }
    return grant;
  };

  const readRecord = async (pathNorm: string): Promise<TrustRecord | null> => {
    try {
      const raw = await persistence.get(await trustRecordKey(pathNorm));
      return parseRecord(raw, pathNorm);
    } catch {
      return null;
    }
  };

  const lookupRecords = async (
    subject: TrustSubject,
    fingerprint: string,
  ): Promise<{ matchPathNorm: string | null; hadRecord: boolean }> => {
    let hadRecord = false;
    for (const pathNorm of subjectPathNorms(subject)) {
      const rec = await readRecord(pathNorm);
      if (!rec) continue;
      hadRecord = true;
      if (rec.fingerprint === fingerprint) return { matchPathNorm: pathNorm, hadRecord };
    }
    return { matchPathNorm: null, hadRecord };
  };

  const failClosed = (): TrustEvaluation => ({
    state: { kind: "untrusted", reason: "new", canAlways: false },
    content: UNAVAILABLE_CONTENT,
    grant: null,
  });

  const evaluateOnce = async (
    subject: TrustSubject,
    snapshotJson: string | null,
  ): Promise<TrustEvaluation | "retry"> => {
    const key = subject.sessionKey;
    const s = sessionFor(key);
    if (!s) return failClosed();
    touchSubject(s, subject);
    await s.pending;
    const startRevocations = revocations;
    const content = bindToSession(await computeActiveContent(snapshotJson), key);
    if (content.isEmpty) return { state: { kind: "none" }, content, grant: null };
    if (!isAlive(key, s)) return failClosed();

    const known = s.trusted.get(content.fingerprint);
    if (known) {
      return {
        state: { kind: "trusted", scope: known.scope },
        content,
        grant: grantFor(key, s, content, known.scope),
      };
    }

    const found = await lookupRecords(subject, content.fingerprint);
    if (!isAlive(key, s)) return failClosed();
    if (revocations !== startRevocations) return "retry";
    if (found.matchPathNorm !== null) {
      remember(s, content.fingerprint, { scope: "always", fromPathNorm: found.matchPathNorm });
      return {
        state: { kind: "trusted", scope: "always" },
        content,
        grant: grantFor(key, s, content, "always"),
      };
    }
    return {
      state: {
        kind: "untrusted",
        reason: found.hadRecord ? "changed" : "new",
        canAlways: hasSavedPath(subject),
      },
      content,
      grant: null,
    };
  };

  const evaluate: ScriptTrustStore["evaluate"] = async (subject, snapshotJson) => {
    try {
      assertSubject(subject);
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await evaluateOnce(subject, snapshotJson);
        if (r !== "retry") return r;
      }
      return failClosed();
    } catch {
      return failClosed();
    }
  };

  const isTrusted: ScriptTrustStore["isTrusted"] = async (subject, fingerprint) => {
    try {
      assertSubject(subject);
      const s = sessionFor(subject.sessionKey);
      if (!s) return false;
      if (s.trusted.has(fingerprint)) return true;
      if (!FINGERPRINT_RE.test(fingerprint)) return false;
      return (await lookupRecords(subject, fingerprint)).matchPathNorm !== null;
    } catch {
      return false;
    }
  };

  const trust: ScriptTrustStore["trust"] = async (subject, content, scope) => {
    assertSubject(subject);
    if (content === null || typeof content !== "object" || content.isEmpty) {
      throw new Error("Only evaluated, non-empty content can be trusted");
    }
    if (evaluatedFor.get(content) !== subject.sessionKey) {
      throw new Error("The content was not evaluated for this document session");
    }
    if (scope !== "session" && scope !== "always") throw new Error("Unknown trust scope");
    const key = subject.sessionKey;
    const s = sessionFor(key);
    if (!s) throw new Error("The document session has ended");
    touchSubject(s, subject);

    if (scope === "always") {
      if (!hasSavedPath(subject)) {
        throw new Error("Always-trust requires a saved file path");
      }
      const path = String(subject.path);
      const pathNorm = normalizeTrustPath(path);
      let degraded = false;
      try {
        const record: TrustRecord = {
          v: 1,
          path,
          pathNorm,
          fingerprint: content.fingerprint,
          trustedAt: new Date().toISOString(),
          summary: {
            scripts: content.scriptCount,
            autoConnections: content.autoConnectionCount,
          },
        };
        await persistence.set(await trustRecordKey(pathNorm), JSON.stringify(record));
      } catch {
        degraded = true;
      }
      if (!isAlive(key, s)) throw new Error("The document session has ended");
      const effective: GrantScope = degraded ? "session" : "always";
      remember(s, content.fingerprint, {
        scope: effective,
        fromPathNorm: degraded ? null : pathNorm,
      });
      const grant = grantFor(key, s, content, s.trusted.get(content.fingerprint)!.scope);
      notify();
      return { grant, degraded };
    }

    remember(s, content.fingerprint, { scope: "session", fromPathNorm: null });
    const grant = grantFor(key, s, content, s.trusted.get(content.fingerprint)!.scope);
    notify();
    return { grant, degraded: false };
  };

  /**
   * Drop every decision (always, allow once, self) of the open documents the
   * revoked path applies to, and revoke their grants, so they fall back to
   * untrusted and their timers stop. Other documents are not touched.
   */
  const dropSessionsFor = (pathNorm: string) => {
    for (const [key, s] of sessions) {
      const affected =
        s.pathNorms.includes(pathNorm) ||
        [...s.trusted.values()].some((e) => e.fromPathNorm === pathNorm);
      if (!affected) continue;
      s.trusted.clear();
      s.grants.clear();
      revokeSessionGrants(key);
    }
  };

  const revoke: ScriptTrustStore["revoke"] = async (path) => {
    const pathNorm = normalizeTrustPath(path);
    if (!pathNorm) return;
    try {
      // Delete first: an evaluation that reads the record before this point
      // is caught by the revocation counter below and runs again.
      await persistence.delete(await trustRecordKey(pathNorm));
    } finally {
      // Also on failure: the open documents lose their session decisions; if
      // the record survived, re-evaluation restores only "always".
      revocations += 1;
      dropSessionsFor(pathNorm);
      notify();
    }
  };

  const list: ScriptTrustStore["list"] = async () => {
    const rows = await persistence.list();
    const out: TrustRecord[] = [];
    for (const row of rows) {
      if (typeof row?.key !== "string" || !row.key.startsWith(SCRIPT_TRUST_KEY_PREFIX)) continue;
      let pathNorm: string | null = null;
      try {
        const parsed = JSON.parse(row.value) as { pathNorm?: unknown };
        pathNorm = typeof parsed?.pathNorm === "string" ? parsed.pathNorm : null;
      } catch {
        continue;
      }
      if (!pathNorm) continue;
      const rec = parseRecord(row.value, pathNorm);
      if (!rec) continue;
      try {
        if ((await trustRecordKey(pathNorm)) !== row.key) continue;
      } catch {
        continue;
      }
      out.push(rec);
    }
    return out;
  };

  const adoptLocalEdit: ScriptTrustStore["adoptLocalEdit"] = (subject, prevJson, nextJson) => {
    let s: SessionMemory | null;
    try {
      assertSubject(subject);
      s = sessionFor(subject.sessionKey);
    } catch {
      return Promise.resolve();
    }
    if (!s) return Promise.resolve();
    const session = s;
    const key = subject.sessionKey;
    touchSubject(session, subject);
    // Registered synchronously so an evaluate() started right after this call
    // (by the store update that follows the edit) waits for the decision.
    const run = session.pending.then(async () => {
      const startRevocations = revocations;
      const prev = await computeActiveContent(prevJson);
      const next = await computeActiveContent(nextJson);
      if (next.isEmpty || next.fingerprint === prev.fingerprint) return;
      let prevTrusted = prev.isEmpty || session.trusted.has(prev.fingerprint);
      if (!prevTrusted) {
        prevTrusted = (await lookupRecords(subject, prev.fingerprint)).matchPathNorm !== null;
      }
      // A revoke while deciding means the basis for "prev was trusted" may be
      // gone; do not promote.
      if (revocations !== startRevocations) return;
      if (!prevTrusted || !isAlive(key, session)) return;
      remember(session, next.fingerprint, { scope: "self", fromPathNorm: null });
      notify();
    });
    const settled = run.catch(() => {
      // Fail closed: when the decision cannot be made nothing is promoted.
    });
    session.pending = settled;
    return settled;
  };

  const endSession: ScriptTrustStore["endSession"] = (sessionKey) => {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
    revokeSessionGrants(sessionKey);
    sessions.delete(sessionKey);
    endedSessions.add(sessionKey);
    notify();
  };

  const subscribe: ScriptTrustStore["subscribe"] = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { isTrusted, trust, revoke, list, evaluate, adoptLocalEdit, endSession, subscribe };
}

// ---------- persistence -----------------------------------------------------------

/** In-memory persistence (tests, and the default until a durable backend is installed). */
export function createMemoryTrustPersistence(
  initial: Record<string, string> = {},
): TrustPersistence & { dump(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    async get(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async list() {
      return [...map.entries()].map(([key, value]) => ({ key, value }));
    },
    async delete(key) {
      map.delete(key);
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
}

// ---------- app-wide instance ---------------------------------------------------

let backend: TrustPersistence = createMemoryTrustPersistence();

// Delegates to the current backend so installing a durable backend later does
// not drop in-memory session decisions.
const delegatingPersistence: TrustPersistence = {
  get: (key) => backend.get(key),
  set: (key, value) => backend.set(key, value),
  list: () => backend.list(),
  delete: (key) => backend.delete(key),
};

let appStore: ScriptTrustStore | null = null;
let backendInstalled = false;

/** The store used by the app. */
export function getScriptTrustStore(): ScriptTrustStore {
  if (!appStore) appStore = createScriptTrustStore(delegatingPersistence);
  return appStore;
}

/**
 * Install the durable storage backend of the app-wide store. Meant to be
 * called once at startup (main.tsx). Only the first call takes effect; later
 * calls are ignored and return false, so the backend cannot be swapped while
 * the app runs.
 */
export function setScriptTrustPersistence(next: TrustPersistence): boolean {
  if (backendInstalled) return false;
  if (
    !next ||
    typeof next.get !== "function" ||
    typeof next.set !== "function" ||
    typeof next.list !== "function" ||
    typeof next.delete !== "function"
  ) {
    throw new Error("setScriptTrustPersistence: invalid persistence");
  }
  backend = next;
  backendInstalled = true;
  return true;
}

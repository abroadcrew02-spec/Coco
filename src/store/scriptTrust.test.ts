// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeActiveContent,
  createMemoryTrustPersistence,
  createScriptTrustStore,
  getScriptTrustStore,
  normalizeTrustPath,
  setScriptTrustPersistence,
  trustRecordKey,
  SCRIPT_TRUST_KEY_PREFIX,
  type ActiveContent,
  type TrustPersistence,
  type TrustSubject,
} from "./scriptTrust";
import { checkConnectionGrant, checkGrant } from "./scriptGrant";
import { connectionSignature } from "./dataConnectionSchedule";
import type { DataConnection } from "./dataConnections";

// ---------- fixtures -------------------------------------------------------------

interface S {
  id: string;
  source: string;
  name?: string;
  lastModified?: number;
}

function script(s: S) {
  return { id: s.id, name: s.name ?? s.id, source: s.source, lastModified: s.lastModified ?? 1 };
}

function conn(overrides: Partial<DataConnection> = {}): DataConnection {
  return {
    id: "c1",
    name: "conn",
    type: "web",
    sourcePath: "",
    targetSheetId: "t1",
    targetSheetName: "Data",
    lastRefreshedAt: null,
    steps: [],
    web: { url: "https://example.test/data.json", format: "json", headers: { Accept: "x", B: "y" } },
    schedule: { onOpen: true, intervalMinutes: 0 },
    ...overrides,
  };
}

function snap(scripts: S[], connections: DataConnection[] = [], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    sheets: { s1: { name: "Sheet1", cellData: {} } },
    ...extra,
    _scripts: scripts.map(script),
    _connections: connections,
  });
}

const A = { id: "a", source: "api.log('a');" };
const B = { id: "b", source: "api.log('b');" };

let seq = 0;
function subject(overrides: Partial<TrustSubject> = {}): TrustSubject {
  return {
    sessionKey: overrides.sessionKey ?? `trust-test-${++seq}`,
    path: overrides.path === undefined ? "C:\\Books\\Report.coco" : overrides.path,
    lookupPath: overrides.lookupPath ?? null,
  };
}

function newStore(p: TrustPersistence = createMemoryTrustPersistence()) {
  return { store: createScriptTrustStore(p), p };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------- fingerprint ----------------------------------------------------------

describe("computeActiveContent — fingerprint", () => {
  it("is deterministic and has the sha256:<hex> form", async () => {
    const a = await computeActiveContent(snap([A, B]));
    const b = await computeActiveContent(snap([A, B]));
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.scriptCount).toBe(2);
    expect(a.isEmpty).toBe(false);
  });

  it("ignores script order, names and timestamps", async () => {
    const base = await computeActiveContent(snap([A, B]));
    const reordered = await computeActiveContent(
      snap([{ ...B, name: "renamed", lastModified: 99 }, A]),
    );
    expect(reordered.fingerprint).toBe(base.fingerprint);
  });

  it("changes when a source changes, a script is added or an id changes", async () => {
    const base = (await computeActiveContent(snap([A]))).fingerprint;
    expect((await computeActiveContent(snap([{ ...A, source: "api.log('A');" }]))).fingerprint).not.toBe(base);
    expect((await computeActiveContent(snap([A, B]))).fingerprint).not.toBe(base);
    expect((await computeActiveContent(snap([{ ...A, id: "z" }]))).fingerprint).not.toBe(base);
  });

  it("includes auto-refresh connection definitions but not display fields", async () => {
    const base = await computeActiveContent(snap([], [conn()]));
    expect(base.autoConnectionCount).toBe(1);
    expect(base.connectionSignatures).toEqual([connectionSignature(conn())]);

    const display = await computeActiveContent(
      snap([], [
        conn({
          name: "other",
          targetSheetId: "t9",
          targetSheetName: "Other",
          lastRefreshedAt: 123,
          steps: [{ kind: "select", columns: ["a"] }],
          web: { url: "https://example.test/data.json", format: "json", headers: { B: "y", Accept: "x" } },
        }),
      ]),
    );
    expect(display.fingerprint).toBe(base.fingerprint);

    const url = await computeActiveContent(
      snap([], [conn({ web: { url: "https://other.test/", format: "json", headers: {} } })]),
    );
    expect(url.fingerprint).not.toBe(base.fingerprint);
    const interval = await computeActiveContent(
      snap([], [conn({ schedule: { onOpen: true, intervalMinutes: 5 } })]),
    );
    expect(interval.fingerprint).not.toBe(base.fingerprint);
  });

  it("does not count manual-only connections", async () => {
    const manual = await computeActiveContent(
      snap([], [conn({ schedule: { onOpen: false, intervalMinutes: 0 } }), conn({ id: "c2", schedule: undefined })]),
    );
    expect(manual.isEmpty).toBe(true);
    expect(manual.fingerprint).toBe("none");
  });

  it("returns none without parsing when neither key can be present", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const c = await computeActiveContent(JSON.stringify({ sheets: { s1: { cellData: { 0: { 0: { v: "x" } } } } } }));
    expect(c.isEmpty).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect((await computeActiveContent(null)).isEmpty).toBe(true);
    expect((await computeActiveContent("")).isEmpty).toBe(true);
  });

  it("still finds scripts behind a \\u-escaped key", async () => {
    const escaped = snap([A]).replace('"_scripts"', '"\\u005fscripts"');
    expect(escaped.includes('"_scripts"')).toBe(false);
    const c = await computeActiveContent(escaped);
    expect(c.isEmpty).toBe(false);
    expect(c.scriptSources).toEqual([A.source]);
  });

  it("throws on unparsable input that may hold scripts, and treats non-objects as empty", async () => {
    await expect(computeActiveContent('{"_scripts": [')).rejects.toThrow();
    expect((await computeActiveContent('"_scripts"')).isEmpty).toBe(true);
    expect((await computeActiveContent('["_scripts"]')).isEmpty).toBe(true);
  });

  it("uses the same script filter as the runtime (malformed entries dropped)", async () => {
    const json = JSON.stringify({ _scripts: [script(A), { id: 1, source: "x" }, null] });
    const c = await computeActiveContent(json);
    expect(c.scriptSources).toEqual([A.source]);
    expect(c.scriptCount).toBe(1);
  });
});

// ---------- identifiers ----------------------------------------------------------

describe("normalizeTrustPath / trustRecordKey", () => {
  it("normalizes Windows paths (separators, repeats, case)", () => {
    expect(normalizeTrustPath("  C:\\Users\\Ann\\\\Book.COCO ")).toBe("c:/users/ann/book.coco");
    expect(normalizeTrustPath("c:/Users/ann/book.coco")).toBe("c:/users/ann/book.coco");
    expect(normalizeTrustPath("\\\\server\\Share\\B.coco")).toBe("/server/share/b.coco");
  });

  it("keeps case for POSIX paths and returns empty for blank input", () => {
    expect(normalizeTrustPath("/Users/Ann//Book.coco")).toBe("/Users/Ann/Book.coco");
    expect(normalizeTrustPath("   ")).toBe("");
  });

  it("derives a stable prefixed hex key", async () => {
    const k1 = await trustRecordKey("c:/a/b.coco");
    const k2 = await trustRecordKey("c:/a/b.coco");
    const k3 = await trustRecordKey("c:/a/c.coco");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1.startsWith(SCRIPT_TRUST_KEY_PREFIX)).toBe(true);
    expect(k1.slice(SCRIPT_TRUST_KEY_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------- store transitions -----------------------------------------------------

describe("createScriptTrustStore — evaluate", () => {
  it("none: no active content, no grant", async () => {
    const { store } = newStore();
    const r = await store.evaluate(subject(), JSON.stringify({ sheets: {} }));
    expect(r.state).toEqual({ kind: "none" });
    expect(r.grant).toBeNull();
  });

  it("untrusted/new by default; canAlways follows the saved path", async () => {
    const { store } = newStore();
    const withPath = await store.evaluate(subject(), snap([A]));
    expect(withPath.state).toEqual({ kind: "untrusted", reason: "new", canAlways: true });
    expect(withPath.grant).toBeNull();
    const noPath = await store.evaluate(subject({ path: null }), snap([A]));
    expect(noPath.state).toEqual({ kind: "untrusted", reason: "new", canAlways: false });
  });

  it("untrusted → session (allow once) and the grant covers exactly the content", async () => {
    const { store } = newStore();
    const sub = subject();
    const json = snap([A], [conn()]);
    const first = await store.evaluate(sub, json);
    const { grant, degraded } = await store.trust(sub, first.content, "session");
    expect(degraded).toBe(false);
    expect(grant.scope).toBe("session");
    expect(checkGrant(grant, A.source).ok).toBe(true);
    expect(checkGrant(grant, B.source).ok).toBe(false);
    expect(checkConnectionGrant(grant, connectionSignature(conn())).ok).toBe(true);

    const again = await store.evaluate(sub, json);
    expect(again.state).toEqual({ kind: "trusted", scope: "session" });
    expect(again.grant).toBe(grant); // same object → no effect churn
  });

  it("allow once does not carry over to another session", async () => {
    const { store } = newStore();
    const s1 = subject();
    const json = snap([A]);
    await store.trust(s1, (await store.evaluate(s1, json)).content, "session");
    const other = await store.evaluate(subject(), json);
    expect(other.state.kind).toBe("untrusted");
  });

  it("untrusted → always writes a record that a later session honours", async () => {
    const { store, p } = newStore();
    const s1 = subject({ path: "C:\\Books\\Report.coco" });
    const json = snap([A]);
    const r = await store.trust(s1, (await store.evaluate(s1, json)).content, "always");
    expect(r.grant.scope).toBe("always");
    expect(r.degraded).toBe(false);
    const keys = Object.keys((p as ReturnType<typeof createMemoryTrustPersistence>).dump());
    expect(keys).toEqual([await trustRecordKey("c:/books/report.coco")]);

    const s2 = subject({ path: "c:/books/REPORT.coco" });
    const later = await store.evaluate(s2, json);
    expect(later.state).toEqual({ kind: "trusted", scope: "always" });
    expect(checkGrant(later.grant, A.source).ok).toBe(true);
  });

  it("always → untrusted/changed when the content differs from the record", async () => {
    const { store } = newStore();
    const s1 = subject();
    await store.trust(s1, (await store.evaluate(s1, snap([A]))).content, "always");
    const changed = await store.evaluate(subject(), snap([{ ...A, source: "api.log('evil');" }]));
    expect(changed.state).toEqual({ kind: "untrusted", reason: "changed", canAlways: true });
  });

  it("always is refused without a saved path (new / template / restored copy)", async () => {
    const { store } = newStore();
    const sub = subject({ path: null, lookupPath: "C:\\Books\\Report.coco" });
    const r = await store.evaluate(sub, snap([A]));
    await expect(store.trust(sub, r.content, "always")).rejects.toThrow();
  });

  it("lookupPath (restore / history) finds a record but does not grant always-writes", async () => {
    const { store, p } = newStore();
    const orig = subject({ path: "C:\\Books\\Report.coco" });
    const json = snap([A]);
    await store.trust(orig, (await store.evaluate(orig, json)).content, "always");
    const before = Object.keys((p as ReturnType<typeof createMemoryTrustPersistence>).dump()).length;

    const restored = subject({ path: null, lookupPath: "C:\\Books\\Report.coco" });
    const r = await store.evaluate(restored, json);
    expect(r.state).toEqual({ kind: "trusted", scope: "always" });

    const differs = await store.evaluate(subject({ path: null, lookupPath: "C:\\Books\\Report.coco" }), snap([B]));
    expect(differs.state).toEqual({ kind: "untrusted", reason: "changed", canAlways: false });
    expect(Object.keys((p as ReturnType<typeof createMemoryTrustPersistence>).dump()).length).toBe(before);
  });

  it("keeps trust across a save-as path change in the same session", async () => {
    const { store } = newStore();
    const sub = subject({ path: null });
    const json = snap([A]);
    await store.trust(sub, (await store.evaluate(sub, json)).content, "session");
    const moved = await store.evaluate({ ...sub, path: "D:\\New\\Place.coco" }, json);
    expect(moved.state).toEqual({ kind: "trusted", scope: "session" });
  });
});

describe("createScriptTrustStore — self (in-app edits)", () => {
  it("trusted → self when the user edits in the app", async () => {
    const { store } = newStore();
    const sub = subject();
    const prev = snap([A]);
    await store.trust(sub, (await store.evaluate(sub, prev)).content, "session");
    const next = snap([{ ...A, source: "api.log('edited');" }]);
    await store.adoptLocalEdit(sub, prev, next);
    const r = await store.evaluate(sub, next);
    expect(r.state).toEqual({ kind: "trusted", scope: "self" });
    expect(checkGrant(r.grant, "api.log('edited');").ok).toBe(true);
  });

  it("none → self when the user adds the first script", async () => {
    const { store } = newStore();
    const sub = subject({ path: null });
    const prev = JSON.stringify({ sheets: {} });
    const next = snap([A]);
    await store.adoptLocalEdit(sub, prev, next);
    expect((await store.evaluate(sub, next)).state).toEqual({ kind: "trusted", scope: "self" });
  });

  it("untrusted stays untrusted after an in-app edit", async () => {
    const { store } = newStore();
    const sub = subject();
    const prev = snap([A]);
    expect((await store.evaluate(sub, prev)).state.kind).toBe("untrusted");
    const next = snap([A, B]);
    await store.adoptLocalEdit(sub, prev, next);
    const r = await store.evaluate(sub, next);
    expect(r.state.kind).toBe("untrusted");
    expect(r.grant).toBeNull();
  });

  it("an escaped-key snapshot is not mistaken for none (no self promotion)", async () => {
    const { store } = newStore();
    const sub = subject();
    const prev = snap([A]).replace('"_scripts"', '"\\u005fscripts"');
    const next = snap([A, B]);
    await store.adoptLocalEdit(sub, prev, next);
    expect((await store.evaluate(sub, next)).state.kind).toBe("untrusted");
  });

  it("an evaluate started right after the edit waits for the adoption", async () => {
    const { store } = newStore();
    const sub = subject({ path: null });
    const prev = JSON.stringify({ sheets: {} });
    const next = snap([A]);
    void store.adoptLocalEdit(sub, prev, next); // not awaited, like EditorScreen
    const r = await store.evaluate(sub, next);
    expect(r.state).toEqual({ kind: "trusted", scope: "self" });
  });
});

describe("createScriptTrustStore — revoke / endSession / list", () => {
  it("revoke removes the record, revokes live grants and drops the session to untrusted", async () => {
    const { store, p } = newStore();
    const sub = subject();
    const json = snap([A]);
    const { grant } = await store.trust(sub, (await store.evaluate(sub, json)).content, "always");
    const notified = vi.fn();
    store.subscribe(notified);

    await store.revoke("c:/books/report.COCO");
    expect(notified).toHaveBeenCalled();
    expect(checkGrant(grant, A.source).ok).toBe(false);
    expect(Object.keys((p as ReturnType<typeof createMemoryTrustPersistence>).dump())).toEqual([]);
    expect((await store.evaluate(sub, json)).state).toEqual({
      kind: "untrusted",
      reason: "new",
      canAlways: true,
    });
    expect(await store.list()).toEqual([]);
  });

  it("revoke drops allow-once decisions of the open workbook at that path", async () => {
    const { store } = newStore();
    const sub = subject();
    const json = snap([A]);
    const { grant } = await store.trust(sub, (await store.evaluate(sub, json)).content, "session");
    await store.revoke(sub.path!);
    expect(checkGrant(grant, A.source).ok).toBe(false);
    expect((await store.evaluate(sub, json)).state.kind).toBe("untrusted");
  });

  it("revoke drops self decisions made by in-app edits (#355)", async () => {
    const { store } = newStore();
    const sub = subject();
    const prev = snap([A]);
    await store.trust(sub, (await store.evaluate(sub, prev)).content, "always");
    const next = snap([{ ...A, source: "api.log('edited');" }]);
    await store.adoptLocalEdit(sub, prev, next);
    const selfEval = await store.evaluate(sub, next);
    expect(selfEval.state).toEqual({ kind: "trusted", scope: "self" });

    await store.revoke(sub.path!);
    expect(checkGrant(selfEval.grant, "api.log('edited');").ok).toBe(false);
    const after = await store.evaluate(sub, next);
    expect(after.state.kind).toBe("untrusted");
    expect(after.grant).toBeNull();
    // Also the pre-edit content, whose record is gone now.
    expect((await store.evaluate(sub, prev)).state.kind).toBe("untrusted");
  });

  it("revoke drops a restored copy trusted through its lookup path", async () => {
    const { store } = newStore();
    const orig = subject({ path: "C:\\Books\\Report.coco" });
    const json = snap([A]);
    await store.trust(orig, (await store.evaluate(orig, json)).content, "always");
    const restored = subject({ path: null, lookupPath: "C:\\Books\\Report.coco" });
    expect((await store.evaluate(restored, json)).state.kind).toBe("trusted");
    await store.revoke("C:\\Books\\Report.coco");
    expect((await store.evaluate(restored, json)).state.kind).toBe("untrusted");
  });

  it("revoke leaves open workbooks at other paths alone", async () => {
    const { store } = newStore();
    const other = subject({ path: "C:\\Books\\Other.coco" });
    const json = snap([A]);
    const { grant } = await store.trust(other, (await store.evaluate(other, json)).content, "session");
    await store.revoke("C:\\Books\\Report.coco");
    expect(checkGrant(grant, A.source).ok).toBe(true);
    expect((await store.evaluate(other, json)).state).toEqual({ kind: "trusted", scope: "session" });
  });

  it("revoke still drops session decisions when deleting the record fails", async () => {
    const base = createMemoryTrustPersistence();
    const p: TrustPersistence = {
      ...base,
      delete: async () => {
        throw new Error("locked");
      },
    };
    const { store } = newStore(p);
    const sub = subject();
    const json = snap([A]);
    const { grant } = await store.trust(sub, (await store.evaluate(sub, json)).content, "session");
    await expect(store.revoke(sub.path!)).rejects.toThrow("locked");
    expect(checkGrant(grant, A.source).ok).toBe(false);
    expect((await store.evaluate(sub, json)).state.kind).toBe("untrusted");
  });

  it("an adoption that is deciding while a revoke lands does not promote", async () => {
    const json = snap([A]);
    const fp = (await computeActiveContent(json)).fingerprint;
    const pathNorm = "c:/books/report.coco";
    const key = await trustRecordKey(pathNorm);
    const base = createMemoryTrustPersistence({
      [key]: JSON.stringify({
        v: 1,
        path: pathNorm,
        pathNorm,
        fingerprint: fp,
        trustedAt: "2026-09-29T00:00:00.000Z",
        summary: { scripts: 1, autoConnections: 0 },
      }),
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const readStarted = new Promise<void>((r) => (entered = r));
    const p: TrustPersistence = {
      ...base,
      get: async (k) => {
        const v = await base.get(k); // the record as it was before the revoke
        entered();
        await gate;
        return v;
      },
    };
    const { store } = newStore(p);
    const sub = subject();
    const next = snap([A, B]);
    // prev is trusted only through the record, so the adoption has to read it.
    const adopting = store.adoptLocalEdit(sub, json, next);
    await readStarted;
    await store.revoke(sub.path!); // lands while the adoption holds the old record
    release();
    await adopting;
    expect((await store.evaluate(sub, next)).state.kind).toBe("untrusted");
  });

  it("endSession revokes grants and refuses further decisions for that key", async () => {
    const { store } = newStore();
    const sub = subject();
    const json = snap([A]);
    const first = await store.evaluate(sub, json);
    const { grant } = await store.trust(sub, first.content, "session");
    store.endSession(sub.sessionKey);
    expect(checkGrant(grant, A.source)).toEqual({ ok: false, reason: "revoked" });
    const after = await store.evaluate(sub, json);
    expect(after.grant).toBeNull();
    expect(after.state.kind).toBe("untrusted");
    await expect(store.trust(sub, first.content, "session")).rejects.toThrow();
  });

  it("list returns valid records and skips foreign, corrupt or misplaced rows", async () => {
    const good = await trustRecordKey("c:/a.coco");
    const misplaced = await trustRecordKey("c:/other.coco");
    const record = (pathNorm: string) =>
      JSON.stringify({
        v: 1,
        path: pathNorm,
        pathNorm,
        fingerprint: "sha256:" + "a".repeat(64),
        trustedAt: "2026-09-29T00:00:00.000Z",
        summary: { scripts: 1, autoConnections: 0 },
      });
    const p = createMemoryTrustPersistence({
      [good]: record("c:/a.coco"),
      [misplaced]: record("c:/a.coco"),
      [SCRIPT_TRUST_KEY_PREFIX + "b".repeat(64)]: "{not json",
      "autosave.interval_ms": "30000",
    });
    const { store } = newStore(p);
    const list = await store.list();
    expect(list.map((r) => r.pathNorm)).toEqual(["c:/a.coco"]);
  });
});

describe("createScriptTrustStore — fail closed", () => {
  const recordFor = async (pathNorm: string, fields: Record<string, unknown>) => ({
    [await trustRecordKey(pathNorm)]: JSON.stringify({
      v: 1,
      path: pathNorm,
      pathNorm,
      fingerprint: "",
      trustedAt: "2026-09-29T00:00:00.000Z",
      summary: { scripts: 1, autoConnections: 0 },
      ...fields,
    }),
  });

  it("ignores corrupt or mismatched records (treated as no record)", async () => {
    const json = snap([A]);
    const fp = (await computeActiveContent(json)).fingerprint;
    const pathNorm = "c:/books/report.coco";
    const variants: Record<string, string>[] = [
      { [await trustRecordKey(pathNorm)]: "{broken" },
      await recordFor(pathNorm, { fingerprint: fp, v: 2 }),
      await recordFor(pathNorm, { fingerprint: fp, pathNorm: "c:/elsewhere.coco" }),
      await recordFor(pathNorm, { fingerprint: "sha1:abc" }),
    ];
    for (const initial of variants) {
      const { store } = newStore(createMemoryTrustPersistence(initial));
      const r = await store.evaluate(subject(), json);
      expect(r.state).toEqual({ kind: "untrusted", reason: "new", canAlways: true });
      expect(r.grant).toBeNull();
    }
  });

  it("a failing read is untrusted", async () => {
    const p: TrustPersistence = {
      get: async () => {
        throw new Error("io");
      },
      set: async () => {},
      list: async () => [],
      delete: async () => {},
    };
    const { store } = newStore(p);
    const r = await store.evaluate(subject(), snap([A]));
    expect(r.state.kind).toBe("untrusted");
    expect(r.grant).toBeNull();
  });

  it("a failing save degrades always to session", async () => {
    const p: TrustPersistence = {
      get: async () => null,
      set: async () => {
        throw new Error("disk full");
      },
      list: async () => [],
      delete: async () => {},
    };
    const { store } = newStore(p);
    const sub = subject();
    const json = snap([A]);
    const r = await store.trust(sub, (await store.evaluate(sub, json)).content, "always");
    expect(r.degraded).toBe(true);
    expect(r.grant.scope).toBe("session");
    expect((await store.evaluate(sub, json)).state).toEqual({ kind: "trusted", scope: "session" });
  });

  it("is untrusted when Web Crypto is unavailable", async () => {
    const { store } = newStore();
    vi.stubGlobal("crypto", {});
    const r = await store.evaluate(subject(), snap([A]));
    expect(r.state).toEqual({ kind: "untrusted", reason: "new", canAlways: false });
    expect(r.grant).toBeNull();
  });

  it("is untrusted when the snapshot cannot be parsed", async () => {
    const { store } = newStore();
    const r = await store.evaluate(subject(), '{"_scripts": [');
    expect(r.state.kind).toBe("untrusted");
    expect(r.grant).toBeNull();
  });

  it("only trusts content this store evaluated for the same session (#355)", async () => {
    const { store } = newStore();
    const json = snap([A]);
    const s1 = subject();
    const s2 = subject();
    const fromS1 = (await store.evaluate(s1, json)).content;
    await expect(store.trust(s2, fromS1, "session")).rejects.toThrow(/session/);
    // Computed directly (not through evaluate), or by another store instance.
    await expect(store.trust(s1, await computeActiveContent(json), "session")).rejects.toThrow();
    const other = newStore().store;
    const fromOther = (await other.evaluate(s1, json)).content;
    await expect(store.trust(s1, fromOther, "session")).rejects.toThrow();
    // The matching session still works.
    await expect(store.trust(s1, fromS1, "session")).resolves.toMatchObject({ degraded: false });
  });

  it("rejects hand-made or failed content", async () => {
    const { store } = newStore();
    const fake: ActiveContent = {
      fingerprint: "sha256:" + "0".repeat(64),
      scriptSources: ["api.log('x')"],
      connectionSignatures: [],
      scriptCount: 1,
      autoConnectionCount: 0,
      isEmpty: false,
    };
    await expect(store.trust(subject(), fake, "session")).rejects.toThrow();
    const failed = await store.evaluate(subject(), '{"_scripts": [');
    await expect(store.trust(subject(), failed.content, "session")).rejects.toThrow();
  });

  it("isTrusted mirrors evaluate for session and record decisions", async () => {
    const { store } = newStore();
    const sub = subject();
    const json = snap([A]);
    const r = await store.evaluate(sub, json);
    expect(await store.isTrusted(sub, r.content.fingerprint)).toBe(false);
    await store.trust(sub, r.content, "always");
    expect(await store.isTrusted(sub, r.content.fingerprint)).toBe(true);
    expect(await store.isTrusted(subject(), r.content.fingerprint)).toBe(true);
    expect(await store.isTrusted(subject({ path: "C:\\x.coco" }), r.content.fingerprint)).toBe(false);
  });
});

describe("setScriptTrustPersistence", () => {
  it("installs the backend once and ignores later calls", async () => {
    const pathNorm = "c:/books/once.coco";
    const key = await trustRecordKey(pathNorm);
    const record = JSON.stringify({
      v: 1,
      path: pathNorm,
      pathNorm,
      fingerprint: "sha256:" + "c".repeat(64),
      trustedAt: "2026-09-29T00:00:00.000Z",
      summary: { scripts: 1, autoConnections: 0 },
    });
    const first = createMemoryTrustPersistence({ [key]: record });
    const second = createMemoryTrustPersistence();

    expect(() => setScriptTrustPersistence({} as TrustPersistence)).toThrow();
    expect(setScriptTrustPersistence(first)).toBe(true);
    expect(setScriptTrustPersistence(second)).toBe(false);
    const listed = await getScriptTrustStore().list();
    expect(listed.map((r) => r.pathNorm)).toEqual([pathNorm]);
  });
});

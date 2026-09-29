// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { createTauriTrustPersistence, TRUST_RECORD_KEY_RE } from "./scriptTrustPersistence";
import { createScriptTrustStore, normalizeTrustPath, trustRecordKey } from "./scriptTrust";

const KEY = "script_trust.v1." + "a".repeat(64);
const PATH = "C:\\books\\report.coco";

function snap(source: string) {
  return JSON.stringify({
    sheets: { s1: { cellData: {} } },
    _scripts: [{ id: "s1", name: "s1", source, lastModified: 1 }],
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("createTauriTrustPersistence", () => {
  it("maps get / set / list / delete onto the dedicated commands", async () => {
    const p = createTauriTrustPersistence();

    invokeMock.mockResolvedValueOnce('{"v":1}');
    expect(await p.get(KEY)).toBe('{"v":1}');
    expect(invokeMock).toHaveBeenLastCalledWith("script_trust_check", { key: KEY });

    invokeMock.mockResolvedValueOnce(undefined);
    await p.set(KEY, '{"v":1}');
    expect(invokeMock).toHaveBeenLastCalledWith("script_trust_grant", { key: KEY, value: '{"v":1}' });

    invokeMock.mockResolvedValueOnce([{ key: KEY, value: "{}" }]);
    expect(await p.list()).toEqual([{ key: KEY, value: "{}" }]);
    expect(invokeMock).toHaveBeenLastCalledWith("script_trust_list");

    invokeMock.mockResolvedValueOnce(undefined);
    await p.delete(KEY);
    expect(invokeMock).toHaveBeenLastCalledWith("script_trust_revoke", { key: KEY });

    const commands = invokeMock.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain("set_setting");
    expect(commands).not.toContain("get_setting");
    expect(commands).not.toContain("delete_setting");
  });

  it("returns null when no record is stored", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await createTauriTrustPersistence().get(KEY)).toBeNull();
  });

  it("refuses keys outside the record key family without invoking", async () => {
    const p = createTauriTrustPersistence();
    for (const bad of ["csv.export_encoding", "script_trust.v1.XYZ", "script_trust.v2." + "a".repeat(64)]) {
      await expect(p.get(bad)).rejects.toThrow();
      await expect(p.set(bad, "{}")).rejects.toThrow();
      await expect(p.delete(bad)).rejects.toThrow();
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("skips list rows with another shape or key family", async () => {
    invokeMock.mockResolvedValueOnce([
      { key: KEY, value: "{}" },
      { key: "csv.export_encoding", value: "utf8" },
      { path: "C:/x.coco", trusted_at: "2026-09-29T00:00:00Z" },
      null,
    ]);
    expect(await createTauriTrustPersistence().list()).toEqual([{ key: KEY, value: "{}" }]);
  });

  it("rejects a list that is not an array", async () => {
    invokeMock.mockResolvedValueOnce({ rows: [] });
    await expect(createTauriTrustPersistence().list()).rejects.toThrow();
  });

  it("produces keys that match the Rust-side pattern", async () => {
    const key = await trustRecordKey(normalizeTrustPath(PATH));
    expect(TRUST_RECORD_KEY_RE.test(key)).toBe(true);
  });
});

describe("trust store over the Tauri persistence (fail closed)", () => {
  it("a failing check means no record: the workbook stays untrusted", async () => {
    invokeMock.mockRejectedValue(new Error("command script_trust_check not found"));
    const store = createScriptTrustStore(createTauriTrustPersistence());
    const r = await store.evaluate({ sessionKey: "p-1", path: PATH, lookupPath: null }, snap("api.log(1)"));
    expect(r.state).toEqual({ kind: "untrusted", reason: "new", canAlways: true });
    expect(r.grant).toBeNull();
  });

  it("a failing grant downgrades always to this session", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "script_trust_check") return null;
      if (cmd === "script_trust_grant") throw new Error("disk full");
      return undefined;
    });
    const store = createScriptTrustStore(createTauriTrustPersistence());
    const subject = { sessionKey: "p-2", path: PATH, lookupPath: null };
    const content = (await store.evaluate(subject, snap("api.log(2)"))).content;
    const r = await store.trust(subject, content, "always");
    expect(r.degraded).toBe(true);
    expect(r.grant.scope).toBe("session");
  });

  it("a stored record written by grant is read back through check", async () => {
    const rows = new Map<string, string>();
    invokeMock.mockImplementation(async (cmd: string, args?: { key?: string; value?: string }) => {
      if (cmd === "script_trust_check") return rows.get(args!.key!) ?? null;
      if (cmd === "script_trust_grant") rows.set(args!.key!, args!.value!);
      if (cmd === "script_trust_list") return [...rows].map(([key, value]) => ({ key, value }));
      if (cmd === "script_trust_revoke") rows.delete(args!.key!);
      return undefined;
    });
    const store = createScriptTrustStore(createTauriTrustPersistence());
    const json = snap("api.log(3)");
    const p3 = { sessionKey: "p-3", path: PATH, lookupPath: null };
    const content = (await store.evaluate(p3, json)).content;
    await store.trust(p3, content, "always");

    const again = await store.evaluate({ sessionKey: "p-4", path: PATH, lookupPath: null }, json);
    expect(again.state).toEqual({ kind: "trusted", scope: "always" });
    const listed = await store.list();
    expect(listed.map((r) => r.path)).toEqual([PATH]);
    const stored = JSON.parse([...rows.values()][0]);
    expect(Object.keys(stored).sort()).toEqual(
      ["fingerprint", "path", "pathNorm", "summary", "trustedAt", "v"].sort(),
    );

    await store.revoke(PATH);
    expect(rows.size).toBe(0);
  });

  it("a failing revoke rejects", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "script_trust_revoke") throw new Error("locked");
      return null;
    });
    const store = createScriptTrustStore(createTauriTrustPersistence());
    await expect(store.revoke(PATH)).rejects.toThrow("locked");
  });
});

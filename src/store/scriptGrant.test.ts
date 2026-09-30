// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  issueGrant,
  checkGrant,
  checkConnectionGrant,
  revokeSessionGrants,
} from "./scriptGrant";

let seq = 0;
const freshKey = () => `grant-test-${++seq}`;

const approved = (sources: string[], connectionSignatures: string[] = []) => ({
  sources,
  connectionSignatures,
});

describe("issueGrant / checkGrant", () => {
  it("accepts an issued grant for an approved source", () => {
    const g = issueGrant(freshKey(), "sha256:a", "session", approved(["api.log(1)"]));
    expect(checkGrant(g, "api.log(1)")).toEqual({ ok: true });
  });

  it("returns a frozen grant carrying session, fingerprint and scope", () => {
    const key = freshKey();
    const g = issueGrant(key, "sha256:f", "always", approved([]));
    expect(Object.isFrozen(g)).toBe(true);
    expect(g.sessionKey).toBe(key);
    expect(g.fingerprint).toBe("sha256:f");
    expect(g.scope).toBe("always");
  });

  it("reports missing for null / undefined", () => {
    expect(checkGrant(null, "x")).toEqual({ ok: false, reason: "missing" });
    expect(checkGrant(undefined, "x")).toEqual({ ok: false, reason: "missing" });
  });

  it("reports forged for look-alike objects, copies, proxies and primitives", () => {
    const key = freshKey();
    const g = issueGrant(key, "sha256:a", "session", approved(["x"]));
    const lookAlike = { __brand: "ScriptExecutionGrant", sessionKey: key, fingerprint: "sha256:a", scope: "session" };
    expect(checkGrant(lookAlike, "x")).toEqual({ ok: false, reason: "forged" });
    expect(checkGrant({ ...g }, "x")).toEqual({ ok: false, reason: "forged" });
    expect(checkGrant(JSON.parse(JSON.stringify(g)), "x")).toEqual({ ok: false, reason: "forged" });
    expect(checkGrant(new Proxy(g, {}), "x")).toEqual({ ok: false, reason: "forged" });
    expect(checkGrant("grant", "x")).toEqual({ ok: false, reason: "forged" });
    expect(checkGrant(42, "x")).toEqual({ ok: false, reason: "forged" });
  });

  it("does not read properties of the value being checked", () => {
    let touched = false;
    const trap = new Proxy(
      {},
      {
        get() {
          touched = true;
          return undefined;
        },
        has() {
          touched = true;
          return false;
        },
      },
    );
    expect(checkGrant(trap, "x").ok).toBe(false);
    expect(touched).toBe(false);
  });

  it("reports source-mismatch for any text not approved verbatim", () => {
    const g = issueGrant(freshKey(), "sha256:a", "session", approved(["api.log(1)"]));
    expect(checkGrant(g, "api.log(2)")).toEqual({ ok: false, reason: "source-mismatch" });
    expect(checkGrant(g, "api.log(1) ")).toEqual({ ok: false, reason: "source-mismatch" });
    expect(checkGrant(g, "")).toEqual({ ok: false, reason: "source-mismatch" });
    expect(checkGrant(g, 123 as unknown as string)).toEqual({ ok: false, reason: "source-mismatch" });
  });

  it("is not affected by later mutation of the approval arrays", () => {
    const sources = ["a"];
    const g = issueGrant(freshKey(), "sha256:a", "session", approved(sources));
    sources.push("b");
    expect(checkGrant(g, "b").ok).toBe(false);
    expect(checkGrant(g, "a").ok).toBe(true);
  });

  it("rejects invalid issue arguments", () => {
    expect(() => issueGrant("", "sha256:a", "session", approved([]))).toThrow();
    expect(() => issueGrant(freshKey(), "", "session", approved([]))).toThrow();
    expect(() =>
      issueGrant(freshKey(), "sha256:a", "root" as unknown as "session", approved([])),
    ).toThrow();
  });
});

describe("checkConnectionGrant", () => {
  it("accepts approved signatures and rejects others", () => {
    const g = issueGrant(freshKey(), "sha256:c", "session", approved([], ['["c1"]']));
    expect(checkConnectionGrant(g, '["c1"]')).toEqual({ ok: true });
    expect(checkConnectionGrant(g, '["c2"]')).toEqual({ ok: false, reason: "source-mismatch" });
    expect(checkConnectionGrant(null, '["c1"]')).toEqual({ ok: false, reason: "missing" });
    expect(checkConnectionGrant({}, '["c1"]')).toEqual({ ok: false, reason: "forged" });
  });

  it("keeps script and connection approvals separate", () => {
    const g = issueGrant(freshKey(), "sha256:c", "session", approved(["s"], ["k"]));
    expect(checkGrant(g, "k").ok).toBe(false);
    expect(checkConnectionGrant(g, "s").ok).toBe(false);
  });
});

describe("revokeSessionGrants (endSession)", () => {
  it("revokes every grant issued for the session so far", () => {
    const key = freshKey();
    const a = issueGrant(key, "sha256:a", "session", approved(["a"]));
    const b = issueGrant(key, "sha256:b", "self", approved(["b"], ["cb"]));
    revokeSessionGrants(key);
    expect(checkGrant(a, "a")).toEqual({ ok: false, reason: "revoked" });
    expect(checkGrant(b, "b")).toEqual({ ok: false, reason: "revoked" });
    expect(checkConnectionGrant(b, "cb")).toEqual({ ok: false, reason: "revoked" });
  });

  it("does not affect other sessions", () => {
    const k1 = freshKey();
    const k2 = freshKey();
    const g2 = issueGrant(k2, "sha256:a", "session", approved(["a"]));
    issueGrant(k1, "sha256:a", "session", approved(["a"]));
    revokeSessionGrants(k1);
    expect(checkGrant(g2, "a").ok).toBe(true);
  });

  it("lets grants issued after the revocation work again", () => {
    const key = freshKey();
    const old = issueGrant(key, "sha256:a", "always", approved(["a"]));
    revokeSessionGrants(key);
    const fresh = issueGrant(key, "sha256:a", "session", approved(["a"]));
    expect(checkGrant(old, "a").ok).toBe(false);
    expect(checkGrant(fresh, "a").ok).toBe(true);
  });

  it("ignores empty or non-string keys", () => {
    const key = freshKey();
    const g = issueGrant(key, "sha256:a", "session", approved(["a"]));
    revokeSessionGrants("");
    revokeSessionGrants(undefined as unknown as string);
    expect(checkGrant(g, "a").ok).toBe(true);
  });
});

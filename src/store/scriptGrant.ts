// #355 — Script execution grants.
//
// A grant is an opaque token that says "the user allowed this exact set of
// workbook scripts / auto-refreshing data connections to run in this document
// session". The runtime (`runScript`) and the data-connection scheduler refuse
// to do anything without one.
//
// Rules this module enforces:
//   - Only objects returned by `issueGrant` are accepted. Validation is an
//     identity lookup in a module-private WeakMap, so a look-alike object (same
//     fields, a copy, a Proxy, a JSON round-trip) is rejected as "forged".
//   - A grant only covers the script sources and connection signatures it was
//     issued for. Anything else is "source-mismatch".
//   - `revokeSessionGrants(sessionKey)` invalidates every grant issued for that
//     session so far. Grants issued afterwards for the same key are valid again
//     (the key stays usable, e.g. after a trust record is withdrawn).
//   - All checks are synchronous and never read properties of the value passed
//     in, so no caller-controlled getter runs during a check.
//
// Only `scriptTrust.ts` may call `issueGrant` (enforced by a source-reading
// test). This module has no imports on purpose.

export type GrantScope = "session" | "always" | "self";

export interface ScriptExecutionGrant {
  readonly __brand: "ScriptExecutionGrant";
  readonly sessionKey: string;
  readonly fingerprint: string;
  readonly scope: GrantScope;
}

export interface ApprovedContent {
  sources: readonly string[];
  connectionSignatures: readonly string[];
}

export type GrantVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "forged" | "revoked" | "source-mismatch" };

interface GrantRecord {
  sessionKey: string;
  epoch: number;
  sources: ReadonlySet<string>;
  connectionSignatures: ReadonlySet<string>;
}

// Records are keyed by the grant object itself so they are collected together
// with the grant. Nothing else holds a strong reference to a record.
const issued = new WeakMap<object, GrantRecord>();

// Revocation is per session and epoch based: revoking bumps the session's
// epoch, which invalidates every record stamped with an older epoch. Only one
// number per revoked session key is retained.
const sessionEpochs = new Map<string, number>();

const VALID_SCOPES: readonly GrantScope[] = ["session", "always", "self"];

function currentEpoch(sessionKey: string): number {
  return sessionEpochs.get(sessionKey) ?? 0;
}

function stringSet(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === "string") out.add(v);
  }
  return out;
}

/**
 * Issue a grant for the given session and approved content. Must only be
 * called from `scriptTrust.ts`, after a trust decision.
 */
export function issueGrant(
  sessionKey: string,
  fingerprint: string,
  scope: GrantScope,
  approved: ApprovedContent,
): ScriptExecutionGrant {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    throw new Error("issueGrant: sessionKey must be a non-empty string");
  }
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error("issueGrant: fingerprint must be a non-empty string");
  }
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error("issueGrant: unknown scope");
  }
  const grant: ScriptExecutionGrant = Object.freeze({
    __brand: "ScriptExecutionGrant" as const,
    sessionKey,
    fingerprint,
    scope,
  });
  issued.set(grant, {
    sessionKey,
    epoch: currentEpoch(sessionKey),
    sources: stringSet(approved.sources),
    connectionSignatures: stringSet(approved.connectionSignatures),
  });
  return grant;
}

function lookup(
  grant: unknown,
): { ok: true; record: GrantRecord } | { ok: false; reason: "missing" | "forged" | "revoked" } {
  if (grant === null || grant === undefined) return { ok: false, reason: "missing" };
  if (typeof grant !== "object") return { ok: false, reason: "forged" };
  const record = issued.get(grant);
  if (!record) return { ok: false, reason: "forged" };
  if (record.epoch !== currentEpoch(record.sessionKey)) {
    return { ok: false, reason: "revoked" };
  }
  return { ok: true, record };
}

/** Synchronous check that `grant` is a live grant covering `source`. */
export function checkGrant(grant: unknown, source: string): GrantVerdict {
  const found = lookup(grant);
  if (!found.ok) return found;
  if (typeof source !== "string" || !found.record.sources.has(source)) {
    return { ok: false, reason: "source-mismatch" };
  }
  return { ok: true };
}

/** Synchronous check that `grant` is a live grant covering the connection. */
export function checkConnectionGrant(
  grant: unknown,
  connectionSignature: string,
): GrantVerdict {
  const found = lookup(grant);
  if (!found.ok) return found;
  if (
    typeof connectionSignature !== "string" ||
    !found.record.connectionSignatures.has(connectionSignature)
  ) {
    return { ok: false, reason: "source-mismatch" };
  }
  return { ok: true };
}

/** Invalidate every grant issued so far for `sessionKey`. */
export function revokeSessionGrants(sessionKey: string): void {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
  sessionEpochs.set(sessionKey, currentEpoch(sessionKey) + 1);
}

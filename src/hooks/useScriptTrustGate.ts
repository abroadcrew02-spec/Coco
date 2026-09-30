// #355 — Trust gate state for the open workbook.
//
// Watches the workbook store (document session key, path, lookup path and
// snapshot), asks the trust store whether the content that runs by itself is
// allowed, and exposes the resulting execution grant. Consumers pass `grant`
// to the script runtime and the data-connection scheduler; with `grant: null`
// nothing runs.
//
// While a new snapshot of the same session is being evaluated, the previous
// result (including its grant) is kept. That is safe because a grant only
// covers the exact script sources and connection signatures it was issued
// for. A new session always starts from { evaluating, grant: null }.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkbookStore } from "../store/useWorkbookStore";
import {
  getScriptTrustStore,
  type ActiveContent,
  type ScriptTrustStore,
  type TrustEvaluation,
  type TrustState,
  type TrustSubject,
} from "../store/scriptTrust";
import type { ScriptExecutionGrant } from "../store/scriptGrant";

export interface ScriptTrustGate {
  state: TrustState;
  /** Content the current state refers to (what a banner would describe). */
  content: ActiveContent | null;
  grant: ScriptExecutionGrant | null;
  subject: TrustSubject | null;
  /** Allow the evaluated content for this document session only. */
  allowOnce: () => Promise<void>;
  /** Allow the evaluated content for this path. Falls back to "once" when
   *  the record cannot be saved (`degraded: true`). */
  allowAlways: () => Promise<{ degraded: boolean }>;
  /** Report an in-app edit (scripts or connections) of the open document. */
  adoptLocalEdit: (prevSnapshotJson: string | null, nextSnapshotJson: string | null) => Promise<void>;
}

interface GateResult {
  sessionKey: string | null;
  state: TrustState;
  content: ActiveContent | null;
  grant: ScriptExecutionGrant | null;
}

const NO_DOCUMENT: GateResult = {
  sessionKey: null,
  state: { kind: "none" },
  content: null,
  grant: null,
};

function evaluatingFor(sessionKey: string): GateResult {
  return { sessionKey, state: { kind: "evaluating" }, content: null, grant: null };
}

function sameState(a: TrustState, b: TrustState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "trusted" && b.kind === "trusted") return a.scope === b.scope;
  if (a.kind === "untrusted" && b.kind === "untrusted") {
    return a.reason === b.reason && a.canAlways === b.canAlways;
  }
  return true;
}

function merge(prev: GateResult, sessionKey: string, next: TrustEvaluation): GateResult {
  if (
    prev.sessionKey === sessionKey &&
    prev.grant === next.grant &&
    prev.content?.fingerprint === next.content.fingerprint &&
    sameState(prev.state, next.state)
  ) {
    return prev;
  }
  return { sessionKey, state: next.state, content: next.content, grant: next.grant };
}

export function useScriptTrustGate(
  store: ScriptTrustStore = getScriptTrustStore(),
): ScriptTrustGate {
  const sessionKey = useWorkbookStore((s) => s.docSessionKey);
  const path = useWorkbookStore((s) => s.currentHandle?.path ?? null);
  const lookupPath = useWorkbookStore((s) => s.trustLookupPath);
  const snapshotJson = useWorkbookStore((s) => s.currentSnapshotJson);

  const subject = useMemo<TrustSubject | null>(
    () => (sessionKey ? { sessionKey, path, lookupPath } : null),
    [sessionKey, path, lookupPath],
  );

  const [result, setResult] = useState<GateResult>(() =>
    sessionKey ? evaluatingFor(sessionKey) : NO_DOCUMENT,
  );
  // Bumped when the trust store reports a change (allow, revoke, local edit,
  // session end) so the current snapshot is evaluated again.
  const [revision, setRevision] = useState(0);

  useEffect(() => store.subscribe(() => setRevision((r) => r + 1)), [store]);

  useEffect(() => {
    if (!subject) {
      setResult(NO_DOCUMENT);
      return;
    }
    const key = subject.sessionKey;
    // Different session: drop the previous grant immediately (fail closed).
    setResult((prev) => (prev.sessionKey === key ? prev : evaluatingFor(key)));
    let cancelled = false;
    store.evaluate(subject, snapshotJson).then(
      (next) => {
        if (!cancelled) setResult((prev) => merge(prev, key, next));
      },
      () => {
        if (!cancelled) {
          setResult({
            sessionKey: key,
            state: { kind: "untrusted", reason: "new", canAlways: false },
            content: null,
            grant: null,
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, subject, snapshotJson, revision]);

  // Only report state that belongs to the current session.
  const current: GateResult =
    subject && result.sessionKey === subject.sessionKey
      ? result
      : subject
        ? evaluatingFor(subject.sessionKey)
        : NO_DOCUMENT;

  const allow = useCallback(
    async (scope: "session" | "always"): Promise<{ degraded: boolean }> => {
      if (!subject || current.state.kind !== "untrusted" || !current.content) {
        return { degraded: false };
      }
      const r = await store.trust(subject, current.content, scope);
      return { degraded: r.degraded };
    },
    [store, subject, current.state.kind, current.content],
  );

  const allowOnce = useCallback(async () => {
    await allow("session");
  }, [allow]);

  const allowAlways = useCallback(() => allow("always"), [allow]);

  const adoptLocalEdit = useCallback(
    (prevJson: string | null, nextJson: string | null) =>
      subject ? store.adoptLocalEdit(subject, prevJson, nextJson) : Promise.resolve(),
    [store, subject],
  );

  return {
    state: current.state,
    content: current.content,
    grant: current.grant,
    subject,
    allowOnce,
    allowAlways,
    adoptLocalEdit,
  };
}

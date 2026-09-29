// #355 — Settings: workbooks whose automatic content (scripts and
// auto-refreshing data connections) is always allowed. Lists the persisted
// "always trust" records and revokes them. Adding a record only happens from
// the banner in the editor, never here.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getLocale, t } from "../i18n/locale";
import { getScriptTrustStore, type ScriptTrustStore, type TrustRecord } from "../store/scriptTrust";

interface Props {
  store?: Pick<ScriptTrustStore, "list" | "revoke">;
}

type Status = { kind: "ok" | "error"; message: string } | null;

function formatTrustedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(getLocale());
}

function newestFirst(records: TrustRecord[]): TrustRecord[] {
  return [...records].sort((a, b) =>
    a.trustedAt < b.trustedAt ? 1 : a.trustedAt > b.trustedAt ? -1 : 0,
  );
}

export default function TrustedWorkbooksSection({ store = getScriptTrustStore() }: Props) {
  // null while the first load is in flight.
  const [records, setRecords] = useState<TrustRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revokingPath, setRevokingPath] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const baseId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await store.list();
      if (!mountedRef.current) return;
      setRecords(newestFirst(list));
      setLoadFailed(false);
    } catch {
      if (!mountedRef.current) return;
      setRecords([]);
      setLoadFailed(true);
    }
  }, [store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoke = async (path: string) => {
    if (revokingPath !== null) return;
    setRevokingPath(path);
    setStatus(null);
    try {
      await store.revoke(path);
      if (!mountedRef.current) return;
      setStatus({ kind: "ok", message: t("toast.trustedWorkbooks.revoked") });
    } catch {
      if (!mountedRef.current) return;
      setStatus({ kind: "error", message: t("settings.trustedWorkbooks.revokeFailed") });
    }
    await reload();
    if (!mountedRef.current) return;
    setRevokingPath(null);
    // The row's button is gone; keep keyboard focus inside the section.
    listRef.current?.focus();
  };

  return (
    <div className="trusted-wb">
      <p className="settings-hint">{t("settings.trustedWorkbooks.description")}</p>
      <div ref={listRef} tabIndex={-1} className="trusted-wb-list-wrap">
        {records === null ? (
          <p className="settings-hint">{t("settings.trustedWorkbooks.loading")}</p>
        ) : loadFailed ? (
          <p className="settings-hint trusted-wb-error" role="alert">
            {t("settings.trustedWorkbooks.loadFailed")}
          </p>
        ) : records.length === 0 ? (
          <p className="settings-hint">{t("settings.trustedWorkbooks.empty")}</p>
        ) : (
          <ul className="trusted-wb-list">
            {records.map((r, i) => {
              const pathId = `${baseId}-path-${i}`;
              return (
                <li key={r.pathNorm} className="trusted-wb-row">
                  <div className="trusted-wb-text">
                    <span id={pathId} className="trusted-wb-path" title={r.path}>
                      {r.path}
                    </span>
                    <span className="trusted-wb-date">
                      {t("settings.trustedWorkbooks.trustedAt", formatTrustedAt(r.trustedAt))}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-btn"
                    aria-describedby={pathId}
                    disabled={revokingPath !== null}
                    onClick={() => void revoke(r.path)}
                  >
                    {t("settings.trustedWorkbooks.revokeButton")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="settings-hint">{t("settings.trustedWorkbooks.revokeHint")}</p>
      {status && (
        <p
          className={
            status.kind === "error" ? "settings-hint trusted-wb-error" : "settings-hint trusted-wb-ok"
          }
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.message}
        </p>
      )}
    </div>
  );
}

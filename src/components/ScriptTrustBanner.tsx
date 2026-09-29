// #355 — Non-modal banner shown while a workbook's automatic content
// (embedded scripts, auto-refreshing data connections) is not allowed to run.
//
// The banner never takes focus and never blocks editing. "有効にする" reveals
// two choices: allow for this document session, or always trust this file
// with this exact content (only when the workbook has a saved path). Closing
// the banner hides it for the current document session; nothing runs.

import { useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n/locale";
import { announce } from "../store/announce";
import { isContentUnavailable } from "../store/scriptTrust";
import { claimScriptTrustFirstRunNotice } from "../store/scriptTrustNotice";
import type { ScriptTrustGate } from "../hooks/useScriptTrustGate";
import "./ScriptTrustBanner.css";

export interface ScriptTrustBannerProps {
  gate: Pick<ScriptTrustGate, "state" | "content" | "subject" | "allowOnce" | "allowAlways">;
  /** Non-modal message after the banner has gone (status bar). */
  onNotice?: (message: string) => void;
}

type Pending = null | "session" | "always";

interface BannerUi {
  sessionKey: string | null;
  dismissed: boolean;
  choicesOpen: boolean;
  pending: Pending;
  error: string | null;
  firstRunNotice: boolean;
}

function initialUi(sessionKey: string | null): BannerUi {
  return {
    sessionKey,
    dismissed: false,
    choicesOpen: false,
    pending: null,
    error: null,
    firstRunNotice: false,
  };
}

export default function ScriptTrustBanner({ gate, onNotice }: ScriptTrustBannerProps) {
  const { state, content } = gate;
  const sessionKey = gate.subject?.sessionKey ?? null;

  // Banner state belongs to one document session: reset it when a different
  // document is opened in the same editor instance.
  const [stored, setUi] = useState<BannerUi>(() => initialUi(sessionKey));
  let ui = stored;
  if (stored.sessionKey !== sessionKey) {
    ui = initialUi(sessionKey);
    setUi(ui);
  }

  const visible = state.kind === "untrusted" && sessionKey !== null && !ui.dismissed;
  const reason = state.kind === "untrusted" ? state.reason : null;
  const unavailable = isContentUnavailable(content);
  const canAlways = state.kind === "untrusted" && state.canAlways && !unavailable;

  const baseId = useId();
  const choicesId = `${baseId}-choices`;
  const sessionDescId = `${baseId}-session-desc`;
  const alwaysDescId = `${baseId}-always-desc`;
  const alwaysHintId = `${baseId}-always-hint`;
  const noticeId = `${baseId}-notice`;
  const sourceHintId = `${baseId}-source-hint`;
  // The cautions below the choices apply to both of them.
  const cautionIds = `${noticeId} ${sourceHintId}`;

  // Screen readers learn about the banner without it taking focus.
  const announcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const token = `${sessionKey}:${reason}`;
    if (announcedRef.current === token) return;
    announcedRef.current = token;
    announce(t("scriptTrust.banner.message"));
  }, [visible, sessionKey, reason]);

  // One-time notice for the first banner after the update.
  useEffect(() => {
    if (!visible || sessionKey === null) return;
    let cancelled = false;
    void claimScriptTrustFirstRunNotice(sessionKey).then((show) => {
      if (cancelled || !show) return;
      setUi((u) => (u.sessionKey === sessionKey ? { ...u, firstRunNotice: true } : u));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, sessionKey]);

  if (!visible) return null;

  const enable = async (scope: "session" | "always") => {
    if (ui.pending !== null) return;
    if (scope === "always" && !canAlways) return;
    const key = sessionKey;
    setUi((u) => (u.sessionKey === key ? { ...u, pending: scope, error: null } : u));
    try {
      if (scope === "session") {
        await gate.allowOnce();
      } else {
        const r = await gate.allowAlways();
        if (r.degraded) onNotice?.(t("scriptTrust.notice.alwaysDegraded"));
      }
      setUi((u) => (u.sessionKey === key ? { ...u, pending: null } : u));
    } catch (e) {
      // Session ended, evaluation failed, or no saved path: say so instead
      // of closing quietly. Nothing was allowed.
      console.warn("[scriptTrust] enabling failed:", e);
      setUi((u) =>
        u.sessionKey === key
          ? { ...u, pending: null, error: t("scriptTrust.error.enableFailed") }
          : u,
      );
    }
  };

  const busy = ui.pending !== null;
  const alwaysBlocked = !canAlways || busy;

  return (
    <section className="script-trust-banner" aria-label={t("scriptTrust.banner.regionLabel")}>
      <div className="script-trust-banner__head">
        <div className="script-trust-banner__text">
          <p className="script-trust-banner__message">{t("scriptTrust.banner.message")}</p>
          {unavailable ? (
            <p className="script-trust-banner__detail">{t("scriptTrust.banner.unavailable")}</p>
          ) : (
            <p className="script-trust-banner__detail">
              {t(
                "scriptTrust.banner.summary",
                content?.scriptCount ?? 0,
                content?.autoConnectionCount ?? 0,
              )}
            </p>
          )}
          {!unavailable && reason === "changed" && (
            <p className="script-trust-banner__detail">{t("scriptTrust.banner.changedNotice")}</p>
          )}
          {ui.firstRunNotice && (
            <p className="script-trust-banner__first-run">{t("scriptTrust.banner.firstRunNotice")}</p>
          )}
        </div>
        {!unavailable && (
          <button
            type="button"
            className="script-trust-banner__btn script-trust-banner__btn--primary"
            aria-expanded={ui.choicesOpen}
            aria-controls={ui.choicesOpen ? choicesId : undefined}
            onClick={() => setUi((u) => ({ ...u, choicesOpen: !u.choicesOpen, error: null }))}
          >
            {t("scriptTrust.banner.enableButton")}
          </button>
        )}
      </div>
      {!unavailable && ui.choicesOpen && (
        <div
          id={choicesId}
          className="script-trust-banner__choices"
          role="group"
          aria-label={t("scriptTrust.choice.groupLabel")}
          aria-busy={busy || undefined}
        >
          <div className="script-trust-banner__choice">
            <button
              type="button"
              className="script-trust-banner__btn script-trust-banner__btn--primary"
              aria-describedby={`${sessionDescId} ${cautionIds}`}
              aria-disabled={busy || undefined}
              onClick={() => void enable("session")}
            >
              {t("scriptTrust.choice.sessionOnly.label")}
            </button>
            <p id={sessionDescId} className="script-trust-banner__choice-desc">
              {t("scriptTrust.choice.sessionOnly.description")}
            </p>
          </div>
          <div className="script-trust-banner__choice">
            {/* aria-disabled rather than disabled: the button stays focusable
                so keyboard users reach the reason, and the tooltip shows. */}
            <button
              type="button"
              className="script-trust-banner__btn"
              aria-describedby={
                canAlways
                  ? `${alwaysDescId} ${cautionIds}`
                  : `${alwaysDescId} ${alwaysHintId} ${cautionIds}`
              }
              aria-disabled={alwaysBlocked || undefined}
              title={canAlways ? undefined : t("scriptTrust.choice.alwaysTrust.disabledTooltip")}
              onClick={() => void enable("always")}
            >
              {t("scriptTrust.choice.alwaysTrust.label")}
            </button>
            <p id={alwaysDescId} className="script-trust-banner__choice-desc">
              {t("scriptTrust.choice.alwaysTrust.description")}
            </p>
            {!canAlways && (
              <p id={alwaysHintId} className="script-trust-banner__choice-desc">
                {t("scriptTrust.choice.alwaysTrust.disabledTooltip")}
              </p>
            )}
          </div>
          <p id={noticeId} className="script-trust-banner__caution">
            {t("scriptTrust.choice.alwaysTrust.noticeA")}
          </p>
          <p id={sourceHintId} className="script-trust-banner__caution">
            {t("scriptTrust.choice.trustSourceHint")}
          </p>
        </div>
      )}
      {ui.error && (
        <p className="script-trust-banner__error" role="alert">
          {ui.error}
        </p>
      )}
      <button
        type="button"
        className="script-trust-banner__dismiss"
        aria-label={t("scriptTrust.banner.dismissAriaLabel")}
        onClick={() => setUi((u) => ({ ...u, dismissed: true }))}
      >
        ×
      </button>
    </section>
  );
}

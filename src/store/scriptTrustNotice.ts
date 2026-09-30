// #355 — One-time notice shown with the first trust banner after the update
// that stopped scripts from running on open.
//
// The "seen" flag is an ordinary app setting (not a trust record), so it goes
// through get_setting / set_setting like the other UI preferences. The key
// must not start with "script_trust." — the Rust side reserves that prefix
// for the dedicated trust commands.

import { invoke } from "@tauri-apps/api/core";

export const SCRIPT_TRUST_NOTICE_SEEN_KEY = "scripts.trust_notice_seen";

let owner: string | null = null;
let decision: Promise<boolean> | null = null;

async function readAndMarkSeen(): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await invoke<string | null>("get_setting", { key: SCRIPT_TRUST_NOTICE_SEEN_KEY });
  } catch {
    // Unknown state: stay quiet rather than repeat the notice on every open.
    return false;
  }
  if (raw === "true") return false;
  try {
    await invoke("set_setting", { key: SCRIPT_TRUST_NOTICE_SEEN_KEY, value: "true" });
  } catch {
    // Best effort; the notice may show again next launch.
  }
  return true;
}

/**
 * Whether the banner for `sessionKey` should carry the first-run notice.
 * The first document session that asks owns the answer (repeated calls for
 * that session, e.g. React StrictMode effect re-runs, get the same answer);
 * every other session gets false. The flag is stored as seen as soon as the
 * notice is handed out.
 */
export function claimScriptTrustFirstRunNotice(sessionKey: string): Promise<boolean> {
  if (decision === null) {
    owner = sessionKey;
    decision = readAndMarkSeen();
  }
  return owner === sessionKey ? decision : Promise.resolve(false);
}

/** Test hook: forget which session claimed the notice. */
export function resetScriptTrustFirstRunNoticeForTests(): void {
  owner = null;
  decision = null;
}

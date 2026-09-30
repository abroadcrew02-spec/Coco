// #355 — Durable storage for "always trust" records.
//
// Records live in the app settings database but are read and written only
// through the dedicated `script_trust_*` commands. The generic
// `get_setting` / `set_setting` / `delete_setting` commands refuse
// `script_trust.*` keys on the Rust side, so a workbook script cannot grant
// itself execution by writing a record through the settings API.
//
// Command contract (Rust: src-tauri/src/commands/script_trust.rs):
//   script_trust_check({ key })          -> string | null   (record JSON)
//   script_trust_grant({ key, value })   -> void
//   script_trust_list()                  -> { key, value }[]
//   script_trust_revoke({ key })         -> void
// `key` is `script_trust.v1.<sha256 hex of the normalized path>`; `value` is
// the JSON text of a TrustRecord (see scriptTrust.ts).
//
// Errors propagate to the trust store, which already fails closed: a failed
// `get` counts as "no record", a failed `set` downgrades "always" to "this
// session", and a failed `delete` rejects `revoke`.

import { invoke } from "@tauri-apps/api/core";
import type { TrustPersistence } from "./scriptTrust";

/** Shape of a persisted record key. Anything else is refused before invoking. */
export const TRUST_RECORD_KEY_RE = /^script_trust\.v1\.[0-9a-f]{64}$/;

function requireRecordKey(key: string): string {
  if (typeof key !== "string" || !TRUST_RECORD_KEY_RE.test(key)) {
    throw new Error("Invalid trust record key");
  }
  return key;
}

function isRow(row: unknown): row is { key: string; value: string } {
  if (!row || typeof row !== "object") return false;
  const r = row as { key?: unknown; value?: unknown };
  return typeof r.key === "string" && typeof r.value === "string";
}

/** TrustPersistence backed by the Tauri `script_trust_*` commands. */
export function createTauriTrustPersistence(): TrustPersistence {
  return {
    async get(key) {
      const value = await invoke<unknown>("script_trust_check", { key: requireRecordKey(key) });
      return typeof value === "string" ? value : null;
    },
    async set(key, value) {
      if (typeof value !== "string") throw new Error("Trust record value must be a string");
      await invoke("script_trust_grant", { key: requireRecordKey(key), value });
    },
    async list() {
      const rows = await invoke<unknown>("script_trust_list");
      if (!Array.isArray(rows)) throw new Error("Unexpected trust record list");
      // Rows with another shape or another key family are skipped; the trust
      // store validates each record again before using it.
      return rows
        .filter(isRow)
        .filter((row) => TRUST_RECORD_KEY_RE.test(row.key))
        .map((row) => ({ key: row.key, value: row.value }));
    },
    async delete(key) {
      await invoke("script_trust_revoke", { key: requireRecordKey(key) });
    },
  };
}

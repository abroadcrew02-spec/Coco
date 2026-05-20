// #186 (scope 3) — encrypted persistence layer for the macro store.
//
// `macroRecord.ts` ships synchronous `loadAll` / `saveAll` that read/write
// plaintext JSON at `coco.macros`. WebCrypto is async, so encryption can't be
// folded into those functions without changing their signature and breaking
// the #131 MVP test surface. Instead this module provides async
// `loadAllSecure` / `saveAllSecure` that:
//
//   * encrypt with `macroCrypto` before writing,
//   * decrypt + verify on read,
//   * transparently MIGRATE a legacy plaintext `coco.macros` payload to the
//     encrypted envelope on first load, and
//   * fall back SAFELY (return `[]`) when decryption fails — a tampered or
//     unreadable store must never crash the editor or wipe-and-overwrite
//     silently; the user keeps their (unreadable) data on disk and can
//     re-record.
//
// MacroDialog calls the secure variants; `macroRecord`'s sync helpers stay
// for tests and for the pure parse/serialize logic they still own.

import {
  LOCAL_STORAGE_KEY,
  parse,
  serialize,
  type SavedMacro,
} from "./macroRecord";
import {
  decryptMacros,
  encryptMacros,
  isCryptoEnvelope,
  MacroTamperError,
} from "./macroCrypto";

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export interface SecureLoadResult {
  macros: SavedMacro[];
  /** True when the on-disk payload was legacy plaintext and got re-written
   *  encrypted during this load (caller may surface a one-time notice). */
  migrated: boolean;
  /** Set when the payload existed but could not be decrypted/verified — the
   *  store was left untouched and `macros` is `[]`. */
  tampered: boolean;
}

/**
 * Load + decrypt the macro store.
 *
 * Cases handled:
 *   1. empty / absent           -> `{ macros: [], migrated: false }`
 *   2. encrypted envelope       -> decrypt + verify
 *   3. legacy plaintext payload -> parse, then re-encrypt back to disk
 *      (`migrated: true`)
 *   4. tampered / undecryptable -> `{ macros: [], tampered: true }`, store
 *      left as-is so nothing is lost.
 */
export async function loadAllSecure(): Promise<SecureLoadResult> {
  const ls = safeLocalStorage();
  if (!ls) return { macros: [], migrated: false, tampered: false };

  let raw: string | null;
  try {
    raw = ls.getItem(LOCAL_STORAGE_KEY);
  } catch {
    return { macros: [], migrated: false, tampered: false };
  }
  if (!raw) return { macros: [], migrated: false, tampered: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not even JSON — treat as unreadable, keep on disk, fail safe.
    return { macros: [], migrated: false, tampered: true };
  }

  // Case 2 — encrypted envelope.
  if (isCryptoEnvelope(parsed)) {
    try {
      const plaintextJson = await decryptMacros(parsed);
      return { macros: parse(plaintextJson), migrated: false, tampered: false };
    } catch (err) {
      // Tamper vs. genuine error: either way we must not crash. A
      // MacroTamperError specifically flags improper modification.
      const tampered = err instanceof MacroTamperError;
      return { macros: [], migrated: false, tampered };
    }
  }

  // Case 3 — legacy plaintext `{ version, items }`. `parse` tolerates any
  // malformed shape (returns []). Re-encrypt so the next load takes case 2.
  const macros = parse(raw);
  try {
    const envelope = await encryptMacros(serialize(macros));
    ls.setItem(LOCAL_STORAGE_KEY, JSON.stringify(envelope));
    return { macros, migrated: true, tampered: false };
  } catch {
    // Crypto unavailable or quota — return the macros anyway; the store stays
    // plaintext and we'll retry the migration next load.
    return { macros, migrated: false, tampered: false };
  }
}

/**
 * Encrypt + persist the macro store. Best-effort: a crypto or quota failure is
 * swallowed (mirrors `macroRecord.saveAll`) and reported via the return value
 * so the UI can warn rather than assume success.
 */
export async function saveAllSecure(
  items: readonly SavedMacro[],
): Promise<boolean> {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    const envelope = await encryptMacros(serialize(items));
    ls.setItem(LOCAL_STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

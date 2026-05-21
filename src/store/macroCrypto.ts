// #186 (scope 3) — at-rest encryption + tamper detection for the macro store.
//
// The MVP (#131) wrote `coco.macros` as plaintext JSON. A recorded macro can
// embed cell contents (`set-range-values` params), so it is sensitive enough
// to warrant encryption-at-rest, and a distributed `.coco` workbook that
// carries macros wants tamper detection. This module wraps the macro JSON in
// an AES-GCM ciphertext + HMAC-SHA256 signature envelope.
//
// Crypto design:
//   * Cipher: AES-GCM 256-bit. GCM is authenticated, but we ALSO compute an
//     independent HMAC-SHA256 over the envelope (see below). The HMAC covers
//     the *whole* envelope (algorithm tag, iv, salt, ciphertext) so a
//     distributor can detect any field being swapped, not just ciphertext
//     corruption — GCM's tag only protects the ciphertext+iv pairing.
//   * Key derivation: PBKDF2-SHA256, 150k iterations, over a device-local
//     secret. There is no user passphrase (Coco is a local-first desktop app
//     with no account system — see the project's serverless preference), so
//     the "secret" is a random 256-bit value generated once and kept in
//     localStorage under `coco.macroKeySeed`. This is NOT protection against a
//     local attacker with disk access — it can't be, without an OS keychain —
//     it protects against casual inspection, shoulder-surfing of devtools,
//     and (via HMAC) detects tampering of a macro file moved between machines.
//     A separate salt per encryption call means the same plaintext never
//     produces the same ciphertext.
//   * Two sub-keys are derived from the same PBKDF2 master bits via an HKDF-ish
//     info split: `enc` (AES-GCM) and `mac` (HMAC). Never reuse one key for
//     both primitives.
//
// Envelope JSON shape (`coco.macros` value once encrypted):
//   { v: 1, alg: "AES-GCM", salt, iv, ct, mac }
//   — all binary fields base64. A plaintext (legacy) payload is just the bare
//   `{ version, items }` object, distinguishable because it lacks `alg`.
//
// All functions are async (WebCrypto is promise-based). happy-dom exposes a
// working `crypto.subtle`, so the vitest suite runs the real algorithms.

const ENVELOPE_VERSION = 1;
const PBKDF2_ITERATIONS = 150_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit nonce — the size AES-GCM is specified for.

/** localStorage key holding the device-local random key seed. */
export const KEY_SEED_STORAGE_KEY = "coco.macroKeySeed";

export interface CryptoEnvelope {
  v: number;
  alg: "AES-GCM";
  /** base64 PBKDF2 salt. */
  salt: string;
  /** base64 AES-GCM iv. */
  iv: string;
  /** base64 AES-GCM ciphertext (includes GCM tag). */
  ct: string;
  /** base64 HMAC-SHA256 over `${v}.${alg}.${salt}.${iv}.${ct}`. */
  mac: string;
}

/** Thrown when decryption fails because the data was tampered with (HMAC or
 *  GCM-tag mismatch) — distinct from "this isn't an envelope at all". */
export class MacroTamperError extends Error {
  constructor(message = "マクロデータの署名が一致しません（改竄の可能性）") {
    super(message);
    this.name = "MacroTamperError";
  }
}

// ---- base64 <-> bytes (no Node Buffer dependency) ------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getCrypto(): Crypto {
  // happy-dom and the browser both expose `globalThis.crypto`.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto (crypto.subtle) が利用できません");
  }
  return c;
}

// ---- device key seed -----------------------------------------------------

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Read the device-local key seed, generating + persisting a fresh random one
 * on first use. The seed is 32 random bytes, base64-encoded. When localStorage
 * is unavailable we fall back to a per-process ephemeral seed so encryption
 * still works in-memory (decryption across reloads would fail, which is the
 * correct fail-safe — see `decryptMacros`).
 */
let ephemeralSeed: string | null = null;

export function getOrCreateKeySeed(): string {
  const ls = safeLocalStorage();
  if (ls) {
    try {
      const existing = ls.getItem(KEY_SEED_STORAGE_KEY);
      if (existing && existing.length > 0) return existing;
    } catch {
      // fall through to generation
    }
  }
  const seed = bytesToBase64(getCrypto().getRandomValues(new Uint8Array(32)));
  if (ls) {
    try {
      ls.setItem(KEY_SEED_STORAGE_KEY, seed);
      return seed;
    } catch {
      // quota — fall back to ephemeral
    }
  }
  ephemeralSeed = ephemeralSeed ?? seed;
  return ephemeralSeed;
}

// ---- key derivation ------------------------------------------------------

async function deriveKeys(
  seed: string,
  salt: Uint8Array,
): Promise<{ encKey: CryptoKey; macKey: CryptoKey }> {
  const subtle = getCrypto().subtle;
  const seedBytes = new TextEncoder().encode(seed);
  const baseKey = await subtle.importKey(
    "raw",
    seedBytes,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  // 64 derived bytes: first 32 -> AES key, last 32 -> HMAC key. Splitting one
  // PBKDF2 output keeps a single (expensive) derivation while still using
  // independent key material for the two primitives.
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    512,
  );
  const all = new Uint8Array(bits);
  const encKey = await subtle.importKey(
    "raw",
    all.slice(0, 32),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const macKey = await subtle.importKey(
    "raw",
    all.slice(32, 64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return { encKey, macKey };
}

/** The byte string the HMAC is computed over — every envelope field except
 *  the mac itself, so swapping any field invalidates the signature. */
function macInput(env: Omit<CryptoEnvelope, "mac">): Uint8Array {
  return new TextEncoder().encode(
    `${env.v}.${env.alg}.${env.salt}.${env.iv}.${env.ct}`,
  );
}

// ---- encrypt / decrypt ---------------------------------------------------

/**
 * Encrypt a macro-store JSON string into a signed envelope. A fresh random
 * salt + iv are generated per call so output is non-deterministic.
 */
export async function encryptMacros(plaintextJson: string): Promise<CryptoEnvelope> {
  const subtle = getCrypto().subtle;
  const seed = getOrCreateKeySeed();
  const salt = getCrypto().getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = getCrypto().getRandomValues(new Uint8Array(IV_BYTES));
  const { encKey, macKey } = await deriveKeys(seed, salt);

  const ctBuf = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    encKey,
    new TextEncoder().encode(plaintextJson),
  );

  const partial = {
    v: ENVELOPE_VERSION,
    alg: "AES-GCM" as const,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
  const macBuf = await subtle.sign("HMAC", macKey, macInput(partial) as BufferSource);
  return { ...partial, mac: bytesToBase64(new Uint8Array(macBuf)) };
}

/** Type guard — distinguishes an encrypted envelope from a legacy plaintext
 *  payload (which is a bare `{ version, items }` object). */
export function isCryptoEnvelope(value: unknown): value is CryptoEnvelope {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.alg === "AES-GCM" &&
    typeof o.salt === "string" &&
    typeof o.iv === "string" &&
    typeof o.ct === "string" &&
    typeof o.mac === "string"
  );
}

/**
 * Decrypt + verify an envelope back to the macro-store JSON string.
 *
 * Throws `MacroTamperError` when the HMAC signature or the AES-GCM auth tag
 * fails — both indicate the stored bytes were altered. Throws a plain `Error`
 * for structural problems (not an envelope, wrong version, unusable crypto).
 * Callers (`secureMacroStore`) catch both and fall back to an empty macro
 * list rather than crashing the editor.
 */
export async function decryptMacros(env: CryptoEnvelope): Promise<string> {
  if (!isCryptoEnvelope(env)) {
    throw new Error("暗号化エンベロープの形式が不正です");
  }
  if (env.v !== ENVELOPE_VERSION) {
    throw new Error(`未対応のエンベロープバージョン: ${env.v}`);
  }
  const subtle = getCrypto().subtle;
  const seed = getOrCreateKeySeed();
  const salt = base64ToBytes(env.salt);
  const iv = base64ToBytes(env.iv);
  const ct = base64ToBytes(env.ct);
  const { encKey, macKey } = await deriveKeys(seed, salt);

  // 1. Verify the HMAC over the whole envelope first. This catches tampering
  //    of fields GCM doesn't authenticate (and gives a clear error message).
  const macOk = await subtle.verify(
    "HMAC",
    macKey,
    base64ToBytes(env.mac) as BufferSource,
    macInput(env) as BufferSource,
  );
  if (!macOk) throw new MacroTamperError();

  // 2. Decrypt — AES-GCM will itself throw if the ciphertext/tag was altered
  //    (belt-and-suspenders with the HMAC). Normalise that into MacroTamperError.
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      encKey,
      ct as BufferSource,
    );
  } catch {
    throw new MacroTamperError("マクロデータの復号に失敗しました（改竄の可能性）");
  }
  return new TextDecoder().decode(ptBuf);
}

/** ONLY for unit tests — clears the in-process ephemeral seed cache. */
export function __resetCryptoForTests(): void {
  ephemeralSeed = null;
}

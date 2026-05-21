// @vitest-environment happy-dom
//
// happy-dom exposes a working `crypto.subtle`, so these tests exercise the
// real AES-GCM + PBKDF2 + HMAC algorithms — no mocking.
import { describe, it, expect, beforeEach } from "vitest";
import {
  encryptMacros,
  decryptMacros,
  isCryptoEnvelope,
  getOrCreateKeySeed,
  MacroTamperError,
  KEY_SEED_STORAGE_KEY,
  __resetCryptoForTests,
} from "../macroCrypto";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  __resetCryptoForTests();
});

describe("getOrCreateKeySeed", () => {
  it("generates and persists a seed on first call", () => {
    const seed = getOrCreateKeySeed();
    expect(seed.length).toBeGreaterThan(0);
    expect(localStorage.getItem(KEY_SEED_STORAGE_KEY)).toBe(seed);
  });

  it("returns the same seed on subsequent calls", () => {
    const a = getOrCreateKeySeed();
    const b = getOrCreateKeySeed();
    expect(a).toBe(b);
  });
});

describe("encrypt -> decrypt round-trip", () => {
  it("recovers the original plaintext", async () => {
    const plaintext = JSON.stringify({ version: 1, items: [{ id: "m1" }] });
    const env = await encryptMacros(plaintext);
    expect(isCryptoEnvelope(env)).toBe(true);
    const back = await decryptMacros(env);
    expect(back).toBe(plaintext);
  });

  it("round-trips unicode content", async () => {
    const plaintext = JSON.stringify({ name: "セル A1 を赤く 🎨" });
    const env = await encryptMacros(plaintext);
    expect(await decryptMacros(env)).toBe(plaintext);
  });

  it("produces a different ciphertext each call (random salt + iv)", async () => {
    const plaintext = "same input";
    const a = await encryptMacros(plaintext);
    const b = await encryptMacros(plaintext);
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
    // ...yet both decrypt to the same plaintext.
    expect(await decryptMacros(a)).toBe(plaintext);
    expect(await decryptMacros(b)).toBe(plaintext);
  });
});

describe("isCryptoEnvelope", () => {
  it("accepts a real envelope", async () => {
    expect(isCryptoEnvelope(await encryptMacros("x"))).toBe(true);
  });

  it("rejects a legacy plaintext payload", () => {
    expect(isCryptoEnvelope({ version: 1, items: [] })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isCryptoEnvelope(null)).toBe(false);
    expect(isCryptoEnvelope("string")).toBe(false);
    expect(isCryptoEnvelope(42)).toBe(false);
  });
});

describe("tamper detection", () => {
  it("throws MacroTamperError when the ciphertext is altered", async () => {
    const env = await encryptMacros("secret payload");
    // Flip a character of the base64 ciphertext.
    const flipped = {
      ...env,
      ct: env.ct[0] === "A" ? "B" + env.ct.slice(1) : "A" + env.ct.slice(1),
    };
    await expect(decryptMacros(flipped)).rejects.toBeInstanceOf(MacroTamperError);
  });

  it("throws MacroTamperError when the HMAC is altered", async () => {
    const env = await encryptMacros("secret payload");
    const flipped = {
      ...env,
      mac: env.mac[0] === "A" ? "B" + env.mac.slice(1) : "A" + env.mac.slice(1),
    };
    await expect(decryptMacros(flipped)).rejects.toBeInstanceOf(MacroTamperError);
  });

  it("throws MacroTamperError when the iv is swapped", async () => {
    const a = await encryptMacros("payload one");
    const b = await encryptMacros("payload two");
    // Swap a's iv for b's — the HMAC over the whole envelope must catch it.
    await expect(
      decryptMacros({ ...a, iv: b.iv }),
    ).rejects.toBeInstanceOf(MacroTamperError);
  });

  it("throws a plain Error for a non-envelope value", async () => {
    await expect(
      // @ts-expect-error — deliberately passing a bad shape
      decryptMacros({ version: 1, items: [] }),
    ).rejects.toThrow();
  });

  it("throws for an unsupported envelope version", async () => {
    const env = await encryptMacros("x");
    await expect(decryptMacros({ ...env, v: 999 })).rejects.toThrow(/バージョン/);
  });
});

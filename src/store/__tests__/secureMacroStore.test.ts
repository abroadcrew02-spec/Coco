// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { loadAllSecure, saveAllSecure } from "../secureMacroStore";
import { LOCAL_STORAGE_KEY, serialize, type SavedMacro } from "../macroRecord";
import { isCryptoEnvelope, __resetCryptoForTests } from "../macroCrypto";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  __resetCryptoForTests();
});

const SAMPLE: SavedMacro[] = [
  {
    id: "m1",
    name: "テストマクロ",
    createdAt: 1000,
    events: [
      { id: "sheet.command.set-range-values", params: { a1: "A1", value: 1 }, timestamp: 0 },
    ],
  },
];

describe("saveAllSecure -> loadAllSecure round-trip", () => {
  it("encrypts on save and decrypts on load", async () => {
    const ok = await saveAllSecure(SAMPLE);
    expect(ok).toBe(true);

    // The raw localStorage value must be an encrypted envelope, not plaintext.
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)!;
    expect(isCryptoEnvelope(JSON.parse(raw))).toBe(true);
    expect(raw).not.toContain("テストマクロ");

    const result = await loadAllSecure();
    expect(result.macros).toEqual(SAMPLE);
    expect(result.migrated).toBe(false);
    expect(result.tampered).toBe(false);
  });

  it("loadAllSecure returns an empty list when storage is empty", async () => {
    const result = await loadAllSecure();
    expect(result).toEqual({ macros: [], migrated: false, tampered: false });
  });
});

describe("legacy plaintext migration", () => {
  it("reads a legacy plaintext payload and re-encrypts it", async () => {
    // Simulate a #131-era plaintext store.
    localStorage.setItem(LOCAL_STORAGE_KEY, serialize(SAMPLE));

    const result = await loadAllSecure();
    expect(result.macros).toEqual(SAMPLE);
    expect(result.migrated).toBe(true);
    expect(result.tampered).toBe(false);

    // After migration the on-disk value must now be an encrypted envelope.
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)!;
    expect(isCryptoEnvelope(JSON.parse(raw))).toBe(true);

    // A second load takes the encrypted path — no longer "migrated".
    const second = await loadAllSecure();
    expect(second.macros).toEqual(SAMPLE);
    expect(second.migrated).toBe(false);
  });

  it("migrates an empty/garbage legacy payload to an empty encrypted store", async () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, '{"items":"not an array"}');
    const result = await loadAllSecure();
    expect(result.macros).toEqual([]);
    // It was JSON but not an envelope -> treated as legacy, re-encrypted.
    expect(result.migrated).toBe(true);
  });
});

describe("safe fallback on tamper / corruption", () => {
  it("returns tampered=true and an empty list when the envelope is altered", async () => {
    await saveAllSecure(SAMPLE);
    const raw = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!);
    // Corrupt the ciphertext.
    raw.ct = raw.ct[0] === "A" ? "B" + raw.ct.slice(1) : "A" + raw.ct.slice(1);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(raw));

    const result = await loadAllSecure();
    expect(result.macros).toEqual([]);
    expect(result.tampered).toBe(true);

    // The corrupt store must be LEFT ON DISK (no silent wipe).
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBe(JSON.stringify(raw));
  });

  it("returns tampered=true for a non-JSON payload", async () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, "}{ not json");
    const result = await loadAllSecure();
    expect(result.macros).toEqual([]);
    expect(result.tampered).toBe(true);
  });
});

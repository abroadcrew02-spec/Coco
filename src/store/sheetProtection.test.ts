import { describe, it, expect } from "vitest";
import { isSheetProtectedInSnapshot } from "./sheetProtection";

describe("isSheetProtectedInSnapshot", () => {
  it("returns false for null/empty snapshot", () => {
    expect(isSheetProtectedInSnapshot(null, "s1")).toBe(false);
    expect(isSheetProtectedInSnapshot(undefined, "s1")).toBe(false);
    expect(isSheetProtectedInSnapshot("", "s1")).toBe(false);
  });

  it("returns false when sheetId is missing", () => {
    const snap = JSON.stringify({ sheets: { s1: { _protected: { protected: true } } } });
    expect(isSheetProtectedInSnapshot(snap, null)).toBe(false);
    expect(isSheetProtectedInSnapshot(snap, undefined)).toBe(false);
    expect(isSheetProtectedInSnapshot(snap, "")).toBe(false);
  });

  it("returns false on malformed JSON", () => {
    expect(isSheetProtectedInSnapshot("not json {", "s1")).toBe(false);
  });

  it("returns false when the sheet has no _protected key", () => {
    const snap = JSON.stringify({ sheets: { s1: { cellData: {} } } });
    expect(isSheetProtectedInSnapshot(snap, "s1")).toBe(false);
  });

  it("returns false when _protected.protected is explicitly false", () => {
    const snap = JSON.stringify({ sheets: { s1: { _protected: { protected: false } } } });
    expect(isSheetProtectedInSnapshot(snap, "s1")).toBe(false);
  });

  it("returns true when the sheet is marked protected", () => {
    const snap = JSON.stringify({ sheets: { s1: { _protected: { protected: true } } } });
    expect(isSheetProtectedInSnapshot(snap, "s1")).toBe(true);
  });

  it("returns false for a sheet id that doesn't exist in the snapshot", () => {
    const snap = JSON.stringify({ sheets: { s1: { _protected: { protected: true } } } });
    expect(isSheetProtectedInSnapshot(snap, "s2")).toBe(false);
  });

  it("does not confuse two sheets — only the targeted one is checked", () => {
    const snap = JSON.stringify({
      sheets: {
        s1: { _protected: { protected: true } },
        s2: { cellData: {} },
      },
    });
    expect(isSheetProtectedInSnapshot(snap, "s1")).toBe(true);
    expect(isSheetProtectedInSnapshot(snap, "s2")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { recoveryReasonLabel } from "./recoveryLabels";

describe("recoveryReasonLabel", () => {
  it("translates auto_save", () => {
    expect(recoveryReasonLabel("auto_save")).toBe("自動保存");
  });

  it("translates manual_save", () => {
    expect(recoveryReasonLabel("manual_save")).toBe("手動保存");
  });

  it("passes through 'backup' as a raw code (#104: not emitted by Rust today)", () => {
    expect(recoveryReasonLabel("backup")).toBe("backup");
  });

  it("passes through 'crash' as a raw code (#104: not emitted by Rust today)", () => {
    expect(recoveryReasonLabel("crash")).toBe("crash");
  });

  it("passes through unknown codes so debugging info isn't lost", () => {
    expect(recoveryReasonLabel("some_new_code")).toBe("some_new_code");
  });

  it("passes through empty string unchanged", () => {
    expect(recoveryReasonLabel("")).toBe("");
  });
});

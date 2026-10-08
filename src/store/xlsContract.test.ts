import { describe, it, expect } from "vitest";
import { friendlyError } from "./errorMessages";

// #417: the strings below are what src-tauri/src/commands/xls_io.rs really
// returns (captured from `cargo test --test xls_contract` on 2026-10-08). The
// Rust side pins the same literals in
// src-tauri/tests/xls_contract.rs::error_strings_match_the_table_the_frontend_translates.
// Change both sides together.
describe("xls_io.rs error strings as emitted by Rust", () => {
  it("XLS_TOO_LARGE carries one decimal and no unit; the message shows the unit once", () => {
    expect(friendlyError("XLS_TOO_LARGE: 51.0", "ja-JP")).toBe(
      ".xls のファイルサイズが上限（50 MB）を超えています（51.0 MB）。"
    );
    expect(friendlyError("XLS_TOO_LARGE: 51.0", "en-US")).toBe(
      "The .xls file exceeds the size limit (50 MB) (51.0 MB)."
    );
  });

  it("XLS_CORRUPT keeps the one-line Cfb detail of a truncated file", () => {
    const raw = "XLS_CORRUPT: Cfb error: I/O error: sector id past the end of the file";
    expect(friendlyError(raw, "ja-JP")).toBe(
      ".xls を読み取れませんでした。ファイルが壊れているか、対応していない形式です（Cfb error: I/O error: sector id past the end of the file）。"
    );
    expect(friendlyError(raw, "ja-JP")).not.toMatch(/XLS_CORRUPT/);
  });

  it("XLS_CORRUPT from a rejected column / sector shift is translated, not raw", () => {
    const raw = "XLS_CORRUPT: Cfb error: Invalid sector shift, expecting 0x09 or 0x0C found 1F";
    const out = friendlyError(raw, "ja-JP");
    expect(out?.startsWith(".xls を読み取れませんでした")).toBe(true);
    expect(out).not.toBe(raw);
  });

  it("exact codes are matched as emitted (no tail)", () => {
    expect(friendlyError("XLS_PASSWORD_PROTECTED", "ja-JP")).toContain("パスワード");
    expect(friendlyError("XLS_NO_WORKSHEETS", "ja-JP")).toBe("読み込めるワークシートがありません。");
  });

  it("every sniffed hint Rust can emit is translated and says the file is not Excel 97-2003", () => {
    for (const hint of ["html", "xml", "text", "empty", "unknown"]) {
      const out = friendlyError(`XLS_NOT_EXCEL97: ${hint}`, "ja-JP");
      expect(out).toContain("Excel 97-2003 形式ではありません");
      expect(out).not.toMatch(/XLS_NOT_EXCEL97/);
    }
  });

  it("an xlsx error passed through unchanged from a .xls that is really a zip keeps its own message", () => {
    expect(friendlyError("Invalid xlsx (zip): invalid Zip archive", "ja-JP")).toContain(
      "xlsx として開けません"
    );
  });
});

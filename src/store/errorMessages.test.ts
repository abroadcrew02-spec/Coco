import { describe, it, expect } from "vitest";
import { friendlyError } from "./errorMessages";

describe("friendlyError", () => {
  describe("null/empty inputs", () => {
    it("returns null for null input", () => {
      expect(friendlyError(null)).toBeNull();
    });
    it("returns null for undefined input", () => {
      expect(friendlyError(undefined)).toBeNull();
    });
    it("returns null for empty string", () => {
      expect(friendlyError("")).toBeNull();
    });
  });

  describe("exact-match codes", () => {
    const cases: Array<[string, string]> = [
      ["NEEDS_PATH", "保存先が指定されていません。「名前を付けて保存」から保存先を選んでください。"],
      ["XLSX_INVALID_EXTENSION", "対応していない拡張子です（.xlsx / .xlsm のみ）。"],
      ["XLSX_EMPTY_SNAPSHOT", "出力する内容がありません。空のワークブックは保存できません。"],
      ["XLSX_BUILD_FAILED", "xlsx の構築中にエラーが発生しました。"],
      ["XLSX_WRITE_FAILED", "xlsx の書き込みに失敗しました。ディスク容量や権限を確認してください。"],
      ["XLSX_SECURITY_BLOCKED", "セキュリティ上の制限を超えているため、ファイルを開けません。"],
      ["CSV_INVALID_EXTENSION", "拡張子が .csv / .tsv ではありません。"],
      ["CSV_EMPTY_WORKBOOK", "エクスポートできるシートが見つかりませんでした。"],
      ["CSV_TOO_LARGE", "CSV のセル数が上限（500万）を超えています。"],
      ["REVEAL_EMPTY_PATH", "ファイルパスが指定されていません。"],
    ];
    for (const [code, expected] of cases) {
      it(`maps ${code} → human message`, () => {
        expect(friendlyError(code)).toBe(expected);
      });
    }
  });

  describe("prefix-match patterns", () => {
    it("formats Integrity check failed", () => {
      expect(friendlyError("Integrity check failed: bad page")).toBe(
        "保存後の整合性チェックに失敗しました（bad page）"
      );
    });
    it("formats rename failed", () => {
      expect(friendlyError("rename failed: Access denied (os error 5)")).toBe(
        "一時ファイルの最終置換に失敗しました（Access denied (os error 5)）"
      );
    });
    it("formats Sheet not found", () => {
      expect(friendlyError("Sheet not found: sheet-99")).toBe(
        "指定されたシートが見つかりません（sheet-99）"
      );
    });
    it("formats Failed to open xlsx", () => {
      expect(friendlyError("Failed to open xlsx: invalid signature")).toBe(
        "xlsx を開けませんでした（invalid signature）"
      );
    });
    it("formats security scan failed", () => {
      expect(friendlyError("security scan failed: io error")).toBe(
        "セキュリティ検査に失敗しました（io error）"
      );
    });
    it("formats backup rotation failed", () => {
      expect(friendlyError("backup rotation failed: disk full")).toBe(
        "バックアップのローテーションに失敗しました（disk full）"
      );
    });
    it("formats File not found", () => {
      expect(friendlyError("File not found: /tmp/missing.coco")).toBe(
        "ファイルが見つかりません（/tmp/missing.coco）"
      );
    });
    it("formats Recovery file is missing with candidate-cleanup hint", () => {
      const result = friendlyError("Recovery file is missing: /tmp/recovery/wb.coco");
      expect(result).toContain("復元ファイルが見つかりません");
      expect(result).toContain("/tmp/recovery/wb.coco");
      expect(result).toContain("候補一覧から自動的に取り除きました");
    });
    it("formats Recovery candidate not found", () => {
      expect(friendlyError("Recovery candidate not found: wb-123")).toBe(
        "復元候補が見つかりません（wb-123）"
      );
    });
    it("formats Snapshot not found", () => {
      const result = friendlyError("Snapshot not found: 42");
      expect(result).toContain("スナップショットが見つかりません");
      expect(result).toContain("42");
    });
    it("formats Invalid xlsx (zip)", () => {
      expect(friendlyError("Invalid xlsx (zip): unexpected EOF")).toBe(
        "xlsx として開けません。ZIP 構造が不正です（unexpected EOF）"
      );
    });
    it("formats REVEAL_SPAWN_FAILED", () => {
      expect(friendlyError("REVEAL_SPAWN_FAILED: No such file (os error 2)")).toBe(
        "ファイルマネージャを起動できませんでした（No such file (os error 2)）"
      );
    });
    it("trims whitespace in the detail tail", () => {
      expect(friendlyError("Sheet not found:    sheet-1   ")).toBe(
        "指定されたシートが見つかりません（sheet-1）"
      );
    });
  });

  describe("pass-through", () => {
    it("returns unknown codes unchanged", () => {
      expect(friendlyError("SOMETHING_NEW_2026")).toBe("SOMETHING_NEW_2026");
    });
    it("returns free-form Tauri errors unchanged", () => {
      expect(friendlyError("Tauri command 'foo' is not registered")).toBe(
        "Tauri command 'foo' is not registered"
      );
    });
    it("does not match a code that merely contains a known one as substring", () => {
      // "XLSX_INVALID_EXTENSION" is exact; a variant should pass through.
      expect(friendlyError("MAYBE_XLSX_INVALID_EXTENSION_BUT_NEW")).toBe(
        "MAYBE_XLSX_INVALID_EXTENSION_BUT_NEW"
      );
    });
  });

  describe("prefix edge cases", () => {
    it("prefix-only string (no detail tail) yields the translation with empty parens", () => {
      // Rust historically emits "Sheet not found: <id>", but a programming
      // error could ship just the prefix. Confirm the result is still
      // user-facing (Japanese) and does not throw on the empty slice.
      const result = friendlyError("Sheet not found:");
      expect(result).toBe("指定されたシートが見つかりません（）");
    });

    it("prefix without the trailing colon does NOT match — passes through", () => {
      // "Sheet not found" (no colon) shares the leading text but is NOT
      // a recognized prefix. Must not get the friendly wrapping or it would
      // corrupt unrelated logs.
      const result = friendlyError("Sheet not found anywhere in the workbook");
      expect(result).toBe("Sheet not found anywhere in the workbook");
    });

    it("CSV_TOO_LARGE prefix variant ('CSV_TOO_LARGE: ...') matches both forms", () => {
      // The bare "CSV_TOO_LARGE" hits the FRIENDLY exact map; the
      // "CSV_TOO_LARGE: <tail>" form hits the PREFIX_FRIENDLY entry and
      // must yield the same user-facing string (no diagnostic tail leaked).
      const exact = friendlyError("CSV_TOO_LARGE");
      const withTail = friendlyError("CSV_TOO_LARGE: more than 5M cells");
      expect(exact).toBe("CSV のセル数が上限（500万）を超えています。");
      expect(withTail).toBe(exact);
    });
  });
});

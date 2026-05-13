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
      ["CSV_INVALID_EXTENSION", "拡張子が .csv ではありません。"],
      ["CSV_EMPTY_WORKBOOK", "エクスポートできるシートが見つかりませんでした。"],
      ["CSV_TOO_LARGE", "CSV のセル数が上限（500万）を超えています。"],
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
});

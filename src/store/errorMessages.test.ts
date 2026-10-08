import { describe, it, expect } from "vitest";
import { friendlyError } from "./errorMessages";

// #179: friendlyError is locale-aware. Pass the locale explicitly so these
// assertions stay deterministic regardless of the host's navigator.language.
describe("friendlyError", () => {
  describe("null/empty inputs", () => {
    it("returns null for null input", () => {
      expect(friendlyError(null, "ja-JP")).toBeNull();
    });
    it("returns null for undefined input", () => {
      expect(friendlyError(undefined, "ja-JP")).toBeNull();
    });
    it("returns null for empty string", () => {
      expect(friendlyError("", "ja-JP")).toBeNull();
    });
  });

  describe("en-US locale", () => {
    it("maps an exact code to the English message", () => {
      expect(friendlyError("XLSX_BUILD_FAILED", "en-US")).toBe(
        "An error occurred while building the xlsx file."
      );
    });
    it("formats a prefix-match pattern in English", () => {
      expect(friendlyError("Sheet not found: sheet-99", "en-US")).toBe(
        "The specified sheet was not found (sheet-99)."
      );
    });
    it("passes unknown codes through unchanged", () => {
      expect(friendlyError("SOMETHING_NEW_2026", "en-US")).toBe(
        "SOMETHING_NEW_2026"
      );
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
        expect(friendlyError(code, "ja-JP")).toBe(expected);
      });
    }
  });

  describe("prefix-match patterns", () => {
    it("formats Integrity check failed", () => {
      expect(friendlyError("Integrity check failed: bad page", "ja-JP")).toBe(
        "保存後の整合性チェックに失敗しました（bad page）"
      );
    });
    it("formats rename failed", () => {
      expect(friendlyError("rename failed: Access denied (os error 5)", "ja-JP")).toBe(
        "一時ファイルの最終置換に失敗しました（Access denied (os error 5)）"
      );
    });
    it("formats Sheet not found", () => {
      expect(friendlyError("Sheet not found: sheet-99", "ja-JP")).toBe(
        "指定されたシートが見つかりません（sheet-99）"
      );
    });
    it("formats Failed to open xlsx", () => {
      expect(friendlyError("Failed to open xlsx: invalid signature", "ja-JP")).toBe(
        "xlsx を開けませんでした（invalid signature）"
      );
    });
    it("formats security scan failed", () => {
      expect(friendlyError("security scan failed: io error", "ja-JP")).toBe(
        "セキュリティ検査に失敗しました（io error）"
      );
    });
    it("formats backup rotation failed", () => {
      expect(friendlyError("backup rotation failed: disk full", "ja-JP")).toBe(
        "バックアップのローテーションに失敗しました（disk full）"
      );
    });
    it("formats File not found", () => {
      expect(friendlyError("File not found: /tmp/missing.coco", "ja-JP")).toBe(
        "ファイルが見つかりません（/tmp/missing.coco）"
      );
    });
    it("formats Recovery file is missing with candidate-cleanup hint", () => {
      const result = friendlyError("Recovery file is missing: /tmp/recovery/wb.coco", "ja-JP");
      expect(result).toContain("復元ファイルが見つかりません");
      expect(result).toContain("/tmp/recovery/wb.coco");
      expect(result).toContain("候補一覧から自動的に取り除きました");
    });
    it("formats Recovery candidate not found", () => {
      expect(friendlyError("Recovery candidate not found: wb-123", "ja-JP")).toBe(
        "復元候補が見つかりません（wb-123）"
      );
    });
    it("formats Snapshot not found", () => {
      const result = friendlyError("Snapshot not found: 42", "ja-JP");
      expect(result).toContain("スナップショットが見つかりません");
      expect(result).toContain("42");
    });
    it("formats Invalid xlsx (zip)", () => {
      expect(friendlyError("Invalid xlsx (zip): unexpected EOF", "ja-JP")).toBe(
        "xlsx として開けません。ZIP 構造が不正です（unexpected EOF）"
      );
    });
    it("formats REVEAL_SPAWN_FAILED", () => {
      expect(friendlyError("REVEAL_SPAWN_FAILED: No such file (os error 2)", "ja-JP")).toBe(
        "ファイルマネージャを起動できませんでした（No such file (os error 2)）"
      );
    });
    it("trims whitespace in the detail tail", () => {
      expect(friendlyError("Sheet not found:    sheet-1   ", "ja-JP")).toBe(
        "指定されたシートが見つかりません（sheet-1）"
      );
    });
  });

  // #417: Rust xls_io.rs error strings. Exact codes carry no tail; the rest are
  // "<CODE>: <detail>". Acceptance 3/4/5 ("Japanese error") are pinned here.
  describe("xls import errors (xls_io.rs)", () => {
    const XLS_ERRORS = [
      "XLS_NOT_EXCEL97: html",
      "XLS_NOT_EXCEL97: xml",
      "XLS_NOT_EXCEL97: text",
      "XLS_NOT_EXCEL97: empty",
      "XLS_NOT_EXCEL97: unknown",
      "XLS_PASSWORD_PROTECTED",
      "XLS_TOO_LARGE: 51.2",
      "XLS_CORRUPT: parser panic",
      "XLS_NO_WORKSHEETS",
      "XLS_TOO_MANY_CELLS",
      "XLS_READ_FAILED: os error 5",
    ];

    for (const locale of ["ja-JP", "en-US"] as const) {
      for (const raw of XLS_ERRORS) {
        it(`${locale}: ${raw} is translated, not returned raw`, () => {
          const out = friendlyError(raw, locale);
          expect(out).not.toBeNull();
          expect(out).not.toBe(raw);
          expect(out).not.toMatch(/XLS_[A-Z0-9_]+/);
        });
      }
    }

    it("every XLS_NOT_EXCEL97 hint says the file is not Excel 97-2003 format (ja-JP)", () => {
      for (const hint of ["html", "xml", "text", "empty", "unknown", "something-new"]) {
        expect(friendlyError(`XLS_NOT_EXCEL97: ${hint}`, "ja-JP")).toContain(
          "Excel 97-2003 形式ではありません"
        );
      }
    });

    it("XLS_NOT_EXCEL97 gives a hint-specific next step (ja-JP)", () => {
      expect(friendlyError("XLS_NOT_EXCEL97: html", "ja-JP")).toBe(
        "このファイルは Excel 97-2003 形式ではありません。中身は Web ページ（HTML）です。Excel で開いて .xlsx として保存し直してください。"
      );
      expect(friendlyError("XLS_NOT_EXCEL97: xml", "ja-JP")).toBe(
        "このファイルは Excel 97-2003 形式ではありません。中身は XML スプレッドシート 2003 です。Excel で開いて .xlsx として保存し直してください。"
      );
      expect(friendlyError("XLS_NOT_EXCEL97: text", "ja-JP")).toBe(
        "このファイルは Excel 97-2003 形式ではありません。中身はテキスト（CSV / TSV など）のようです。拡張子を .csv か .tsv に変えて開いてください。"
      );
      expect(friendlyError("XLS_NOT_EXCEL97: empty", "ja-JP")).toBe(
        "このファイルは Excel 97-2003 形式ではありません。"
      );
      expect(friendlyError("XLS_NOT_EXCEL97: unknown", "ja-JP")).toBe(
        "このファイルは Excel 97-2003 形式ではありません。"
      );
    });

    it("an unrecognized hint falls back to the plain sentence without leaking the hint", () => {
      const out = friendlyError("XLS_NOT_EXCEL97: brand-new-hint", "ja-JP");
      expect(out).toBe("このファイルは Excel 97-2003 形式ではありません。");
    });

    it("XLS_PASSWORD_PROTECTED names the password (ja-JP)", () => {
      expect(friendlyError("XLS_PASSWORD_PROTECTED", "ja-JP")).toBe(
        "パスワードで保護された .xls は開けません。Excel でパスワードを解除して保存し直してください。"
      );
    });

    it("XLS_CORRUPT keeps the detail and starts with the fixed sentence (ja-JP)", () => {
      const parserPanic = friendlyError("XLS_CORRUPT: parser panic", "ja-JP");
      expect(parserPanic?.startsWith(".xls を読み取れませんでした")).toBe(true);
      expect(parserPanic).toBe(
        ".xls を読み取れませんでした。ファイルが壊れているか、対応していない形式です（parser panic）。"
      );
    });

    it("XLS_NO_WORKSHEETS and XLS_READ_FAILED (ja-JP)", () => {
      expect(friendlyError("XLS_NO_WORKSHEETS", "ja-JP")).toBe("読み込めるワークシートがありません。");
      expect(friendlyError("XLS_READ_FAILED: os error 5", "ja-JP")).toBe(
        "ファイルを読み込めませんでした（os error 5）。"
      );
    });

    it("XLS_TOO_LARGE shows the size once, with or without a unit in the detail", () => {
      const expected = ".xls のファイルサイズが上限（50 MB）を超えています（51.2 MB）。";
      expect(friendlyError("XLS_TOO_LARGE: 51.2", "ja-JP")).toBe(expected);
      expect(friendlyError("XLS_TOO_LARGE: 51.2 MB", "ja-JP")).toBe(expected);
    });

    it("XLS_TOO_MANY_CELLS says the file is too large, not damaged", () => {
      const ja = friendlyError("XLS_TOO_MANY_CELLS", "ja-JP");
      expect(ja).toBe(
        "この .xls は大きすぎて開けません。データの入っている範囲が上限を超えています。Excel で不要な行や列を削除してから開いてください。"
      );
      expect(ja).not.toMatch(/壊れて/);
      const en = friendlyError("XLS_TOO_MANY_CELLS", "en-US");
      expect(en).toBe(
        "This .xls file is too large to open. The range that holds data exceeds the limit. Delete unused rows or columns in Excel, then open it again."
      );
      expect(en).not.toMatch(/corrupt/i);
    });

    it("exact codes do not match when a tail is appended (strict shape)", () => {
      // XLS_PASSWORD_PROTECTED / XLS_NO_WORKSHEETS / XLS_TOO_MANY_CELLS are exact-match only.
      expect(friendlyError("XLS_PASSWORD_PROTECTED: extra", "ja-JP")).toBe(
        "XLS_PASSWORD_PROTECTED: extra"
      );
      expect(friendlyError("XLS_TOO_MANY_CELLS: extra", "ja-JP")).toBe(
        "XLS_TOO_MANY_CELLS: extra"
      );
    });

    it("XLS_ prefixes do not collide with the XLSX_ codes", () => {
      expect(friendlyError("XLSX_BUILD_FAILED", "ja-JP")).toBe("xlsx の構築中にエラーが発生しました。");
    });
  });

  describe("pass-through", () => {
    it("returns unknown codes unchanged", () => {
      expect(friendlyError("SOMETHING_NEW_2026", "ja-JP")).toBe("SOMETHING_NEW_2026");
    });
    it("returns free-form Tauri errors unchanged", () => {
      expect(friendlyError("Tauri command 'foo' is not registered", "ja-JP")).toBe(
        "Tauri command 'foo' is not registered"
      );
    });
    it("does not match a code that merely contains a known one as substring", () => {
      // "XLSX_INVALID_EXTENSION" is exact; a variant should pass through.
      expect(friendlyError("MAYBE_XLSX_INVALID_EXTENSION_BUT_NEW", "ja-JP")).toBe(
        "MAYBE_XLSX_INVALID_EXTENSION_BUT_NEW"
      );
    });
  });

  describe("prefix edge cases", () => {
    it("prefix-only string (no detail tail) yields the translation with empty parens", () => {
      // Rust historically emits "Sheet not found: <id>", but a programming
      // error could ship just the prefix. Confirm the result is still
      // user-facing (Japanese) and does not throw on the empty slice.
      const result = friendlyError("Sheet not found:", "ja-JP");
      expect(result).toBe("指定されたシートが見つかりません（）");
    });

    it("prefix without the trailing colon does NOT match — passes through", () => {
      // "Sheet not found" (no colon) shares the leading text but is NOT
      // a recognized prefix. Must not get the friendly wrapping or it would
      // corrupt unrelated logs.
      const result = friendlyError("Sheet not found anywhere in the workbook", "ja-JP");
      expect(result).toBe("Sheet not found anywhere in the workbook");
    });

    it("CSV_TOO_LARGE prefix variant ('CSV_TOO_LARGE: ...') matches both forms", () => {
      // The bare "CSV_TOO_LARGE" hits the FRIENDLY exact map; the
      // "CSV_TOO_LARGE: <tail>" form hits the PREFIX_FRIENDLY entry and
      // must yield the same user-facing string (no diagnostic tail leaked).
      const exact = friendlyError("CSV_TOO_LARGE", "ja-JP");
      const withTail = friendlyError("CSV_TOO_LARGE: more than 5M cells", "ja-JP");
      expect(exact).toBe("CSV のセル数が上限（500万）を超えています。");
      expect(withTail).toBe(exact);
    });
  });
});

import { describe, it, expect } from "vitest";
import { normalizeFormula, JA_FUNCTION_ALIASES } from "./functionLocale";

describe("normalizeFormula", () => {
  describe("non-formula input", () => {
    it("returns plain text unchanged", () => {
      expect(normalizeFormula("hello")).toBe("hello");
      expect(normalizeFormula("合計")).toBe("合計");
    });
    it("returns the empty string unchanged", () => {
      expect(normalizeFormula("")).toBe("");
    });
    it("returns a numeric-looking string unchanged", () => {
      expect(normalizeFormula("123")).toBe("123");
    });
  });

  describe("function-name rewriting", () => {
    it("rewrites a single JA aggregate alias", () => {
      expect(normalizeFormula("=合計(A1:A10)")).toBe("=SUM(A1:A10)");
      expect(normalizeFormula("=平均(A1:A10)")).toBe("=AVERAGE(A1:A10)");
    });
    it("rewrites nested JA aliases", () => {
      expect(normalizeFormula("=合計(平均(A1:A3),B1)")).toBe(
        "=SUM(AVERAGE(A1:A3),B1)"
      );
    });
    it("leaves canonical English names untouched", () => {
      expect(normalizeFormula("=SUM(A1:A10)")).toBe("=SUM(A1:A10)");
      expect(normalizeFormula("=VLOOKUP(A1,B:C,2,FALSE)")).toBe(
        "=VLOOKUP(A1,B:C,2,FALSE)"
      );
    });
    it("preserves whitespace between the name and the paren", () => {
      expect(normalizeFormula("=合計 (A1:A10)")).toBe("=SUM (A1:A10)");
    });
    it("does not rewrite an unknown JA token", () => {
      expect(normalizeFormula("=未知関数(A1)")).toBe("=未知関数(A1)");
    });
  });

  describe("string literals", () => {
    it("does not rewrite a JA alias inside a string literal", () => {
      expect(normalizeFormula('=IF(A1>0,"合計",0)')).toBe('=IF(A1>0,"合計",0)');
    });
    it("rewrites the function name but keeps JA string content", () => {
      expect(normalizeFormula('=もし(A1>0,"合計です",0)')).toBe(
        '=IF(A1>0,"合計です",0)'
      );
    });
    it("handles a doubled-quote escape inside a string", () => {
      expect(normalizeFormula('=合計(A1)&"a""b"')).toBe('=SUM(A1)&"a""b"');
    });
  });

  describe("alias table", () => {
    it("maps every alias value to an upper-case English name", () => {
      for (const canonical of Object.values(JA_FUNCTION_ALIASES)) {
        expect(canonical).toMatch(/^[A-Z]+$/);
      }
    });
  });
});

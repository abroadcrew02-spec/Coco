import { describe, it, expect } from "vitest";
import { routeOpenPath } from "./pathRouter";

describe("routeOpenPath", () => {
  describe("recognized extensions", () => {
    it("routes .coco to coco", () => {
      const r = routeOpenPath("/tmp/wb.coco");
      expect(r).toEqual({ kind: "coco", path: "/tmp/wb.coco" });
    });

    it("routes .xlsx to xlsx", () => {
      const r = routeOpenPath("/tmp/wb.xlsx");
      expect(r).toEqual({ kind: "xlsx", path: "/tmp/wb.xlsx" });
    });

    it("routes .xlsm to xlsx (xlsm treated as xlsx, req AD-02b)", () => {
      const r = routeOpenPath("/tmp/macros.xlsm");
      expect(r).toEqual({ kind: "xlsx", path: "/tmp/macros.xlsm" });
    });

    it("routes .csv to csv", () => {
      const r = routeOpenPath("/tmp/data.csv");
      expect(r).toEqual({ kind: "csv", path: "/tmp/data.csv" });
    });

    it("routes .tsv to csv (same import path, different delimiter)", () => {
      const r = routeOpenPath("/tmp/data.tsv");
      expect(r).toEqual({ kind: "csv", path: "/tmp/data.tsv" });
    });
  });

  describe("case insensitivity", () => {
    it("recognizes uppercase extensions", () => {
      expect(routeOpenPath("/tmp/wb.XLSX").kind).toBe("xlsx");
      expect(routeOpenPath("/tmp/data.CSV").kind).toBe("csv");
      expect(routeOpenPath("/tmp/db.COCO").kind).toBe("coco");
    });

    it("recognizes mixed-case extensions", () => {
      expect(routeOpenPath("/tmp/wb.XlsX").kind).toBe("xlsx");
      expect(routeOpenPath("/tmp/Macros.XlSm").kind).toBe("xlsx");
    });

    it("preserves the original path casing in the route payload", () => {
      const r = routeOpenPath("/Tmp/Mixed-Case.XLSX");
      expect(r).toMatchObject({ kind: "xlsx", path: "/Tmp/Mixed-Case.XLSX" });
    });
  });

  describe("path separators", () => {
    it("handles Windows backslash paths", () => {
      expect(routeOpenPath("C:\\Users\\foo\\book.xlsx").kind).toBe("xlsx");
    });

    it("handles Unix forward-slash paths", () => {
      expect(routeOpenPath("/home/user/book.coco").kind).toBe("coco");
    });

    it("handles mixed separators", () => {
      expect(routeOpenPath("C:/Users\\foo/book.csv").kind).toBe("csv");
    });
  });

  describe("unsupported paths", () => {
    it("returns unsupported with extension for .png", () => {
      const r = routeOpenPath("/tmp/photo.png");
      expect(r).toEqual({ kind: "unsupported", path: "/tmp/photo.png", extension: ".png" });
    });

    it("returns unsupported with extension for .ods", () => {
      expect(routeOpenPath("/tmp/sheet.ods")).toEqual({
        kind: "unsupported",
        path: "/tmp/sheet.ods",
        extension: ".ods",
      });
    });

    it("returns unsupported with null extension when none present", () => {
      expect(routeOpenPath("/tmp/Makefile")).toEqual({
        kind: "unsupported",
        path: "/tmp/Makefile",
        extension: null,
      });
    });

    it("returns unsupported with null extension for empty path", () => {
      expect(routeOpenPath("")).toEqual({ kind: "unsupported", path: "", extension: null });
    });

    it("returns unsupported with null extension for dotfile-only names", () => {
      // ".bashrc" has no extension separator that produces a usable suffix
      // (leading dot means no base name).
      expect(routeOpenPath("/home/.bashrc")).toEqual({
        kind: "unsupported",
        path: "/home/.bashrc",
        extension: null,
      });
    });

    it("returns unsupported when path ends with a separator (directory-like)", () => {
      expect(routeOpenPath("/tmp/some-dir/")).toEqual({
        kind: "unsupported",
        path: "/tmp/some-dir/",
        extension: null,
      });
    });

    it("ignores a known extension that appears mid-path (not at end)", () => {
      // "/tmp/coco-dir/output.png" — the .coco fragment is in the directory name,
      // not the file extension. Must not be routed as a coco workbook.
      expect(routeOpenPath("/tmp/coco-dir/output.png").kind).toBe("unsupported");
    });
  });

  describe("substring trap", () => {
    it("does not match extensions inside a longer suffix", () => {
      // "report.xlsx.bak" ends in .bak, not .xlsx — must be unsupported.
      expect(routeOpenPath("/tmp/report.xlsx.bak").kind).toBe("unsupported");
    });

    it("matches a multi-dot filename by its trailing extension", () => {
      // "data.2026.csv" → .csv
      expect(routeOpenPath("/tmp/data.2026.csv").kind).toBe("csv");
    });
  });

  // --- Audit findings (T2) — item 18 ---------------------------------------

  describe("audit item 18: multi-dot filenames", () => {
    it("routes my..weird..name.xlsx to xlsx (consecutive dots in basename)", () => {
      const r = routeOpenPath("/tmp/my..weird..name.xlsx");
      expect(r).toEqual({ kind: "xlsx", path: "/tmp/my..weird..name.xlsx" });
    });

    it("routes report.2026.05.13.xlsx to xlsx (date-style multi-dot)", () => {
      const r = routeOpenPath("/tmp/report.2026.05.13.xlsx");
      expect(r).toEqual({ kind: "xlsx", path: "/tmp/report.2026.05.13.xlsx" });
    });

    it("routes ...xlsx to xlsx (leading-dots filename — confirms current behavior)", () => {
      // Lower-case ends with ".xlsx", so endsWithAny matches.
      const r = routeOpenPath("/tmp/...xlsx");
      expect(r.kind).toBe("xlsx");
    });
  });

  // --- Audit findings (T2) — item 19 ---------------------------------------

  describe("audit item 19: CJK / emoji filenames", () => {
    it("routes a CJK basename ending in .xlsx to xlsx", () => {
      // toLowerCase must not mangle the Japanese characters; only the ASCII
      // ".xlsx" suffix participates in the match.
      const r = routeOpenPath("/tmp/売上データ.xlsx");
      expect(r).toEqual({ kind: "xlsx", path: "/tmp/売上データ.xlsx" });
    });

    it("routes an emoji-prefixed basename ending in .csv to csv", () => {
      const r = routeOpenPath("/tmp/📊_2026.csv");
      expect(r).toEqual({ kind: "csv", path: "/tmp/📊_2026.csv" });
    });

    it("routes a Chinese basename ending in .coco to coco", () => {
      // Defense-in-depth: confirms lowercasing of mixed-script paths still
      // preserves the path payload exactly as input.
      const r = routeOpenPath("/tmp/工作簿.coco");
      expect(r).toEqual({ kind: "coco", path: "/tmp/工作簿.coco" });
    });

    it("returns the correct non-ASCII extension when unsupported", () => {
      // Sanity check: extractExtension walks the lower-cased basename but
      // returns a slice of it — so the returned extension is also lower-case
      // ASCII when the original was ASCII.
      const r = routeOpenPath("/tmp/写真.png");
      expect(r).toEqual({ kind: "unsupported", path: "/tmp/写真.png", extension: ".png" });
    });
  });
});

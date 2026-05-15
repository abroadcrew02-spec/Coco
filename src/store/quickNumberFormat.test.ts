import { describe, it, expect } from "vitest";
import {
  applyQuickNumberFormat,
  QUICK_FMT_CURRENCY,
  QUICK_FMT_PERCENT,
} from "./quickNumberFormat";

describe("applyQuickNumberFormat", () => {
  it("writes the currency format code to every cell in the range", () => {
    const snap = JSON.stringify({
      sheets: { s1: { cellData: { "0": { "0": { v: 100 } } } } },
    });
    const next = applyQuickNumberFormat(
      snap,
      "s1",
      { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
      QUICK_FMT_CURRENCY,
    );
    const parsed = JSON.parse(next) as {
      sheets: {
        s1: {
          cellData: Record<string, Record<string, { _fmt?: string; v?: unknown }>>;
        };
      };
    };
    expect(parsed.sheets.s1.cellData["0"]["0"]._fmt).toBe("$#,##0.00");
    expect(parsed.sheets.s1.cellData["0"]["0"].v).toBe(100); // preserves existing
    expect(parsed.sheets.s1.cellData["0"]["1"]._fmt).toBe("$#,##0.00");
    expect(parsed.sheets.s1.cellData["1"]["0"]._fmt).toBe("$#,##0.00");
    expect(parsed.sheets.s1.cellData["1"]["1"]._fmt).toBe("$#,##0.00");
  });

  it("writes the percent format code (0%)", () => {
    const snap = JSON.stringify({ sheets: { s1: { cellData: {} } } });
    const next = applyQuickNumberFormat(
      snap,
      "s1",
      { startRow: 2, endRow: 2, startCol: 3, endCol: 3 },
      QUICK_FMT_PERCENT,
    );
    const parsed = JSON.parse(next) as {
      sheets: { s1: { cellData: Record<string, Record<string, { _fmt?: string }>> } };
    };
    expect(parsed.sheets.s1.cellData["2"]["3"]._fmt).toBe("0%");
  });

  it("no-ops on degenerate range or missing sheet", () => {
    const snap = JSON.stringify({ sheets: { s1: { cellData: {} } } });
    expect(
      applyQuickNumberFormat(
        snap,
        "s1",
        { startRow: 5, endRow: 0, startCol: 0, endCol: 0 },
        "0%",
      ),
    ).toBe(snap);
    expect(
      applyQuickNumberFormat(
        snap,
        "missing",
        { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
        "0%",
      ),
    ).toBe(snap);
  });

  it("empty fmt code removes _fmt without dropping the cell", () => {
    const snap = JSON.stringify({
      sheets: {
        s1: { cellData: { "0": { "0": { v: 1, _fmt: "$#,##0.00" } } } },
      },
    });
    const next = applyQuickNumberFormat(
      snap,
      "s1",
      { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
      "",
    );
    const parsed = JSON.parse(next) as {
      sheets: {
        s1: {
          cellData: Record<string, Record<string, { _fmt?: string; v?: unknown }>>;
        };
      };
    };
    expect(parsed.sheets.s1.cellData["0"]["0"]._fmt).toBeUndefined();
    expect(parsed.sheets.s1.cellData["0"]["0"].v).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { QUICK_FMT_CURRENCY, QUICK_FMT_PERCENT } from "./quickNumberFormat";
import {
  NUMBER_FORMAT_MAX_CELLS,
  planUniformNumberFormat,
  runNumberFormatJob,
  type NumberFormatDeps,
} from "./numberFormat";

// The quick-format buttons (通貨 / %) plan with planUniformNumberFormat and run
// the job through the numfmt facade; these tests pin that path with the two
// button codes. The planner / runner themselves are covered in
// numberFormat.test.ts.

function recordingDeps() {
  const calls: Array<{ at: number[]; pattern: string }> = [];
  const deps: NumberFormatDeps = {
    getSheet: () => ({
      getRange: (row, col, numRows, numCols) => ({
        setNumberFormat: (pattern: string) => {
          calls.push({ at: [row, col, numRows, numCols], pattern });
        },
        setNumberFormats: () => undefined,
      }),
    }),
    setCells: () => true,
  };
  return { calls, deps };
}

describe("quick number format codes", () => {
  it("match Excel's defaults", () => {
    expect(QUICK_FMT_CURRENCY).toBe("$#,##0.00");
    expect(QUICK_FMT_PERCENT).toBe("0%");
  });
});

describe("quick number format apply", () => {
  it("applies the currency code to the whole selection with one facade call", () => {
    const { calls, deps } = recordingDeps();
    const job = planUniformNumberFormat(
      "s1",
      { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
      QUICK_FMT_CURRENCY,
      { "0": { "0": { v: 100 } } },
    );
    expect(job).not.toBeNull();
    runNumberFormatJob(job!, deps);
    expect(calls).toEqual([{ at: [0, 0, 2, 2], pattern: "$#,##0.00" }]);
  });

  it("applies the percent code to a single blank cell", () => {
    const { calls, deps } = recordingDeps();
    runNumberFormatJob(
      planUniformNumberFormat("s1", { startRow: 2, endRow: 2, startCol: 3, endCol: 3 }, QUICK_FMT_PERCENT, {})!,
      deps,
    );
    expect(calls).toEqual([{ at: [2, 3, 1, 1], pattern: "0%" }]);
  });

  it("no-ops on a range with a negative corner", () => {
    expect(
      planUniformNumberFormat("s1", { startRow: -1, endRow: 0, startCol: 0, endCol: 0 }, QUICK_FMT_PERCENT),
    ).toBeNull();
  });

  it("#98: a whole-column selection only formats cells that already exist", () => {
    const job = planUniformNumberFormat(
      "s1",
      { startRow: 0, endRow: NUMBER_FORMAT_MAX_CELLS * 10, startCol: 0, endCol: 0 },
      QUICK_FMT_CURRENCY,
      { "4": { "0": { v: 1 } }, "8": { "1": { v: 2 } } },
    );
    expect(job).toEqual({
      kind: "cells",
      sheetId: "s1",
      writes: [{ row: 4, col: 0, pattern: "$#,##0.00" }],
    });
  });
});

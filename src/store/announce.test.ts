// @vitest-environment happy-dom
// Tests for the screen-reader announcement helpers (#177).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  columnLetter,
  describeCellValue,
  buildCellAnnouncement,
  buildRangeAnnouncement,
  buildEditModeAnnouncement,
  announce,
  announceError,
  subscribeAnnouncements,
  type Announcement,
} from "./announce";
import { setLocale } from "../i18n/locale";

describe("columnLetter", () => {
  it("maps 0-based indices to spreadsheet letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(1)).toBe("B");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
  });

  it("returns an empty string for invalid indices", () => {
    expect(columnLetter(-1)).toBe("");
    expect(columnLetter(1.5)).toBe("");
  });
});

describe("describeCellValue", () => {
  beforeEach(() => setLocale("ja-JP"));

  it("describes empty / blank cells with the localized phrase", () => {
    expect(describeCellValue(null)).toBe("空のセル");
    expect(describeCellValue(undefined)).toBe("空のセル");
    expect(describeCellValue("")).toBe("空のセル");
    expect(describeCellValue("   ")).toBe("空のセル");
  });

  it("returns string / number / boolean values verbatim", () => {
    expect(describeCellValue("hello")).toBe("hello");
    expect(describeCellValue(42)).toBe("42");
    expect(describeCellValue(true)).toBe("TRUE");
    expect(describeCellValue(false)).toBe("FALSE");
  });

  it("unwraps Univer ICellData objects", () => {
    expect(describeCellValue({ v: 7, t: 2 })).toBe("7");
    expect(describeCellValue({ v: "x" })).toBe("x");
    expect(describeCellValue({})).toBe("空のセル");
  });
});

describe("buildCellAnnouncement", () => {
  it("formats a 0-based cell as column-letter / 1-based row in Japanese", () => {
    setLocale("ja-JP");
    // row 0, col 0 -> A1
    expect(buildCellAnnouncement(0, 0, "値")).toBe("列A 行1: 値");
    // row 4, col 2 -> C5
    expect(buildCellAnnouncement(4, 2, 100)).toBe("列C 行5: 100");
  });

  it("formats in English when the locale is en-US", () => {
    setLocale("en-US");
    expect(buildCellAnnouncement(0, 0, "x")).toBe("column A row 1: x");
  });

  it("announces empty cells", () => {
    setLocale("en-US");
    expect(buildCellAnnouncement(2, 1, null)).toBe(
      "column B row 3: empty cell",
    );
  });
});

describe("buildRangeAnnouncement", () => {
  it("describes the A1 range and cell count", () => {
    setLocale("en-US");
    // A1:C4 -> 3 cols * 4 rows = 12 cells
    expect(buildRangeAnnouncement(0, 0, 3, 2)).toBe(
      "Range A1:C4 selected, 12 cells",
    );
  });
});

describe("buildEditModeAnnouncement", () => {
  it("returns the localized phrase for each edit event", () => {
    setLocale("ja-JP");
    expect(buildEditModeAnnouncement("start")).toBe("編集モード");
    expect(buildEditModeAnnouncement("commit")).toBe("確定しました");
    expect(buildEditModeAnnouncement("cancel")).toBe("編集を取り消しました");
  });
});

describe("announce pub/sub channel", () => {
  let received: Announcement[];
  let unsubscribe: () => void;

  beforeEach(() => {
    received = [];
    unsubscribe = subscribeAnnouncements((a) => received.push(a));
  });

  afterEach(() => {
    unsubscribe();
  });

  it("delivers polite messages to subscribers", () => {
    announce("hello");
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("hello");
    expect(received[0].politeness).toBe("polite");
  });

  it("routes announceError through the assertive channel", () => {
    announceError("boom");
    expect(received[0].politeness).toBe("assertive");
    expect(received[0].message).toBe("boom");
  });

  it("assigns a unique monotonic token to every message", () => {
    announce("a");
    announce("a");
    expect(received[0].token).not.toBe(received[1].token);
  });

  it("ignores empty messages", () => {
    announce("");
    expect(received).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", () => {
    unsubscribe();
    announce("ignored");
    expect(received).toHaveLength(0);
  });

  it("delivers to multiple subscribers", () => {
    const second: Announcement[] = [];
    const off = subscribeAnnouncements((a) => second.push(a));
    announce("broadcast");
    expect(received).toHaveLength(1);
    expect(second).toHaveLength(1);
    off();
  });
});

describe("announce — no subscribers", () => {
  it("does not throw when nobody is listening", () => {
    expect(() => announce("nobody home")).not.toThrow();
  });
});

// Restore the default locale so other suites aren't affected.
afterEach(() => {
  vi.restoreAllMocks();
});

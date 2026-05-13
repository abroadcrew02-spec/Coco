import { describe, it, expect } from "vitest";
import { timeAgoJa } from "./timeAgo";

describe("timeAgoJa", () => {
  const NOW = 1_700_000_000_000; // arbitrary epoch

  it("returns 'たった今' for very recent timestamps", () => {
    expect(timeAgoJa(NOW - 2000, NOW)).toBe("たった今");
    expect(timeAgoJa(NOW, NOW)).toBe("たった今");
  });

  it("returns seconds for sub-minute gaps", () => {
    expect(timeAgoJa(NOW - 10_000, NOW)).toBe("10 秒前");
    expect(timeAgoJa(NOW - 59_000, NOW)).toBe("59 秒前");
  });

  it("returns minutes for sub-hour gaps", () => {
    expect(timeAgoJa(NOW - 60_000, NOW)).toBe("1 分前");
    expect(timeAgoJa(NOW - 30 * 60_000, NOW)).toBe("30 分前");
    expect(timeAgoJa(NOW - 59 * 60_000, NOW)).toBe("59 分前");
  });

  it("returns hours for sub-day gaps", () => {
    expect(timeAgoJa(NOW - 60 * 60_000, NOW)).toBe("1 時間前");
    expect(timeAgoJa(NOW - 12 * 60 * 60_000, NOW)).toBe("12 時間前");
  });

  it("returns days for >24h gaps", () => {
    expect(timeAgoJa(NOW - 25 * 60 * 60_000, NOW)).toBe("1 日前");
    expect(timeAgoJa(NOW - 7 * 24 * 60 * 60_000, NOW)).toBe("7 日前");
  });

  it("clamps future timestamps to 'たった今'", () => {
    expect(timeAgoJa(NOW + 5000, NOW)).toBe("たった今");
  });
});

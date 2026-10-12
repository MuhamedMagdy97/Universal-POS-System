import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  addDays,
  formatLocalDateTime,
  parseLocalDate,
  quickRange,
  resolveRange,
  todayIn,
  zoneFor,
} from "@/modules/reports/timezone";

const CAIRO = "Africa/Cairo";
const RIYADH = "Asia/Riyadh";

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return (err.details as { reason?: string }).reason;
    throw err;
  }
  return undefined;
}

describe("zoneFor", () => {
  it("maps each country to its IANA zone", () => {
    expect(zoneFor("EG")).toBe(CAIRO);
    expect(zoneFor("SA")).toBe(RIYADH);
  });
});

describe("parseLocalDate", () => {
  it("accepts real dates, with Arabic-Indic digits too", () => {
    expect(parseLocalDate("2026-10-12")).toBe("2026-10-12");
    expect(parseLocalDate("٢٠٢٦-١٠-١٢")).toBe("2026-10-12");
    expect(parseLocalDate("2028-02-29")).toBe("2028-02-29");
  });

  it("refuses impossible or malformed dates", () => {
    expect(parseLocalDate("2026-02-30")).toBeNull();
    expect(parseLocalDate("2026-13-01")).toBeNull();
    expect(parseLocalDate("12/10/2026")).toBeNull();
    expect(parseLocalDate("2026-1-1")).toBeNull();
  });
});

describe("todayIn and formatLocalDateTime", () => {
  // 2026-10-12 22:30 UTC is already the 13th in Riyadh (UTC+3); Cairo is UTC+3 in summer time.
  const lateUtc = new Date("2026-10-12T21:30:00Z");

  it("uses the shop's day, not UTC's", () => {
    expect(todayIn(RIYADH, lateUtc)).toBe("2026-10-13");
    expect(todayIn(CAIRO, new Date("2026-01-12T21:30:00Z"))).toBe("2026-01-12"); // winter, UTC+2
    expect(todayIn(CAIRO, new Date("2026-01-12T22:30:00Z"))).toBe("2026-01-13");
  });

  it("formats local wall time on a 24-hour clock", () => {
    expect(formatLocalDateTime(lateUtc, RIYADH)).toBe("2026-10-13 00:30");
    expect(formatLocalDateTime(new Date("2026-01-12T21:30:00Z"), CAIRO)).toBe("2026-01-12 23:30");
  });
});

describe("resolveRange", () => {
  const now = new Date("2026-10-12T09:00:00Z");

  it("defaults missing ends to today, or to the other end", () => {
    expect(resolveRange({}, CAIRO, now)).toEqual({ from: "2026-10-12", to: "2026-10-12" });
    expect(resolveRange({ from: "2026-10-01" }, CAIRO, now)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(resolveRange({ to: "2026-10-05" }, CAIRO, now)).toEqual({ from: "2026-10-05", to: "2026-10-05" });
  });

  it("allows 366 calendar days and no more", () => {
    expect(resolveRange({ from: "2025-10-12", to: "2026-10-12" }, CAIRO, now)).toEqual({
      from: "2025-10-12",
      to: "2026-10-12",
    });
    expect(reasonOf(() => resolveRange({ from: "2025-10-11", to: "2026-10-12" }, CAIRO, now))).toBe("RANGE_TOO_LONG");
  });

  it("refuses an inverted range and bad dates", () => {
    expect(reasonOf(() => resolveRange({ from: "2026-10-12", to: "2026-10-11" }, CAIRO, now))).toBe("RANGE_INVERTED");
    expect(reasonOf(() => resolveRange({ from: "yesterday" }, CAIRO, now))).toBe("INVALID_DATE");
  });
});

describe("quickRange", () => {
  // Monday 2026-10-12 in Cairo.
  const monday = new Date("2026-10-12T09:00:00Z");

  it("starts the week on Saturday", () => {
    expect(quickRange("thisWeek", CAIRO, monday)).toEqual({ from: "2026-10-10", to: "2026-10-12" });
    const saturday = new Date("2026-10-10T09:00:00Z");
    expect(quickRange("thisWeek", CAIRO, saturday)).toEqual({ from: "2026-10-10", to: "2026-10-10" });
    const friday = new Date("2026-10-16T09:00:00Z");
    expect(quickRange("thisWeek", CAIRO, friday)).toEqual({ from: "2026-10-10", to: "2026-10-16" });
  });

  it("covers today, yesterday and the months", () => {
    expect(quickRange("today", CAIRO, monday)).toEqual({ from: "2026-10-12", to: "2026-10-12" });
    expect(quickRange("yesterday", CAIRO, monday)).toEqual({ from: "2026-10-11", to: "2026-10-11" });
    expect(quickRange("thisMonth", CAIRO, monday)).toEqual({ from: "2026-10-01", to: "2026-10-12" });
    expect(quickRange("lastMonth", CAIRO, monday)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(quickRange("lastMonth", CAIRO, new Date("2026-03-05T09:00:00Z"))).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

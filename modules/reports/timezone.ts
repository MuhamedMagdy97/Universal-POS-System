import { AppError } from "@/lib/errors";
import { normalizeDigits } from "@/lib/money";

/**
 * Business day (P2). A day runs midnight to midnight in the shop's timezone, taken from the
 * org's country. Dates travel as local `YYYY-MM-DD` strings; SQL converts them (see
 * reports-audit-data-model-and-api.md §2). Pure: no DB access.
 */

export type CountryCode = "EG" | "SA";

export const TIMEZONE_BY_COUNTRY: Record<CountryCode, string> = {
  EG: "Africa/Cairo",
  SA: "Asia/Riyadh",
};

/** At most 366 calendar days per query (P8): `to − from ≤ 365`. */
export const MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function zoneFor(country: CountryCode): string {
  return TIMEZONE_BY_COUNTRY[country];
}

function invalidRange(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason });
}

/** Parses `YYYY-MM-DD` (Arabic-Indic digits allowed) into a real calendar date, or null. */
export function parseLocalDate(raw: string): string | null {
  const match = LOCAL_DATE.exec(normalizeDigits(raw).trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const iso = date.toISOString().slice(0, 10);
  return iso === `${y}-${m}-${d}` ? iso : null;
}

/** Calendar arithmetic on local dates (no timezone involved). */
export function addDays(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The local date in `zone` at instant `now`. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now,
  );
}

/** `YYYY-MM-DD HH:mm` in `zone` (CSV and screen timestamps). */
export function formatLocalDateTime(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

export type LocalRange = { from: string; to: string };

/**
 * Resolves the requested range: missing ends default to today (local); `from ≤ to`; at most
 * 366 calendar days. Bad input is a 422 with `details.reason`.
 */
export function resolveRange(input: { from?: string; to?: string }, zone: string, now: Date = new Date()): LocalRange {
  const today = todayIn(zone, now);
  const from = input.from === undefined ? undefined : parseLocalDate(input.from);
  const to = input.to === undefined ? undefined : parseLocalDate(input.to);
  if (from === null || to === null) throw invalidRange("INVALID_DATE", "Dates must be YYYY-MM-DD");
  const range = { from: from ?? to ?? today, to: to ?? from ?? today };
  if (range.from > range.to) throw invalidRange("RANGE_INVERTED", "The start date is after the end date");
  if (daysBetween(range.from, range.to) >= MAX_RANGE_DAYS) {
    throw invalidRange("RANGE_TOO_LONG", `A report covers at most ${MAX_RANGE_DAYS} days`);
  }
  return range;
}

export const QUICK_RANGES = ["today", "yesterday", "thisWeek", "thisMonth", "lastMonth"] as const;
export type QuickRange = (typeof QUICK_RANGES)[number];

/** Saturday, the first day of the week in EG and SA. */
const WEEK_START_UTC_DAY = 6;

/** Ranges behind the screen's quick picks, ending today at the latest. */
export function quickRange(name: QuickRange, zone: string, now: Date = new Date()): LocalRange {
  const today = todayIn(zone, now);
  const monthStart = `${today.slice(0, 8)}01`;
  switch (name) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "thisWeek": {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      return { from: addDays(today, -((weekday - WEEK_START_UTC_DAY + 7) % 7)), to: today };
    }
    case "thisMonth":
      return { from: monthStart, to: today };
    case "lastMonth": {
      const lastDay = addDays(monthStart, -1);
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
    }
  }
}

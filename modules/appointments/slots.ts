/**
 * Calendar arithmetic for appointments (docs/planning/ui-refresh/salon-spec.md S5, S6). Pure and client-safe; times of
 * day are minutes after local midnight in the shop's time zone. Unit-tested in tests/unit/appointment-slots.test.ts.
 */

/** Calendar rows are 15 minutes (S6). */
export const SLOT_MIN = 15;

/** The start of each row from opening to closing, in minutes after midnight. */
export function daySlots(opensAt: number, closesAt: number): number[] {
  const out: number[] = [];
  for (let at = opensAt; at < closesAt; at += SLOT_MIN) out.push(at);
  return out;
}

/** Two bookings overlap when each starts before the other ends; back to back does not overlap. */
export function overlaps(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/** `HH:mm` for minutes after midnight. */
export function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The zone's offset from UTC, in minutes, at instant `at`. */
function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant of `minutes` after midnight on local day `day` (YYYY-MM-DD) in `zone`, daylight saving included. */
export function zonedInstant(day: string, minutes: number, zone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const first = wall - offsetMinutes(zone, new Date(wall)) * 60_000;
  return new Date(wall - offsetMinutes(zone, new Date(first)) * 60_000);
}

/** Minutes after local midnight of instant `at` in `zone`. */
export function minutesInDay(at: Date, zone: string): number {
  const local = new Date(at.getTime() + offsetMinutes(zone, at) * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

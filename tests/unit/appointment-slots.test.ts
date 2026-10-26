import { describe, expect, it } from "vitest";
import { clock, daySlots, minutesInDay, overlaps, zonedInstant } from "@/modules/appointments/slots";

/** Calendar arithmetic (salon-spec S5, S6). Pure, no DB. */

const at = (iso: string) => new Date(iso);

describe("daySlots", () => {
  it("makes 15-minute rows from opening to closing", () => {
    const slots = daySlots(9 * 60, 21 * 60);
    expect(slots).toHaveLength(48);
    expect([clock(slots[0]), clock(slots[47])]).toEqual(["09:00", "20:45"]);
  });
});

describe("overlaps", () => {
  const sara = { startsAt: at("2026-10-26T08:00:00Z"), endsAt: at("2026-10-26T08:45:00Z") };
  it("refuses a booking inside another and allows back to back", () => {
    expect(overlaps(sara, { startsAt: at("2026-10-26T08:30:00Z"), endsAt: at("2026-10-26T09:00:00Z") })).toBe(true);
    expect(overlaps(sara, { startsAt: at("2026-10-26T07:30:00Z"), endsAt: at("2026-10-26T09:30:00Z") })).toBe(true);
    expect(overlaps(sara, { startsAt: at("2026-10-26T08:45:00Z"), endsAt: at("2026-10-26T09:30:00Z") })).toBe(false);
    expect(overlaps(sara, { startsAt: at("2026-10-26T07:15:00Z"), endsAt: at("2026-10-26T08:00:00Z") })).toBe(false);
  });
});

describe("zonedInstant", () => {
  it("turns a local time in Riyadh (UTC+3) into an instant, and back", () => {
    const ten = zonedInstant("2026-10-26", 10 * 60, "Asia/Riyadh");
    expect(ten.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    expect(minutesInDay(ten, "Asia/Riyadh")).toBe(600);
  });

  it("follows Cairo's summer time", () => {
    expect(zonedInstant("2026-01-15", 10 * 60, "Africa/Cairo").toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(zonedInstant("2026-07-15", 10 * 60, "Africa/Cairo").toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });
});

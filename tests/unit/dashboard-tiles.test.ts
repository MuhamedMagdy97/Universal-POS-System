import { describe, expect, it } from "vitest";
import { averageTicketMinor } from "@/modules/reports/average";

/** Dashboard "Average ticket" (business-profiles-spec BP10): net sales ÷ sales today, none without sales. */
describe("averageTicketMinor", () => {
  it("divides and rounds half up", () => {
    expect(averageTicketMinor(1000, 3)).toBe(333);
    expect(averageTicketMinor(1001, 2)).toBe(501);
    expect(averageTicketMinor(-500, 2)).toBe(-250);
  });

  it("is null without sales", () => {
    expect(averageTicketMinor(0, 0)).toBeNull();
  });
});

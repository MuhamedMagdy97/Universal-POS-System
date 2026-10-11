import { describe, expect, it } from "vitest";
import { pickActiveOrganization } from "@/lib/auth/active-org";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const older = new Date("2026-01-01T00:00:00Z");
const newer = new Date("2026-06-01T00:00:00Z");

describe("pickActiveOrganization", () => {
  it("returns null when the user has no active membership", () => {
    expect(pickActiveOrganization([])).toBeNull();
  });

  it("returns the only membership's org", () => {
    expect(pickActiveOrganization([{ orgId: A, createdAt: newer }])).toBe(A);
  });

  it("returns the oldest org when there are several memberships, whatever the input order", () => {
    expect(
      pickActiveOrganization([
        { orgId: A, createdAt: newer },
        { orgId: B, createdAt: older },
      ]),
    ).toBe(B);
    expect(
      pickActiveOrganization([
        { orgId: B, createdAt: older },
        { orgId: A, createdAt: newer },
      ]),
    ).toBe(B);
  });

  it("breaks a creation-time tie by org id so the choice is stable", () => {
    expect(
      pickActiveOrganization([
        { orgId: B, createdAt: older },
        { orgId: A, createdAt: older },
      ]),
    ).toBe(A);
  });
});

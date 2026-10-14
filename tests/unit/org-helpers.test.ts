import { describe, expect, it } from "vitest";
import { orgErrorKey } from "@/app/(app)/settings/_lib/errors";
import { BranchCode, canManageRole, Email } from "@/modules/org/schemas";

describe("onboarding helpers", () => {
  it("lets only owners manage owners and admins (O4)", () => {
    expect(canManageRole("OWNER", "OWNER")).toBe(true);
    expect(canManageRole("OWNER", "ADMIN")).toBe(true);
    expect(canManageRole("ADMIN", "ADMIN")).toBe(false);
    expect(canManageRole("ADMIN", "OWNER")).toBe(false);
    expect(canManageRole("ADMIN", "CASHIER")).toBe(true);
  });

  it("normalises branch codes and emails (O9)", () => {
    expect(BranchCode.parse(" north-1 ")).toBe("NORTH-1");
    expect(BranchCode.safeParse("TOO-LONG-CODE").success).toBe(false);
    expect(BranchCode.safeParse("A B").success).toBe(false);
    expect(Email.parse(" Owner@Shop.TEST ")).toBe("owner@shop.test");
  });

  it("maps service errors to messages by reason, then by code", () => {
    expect(orgErrorKey({ code: "CONFLICT", message: "", details: { reason: "LAST_OWNER" } })).toBe(
      "org.error.LAST_OWNER",
    );
    expect(orgErrorKey({ code: "RATE_LIMITED", message: "", details: { retryAfterSeconds: 5 } })).toBe(
      "org.error.rateLimited",
    );
    expect(orgErrorKey({ code: "VALIDATION_FAILED", message: "", details: [] })).toBe("org.error.invalid");
    expect(orgErrorKey({ code: "INTERNAL", message: "", details: null })).toBe("org.error.generic");
  });
});

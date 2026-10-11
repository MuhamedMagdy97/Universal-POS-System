import { describe, expect, it } from "vitest";
import { PERMISSIONS, hasPermission } from "@/lib/auth/permissions";

describe("permission matrix (docs/product/user-roles-permissions.md)", () => {
  it("grants owners everything", () => {
    for (const permission of PERMISSIONS) expect(hasPermission("OWNER", permission)).toBe(true);
  });

  it("limits reporting users to reports.view", () => {
    const granted = PERMISSIONS.filter((permission) => hasPermission("REPORTING", permission));
    expect(granted).toEqual(["reports.view"]);
  });

  it("does not let cashiers void, refund, override discounts or manage users", () => {
    for (const permission of [
      "sales.void",
      "sales.refund",
      "discounts.override",
      "discounts.apply",
      "users.manage",
    ] as const) {
      expect(hasPermission("CASHIER", permission)).toBe(false);
    }
    expect(hasPermission("CASHIER", "sales.create")).toBe(true);
    expect(hasPermission("CASHIER", "registers.open")).toBe(true);
  });

  it("gives managers voids, refunds and overrides but not user management", () => {
    expect(hasPermission("MANAGER", "sales.void")).toBe(true);
    expect(hasPermission("MANAGER", "sales.refund")).toBe(true);
    expect(hasPermission("MANAGER", "discounts.override")).toBe(true);
    expect(hasPermission("MANAGER", "users.manage")).toBe(false);
  });

  it("gives admins settings and catalog but not sales voids", () => {
    expect(hasPermission("ADMIN", "settings.manage")).toBe(true);
    expect(hasPermission("ADMIN", "products.create")).toBe(true);
    expect(hasPermission("ADMIN", "sales.void")).toBe(false);
  });
});

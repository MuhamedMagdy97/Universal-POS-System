import { describe, expect, it } from "vitest";
import { PERMISSIONS, hasPermission } from "@/lib/auth/permissions";

describe("permission matrix (docs/product/user-roles-permissions.md)", () => {
  it("grants owners everything", () => {
    for (const permission of PERMISSIONS) expect(hasPermission("OWNER", permission)).toBe(true);
  });

  it("limits reporting users to reports.view and read-only stock (inventory D5)", () => {
    const granted = PERMISSIONS.filter((permission) => hasPermission("REPORTING", permission));
    expect(granted).toEqual(["inventory.read", "reports.view"]);
  });

  it("lets managers, admins and owners read stock; cashiers get no stock screens (inventory D5)", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "REPORTING"] as const) {
      expect(hasPermission(role, "inventory.read")).toBe(true);
    }
    expect(hasPermission("CASHIER", "inventory.read")).toBe(false);
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
    expect(hasPermission("MANAGER", "sales.create")).toBe(true);
    expect(hasPermission("MANAGER", "registers.open")).toBe(true);
    expect(hasPermission("MANAGER", "registers.close")).toBe(true);
    expect(hasPermission("MANAGER", "sales.refund")).toBe(true);
    expect(hasPermission("MANAGER", "discounts.override")).toBe(true);
    expect(hasPermission("MANAGER", "users.manage")).toBe(false);
  });

  it("lets managers and cashiers read the catalog but not edit it (catalog Q1)", () => {
    for (const role of ["MANAGER", "CASHIER"] as const) {
      expect(hasPermission(role, "products.read")).toBe(true);
      expect(hasPermission(role, "products.create")).toBe(false);
      expect(hasPermission(role, "products.update")).toBe(false);
    }
    expect(hasPermission("REPORTING", "products.read")).toBe(false);
  });

  it("has no separate price permission; price changes ride on products.update (catalog Q10)", () => {
    expect(PERMISSIONS.filter((permission) => permission.startsWith("products."))).toEqual([
      "products.read",
      "products.create",
      "products.update",
    ]);
  });

  it("gives admins settings and catalog but not sales voids", () => {
    expect(hasPermission("ADMIN", "settings.manage")).toBe(true);
    expect(hasPermission("ADMIN", "products.create")).toBe(true);
    expect(hasPermission("ADMIN", "sales.void")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { PERMISSIONS, hasPermission } from "@/lib/auth/permissions";

describe("permission matrix (docs/product/user-roles-permissions.md)", () => {
  it("grants owners everything", () => {
    for (const permission of PERMISSIONS) expect(hasPermission("OWNER", permission)).toBe(true);
  });

  it("limits reporting users to reports.view, read-only stock (inventory D5) and reading customers", () => {
    const granted = PERMISSIONS.filter((permission) => hasPermission("REPORTING", permission));
    expect(granted).toEqual(["inventory.read", "customers.read", "reports.view"]);
  });

  it("lets managers, admins and owners read stock; cashiers get no stock screens (inventory D5)", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "REPORTING"] as const) {
      expect(hasPermission(role, "inventory.read")).toBe(true);
    }
    expect(hasPermission("CASHIER", "inventory.read")).toBe(false);
  });

  it("does not let cashiers void, refund, override discounts or manage users", () => {
    for (const permission of ["sales.void", "sales.refund", "discounts.override", "users.manage"] as const) {
      expect(hasPermission("CASHIER", permission)).toBe(false);
    }
    expect(hasPermission("CASHIER", "sales.create")).toBe(true);
    expect(hasPermission("CASHIER", "registers.open")).toBe(true);
    // Limited by the shop's maxCashierDiscountBp (discounts-spec DC7, DC8).
    expect(hasPermission("CASHIER", "discounts.apply")).toBe(true);
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

  it("lets owners and admins run purchasing and managers only receive (purchasing P1)", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      expect(hasPermission(role, "purchases.manage")).toBe(true);
      expect(hasPermission(role, "purchases.receive")).toBe(true);
    }
    expect(hasPermission("MANAGER", "purchases.manage")).toBe(false);
    expect(hasPermission("MANAGER", "purchases.receive")).toBe(true);
    for (const role of ["CASHIER", "REPORTING"] as const) {
      expect(hasPermission(role, "purchases.manage")).toBe(false);
      expect(hasPermission(role, "purchases.receive")).toBe(false);
    }
  });

  it("gives admins settings and catalog but not sales voids", () => {
    expect(hasPermission("ADMIN", "settings.manage")).toBe(true);
    expect(hasPermission("ADMIN", "products.create")).toBe(true);
    expect(hasPermission("ADMIN", "sales.void")).toBe(false);
  });

  it("lets cashiers read and add customers, and managers, admins and owners manage them (customers-spec CU6)", () => {
    expect(hasPermission("CASHIER", "customers.read")).toBe(true);
    expect(hasPermission("CASHIER", "customers.create")).toBe(true);
    expect(hasPermission("CASHIER", "customers.manage")).toBe(false);
    for (const role of ["OWNER", "ADMIN", "MANAGER"] as const) {
      for (const permission of ["customers.read", "customers.create", "customers.manage"] as const) {
        expect(hasPermission(role, permission)).toBe(true);
      }
    }
    expect(hasPermission("REPORTING", "customers.create")).toBe(false);
  });
});

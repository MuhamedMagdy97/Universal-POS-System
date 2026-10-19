/**
 * Action grants per role (docs/product/user-roles-permissions.md).
 * Business logic checks permissions, never role names.
 */
export const PERMISSIONS = [
  "products.read",
  "products.create",
  "products.update",
  "inventory.read",
  "inventory.adjust",
  "inventory.transfer",
  "sales.create",
  "sales.void",
  "sales.refund",
  "discounts.apply",
  "discounts.override",
  "registers.open",
  "registers.close",
  "purchases.manage",
  "purchases.receive",
  "reports.view",
  "users.manage",
  "settings.manage",
  // Phase 13 (integration spec I2): link the shop to the inventory system. Owner only.
  "integrations.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role = "OWNER" | "ADMIN" | "MANAGER" | "CASHIER" | "REPORTING";

const PRODUCTS: Permission[] = ["products.read", "products.create", "products.update"];
const INVENTORY: Permission[] = ["inventory.adjust", "inventory.transfer"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set<Permission>([
    "users.manage",
    "settings.manage",
    ...PRODUCTS,
    "inventory.read",
    ...INVENTORY,
    "purchases.manage",
    "purchases.receive",
    "reports.view",
  ]),
  // products.read lets managers and cashiers search and scan at the POS (catalog Q1).
  // Cost fields stay hidden from them: they require products.update.
  // Managers run a till too (sell, open and close shifts), so they can cover a register and refund at it (T8).
  // They receive deliveries at their branches but do not raise purchase orders (T5 P1).
  MANAGER: new Set<Permission>([
    "products.read",
    "sales.create",
    "registers.open",
    "registers.close",
    "inventory.read",
    ...INVENTORY,
    "sales.void",
    "sales.refund",
    "discounts.override",
    "purchases.receive",
    "reports.view",
  ]),
  // discounts.apply is granted per cashier later (T6); not part of the default.
  CASHIER: new Set<Permission>(["products.read", "sales.create", "registers.open", "registers.close"]),
  // Reporting reads stock (D5) but cannot change it.
  REPORTING: new Set<Permission>(["reports.view", "inventory.read"]),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

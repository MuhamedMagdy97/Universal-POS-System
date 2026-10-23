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
  // Customer records (customers-spec CU6): read and search, add, edit and archive.
  "customers.read",
  "customers.create",
  "customers.manage",
  "registers.open",
  "registers.close",
  "purchases.manage",
  "purchases.receive",
  "reports.view",
  "users.manage",
  "settings.manage",
  // Phase 13 (integration spec I2): link the shop to the inventory system. Owner only.
  "integrations.manage",
  // Offline till (offline-till-spec OF5, OF16): allow offline sales, enrol and revoke till devices. Owner only.
  "offline.manage",
  // Offline till (offline-till-spec OF13): the "Offline sales to review" list. Owner, Admin and Manager.
  "sales.review",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role = "OWNER" | "ADMIN" | "MANAGER" | "CASHIER" | "REPORTING";

const PRODUCTS: Permission[] = ["products.read", "products.create", "products.update"];
const INVENTORY: Permission[] = ["inventory.adjust", "inventory.transfer"];
const CUSTOMERS: Permission[] = ["customers.read", "customers.create", "customers.manage"];

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
    ...CUSTOMERS,
    "sales.review",
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
    ...CUSTOMERS,
    "sales.review",
  ]),
  // discounts.apply: cashiers discount up to the shop's maxCashierDiscountBp (discounts-spec DC7, DC8).
  CASHIER: new Set<Permission>([
    "products.read",
    "sales.create",
    "registers.open",
    "registers.close",
    "discounts.apply",
    // Pick a customer and quick-add one at the till; editing and archiving need a manager (CU6).
    "customers.read",
    "customers.create",
  ]),
  // Reporting reads stock (D5) but cannot change it.
  REPORTING: new Set<Permission>(["reports.view", "inventory.read", "customers.read"]),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Action grants per role (docs/product/user-roles-permissions.md).
 * Business logic checks permissions, never role names.
 */
export const PERMISSIONS = [
  "products.read",
  "products.create",
  "products.update",
  "inventory.adjust",
  "inventory.transfer",
  "sales.create",
  "sales.void",
  "sales.refund",
  "discounts.apply",
  "discounts.override",
  "registers.open",
  "registers.close",
  "purchases.receive",
  "reports.view",
  "users.manage",
  "settings.manage",
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
    ...INVENTORY,
    "purchases.receive",
    "reports.view",
  ]),
  MANAGER: new Set<Permission>([...INVENTORY, "sales.void", "sales.refund", "discounts.override", "reports.view"]),
  // discounts.apply is granted per cashier later (T6); not part of the default.
  CASHIER: new Set<Permission>(["sales.create", "registers.open", "registers.close"]),
  REPORTING: new Set<Permission>(["reports.view"]),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

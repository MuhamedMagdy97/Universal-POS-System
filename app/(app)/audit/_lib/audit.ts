import { MESSAGES, type Locale } from "@/lib/i18n";

/** Audit trail screen helpers. Pure. */

/** Actions the services write today, offered in the action filter. */
export const AUDIT_ACTIONS = [
  "sale.created",
  "sale.void",
  "refund.create",
  "shift.opened",
  "shift.closed",
  "shift.cash_movement",
  "inventory.opening.recorded",
  "inventory.adjusted",
  "inventory.transferred",
  "catalog.product.created",
  "catalog.product.updated",
  "catalog.product.price_changed",
  "catalog.product.archived",
  "catalog.product.restored",
  "catalog.product.imported",
  "catalog.variant.created",
  "catalog.variant.price_changed",
  "catalog.category.created",
  "catalog.barcode.added",
  "catalog.barcode.removed",
  "catalog.cost.received",
  "purchasing.supplier.created",
  "purchasing.supplier.updated",
  "purchasing.supplier.archived",
  "purchasing.supplier.restored",
  "customer.created",
  "customer.updated",
  "customer.archived",
  "customer.restored",
  "purchasing.po.created",
  "purchasing.po.updated",
  "purchasing.po.ordered",
  "purchasing.po.cancelled",
  "purchasing.po.closed",
  "purchasing.receipt.created",
  "reports.exported",
  "audit.exported",
  "org.created",
  "staff.added",
  "staff.updated",
  "staff.deactivated",
  "staff.reactivated",
  "staff.password_reset",
  "branch.created",
  "branch.updated",
  "branch.deactivated",
  "branch.reactivated",
  "register.created",
  "register.updated",
  "register.deactivated",
  "register.reactivated",
  "register.offline.enrolled",
  "register.offline.revoked",
  "settings.offline.updated",
  "sale.offline.flagged",
  "account.password_changed",
] as const;

export const AUDIT_ENTITY_TYPES = [
  "Sale",
  "Refund",
  "RegisterShift",
  "InventoryMovement",
  "Product",
  "ProductVariant",
  "Category",
  "Barcode",
  "Supplier",
  "Customer",
  "PurchaseOrder",
  "GoodsReceipt",
  "Report",
  "AuditEvent",
  "Organization",
  "Membership",
  "Branch",
  "Register",
  "User",
] as const;

/** A readable label (`sale.void` → "Sale voided"); an unknown action shows its raw name. */
export function actionLabel(action: string, locale: Locale): string {
  const key = `audit.action.${action}`;
  const messages = MESSAGES[locale] as Record<string, string>;
  if (Object.hasOwn(messages, key)) return messages[key] ?? action;
  if (action.endsWith(".permission.denied"))
    return `${messages["audit.filter.denied"] ?? ""} (${action.split(".")[0]})`;
  return action;
}

/** Metadata as key and value strings, nested values as JSON. */
export function metadataEntries(metadata: unknown): [string, string][] {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return Object.entries(metadata as Record<string, unknown>).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

/** The service query for the screen's filters; empty values are left out. */
export function auditQuery(filters: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) if (value) out[key] = value;
  return out;
}

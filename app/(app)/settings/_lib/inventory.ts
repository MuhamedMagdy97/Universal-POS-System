import type { ErrorBody } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";

/** Message for an inventory-system settings error (client-safe, pure). */

const REASONS = [
  "OPEN_SHIFTS",
  "OPEN_PURCHASE_ORDERS",
  "CHECK_FAILED",
  "NOT_LINKED",
  "SYNC_RUNNING",
  "ENCRYPTION_KEY_MISSING",
  "KEY_UNREADABLE",
  "API_KEY_REQUIRED",
  "ALREADY_SET",
  "INVENTORY_UNAVAILABLE",
  "INVENTORY_LINK_BROKEN",
  "INVENTORY_REJECTED",
  "PENDING_POSTINGS",
  "WAREHOUSE_UNKNOWN",
  "WAREHOUSE_TAKEN",
] as const;

export function inventoryErrorKey(error: ErrorBody): MessageKey {
  const reason = (error.details as { reason?: unknown } | null)?.reason;
  const known = REASONS.find((r) => r === reason);
  if (known) return `settings.inventory.error.${known}`;
  if (error.code === "FORBIDDEN") return "settings.inventory.error.forbidden";
  if (error.code === "VALIDATION_FAILED") return "settings.inventory.error.invalid";
  return "settings.inventory.error.generic";
}

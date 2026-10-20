/**
 * Pure helpers for the customer screens and the till picker (client-safe). Unit-tested in
 * tests/unit/customers-phone.test.ts. No DB, no server imports.
 */
import type { ErrorBody } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

/** Message for a failed customer write, by error code and `details.reason` (customers-spec CU2, CU3). */
export function customerErrorKey(error: ErrorBody): MessageKey {
  const reason = (error.details as { reason?: string } | null)?.reason;
  if (reason === "INVALID_PHONE") return "customers.error.phone";
  if (reason === "PHONE_TAKEN") return "customers.error.phoneTaken";
  if (error.code === "FORBIDDEN") return "customers.error.forbidden";
  if (error.code === "VALIDATION_FAILED") return "customers.error.invalid";
  if (error.code === "NOT_FOUND") return "customers.error.notFound";
  return "customers.error.generic";
}

/** The existing customer's id on a PHONE_TAKEN error, so the till can pick them instead. */
export function takenCustomerId(error: ErrorBody): string | null {
  const details = error.details as { reason?: string; customerId?: unknown } | null;
  return details?.reason === "PHONE_TAKEN" && typeof details.customerId === "string" ? details.customerId : null;
}

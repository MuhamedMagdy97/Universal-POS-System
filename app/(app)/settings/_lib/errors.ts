import type { ErrorBody } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";

/** Message for a shop setup, staff, branch, till or password error (client-safe, pure). */

const REASONS = [
  "EMAIL_TAKEN",
  "ALREADY_IN_SHOP",
  "BRANCH_CODE_TAKEN",
  "REGISTER_NAME_TAKEN",
  "BRANCH_HAS_STOCK",
  "BRANCH_HAS_OPEN_SHIFT",
  "LAST_BRANCH",
  "BRANCH_INACTIVE",
  "REGISTER_HAS_OPEN_SHIFT",
  "LAST_OWNER",
  "SELF",
  "WRONG_PASSWORD",
] as const;

export function orgErrorKey(error: ErrorBody): MessageKey {
  const reason = (error.details as { reason?: unknown } | null)?.reason;
  const known = REASONS.find((r) => r === reason);
  if (known) return `org.error.${known}`;
  switch (error.code) {
    case "RATE_LIMITED":
      return "org.error.rateLimited";
    case "FORBIDDEN":
      return "org.error.forbidden";
    case "NOT_FOUND":
      return "org.error.notFound";
    case "VALIDATION_FAILED":
      return "org.error.invalid";
    default:
      return "org.error.generic";
  }
}

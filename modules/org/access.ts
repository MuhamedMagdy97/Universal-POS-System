import "server-only";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError, forbidden } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";

export type Tx = Prisma.TransactionClient;

/** Denied attempts are audited as `settings.permission.denied` or `staff.permission.denied`. */
const DENIED_ACTION = { "settings.manage": "settings", "offline.manage": "settings", "users.manage": "staff" } as const;

export async function requirePermission(
  ctx: TenantContext,
  permission: keyof typeof DENIED_ACTION,
  attempt: { operation: string; entityType: string; entityId?: string; meta?: AuditRequestMeta },
): Promise<void> {
  if (hasPermission(ctx.role, permission as Permission)) return;
  await recordDenied(ctx, `${DENIED_ACTION[permission]}.permission.denied`, attempt, { permission });
  throw forbidden("Missing permission for this action");
}

/** Audits a refused attempt outside the (rolled back) transaction; a failed write never hides the 403. */
export async function recordDenied(
  ctx: TenantContext,
  action: `${string}.permission.denied`,
  attempt: { operation: string; entityType: string; entityId?: string; meta?: AuditRequestMeta },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await record(getDb(), {
      ctx,
      meta: attempt.meta,
      action,
      entityType: attempt.entityType,
      entityId: attempt.entityId,
      metadata: { operation: attempt.operation, ...metadata },
    });
  } catch {
    // A failed audit write must not turn a 403 into a 500.
  }
}

export type OrgConflictReason =
  | "EMAIL_TAKEN"
  | "ALREADY_IN_SHOP"
  | "BRANCH_CODE_TAKEN"
  | "REGISTER_NAME_TAKEN"
  | "BRANCH_HAS_STOCK"
  | "BRANCH_HAS_OPEN_SHIFT"
  | "LAST_BRANCH"
  | "BRANCH_INACTIVE"
  | "REGISTER_HAS_OPEN_SHIFT"
  | "LAST_OWNER";

export function orgConflict(reason: OrgConflictReason, message: string) {
  return new AppError(reason === "ALREADY_IN_SHOP" ? "FORBIDDEN" : "CONFLICT", message, { reason });
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

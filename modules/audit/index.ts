/**
 * audit — Append-only audit events; never logs secrets (T9).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 *
 * T3 pulls a minimal writer forward (catalog-api-and-rules.md §6): services
 * call `record(tx, event)` inside the same transaction as the change. Only
 * inserts are exposed; there is no update or delete.
 */
import type { Prisma } from "@/lib/generated/prisma/client";
import type { TenantContext } from "@/lib/auth/tenant";
import { redact } from "@/lib/logger";

/** Dotted action name, e.g. `catalog.product.price_changed`. */
export type AuditAction = `${string}.${string}`;

/** Any Prisma client or interactive-transaction client that can insert audit events. */
export type AuditWriter = { auditEvent: Pick<Prisma.TransactionClient["auditEvent"], "create"> };

/** Who acted: taken from the verified tenant context, never from client input. */
export type AuditActor = Pick<TenantContext, "orgId" | "branchId" | "userId">;

/** Request metadata (`RouteMeta` from lib/http.ts satisfies this). Server Actions may omit it. */
export type AuditRequestMeta = { requestId?: string | null };

export type AuditEventInput = {
  ctx: AuditActor;
  meta?: AuditRequestMeta;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

const ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Pure mapping from an event to the `AuditEvent` row. Metadata is redacted
 * (secret-looking keys → "[REDACTED]") and normalised to plain JSON.
 */
export function toAuditEventData(event: AuditEventInput): Prisma.AuditEventUncheckedCreateInput {
  if (!ACTION_PATTERN.test(event.action)) {
    throw new Error(`Invalid audit action "${event.action}"; expected dotted lower-case, e.g. catalog.product.created`);
  }
  if (event.entityType.trim() === "") throw new Error("Audit entityType is required");

  const requestId = event.meta?.requestId?.slice(0, MAX_REQUEST_ID_LENGTH) ?? null;
  const metadata = JSON.parse(JSON.stringify(redact(event.metadata ?? {}))) as Prisma.InputJsonObject;

  return {
    orgId: event.ctx.orgId,
    branchId: event.ctx.branchId,
    actorUserId: event.ctx.userId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    requestId,
    metadata,
  };
}

/** Append one audit event. Call with the transaction client so it commits or rolls back with the change. */
export async function record(tx: AuditWriter, event: AuditEventInput): Promise<void> {
  await tx.auditEvent.create({ data: toAuditEventData(event), select: { id: true } });
}

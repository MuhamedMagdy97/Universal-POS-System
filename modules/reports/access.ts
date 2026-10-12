import "server-only";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { prismaTenantRepository, type TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import type { CurrencyCode } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import type { ReportName } from "./schemas";
import { zoneFor } from "./timezone";

/**
 * Guards for reports (P4, P5, P6). The service checks the permission itself and audit-logs a
 * refusal, like the other modules. Reports read only: nothing here writes except denial and
 * export audit rows.
 */

type Area = "reports" | "audit";

const PERMISSION_FOR: Record<Area, Permission> = { reports: "reports.view", audit: "users.manage" };

/** Reports that show cost need a second grant on top of reports.view (T5 P5). */
const EXTRA_PERMISSION: Partial<Record<ReportName, Permission>> = { purchases: "purchases.manage" };

/** Whether the caller may run `report` (the picker hides the others). */
export function canRunReport(ctx: Pick<TenantContext, "role">, report: ReportName): boolean {
  const extra = EXTRA_PERMISSION[report];
  return hasPermission(ctx.role, "reports.view") && (extra === undefined || hasPermission(ctx.role, extra));
}

export async function requireAccess(
  ctx: TenantContext,
  area: Area,
  operation: string,
  meta?: AuditRequestMeta,
  report?: ReportName,
) {
  const extra = report ? EXTRA_PERMISSION[report] : undefined;
  const permission = extra && hasPermission(ctx.role, PERMISSION_FOR[area]) ? extra : PERMISSION_FOR[area];
  if (hasPermission(ctx.role, permission)) return;
  try {
    await record(getDb(), {
      ctx,
      meta,
      action: `${area}.permission.denied`,
      entityType: area === "reports" ? "Report" : "AuditEvent",
      metadata: { permission, operation },
    });
  } catch {
    // A failed audit write must not turn a 403 into a 500.
  }
  throw forbidden("Missing permission for this action");
}

export type ReportBranch = { id: string; name: string };

/** Active branches the caller may see, by name. Empty when the membership is inactive. */
export async function branchesInScope(ctx: TenantContext): Promise<ReportBranch[]> {
  const db = getDb();
  const membership = await prismaTenantRepository(db).findMembership(ctx.orgId, ctx.userId);
  if (!membership || !membership.isActive) return [];
  return db.branch.findMany({
    where: {
      orgId: ctx.orgId,
      isActive: true,
      ...(membership.allBranches ? {} : { membershipBranches: { some: { membershipId: membership.id } } }),
    },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/**
 * The branch ids a report covers: the one asked for (404 outside scope), or every branch in the
 * caller's scope ("All my branches"). Never empty: no branch in scope is a 404.
 */
export async function resolveBranchIds(ctx: TenantContext, branchId?: string): Promise<string[]> {
  const scope = await branchesInScope(ctx);
  if (branchId !== undefined) {
    if (!scope.some((b) => b.id === branchId)) throw notFound("Branch");
    return [branchId];
  }
  if (scope.length === 0) throw notFound("Branch");
  return scope.map((b) => b.id);
}

export type OrgReportSettings = { zone: string; currency: CurrencyCode };

export async function orgSettings(orgId: string): Promise<OrgReportSettings> {
  const org = await getDb().organization.findUnique({
    where: { id: orgId },
    select: { countryCode: true, currency: true },
  });
  if (!org) throw notFound("Organization");
  return { zone: zoneFor(org.countryCode), currency: org.currency };
}

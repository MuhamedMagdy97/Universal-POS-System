import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getSession, toIdentity, type SessionIdentity } from "@/lib/auth/session";
import { prismaTenantRepository, resolveTenantContext } from "@/lib/auth/tenant";

type BadgeData = { orgName: string | null; branchName: string | null } | "no-access";

async function loadBadge(identity: SessionIdentity): Promise<BadgeData> {
  const db = getDb();
  try {
    const ctx = await resolveTenantContext(identity, {}, prismaTenantRepository(db));
    const [org, branch] = await Promise.all([
      db.organization.findUnique({ where: { id: ctx.orgId }, select: { name: true } }),
      ctx.branchId
        ? db.branch.findFirst({ where: { id: ctx.branchId, orgId: ctx.orgId }, select: { name: true } })
        : Promise.resolve(null),
    ]);
    return { orgName: org?.name ?? null, branchName: branch?.name ?? null };
  } catch (err) {
    if (err instanceof AppError) return "no-access";
    throw err;
  }
}

/** Shows the verified org/branch context of the current session. */
export async function TenantBadge() {
  const identity = toIdentity(await getSession(await headers()));
  if (!identity) redirect("/login");

  if (!identity.activeOrganizationId) {
    return <span className="text-muted">No organization selected</span>;
  }

  const data = await loadBadge(identity);
  if (data === "no-access") return <span className="text-muted">No access to this organization</span>;

  return (
    <span className="text-sm">
      <span className="font-medium">{data.orgName}</span>
      <span className="text-muted"> · {data.branchName ?? "No branch selected"}</span>
    </span>
  );
}

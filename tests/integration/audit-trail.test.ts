import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { DENIED_ACTIONS, listAuditActors, listAuditEvents } from "@/modules/reports";
import { createMember, createTenant, expectAppError, testDb } from "./helpers";

/** Audit trail (P6, P7): newest first, gap-free cursor paging, filters, Owner and Admin only. */

let db: Db;
let orgId: string;
let owner: TenantContext;
let admin: TenantContext;
let manager: TenantContext;
let otherOrgId: string;

const DAY = "2026-03-10";
const range = { from: DAY, to: DAY };
const SAME_INSTANT = new Date("2026-03-10T10:00:00.000Z");

beforeAll(async () => {
  db = testDb();
  const t = await createTenant(db, "Audit");
  orgId = t.org.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  const other = await createTenant(db, "AuditOther");
  otherOrgId = other.org.id;

  const event = (createdAt: Date, actor: TenantContext, action: string, entityId: string, org = orgId) => ({
    orgId: org,
    actorUserId: actor.userId,
    action,
    entityType: "Sale",
    entityId,
    metadata: { n: entityId },
    createdAt,
  });
  // 70 events at one instant (ties must page by id) and 50 spread over the day.
  await db.auditEvent.createMany({
    data: [
      ...Array.from({ length: 70 }, (_, i) => event(SAME_INSTANT, owner, "sale.created", `tie-${i}`)),
      ...Array.from({ length: 50 }, (_, i) =>
        event(new Date(Date.UTC(2026, 2, 10, 6, i)), manager, "sale.void", `spread-${i}`),
      ),
      event(new Date("2026-03-10T11:00:00Z"), manager, "sales.permission.denied", "denied-1"),
      event(new Date("2026-03-10T11:00:00Z"), owner, "sale.created", "other-org", otherOrgId),
      event(new Date("2026-03-11T11:00:00Z"), owner, "sale.created", "next-day"),
    ],
  });
});

afterAll(async () => {
  await db.$disconnect();
});

async function everything(ctx: TenantContext, filters: Record<string, string> = {}) {
  const rows = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await listAuditEvents(ctx, { ...range, ...filters, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 10) throw new Error("paging did not end");
  } while (cursor);
  return { rows, pages };
}

describe("audit trail", () => {
  it("pages newest first with no gaps or repeats, even across equal times", async () => {
    const { rows, pages } = await everything(owner);
    expect(rows).toHaveLength(121);
    expect(pages).toBe(3);
    expect(new Set(rows.map((r) => r.id)).size).toBe(121);
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      if (!a || !b) throw new Error("missing row");
      expect(a.at.getTime() > b.at.getTime() || (a.at.getTime() === b.at.getTime() && a.id > b.id)).toBe(true);
    }
    expect(rows.some((r) => r.entityId === "other-org" || r.entityId === "next-day")).toBe(false);
    expect(rows[0]).toMatchObject({ action: "sales.permission.denied", actorName: expect.stringContaining("MANAGER") });
  });

  it("filters by actor, action, denied attempts and record", async () => {
    expect((await everything(owner, { actor: manager.userId })).rows).toHaveLength(51);
    expect((await everything(owner, { action: "sale.void" })).rows).toHaveLength(50);
    const denied = await everything(owner, { action: DENIED_ACTIONS });
    expect(denied.rows.map((r) => r.entityId)).toEqual(["denied-1"]);
    const one = await everything(owner, { entityType: "Sale", entityId: "tie-3" });
    expect(one.rows.map((r) => r.metadata)).toEqual([{ n: "tie-3" }]);
  });

  it("is for Owner and Admin only", async () => {
    expect((await listAuditEvents(admin, range)).rows).toHaveLength(50);
    await expectAppError(listAuditEvents(manager, range), 403);
    const refusal = await db.auditEvent.findFirst({
      where: { orgId, actorUserId: manager.userId, action: "audit.permission.denied" },
    });
    expect(refusal).not.toBeNull();
    await expectAppError(listAuditActors(manager), 403);
    const actors = await listAuditActors(owner);
    expect(actors.map((a) => a.id).sort()).toEqual([owner.userId, admin.userId, manager.userId].sort());
  });

  it("refuses a forged cursor and a second wildcard", async () => {
    await expectAppError(listAuditEvents(owner, { ...range, cursor: "Zm9vfGJhcg" }), 422, "INVALID_CURSOR");
    await expect(listAuditEvents(owner, { ...range, action: "*.created" })).rejects.toThrow();
  });
});

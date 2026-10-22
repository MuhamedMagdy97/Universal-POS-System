import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { hashDeviceSecret } from "@/modules/sales/offline";
import { requirePermission, type Tx } from "./access";
import { Uuid } from "./schemas";

/**
 * Offline till settings (docs/planning/offline-till/offline-till-spec.md, slice 1): the shop's "Allow offline
 * sales" (OF5) and the one enrolled device per register with its offline series code (OF8, OF16). Owner and Admin
 * read it (`settings.manage`); only the Owner changes it (`offline.manage`). Refused for a shop linked to the
 * inventory system (OF15); linking is refused in turn while offline is on (inventory-sys/link.ts).
 */

export const OfflineSettingsInput = z.strictObject({ allowOfflineSales: z.boolean() });

export type OfflineRegisterRow = {
  id: string;
  name: string;
  branchName: string;
  isActive: boolean;
  offlineCode: string | null;
  lastOfflineSaleNo: number;
  device: { id: string; enrolledAt: string } | null;
};

export type OfflineSettings = {
  allowOfflineSales: boolean;
  linked: boolean;
  canManage: boolean;
  registers: OfflineRegisterRow[];
};

/** What the device keeps (IndexedDB, OF10). The secret is shown once and stored only as a hash. */
export type EnrolledDevice = {
  deviceId: string;
  deviceSecret: string;
  registerId: string;
  offlineCode: string;
  lastOfflineSaleNo: number;
};

function conflict(reason: string, message: string): AppError {
  return new AppError("CONFLICT", message, { reason });
}

function requireOwner(ctx: TenantContext, operation: string, meta?: AuditRequestMeta): Promise<void> {
  return requirePermission(ctx, "offline.manage", { operation, entityType: "Organization", entityId: ctx.orgId, meta });
}

/** The org row, locked: serialises with setInventorySource, which locks it too. */
async function lockOrg(tx: Tx, orgId: string): Promise<{ allowOfflineSales: boolean; linked: boolean }> {
  const [org] = await tx.$queryRaw<{ allowOfflineSales: boolean; linked: boolean }[]>`
    SELECT "allowOfflineSales", "inventorySource" = 'EXTERNAL' AS "linked"
      FROM "Organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`;
  return org;
}

export async function getOfflineSettings(ctx: TenantContext): Promise<OfflineSettings> {
  await requirePermission(ctx, "settings.manage", { operation: "offline.read", entityType: "Organization" });
  const db = getDb();
  const [org, registers] = await Promise.all([
    db.organization.findUniqueOrThrow({
      where: { id: ctx.orgId },
      select: { allowOfflineSales: true, inventorySource: true },
    }),
    db.register.findMany({
      where: { orgId: ctx.orgId },
      orderBy: [{ branch: { name: "asc" } }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        isActive: true,
        offlineCode: true,
        lastOfflineSaleNo: true,
        branch: { select: { name: true } },
        devices: { where: { revokedAt: null }, select: { id: true, enrolledAt: true } },
      },
    }),
  ]);
  return {
    allowOfflineSales: org.allowOfflineSales,
    linked: org.inventorySource === "EXTERNAL",
    canManage: hasPermission(ctx.role, "offline.manage"),
    registers: registers.map(({ branch, devices, ...register }) => ({
      ...register,
      branchName: branch.name,
      device: devices[0] ? { id: devices[0].id, enrolledAt: devices[0].enrolledAt.toISOString() } : null,
    })),
  };
}

/** OF5: on is refused while linked; off keeps enrolled devices so sales already rung up still sync. */
export async function updateOfflineSettings(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ allowOfflineSales: boolean }> {
  await requireOwner(ctx, "offline.update", meta);
  const { allowOfflineSales } = OfflineSettingsInput.parse(input);
  return getDb().$transaction(async (tx) => {
    const before = await lockOrg(tx, ctx.orgId);
    if (allowOfflineSales && before.linked) {
      throw conflict("INVENTORY_LINKED", "A shop linked to the inventory system cannot sell offline");
    }
    if (before.allowOfflineSales !== allowOfflineSales) {
      await tx.organization.update({ where: { id: ctx.orgId }, data: { allowOfflineSales } });
      await record(tx, {
        ctx,
        meta,
        action: "settings.offline.updated",
        entityType: "Organization",
        entityId: ctx.orgId,
        metadata: { allowOfflineSales: { from: before.allowOfflineSales, to: allowOfflineSales } },
      });
    }
    return { allowOfflineSales };
  });
}

/**
 * OF16: turning offline on for a register enrols the calling browser. One device per register: revoke the old one
 * first. The register gets its series code (T1, T2, ...) the first time and keeps it.
 */
export async function enrolOfflineDevice(
  ctx: TenantContext,
  registerId: string,
  meta?: AuditRequestMeta,
): Promise<EnrolledDevice> {
  await requireOwner(ctx, "offline.enrol", meta);
  if (!Uuid.safeParse(registerId).success) throw notFound("Register");
  const deviceSecret = randomBytes(32).toString("base64url");
  return getDb().$transaction(async (tx) => {
    const org = await lockOrg(tx, ctx.orgId);
    if (org.linked) throw conflict("INVENTORY_LINKED", "A shop linked to the inventory system cannot sell offline");
    if (!org.allowOfflineSales) throw conflict("OFFLINE_DISABLED", "Turn on offline sales for the shop first");
    const [register] = await tx.$queryRaw<
      { isActive: boolean; offlineCode: string | null; lastOfflineSaleNo: number }[]
    >`
      SELECT "isActive", "offlineCode", "lastOfflineSaleNo" FROM "Register"
       WHERE "id" = ${registerId}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
    if (!register || !register.isActive) throw notFound("Register");
    if (await tx.registerDevice.count({ where: { orgId: ctx.orgId, registerId, revokedAt: null } })) {
      throw conflict("DEVICE_ALREADY_ENROLLED", "This till already has an offline device; revoke it first");
    }
    // Codes are never taken back, so the next one is one past the count (the org row lock serialises this).
    const offlineCode =
      register.offlineCode ??
      `T${(await tx.register.count({ where: { orgId: ctx.orgId, offlineCode: { not: null } } })) + 1}`;
    if (!register.offlineCode) await tx.register.update({ where: { id: registerId }, data: { offlineCode } });
    const device = await tx.registerDevice.create({
      data: { orgId: ctx.orgId, registerId, secretHash: hashDeviceSecret(deviceSecret), enrolledById: ctx.userId },
      select: { id: true },
    });
    await record(tx, {
      ctx,
      meta,
      action: "register.offline.enrolled",
      entityType: "Register",
      entityId: registerId,
      metadata: { deviceId: device.id, offlineCode },
    });
    return {
      deviceId: device.id,
      deviceSecret,
      registerId,
      offlineCode,
      lastOfflineSaleNo: register.lastOfflineSaleNo,
    };
  });
}

/** OF16: the register's device stops being accepted; its unsynced sales are refused and listed (OF13). */
export async function revokeOfflineDevice(
  ctx: TenantContext,
  registerId: string,
  meta?: AuditRequestMeta,
): Promise<void> {
  await requireOwner(ctx, "offline.revoke", meta);
  if (!Uuid.safeParse(registerId).success) throw notFound("Register");
  await getDb().$transaction(async (tx) => {
    const device = await tx.registerDevice.findFirst({
      where: { orgId: ctx.orgId, registerId, revokedAt: null },
      select: { id: true },
    });
    if (!device) throw notFound("Device");
    await tx.registerDevice.update({
      where: { id: device.id },
      data: { revokedAt: new Date(), revokedById: ctx.userId },
    });
    await record(tx, {
      ctx,
      meta,
      action: "register.offline.revoked",
      entityType: "Register",
      entityId: registerId,
      metadata: { deviceId: device.id },
    });
  });
}

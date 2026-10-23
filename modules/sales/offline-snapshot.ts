import "server-only";
import type { Role } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import type { CurrencyCode } from "@/lib/money";
import { listSellable } from "@/modules/catalog";
import type { SellableSummary } from "@/modules/catalog/schemas";
import { Uuid } from "@/modules/inventory/schemas";
import { zoneFor } from "@/modules/reports/timezone";
import { requireBranch, requirePermission, requireRegister } from "./access";
import type { ReceiptShop } from "./receipt";
import { isSaudiVatNumber } from "./zatca";

/**
 * The till snapshot (offline-till-spec OF7, slice 2): what one register needs to sell while the server is
 * unreachable. No stock, customers, costs or other branches. The device keeps it in IndexedDB.
 */

/** Bumped when the snapshot or the offline sale it produces changes shape (sent as `offline.snapshotVersion`). */
export const SNAPSHOT_VERSION = 1;

export type SnapshotItem = SellableSummary & { barcodes: string[] };

export type TillSnapshot = {
  version: number;
  snapshotAt: string;
  orgId: string;
  branchId: string;
  /** The shop allows offline sales and is not linked to the inventory system (OF5, OF15). */
  allowOfflineSales: boolean;
  register: { id: string; name: string; offlineCode: string | null; deviceId: string | null };
  shift: { id: string; openedAt: string } | null;
  user: { id: string; name: string; role: Role };
  /** The session dies here; no offline sale after it (OF17, OF19). */
  sessionExpiresAt: string | null;
  settings: { currency: CurrencyCode; vatRateBp: number; pricesIncludeVat: boolean; maxCashierDiscountBp: number };
  shop: ReceiptShop;
  timeZone: string;
  /** Set for a Saudi shop with a valid VAT number: the offline slip carries the phase-1 QR (OF9). */
  zatcaVatNumber: string | null;
  items: SnapshotItem[];
};

export async function getTillSnapshot(
  ctx: TenantContext,
  branchId: string,
  registerId: string,
  sessionExpiresAt: Date | null,
): Promise<TillSnapshot> {
  await requirePermission(ctx, "sales.create", { operation: "offline.snapshot", entityType: "Sale" });
  if (!Uuid.safeParse(branchId).success) throw notFound("Branch");
  if (!Uuid.safeParse(registerId).success) throw notFound("Register");
  await requireBranch(ctx, branchId);
  const db = getDb();
  await requireRegister(db, ctx.orgId, branchId, registerId);
  const snapshotAt = new Date();
  const [org, branch, register, shift, user, items] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId } }),
    db.branch.findUniqueOrThrow({ where: { id: branchId }, select: { name: true, address: true } }),
    db.register.findUniqueOrThrow({
      where: { id: registerId },
      select: { name: true, offlineCode: true, devices: { where: { revokedAt: null }, select: { id: true } } },
    }),
    db.registerShift.findFirst({
      where: { orgId: ctx.orgId, registerId, status: "OPEN" },
      select: { id: true, openedAt: true },
    }),
    db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { name: true } }),
    listSellable(ctx),
  ]);
  return {
    version: SNAPSHOT_VERSION,
    snapshotAt: snapshotAt.toISOString(),
    orgId: ctx.orgId,
    branchId,
    allowOfflineSales: org.allowOfflineSales && org.inventorySource !== "EXTERNAL",
    register: {
      id: registerId,
      name: register.name,
      offlineCode: register.offlineCode,
      deviceId: register.devices[0]?.id ?? null,
    },
    shift: shift ? { id: shift.id, openedAt: shift.openedAt.toISOString() } : null,
    user: { id: ctx.userId, name: user.name, role: ctx.role },
    sessionExpiresAt: sessionExpiresAt?.toISOString() ?? null,
    settings: {
      currency: org.currency,
      vatRateBp: org.vatRateBp,
      pricesIncludeVat: org.pricesIncludeVat,
      maxCashierDiscountBp: org.maxCashierDiscountBp,
    },
    // Same fields as the server-built receipt (receipt.ts).
    shop: {
      name: org.legalName ?? org.name,
      branchName: branch.name,
      address: org.receiptAddress ?? branch.address,
      phone: org.receiptPhone,
      taxNumber: org.taxNumber,
      header: org.receiptHeader,
      footer: org.receiptFooter,
    },
    timeZone: zoneFor(org.countryCode),
    zatcaVatNumber: org.countryCode === "SA" && org.taxNumber && isSaudiVatNumber(org.taxNumber) ? org.taxNumber : null,
    items,
  };
}

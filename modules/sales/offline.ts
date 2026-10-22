import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { hasPermission, type Role } from "@/lib/auth/permissions";
import { AppError, notFound } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { multiply, sum } from "@/lib/money";
import type { SellableItem } from "@/modules/catalog/schemas";
import { lockShift } from "@/modules/registers";
import type { OfflineSaleInput, SaleInput } from "./schemas";
import { allocate, overDiscountLimit, priceSale, type PricedSale } from "./totals";

/**
 * Offline sales replayed by their device (docs/planning/offline-till/offline-till-spec.md, slice 1). An offline
 * sale is a fact, not a request (OF12): it is recorded as sold, and each drift since the sale only sets a review
 * flag (OF13). Hard refusals are malformed bodies, unknown items, wrong tenant/branch/register, an unknown or
 * revoked device and an idempotency conflict.
 */

type Tx = Prisma.TransactionClient;

export type OfflineFlag =
  | "PRICE_CHANGED"
  | "ITEM_ARCHIVED"
  | "STOCK_NEGATIVE"
  | "DISCOUNT_OVER_LIMIT"
  | "LATE_FOR_CLOSED_SHIFT"
  | "STALE_SNAPSHOT"
  | "CLOCK_SKEW"
  | "TOTALS_DIFFER";

/** Each raised flag and what the review list shows for it, in the order raised. */
export type OfflineFlags = Map<OfflineFlag, Record<string, unknown>>;

/** OF7: offline selling may start only on a snapshot at most 24 h old. */
const STALE_SNAPSHOT_MS = 24 * 60 * 60_000;
/** OF20: device clocks drift; a soldAt up to this far ahead of the server is not flagged. */
const CLOCK_GRACE_MS = 5 * 60_000;

export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function deviceRefused(reason: "DEVICE_NOT_ENROLLED" | "DEVICE_REVOKED"): AppError {
  return new AppError(
    "FORBIDDEN",
    reason === "DEVICE_REVOKED" ? "This device was revoked" : "This device may not sell offline here",
    { reason },
  );
}

function malformed(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason: "OFFLINE_SALE_INVALID", ...details });
}

/** OF16: the device is enrolled on this register, not revoked, and knows its secret. Row-locked against a revoke. */
export async function requireOfflineDevice(
  tx: Tx,
  orgId: string,
  registerId: string,
  offline: OfflineSaleInput,
): Promise<void> {
  const [device] = await tx.$queryRaw<{ registerId: string; secretHash: string; revoked: boolean }[]>`
    SELECT "registerId", "secretHash", "revokedAt" IS NOT NULL AS "revoked" FROM "RegisterDevice"
     WHERE "id" = ${offline.deviceId}::uuid AND "orgId" = ${orgId}::uuid FOR UPDATE`;
  const given = Buffer.from(hashDeviceSecret(offline.deviceSecret), "hex");
  const stored = Buffer.from(device?.secretHash ?? "", "hex");
  if (
    !device ||
    device.registerId !== registerId ||
    stored.length !== given.length ||
    !timingSafeEqual(stored, given)
  ) {
    throw deviceRefused("DEVICE_NOT_ENROLLED");
  }
  if (device.revoked) throw deviceRefused("DEVICE_REVOKED");
}

/**
 * Keeps the register's offline series (OF8): the number must carry the register's code, must not be taken, and
 * moves the register's high-water mark. The register row lock serialises this register's offline sales.
 */
export async function claimOfflineNumber(tx: Tx, orgId: string, registerId: string, number: string): Promise<void> {
  const [code, digits] = number.split("-");
  const seq = Number(digits);
  const [register] = await tx.$queryRaw<{ offlineCode: string | null }[]>`
    UPDATE "Register" SET "lastOfflineSaleNo" = GREATEST("lastOfflineSaleNo", ${seq})
     WHERE "id" = ${registerId}::uuid AND "orgId" = ${orgId}::uuid
    RETURNING "offlineCode"`;
  if (seq < 1 || !register || register.offlineCode !== code) {
    throw malformed("This number is not in the register's offline series", { number });
  }
  if (await tx.sale.findFirst({ where: { orgId, number }, select: { id: true } })) {
    throw new AppError("CONFLICT", "Another sale already has this number", { reason: "OFFLINE_NUMBER_TAKEN", number });
  }
}

/** The shift the device rang the sale in (OF13): this register's, open or closed, locked like an online sale's. */
export async function offlineShift(
  tx: Tx,
  orgId: string,
  branchId: string,
  registerId: string,
  shiftId: string,
): Promise<{ id: string; status: "OPEN" | "CLOSED"; openedAt: Date }> {
  const where = { id: shiftId, orgId, branchId, registerId };
  if (!(await tx.registerShift.findFirst({ where, select: { id: true } }))) throw notFound("Shift");
  await lockShift(tx, orgId, shiftId);
  return tx.registerShift.findFirstOrThrow({ where, select: { id: true, status: true, openedAt: true } });
}

/** The cashier who rang it up: a member of this shop, even if deactivated since (their sale still happened). */
export async function offlineCashierRole(tx: Tx, orgId: string, cashierId: string): Promise<Role> {
  const membership = await tx.membership.findFirst({ where: { orgId, userId: cashierId }, select: { role: true } });
  if (!membership) throw notFound("Cashier");
  return membership.role;
}

/** Which refs are archived now (the catalog seam does not say; sold offline anyway, OF13). */
export async function archivedFlags(
  tx: Tx,
  orgId: string,
  refs: readonly { productId: string; variantId: string | null }[],
): Promise<boolean[]> {
  const variantIds = refs.flatMap((ref) => (ref.variantId ? [ref.variantId] : []));
  const [products, variants] = await Promise.all([
    tx.product.findMany({
      where: { orgId, id: { in: refs.map((ref) => ref.productId) } },
      select: { id: true, isActive: true },
    }),
    tx.productVariant.findMany({ where: { orgId, id: { in: variantIds } }, select: { id: true, isActive: true } }),
  ]);
  const inactive = new Set([...products, ...variants].filter((row) => !row.isActive).map((row) => row.id));
  return refs.map((ref) => inactive.has(ref.productId) || (ref.variantId !== null && inactive.has(ref.variantId)));
}

type OrgSettings = { vatRateBp: number; pricesIncludeVat: boolean; maxCashierDiscountBp: number };

/**
 * The sale as the device priced it (OF12). Recomputed with the shared totals.ts from the device's prices and the
 * sent discounts; when that matches what the device sent (the normal case) it is used as is, with per-line VAT.
 * Otherwise (VAT rate changed since the snapshot) the device's figures stand, VAT is spread over the lines, and
 * TOTALS_DIFFER is flagged. Device totals that do not add up are malformed (a hard refusal).
 */
export function priceOfflineSale(
  items: readonly SellableItem[],
  lines: readonly { qty: number; discount: SaleInput["discount"] | null }[],
  input: SaleInput,
  offline: OfflineSaleInput,
  org: OrgSettings,
  cashierRole: Role,
  flags: OfflineFlags,
): { items: SellableItem[]; totals: PricedSale } {
  const sold = offline.lines;
  if (sold.length !== lines.length) throw malformed("Each item may appear once in an offline sale");
  const shelf = sold.map((line, index) => multiply(line.unitPriceMinor, lines[index].qty));
  if (
    sold.some((line, index) => line.discountMinor > shelf[index]) ||
    sum(sold.map((line) => line.lineTotalMinor)) !== offline.totalMinor ||
    offline.subtotalMinor + offline.vatMinor !== offline.totalMinor
  ) {
    throw malformed("The offline totals do not add up");
  }

  const changed = items.flatMap((item, index) =>
    item.unitPriceMinor === sold[index].unitPriceMinor
      ? []
      : [{ sku: item.sku, soldMinor: sold[index].unitPriceMinor, currentMinor: item.unitPriceMinor }],
  );
  if (changed.length > 0) flags.set("PRICE_CHANGED", { lines: changed });

  const asSold = items.map((item, index) => ({ ...item, unitPriceMinor: sold[index].unitPriceMinor }));
  const repriced = priceSale(
    asSold.map((item, index) => ({
      unitPriceMinor: item.unitPriceMinor,
      qty: lines[index].qty,
      vatApplicable: item.vatApplicable,
      discount: lines[index].discount,
    })),
    input.discount,
    org.vatRateBp,
    org.pricesIncludeVat,
  );

  if (repriced.discountMinor > 0 && !hasPermission(cashierRole, "discounts.override")) {
    const over =
      !hasPermission(cashierRole, "discounts.apply") || overDiscountLimit(repriced, org.maxCashierDiscountBp);
    if (over) {
      flags.set("DISCOUNT_OVER_LIMIT", {
        cashierId: offline.cashierId,
        discountMinor: repriced.discountMinor,
        limitBp: hasPermission(cashierRole, "discounts.apply") ? org.maxCashierDiscountBp : 0,
      });
    }
  }

  const same =
    repriced.subtotalMinor === offline.subtotalMinor &&
    repriced.vatMinor === offline.vatMinor &&
    repriced.totalMinor === offline.totalMinor &&
    repriced.lines.every(
      (line, index) =>
        line.discountMinor === sold[index].discountMinor && line.lineTotalMinor === sold[index].lineTotalMinor,
    );
  if (same) return { items: asSold, totals: repriced };

  flags.set("TOTALS_DIFFER", {
    device: { subtotalMinor: offline.subtotalMinor, vatMinor: offline.vatMinor, totalMinor: offline.totalMinor },
    server: { subtotalMinor: repriced.subtotalMinor, vatMinor: repriced.vatMinor, totalMinor: repriced.totalMinor },
  });
  const taxed = sold.map((line, index) => (items[index].vatApplicable ? line.lineTotalMinor : 0));
  const vat = allocate(offline.vatMinor, taxed.some((weight) => weight > 0) ? taxed : shelf);
  const totals: PricedSale = {
    subtotalMinor: offline.subtotalMinor,
    vatMinor: offline.vatMinor,
    totalMinor: offline.totalMinor,
    shelfMinor: sum(shelf),
    discountMinor: sum(sold.map((line) => line.discountMinor)),
    lines: sold.map((line, index) => ({
      netMinor: line.lineTotalMinor - vat[index],
      vatRateBp: items[index].vatApplicable ? org.vatRateBp : 0,
      vatMinor: vat[index],
      lineTotalMinor: line.lineTotalMinor,
      shelfMinor: shelf[index],
      lineDiscountMinor: line.discountMinor,
      discountMinor: line.discountMinor,
    })),
  };
  return { items: asSold, totals };
}

/** OF13 time checks: a snapshot over 24 h old at sale time, and OF20 clock skew (future, or before the shift). */
export function flagTimes(
  offline: OfflineSaleInput,
  shift: { status: "OPEN" | "CLOSED"; openedAt: Date },
  receivedAt: Date,
  flags: OfflineFlags,
): void {
  const soldAt = new Date(offline.soldAt);
  const snapshotAt = new Date(offline.snapshotAt);
  if (shift.status === "CLOSED") flags.set("LATE_FOR_CLOSED_SHIFT", { shiftId: offline.shiftId });
  if (soldAt.getTime() - snapshotAt.getTime() > STALE_SNAPSHOT_MS) {
    flags.set("STALE_SNAPSHOT", { snapshotAt: snapshotAt.toISOString(), soldAt: soldAt.toISOString() });
  }
  if (soldAt.getTime() > receivedAt.getTime() + CLOCK_GRACE_MS || soldAt < shift.openedAt) {
    flags.set("CLOCK_SKEW", {
      soldAt: soldAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
      shiftOpenedAt: shift.openedAt.toISOString(),
    });
  }
}

/** The sale with its device secret removed: what the request hash covers (the secret is not part of the sale). */
export function hashedBody(input: SaleInput): unknown {
  if (!input.offline) return input;
  const offline = Object.fromEntries(Object.entries(input.offline).filter(([key]) => key !== "deviceSecret"));
  return { ...input, offline };
}

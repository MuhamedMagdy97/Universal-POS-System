/**
 * Pure helpers for the offline till (docs/planning/offline-till/offline-till-spec.md, slice 2), client-safe.
 * Unit-tested in tests/unit/pos-offline.test.ts. The device prices with the same totals.ts as the server (OF9),
 * so the slip printed offline is the sale the server records.
 */
import type { z } from "zod";
import type { ErrorBody } from "@/lib/errors";
import type { ReceiptDoc, SnapshotItem, TillSnapshot } from "@/modules/sales";
import type { SaleInput } from "@/modules/sales/schemas";
import { priceSale, settlePayments, type Discount } from "@/modules/sales/totals";
import { qrSvg, zatcaTlvBase64 } from "@/modules/sales/zatca";
import type { ActionResult } from "../../inventory/_lib/form";
import type { CartLine, PaymentPlan, TillItem } from "./till";

export type SaleBody = z.input<typeof SaleInput>;

/** What the device keeps after enrolment (OF16); the secret never leaves it except inside replays. */
export type OfflineDevice = {
  deviceId: string;
  deviceSecret: string;
  registerId: string;
  offlineCode: string;
  lastOfflineSaleNo: number;
};

/** A sale waiting on the device (OF10). Deleted only after the server took it; a refused one stays, red. */
export type QueueEntry = {
  /** The cart's Idempotency-Key, kept for every replay. */
  key: string;
  registerId: string;
  number: string;
  soldAt: string;
  totalMinor: number;
  body: SaleBody;
  status: "PENDING" | "REJECTED";
  error: ErrorBody | null;
};

/** OF7: offline selling may start only on a snapshot at most this old. */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
/** OF19 limits: constants, not settings. */
export const CONTACT_LIMIT_MS = 12 * 60 * 60_000;
export const MAX_QUEUED = 300;
/** A sale with no answer after this long counts as unreachable (OF6); its key is kept, so a replay is safe. */
export const SALE_TIMEOUT_MS = 15_000;

export type OfflineBlock =
  | "NOT_ENABLED"
  | "NO_DEVICE"
  | "NO_SHIFT"
  | "OTHER_USER"
  | "STALE_SNAPSHOT"
  | "CONTACT_LIMIT"
  | "QUEUE_FULL"
  | "SESSION_EXPIRED"
  | "CUSTOMER";

/** Why this device may not sell offline right now, or null when it may (OF5, OF7, OF16, OF17, OF19). */
export function offlineBlock(input: {
  snapshot: TillSnapshot | null;
  device: OfflineDevice | null;
  userId: string;
  lastContactAt: string | null;
  queued: number;
  now: Date;
}): OfflineBlock | null {
  const { snapshot, device, now } = input;
  if (!snapshot || !snapshot.allowOfflineSales) return "NOT_ENABLED";
  // The server's live device for this register must be this one: a revoke or a re-enrol elsewhere stops it.
  if (!device || snapshot.register.deviceId !== device.deviceId || !snapshot.register.offlineCode) return "NO_DEVICE";
  if (snapshot.user.id !== input.userId) return "OTHER_USER";
  if (!snapshot.shift) return "NO_SHIFT";
  const time = now.getTime();
  if (time - Date.parse(snapshot.snapshotAt) > SNAPSHOT_MAX_AGE_MS) return "STALE_SNAPSHOT";
  if (snapshot.sessionExpiresAt && time >= Date.parse(snapshot.sessionExpiresAt)) return "SESSION_EXPIRED";
  if (time - Date.parse(input.lastContactAt ?? snapshot.snapshotAt) > CONTACT_LIMIT_MS) return "CONTACT_LIMIT";
  if (input.queued >= MAX_QUEUED) return "QUEUE_FULL";
  return null;
}

/** `T1-000045` (OF8). */
export function offlineNumber(code: string, seq: number): string {
  return `${code}-${String(seq).padStart(6, "0")}`;
}

/** A Server Action call that may not reach the server: a throw (network) or no answer in time is UNREACHABLE. */
export async function reach<T>(
  run: () => Promise<ActionResult<T>>,
  timeoutMs = SALE_TIMEOUT_MS,
): Promise<ActionResult<T> | "UNREACHABLE"> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "UNREACHABLE";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<"UNREACHABLE">((resolve) => (timer = setTimeout(() => resolve("UNREACHABLE"), timeoutMs))),
    ]);
  } catch {
    return "UNREACHABLE";
  } finally {
    clearTimeout(timer);
  }
}

/** OF6: offline mode starts only when the server cannot be reached or its database is down, never on a 4xx. */
export function unreachable(result: ActionResult<unknown> | "UNREACHABLE"): boolean {
  return result === "UNREACHABLE" || (!result.ok && result.error.code === "DB_UNAVAILABLE");
}

/**
 * What a replay's answer means for its queue entry (OF11, OF13): DONE deletes it, STOP keeps it and waits for the
 * next round (no server, a busy or failing server, no session), REJECT marks it red for a manager. Only the hard
 * refusals reject; a missing permission of whoever is signed in now is theirs, not the sale's.
 */
export function replayStep(result: ActionResult<unknown> | "UNREACHABLE"): "DONE" | "STOP" | "REJECT" {
  if (result === "UNREACHABLE") return "STOP";
  if (result.ok) return "DONE";
  const { code } = result.error;
  const reason = (result.error.details as { reason?: string } | null)?.reason;
  if (code === "FORBIDDEN") return reason === "DEVICE_NOT_ENROLLED" || reason === "DEVICE_REVOKED" ? "REJECT" : "STOP";
  return code === "DB_UNAVAILABLE" || code === "RATE_LIMITED" || code === "UNAUTHENTICATED" || code === "INTERNAL"
    ? "STOP"
    : "REJECT";
}

/** Oldest first (OF11). */
export function replayOrder(entries: readonly QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => a.soldAt.localeCompare(b.soldAt) || a.number.localeCompare(b.number));
}

/** Search the snapshot like the server's quick search: an exact barcode or SKU wins, else a name/SKU match. */
export function searchSnapshot(items: readonly SnapshotItem[], raw: string, limit = 10): TillItem[] {
  const q = raw.trim();
  if (!q) return [];
  const upper = q.toUpperCase();
  const exact = items.filter((item) => item.barcodes.includes(q) || item.sku.toUpperCase() === upper);
  const lower = q.toLowerCase();
  const found =
    exact.length > 0
      ? exact
      : items.filter(
          (item) =>
            item.sku.toLowerCase().includes(lower) ||
            item.name.toLowerCase().includes(lower) ||
            (item.nameAr ?? "").includes(q),
        );
  return found.slice(0, limit).map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    sku: item.sku,
    name: item.name,
    nameAr: item.nameAr,
    unitPriceMinor: item.unitPriceMinor,
    vatApplicable: item.vatApplicable,
    unitType: item.unitType,
  }));
}

/**
 * The offline sale (OF8, OF9, OF11): the body the device replays, with its `offline` block, and the slip it prints
 * now. `body` is the online body the till built for this cart; prices are the cart's (the snapshot's).
 */
export function buildOfflineSale(input: {
  body: SaleBody;
  cart: readonly CartLine[];
  saleDiscount: Discount | null;
  plan: PaymentPlan;
  snapshot: TillSnapshot;
  device: OfflineDevice;
  seq: number;
  soldAt: Date;
}): { body: SaleBody; receipt: ReceiptDoc; number: string; totalMinor: number } {
  const { cart, snapshot, device, plan } = input;
  const { vatRateBp, pricesIncludeVat, currency } = snapshot.settings;
  const priced = priceSale(
    cart.map((line) => ({
      unitPriceMinor: line.unitPriceMinor,
      qty: line.qty,
      vatApplicable: line.vatApplicable,
      unitType: line.unitType,
      discount: line.discount,
      labels: line.labels,
    })),
    input.saleDiscount,
    vatRateBp,
    pricesIncludeVat,
  );
  const number = offlineNumber(device.offlineCode, input.seq);
  const soldAt = input.soldAt.toISOString();
  const shift = snapshot.shift;
  if (!shift) throw new Error("No open shift in the snapshot");
  const body: SaleBody = {
    ...input.body,
    offline: {
      deviceId: device.deviceId,
      deviceSecret: device.deviceSecret,
      number,
      soldAt,
      snapshotAt: snapshot.snapshotAt,
      snapshotVersion: snapshot.version,
      shiftId: shift.id,
      cashierId: snapshot.user.id,
      lines: cart.map((line, index) => ({
        unitPriceMinor: line.unitPriceMinor,
        discountMinor: priced.lines[index].discountMinor,
        lineTotalMinor: priced.lines[index].lineTotalMinor,
      })),
      subtotalMinor: priced.subtotalMinor,
      vatMinor: priced.vatMinor,
      totalMinor: priced.totalMinor,
    },
  };
  // What the server will store, so the slip shows the same split and change (totals.ts).
  const settled = settlePayments(priced.totalMinor, plan.payments);
  const receipt: ReceiptDoc = {
    kind: "SALE",
    copy: false,
    offline: true,
    shop: snapshot.shop,
    saleNumber: number,
    currency,
    at: soldAt,
    timeZone: snapshot.timeZone,
    staffName: snapshot.user.name,
    registerName: snapshot.register.name,
    reason: null,
    customer: null,
    lines: cart.map((line, index) => ({
      name: line.name,
      nameAr: line.nameAr,
      qty: line.qty,
      unitType: line.unitType,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: priced.lines[index].discountMinor,
      lineTotalMinor: priced.lines[index].lineTotalMinor,
    })),
    discountMinor: priced.discountMinor,
    subtotalMinor: priced.subtotalMinor,
    vatMinor: priced.vatMinor,
    totalMinor: priced.totalMinor,
    vatRatesBp: [...new Set(priced.lines.map((line) => line.vatRateBp))].sort((a, b) => a - b),
    payments: settled.payments.map((payment) => ({ method: payment.method, amountMinor: payment.amountMinor })),
    changeMinor: settled.changeMinor,
    zatca: null,
  };
  if (snapshot.zatcaVatNumber) {
    const tlv = zatcaTlvBase64({
      sellerName: snapshot.shop.name,
      vatNumber: snapshot.zatcaVatNumber,
      at: soldAt,
      totalMinor: priced.totalMinor,
      vatMinor: priced.vatMinor,
    });
    receipt.zatca = { tlv, qr: qrSvg(tlv) };
  }
  return { body, receipt, number, totalMinor: priced.totalMinor };
}

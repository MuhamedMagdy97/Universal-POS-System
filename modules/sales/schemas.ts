import { z } from "zod";
import { MAX_STORABLE_MINOR } from "@/lib/money";
import { ItemRefInput, Qty, Uuid } from "@/modules/inventory/schemas";

/**
 * Checkout input schemas (T6). Strict objects, so totals, org and cashier ids can never come
 * from the client. See checkout-data-model-and-api.md (§3, §6, §8).
 */

export const PAY_METHOD_VALUES = ["CASH", "CARD_MANUAL", "WALLET"] as const;

export const PaymentInput = z
  .object({
    method: z.enum(PAY_METHOD_VALUES),
    amountMinor: z.number().int().min(1).max(MAX_STORABLE_MINOR),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .nullish()
      .transform((value) => value ?? null),
  })
  .strict();
export type PaymentInput = z.infer<typeof PaymentInput>;

/** A line or sale discount (discounts-spec DC1): an amount in minor units, or a percent in basis points. */
export const DiscountInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("AMOUNT"), amountMinor: z.number().int().min(1).max(MAX_STORABLE_MINOR) }).strict(),
  z.object({ kind: z.literal("PERCENT"), percentBp: z.number().int().min(1).max(10_000) }).strict(),
]);
export type DiscountInput = z.infer<typeof DiscountInput>;

/** A price scale label on a KG line (weighed-selling-spec W6): its grams and printed total. */
const ScaleLabelInput = z.strictObject({ grams: Qty, totalMinor: z.int().min(1).max(MAX_STORABLE_MINOR) });

export const SaleLineInput = z
  .object({
    ref: ItemRefInput,
    qty: Qty,
    discount: DiscountInput.optional(),
    labels: z.array(ScaleLabelInput).min(1).max(50).optional(),
  })
  .strict();

const Money = z.number().int().min(0).max(MAX_STORABLE_MINOR);

/**
 * An offline sale replayed by its device (offline-till-spec OF11): what was sold, as the device priced and numbered
 * it. `lines` follow the sale's `lines` one for one. `deviceSecret` proves the enrolled device (OF16) and is left
 * out of the request hash; `shiftId` and `snapshotAt` are the device's cached shift and snapshot time (OF13).
 */
export const OfflineSaleInput = z
  .object({
    deviceId: Uuid,
    deviceSecret: z.string().min(16).max(200),
    number: z.string().regex(/^[A-Z][A-Z0-9]{0,7}-\d{6}$/, "Offline number like T1-000045"),
    soldAt: z.iso.datetime({ offset: true }),
    snapshotAt: z.iso.datetime({ offset: true }),
    snapshotVersion: z.number().int().min(1).max(1000),
    shiftId: Uuid,
    cashierId: Uuid,
    lines: z
      .array(z.object({ unitPriceMinor: Money, discountMinor: Money, lineTotalMinor: Money }).strict())
      .min(1)
      .max(200),
    subtotalMinor: Money,
    vatMinor: Money,
    totalMinor: Money,
  })
  .strict();
export type OfflineSaleInput = z.infer<typeof OfflineSaleInput>;

export const SaleInput = z
  .object({
    branchId: Uuid,
    registerId: Uuid,
    lines: z.array(SaleLineInput).min(1).max(200),
    // Whole-sale discount, allocated across lines on the server (DC4).
    discount: DiscountInput.optional(),
    // Optional customer (customers-spec CU7). Left out for a walk-in, so older requests hash as before (CU9).
    customerId: Uuid.optional(),
    payments: z
      .array(PaymentInput)
      // Empty only for a zero-total sale; settlePayments rejects it otherwise.
      .max(3)
      .refine((payments) => new Set(payments.map((p) => p.method)).size === payments.length, {
        message: "Each payment method may appear once",
      }),
    // Sent only when a device replays an offline sale (OF11); online sales leave it out and hash as before.
    offline: OfflineSaleInput.optional(),
  })
  .strict()
  // Walk-in only offline (OF3).
  .refine((sale) => !sale.offline || !sale.customerId, { message: "An offline sale has no customer" })
  .refine((sale) => !sale.offline || sale.offline.lines.length === sale.lines.length, {
    message: "Offline lines must match the sale lines",
  });
export type SaleInput = z.infer<typeof SaleInput>;

/** `Idempotency-Key` header: 1–128 printable ASCII characters. */
export const IdempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, "Printable ASCII only");

export const OpenShiftInput = z
  .object({
    branchId: Uuid,
    registerId: Uuid,
    openingFloatMinor: z.number().int().min(0).max(MAX_STORABLE_MINOR),
  })
  .strict();
export type OpenShiftInput = z.infer<typeof OpenShiftInput>;

/** Shift close (T7 spec S1–S2). The expected cash is computed on the server, never sent by the client. */
export const CloseShiftInput = z
  .object({
    countedCashMinor: z.number().int().min(0).max(MAX_STORABLE_MINOR),
    discrepancyNote: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullish()
      .transform((value) => value ?? null),
    // Why the shift closes while the register's offline device reported unsynced sales (offline-till-spec OF14).
    unsyncedNote: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullish()
      .transform((value) => value ?? null),
  })
  .strict();
export type CloseShiftInput = z.infer<typeof CloseShiftInput>;

/** A refund of some lines of a completed sale (T8, returns-void-spec.md V3–V5). Quantities are per sale line. */
export const RefundInput = z
  .object({
    lines: z
      .array(z.object({ saleItemId: Uuid, qty: Qty }).strict())
      .min(1)
      .max(200)
      .refine((lines) => new Set(lines.map((line) => line.saleItemId)).size === lines.length, {
        message: "Each sale line may appear once",
      }),
    // The till paying out the refund, in the sale's branch. Omitted: the sale's own till.
    registerId: Uuid.nullish().transform((value) => value ?? null),
    method: z.enum(PAY_METHOD_VALUES),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .nullish()
      .transform((value) => value ?? null),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();
export type RefundInput = z.infer<typeof RefundInput>;

/** A void of a whole sale (T8, V7). The reason is kept on the sale and in the audit row. */
export const VoidInput = z.object({ reason: z.string().trim().min(1).max(200) }).strict();
export type VoidInput = z.infer<typeof VoidInput>;

/** Cash pay-in, pay-out or drop during a shift (T7 spec S5). Amounts are always positive. */
export const CashMovementInput = z
  .object({
    type: z.enum(["PAY_IN", "PAY_OUT", "DROP"]),
    amountMinor: z.number().int().min(1).max(MAX_STORABLE_MINOR),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();
export type CashMovementInput = z.infer<typeof CashMovementInput>;

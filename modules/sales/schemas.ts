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

export const SaleLineInput = z.object({ ref: ItemRefInput, qty: Qty }).strict();

export const SaleInput = z
  .object({
    branchId: Uuid,
    registerId: Uuid,
    lines: z.array(SaleLineInput).min(1).max(200),
    payments: z
      .array(PaymentInput)
      // Empty only for a zero-total sale; settlePayments rejects it otherwise.
      .max(3)
      .refine((payments) => new Set(payments.map((p) => p.method)).size === payments.length, {
        message: "Each payment method may appear once",
      }),
  })
  .strict();
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
  })
  .strict();
export type CloseShiftInput = z.infer<typeof CloseShiftInput>;

/** Cash pay-in, pay-out or drop during a shift (T7 spec S5). Amounts are always positive. */
export const CashMovementInput = z
  .object({
    type: z.enum(["PAY_IN", "PAY_OUT", "DROP"]),
    amountMinor: z.number().int().min(1).max(MAX_STORABLE_MINOR),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();
export type CashMovementInput = z.infer<typeof CashMovementInput>;

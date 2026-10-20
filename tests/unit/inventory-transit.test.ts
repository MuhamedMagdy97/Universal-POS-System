import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { TransferReceiveInput, planReceipt, transferReference } from "@/modules/inventory/schemas";
import { errorMessageKey, parseReceived } from "@/app/(app)/inventory/_lib/form";

/** Pure rules of two-step transfers (transit-transfers-spec T4–T6, T14). */
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const V = "33333333-3333-4333-8333-333333333333";
const sent = [
  { productId: P, variantId: null, qtySent: 5 },
  { productId: Q, variantId: V, qtySent: 2 },
];

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return (err.details as { reason?: string }).reason;
    throw err;
  }
  return undefined;
}

describe("planReceipt", () => {
  it("computes the shortfall per line in sent order", () => {
    const plan = planReceipt(sent, [
      { ref: { productId: Q, variantId: V }, qtyReceived: 2 },
      { ref: { productId: P, variantId: null }, qtyReceived: 3, shortfallReason: "DAMAGED" },
    ]);
    expect(plan.map((line) => [line.productId, line.qtyReceived, line.shortfall, line.shortfallReason])).toEqual([
      [P, 3, 2, "DAMAGED"],
      [Q, 2, 0, null],
    ]);
  });

  it("refuses over-receipt, a missing or extra reason, and lines that do not match", () => {
    const fullQ = { ref: { productId: Q, variantId: V }, qtyReceived: 2 };
    expect(reasonOf(() => planReceipt(sent, [{ ref: { productId: P, variantId: null }, qtyReceived: 6 }, fullQ]))).toBe(
      "QTY_OVER_SENT",
    );
    expect(reasonOf(() => planReceipt(sent, [{ ref: { productId: P, variantId: null }, qtyReceived: 4 }, fullQ]))).toBe(
      "SHORTFALL_REASON",
    );
    expect(
      reasonOf(() =>
        planReceipt(sent, [
          { ref: { productId: P, variantId: null }, qtyReceived: 5, shortfallReason: "OTHER" },
          fullQ,
        ]),
      ),
    ).toBe("SHORTFALL_REASON");
    expect(reasonOf(() => planReceipt(sent, [fullQ]))).toBe("LINES_MISMATCH");
    // Same product, different variant: not the sent line.
    expect(reasonOf(() => planReceipt(sent, [{ ref: { productId: P, variantId: V }, qtyReceived: 5 }, fullQ]))).toBe(
      "LINES_MISMATCH",
    );
    expect(reasonOf(() => planReceipt(sent, [fullQ, fullQ]))).toBe("DUPLICATE_LINE");
  });
});

describe("TransferReceiveInput", () => {
  const base = { receiveKey: P, lines: [{ ref: { productId: P }, qtyReceived: 0, shortfallReason: "OTHER" }] };
  it("needs a note when a shortfall reason is OTHER", () => {
    expect(TransferReceiveInput.safeParse(base).success).toBe(false);
    expect(TransferReceiveInput.safeParse({ ...base, note: "  " }).success).toBe(false);
    expect(TransferReceiveInput.safeParse({ ...base, note: "Missing box" }).success).toBe(true);
  });
  it("refuses reasons outside the shortfall list and negative quantities", () => {
    const line = base.lines[0];
    expect(TransferReceiveInput.safeParse({ ...base, lines: [{ ...line, shortfallReason: "FOUND" }] }).success).toBe(
      false,
    );
    expect(TransferReceiveInput.safeParse({ ...base, note: "x", lines: [{ ...line, qtyReceived: -1 }] }).success).toBe(
      false,
    );
  });
});

describe("screen helpers", () => {
  it("formats the reference from the id", () => {
    expect(transferReference("3f9a12bc-0000-4000-8000-000000000000")).toBe("TR-3F9A12BC");
  });
  it("reads a received quantity from 0 up to sent, Arabic-Indic digits too", () => {
    expect(parseReceived("0", 3)).toBe(0);
    expect(parseReceived("٣", 3)).toBe(3);
    expect(parseReceived("4", 3)).toBeNull();
    expect(parseReceived("", 3)).toBeNull();
    expect(parseReceived("1.5", 3)).toBeNull();
  });
  it("maps transfer errors to their messages", () => {
    const body = (reason: string) => ({ code: "CONFLICT" as const, message: "", details: { reason } });
    expect(errorMessageKey(body("TRANSFER_STATE"))).toBe("inventory.error.transferState");
    expect(errorMessageKey(body("QTY_OVER_SENT"))).toBe("inventory.error.overSent");
  });
});

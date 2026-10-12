import { describe, expect, it } from "vitest";
import {
  canSubmitRefund,
  lineRefundMinor,
  parseRefundQty,
  planRefund,
  returnErrorKey,
  type PreviewLine,
} from "@/app/(app)/returns/_lib/returns";
import type { ErrorBody } from "@/lib/errors";

/** Returns screen helpers (T8): the refund preview must follow the server's rule (V4), remainder included. */

const line = (over: Partial<PreviewLine> = {}): PreviewLine => ({
  saleItemId: "a",
  qty: 3,
  lineTotalMinor: 3003,
  refundedQty: 0,
  refundedAmountMinor: 0,
  ...over,
});

describe("refund quantity", () => {
  it("reads blank as zero and whole numbers up to what is left, Arabic-Indic digits included", () => {
    expect(parseRefundQty("", 2)).toBe(0);
    expect(parseRefundQty("2", 2)).toBe(2);
    expect(parseRefundQty("١", 2)).toBe(1);
  });

  it("refuses more than is left, negatives and fractions", () => {
    expect(parseRefundQty("3", 2)).toBeNull();
    expect(parseRefundQty("-1", 2)).toBeNull();
    expect(parseRefundQty("1.5", 2)).toBeNull();
  });
});

describe("line refund preview", () => {
  it("gives a share of the line total, and the whole line for all units", () => {
    expect(lineRefundMinor(line(), 1)).toBe(1001);
    expect(lineRefundMinor(line(), 3)).toBe(3003);
    expect(lineRefundMinor(line(), 0)).toBe(0);
  });

  it("gives the last units the remainder, so the parts add up to the line exactly", () => {
    const odd = line({ lineTotalMinor: 1000 });
    expect(lineRefundMinor(odd, 1)).toBe(333);
    expect(lineRefundMinor({ ...odd, refundedQty: 2, refundedAmountMinor: 666 }, 1)).toBe(334);
  });
});

describe("refund plan", () => {
  const lines = [line({ saleItemId: "a" }), line({ saleItemId: "b", qty: 2, lineTotalMinor: 2000 })];

  it("keeps only the lines with a quantity and sums their preview", () => {
    expect(planRefund(lines, { a: "1", b: "" })).toEqual({
      ok: true,
      lines: [{ saleItemId: "a", qty: 1 }],
      totalMinor: 1001,
    });
  });

  it("is blocked by any unreadable box", () => {
    expect(planRefund(lines, { a: "1", b: "9" })).toEqual({ ok: false, invalid: ["b"] });
  });

  it("can be sent only with a line, a total above zero, a reason, and no request pending", () => {
    const plan = planRefund(lines, { a: "1" });
    expect(canSubmitRefund(plan, "Damaged", false)).toBe(true);
    expect(canSubmitRefund(plan, "  ", false)).toBe(false);
    expect(canSubmitRefund(plan, "Damaged", true)).toBe(false);
    expect(canSubmitRefund(planRefund(lines, {}), "Damaged", false)).toBe(false);
    expect(canSubmitRefund(planRefund([line({ lineTotalMinor: 0 })], { a: "1" }), "Free", false)).toBe(false);
  });
});

describe("return error messages", () => {
  const error = (code: ErrorBody["code"], reason?: string): ErrorBody => ({
    code,
    message: "x",
    details: reason ? { reason } : null,
  });

  it("maps each server reason to its message", () => {
    expect(returnErrorKey(error("CONFLICT", "REFUND_QTY_EXCEEDED"))).toBe("returns.error.qtyExceeded");
    expect(returnErrorKey(error("CONFLICT", "SHIFT_NOT_OPEN"))).toBe("returns.error.shiftNotOpen");
    expect(returnErrorKey(error("CONFLICT", "SALE_NOT_COMPLETED"))).toBe("returns.error.voided");
    expect(returnErrorKey(error("CONFLICT", "SALE_HAS_REFUNDS"))).toBe("returns.error.hasRefunds");
    expect(returnErrorKey(error("CONFLICT", "VOID_SHIFT_CLOSED"))).toBe("returns.error.voidShiftClosed");
    expect(returnErrorKey(error("VALIDATION_FAILED", "REFUND_ZERO_TOTAL"))).toBe("returns.error.zeroTotal");
  });

  it("maps key, permission and not-found errors, and falls back to generic", () => {
    expect(returnErrorKey(error("IDEMPOTENCY_CONFLICT"))).toBe("returns.error.idempotency");
    expect(returnErrorKey(error("FORBIDDEN"))).toBe("returns.error.forbidden");
    expect(returnErrorKey(error("NOT_FOUND"))).toBe("returns.error.notFound");
    expect(returnErrorKey(error("INTERNAL"))).toBe("returns.error.generic");
  });
});

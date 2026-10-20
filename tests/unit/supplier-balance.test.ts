import { describe, expect, it } from "vitest";
import { balanceEffect, statementOf, type AccountEntry } from "@/modules/purchasing/rules";
import { PaymentInput } from "@/modules/purchasing/schemas";

/** Supplier balance math (supplier-payments-spec S1, S13). */

const e = (kind: AccountEntry["kind"], day: string, amountMinor: number): AccountEntry => ({ kind, day, amountMinor });

describe("balanceEffect", () => {
  it("adds receipts and reversals, subtracts returns and payments", () => {
    expect(balanceEffect(e("RECEIPT", "2026-01-01", 500))).toBe(500);
    expect(balanceEffect(e("RETURN", "2026-01-01", 120))).toBe(-120);
    expect(balanceEffect(e("PAYMENT", "2026-01-01", 300))).toBe(-300);
    expect(balanceEffect(e("REVERSAL", "2026-01-01", 300))).toBe(300);
  });
});

describe("statementOf", () => {
  const all = [
    e("RECEIPT", "2026-01-05", 10_000),
    e("PAYMENT", "2026-01-20", 4_000),
    e("RECEIPT", "2026-02-02", 5_000),
    e("RETURN", "2026-02-03", 1_000),
    e("PAYMENT", "2026-02-10", 2_500),
    e("REVERSAL", "2026-02-11", 2_500),
    e("PAYMENT", "2026-03-01", 8_000),
  ];

  it("opens with everything before the range and runs the balance through it", () => {
    const s = statementOf(all, "2026-02-01", "2026-02-28");
    expect(s.openingMinor).toBe(6_000);
    expect(s.entries.map((x) => x.balanceMinor)).toEqual([11_000, 10_000, 7_500, 10_000]);
    expect(s.closingMinor).toBe(10_000);
    expect(s.balanceMinor).toBe(2_000);
  });

  it("includes both ends of the range", () => {
    const s = statementOf(all, "2026-01-20", "2026-02-02");
    expect(s.entries.map((x) => x.day)).toEqual(["2026-01-20", "2026-02-02"]);
    expect(s.openingMinor).toBe(10_000);
    expect(s.closingMinor).toBe(11_000);
  });

  it("keeps the opening as the closing for an empty range, and goes negative on overpayment", () => {
    const quiet = statementOf(all, "2026-01-21", "2026-01-31");
    expect(quiet.entries).toEqual([]);
    expect(quiet.closingMinor).toBe(quiet.openingMinor);
    const deposit = statementOf([e("PAYMENT", "2026-03-01", 500)], "2026-03-01", "2026-03-31");
    expect(deposit.closingMinor).toBe(-500);
  });

  it("is all zero with no entries", () => {
    expect(statementOf([], "2026-01-01", "2026-01-31")).toEqual({
      openingMinor: 0,
      entries: [],
      closingMinor: 0,
      balanceMinor: 0,
    });
  });
});

describe("PaymentInput", () => {
  const base = { amountMinor: 100, method: "CASH", paidOn: "2026-02-01" };

  it("needs an amount above 0 and a real day", () => {
    expect(PaymentInput.safeParse({ ...base, amountMinor: 0 }).success).toBe(false);
    expect(PaymentInput.safeParse({ ...base, paidOn: "2026-02-30" }).success).toBe(false);
    expect(PaymentInput.parse({ ...base, paidOn: "٢٠٢٦-٠٢-٠١" }).paidOn).toBe("2026-02-01");
  });

  it("turns blanks into null and refuses unknown fields", () => {
    expect(PaymentInput.parse({ ...base, reference: " ", purchaseOrderId: null })).toMatchObject({
      reference: null,
      note: null,
      purchaseOrderId: null,
    });
    expect(PaymentInput.safeParse({ ...base, orgId: "x" }).success).toBe(false);
  });
});

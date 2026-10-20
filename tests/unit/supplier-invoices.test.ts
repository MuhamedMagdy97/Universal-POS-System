import { describe, expect, it } from "vitest";
import {
  allocateOldestFirst,
  balanceEffect,
  defaultInputVat,
  invoiceState,
  maxInputVat,
  statementOf,
  type AccountEntry,
} from "@/modules/purchasing/rules";
import { InvoiceInput, PaymentInput } from "@/modules/purchasing/schemas";

/** Pure rules of supplier-invoices-spec.md: input VAT (I5), allocation (I9), status (I10), balance (I7). */

describe("input VAT (I5)", () => {
  it("defaults to the shop rate on the net, rounded half-up like sales", () => {
    expect(defaultInputVat(10_000, 1_400)).toBe(1_400);
    expect(defaultInputVat(10_000, 1_500)).toBe(1_500);
    expect(defaultInputVat(1_003, 1_400)).toBe(140); // 140.42
    expect(defaultInputVat(1_025, 1_400)).toBe(144); // 143.5 → 144
    expect(defaultInputVat(0, 1_500)).toBe(0);
  });

  it("allows up to one major unit above the rate for per-line rounding", () => {
    expect(maxInputVat(10_000, 1_400)).toBe(1_500);
    expect(maxInputVat(0, 1_500)).toBe(100);
  });
});

describe("allocateOldestFirst (I9)", () => {
  const inv = (id: string, dueOn: string | null, issuedOn: string, openMinor: number) => ({
    id,
    number: id,
    dueOn,
    issuedOn,
    openMinor,
  });

  it("fills by due date (none last), then issue date, each up to its open amount", () => {
    const invoices = [
      inv("no-due", null, "2026-01-01", 500),
      inv("later", "2026-03-01", "2026-01-05", 1_000),
      inv("sooner", "2026-02-01", "2026-01-10", 300),
      inv("same-due-older", "2026-03-01", "2026-01-02", 200),
    ];
    expect(allocateOldestFirst(1_200, invoices)).toEqual([
      { invoiceId: "sooner", amountMinor: 300 },
      { invoiceId: "same-due-older", amountMinor: 200 },
      { invoiceId: "later", amountMinor: 700 },
    ]);
    expect(allocateOldestFirst(10_000, invoices).reduce((t, l) => t + l.amountMinor, 0)).toBe(2_000);
    expect(allocateOldestFirst(0, invoices)).toEqual([]);
  });
});

describe("invoiceState (I10)", () => {
  const base = { voided: false, totalMinor: 1_000, paidMinor: 0, creditedMinor: 0, dueOn: "2026-05-01" };

  it("is open, overdue after the due date, paid once covered, void when voided", () => {
    expect(invoiceState(base, "2026-05-01")).toEqual({ openMinor: 1_000, status: "OPEN" });
    expect(invoiceState(base, "2026-05-02")).toEqual({ openMinor: 1_000, status: "OVERDUE" });
    expect(invoiceState({ ...base, dueOn: null }, "2030-01-01").status).toBe("OPEN");
    expect(invoiceState({ ...base, paidMinor: 600, creditedMinor: 400 }, "2026-06-01")).toEqual({
      openMinor: 0,
      status: "PAID",
    });
    expect(invoiceState({ ...base, voided: true }, "2026-06-01")).toEqual({ openMinor: 0, status: "VOID" });
  });
});

describe("balance effects of documents (I7)", () => {
  it("replace the cost of what they cover; voids undo them", () => {
    expect(balanceEffect({ kind: "INVOICE", amountMinor: 11_400, coveredMinor: 10_000 })).toBe(1_400);
    expect(balanceEffect({ kind: "INVOICE", amountMinor: 500 })).toBe(500);
    expect(balanceEffect({ kind: "INVOICE_VOID", amountMinor: 11_400, coveredMinor: 10_000 })).toBe(-1_400);
    expect(balanceEffect({ kind: "CREDIT_NOTE", amountMinor: 2_280, coveredMinor: 2_000 })).toBe(-280);
    expect(balanceEffect({ kind: "CREDIT_NOTE_VOID", amountMinor: 2_280, coveredMinor: 2_000 })).toBe(280);
  });

  it("run through the statement: receipt, invoice, return, credit note, payment", () => {
    const all: AccountEntry[] = [
      { kind: "RECEIPT", day: "2026-01-01", amountMinor: 10_000 },
      { kind: "INVOICE", day: "2026-01-02", amountMinor: 11_400, coveredMinor: 10_000 },
      { kind: "RETURN", day: "2026-01-03", amountMinor: 2_000 },
      { kind: "CREDIT_NOTE", day: "2026-01-04", amountMinor: 2_280, coveredMinor: 2_000 },
      { kind: "PAYMENT", day: "2026-01-05", amountMinor: 9_120 },
    ];
    const statement = statementOf(all, "2026-01-02", "2026-01-31");
    expect(statement.openingMinor).toBe(10_000);
    expect(statement.entries.map((e) => e.balanceMinor)).toEqual([11_400, 9_400, 9_120, 0]);
    expect(statement.closingMinor).toBe(0);
  });
});

describe("schemas", () => {
  it("refuse two allocation lines for one invoice and an unknown field", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const payment = { amountMinor: 100, method: "CASH", paidOn: "2026-01-01" };
    expect(
      PaymentInput.safeParse({
        ...payment,
        allocations: [
          { invoiceId: id, amountMinor: 1 },
          { invoiceId: id, amountMinor: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(PaymentInput.safeParse({ ...payment, allocations: [{ invoiceId: id, amountMinor: 0 }] }).success).toBe(
      false,
    );
    expect(
      InvoiceInput.safeParse({
        kind: "INVOICE",
        number: "A",
        issuedOn: "2026-01-01",
        netMinor: 1,
        vatMinor: 0,
        totalMinor: 1,
      }).success,
    ).toBe(false);
    expect(
      InvoiceInput.parse({ kind: "INVOICE", number: " A-1 ", issuedOn: "٢٠٢٦-٠١-٠١", netMinor: 1, vatMinor: 0 }),
    ).toMatchObject({
      number: "A-1",
      issuedOn: "2026-01-01",
      dueOn: null,
      goodsReceiptIds: [],
    });
  });
});

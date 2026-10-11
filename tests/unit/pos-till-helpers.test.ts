import { describe, expect, it } from "vitest";
import {
  addToCart,
  canCharge,
  displayName,
  keepKeyAfter,
  parseCash,
  planPayment,
  previewCart,
  removeLine,
  saleErrorKey,
  setLineQty,
  shortLines,
  type CartLine,
  type TillItem,
  type TillSettings,
} from "@/app/(app)/pos/_lib/till";

/** Till screen helpers (client-side preview; the server decides). */

const EG: TillSettings = { currency: "EGP", vatRateBp: 1400, pricesIncludeVat: true };

const item = (id: string, price = 1000, variantId: string | null = null): TillItem => ({
  productId: id,
  variantId,
  sku: `SKU-${id}`,
  name: `Item ${id}`,
  nameAr: `صنف ${id}`,
  unitPriceMinor: price,
  vatApplicable: true,
});

describe("cart", () => {
  it("adds an item, and a second scan of it increments the line", () => {
    const cart = addToCart(addToCart([], item("a")), item("a"));
    expect(cart).toHaveLength(1);
    expect(cart[0].qty).toBe(2);
  });

  it("keeps variants of one product on separate lines", () => {
    const cart = addToCart(addToCart([], item("a", 1000, "v1")), item("a", 1000, "v2"));
    expect(cart).toHaveLength(2);
  });

  it("reads typed quantities, including Arabic-Indic digits; junk counts as 0", () => {
    const cart = addToCart([], item("a"));
    expect(setLineQty(cart, "a|", "٣")[0].qty).toBe(3);
    expect(setLineQty(cart, "a|", "")[0].qty).toBe(0);
    expect(setLineQty(cart, "a|", "x")[0].qty).toBe(0);
  });

  it("removes a line", () => {
    expect(removeLine(addToCart([], item("a")), "a|")).toEqual([]);
  });

  it("shows the Arabic name in Arabic when there is one", () => {
    expect(displayName(item("a"), "ar")).toBe("صنف a");
    expect(displayName({ name: "Only EN", nameAr: null }, "ar")).toBe("Only EN");
  });
});

describe("previewCart", () => {
  it("matches the server arithmetic (VAT inside gross prices)", () => {
    const cart: CartLine[] = [{ ...item("a"), qty: 2 }];
    expect(previewCart(cart, EG)).toEqual({
      ok: true,
      lineTotals: { "a|": 2000 },
      subtotalMinor: 1754,
      vatMinor: 246,
      totalMinor: 2000,
    });
  });

  it("reports a cart too large to record instead of throwing", () => {
    const cart: CartLine[] = [{ ...item("a", 10_000_000), qty: 300 }];
    expect(previewCart(cart, EG)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });
});

describe("payment", () => {
  it("parses cash in major units, Arabic-Indic digits included", () => {
    expect(parseCash("50", "EGP")).toBe(5000);
    expect(parseCash("٥٠٫٥", "EGP")).toBe(5050);
    expect(parseCash("", "EGP")).toBeNull();
    expect(parseCash("abc", "EGP")).toBeNull();
    expect(parseCash("-1", "EGP")).toBeNull();
  });

  it("plans cash with change, and nothing while the cash is short", () => {
    expect(planPayment({ method: "CASH", totalMinor: 1000, cashReceivedMinor: 1500, reference: "" })).toEqual({
      payments: [{ method: "CASH", amountMinor: 1500 }],
      changeMinor: 500,
    });
    expect(planPayment({ method: "CASH", totalMinor: 1000, cashReceivedMinor: 999, reference: "" })).toBeNull();
    expect(planPayment({ method: "CASH", totalMinor: 1000, cashReceivedMinor: null, reference: "" })).toBeNull();
  });

  it("plans a card for the exact total with an optional reference", () => {
    expect(
      planPayment({ method: "CARD_MANUAL", totalMinor: 1000, cashReceivedMinor: null, reference: " 77 " }),
    ).toEqual({
      payments: [{ method: "CARD_MANUAL", amountMinor: 1000, reference: "77" }],
      changeMinor: 0,
    });
    expect(planPayment({ method: "WALLET", totalMinor: 1000, cashReceivedMinor: null, reference: "" })).toEqual({
      payments: [{ method: "WALLET", amountMinor: 1000 }],
      changeMinor: 0,
    });
  });

  it("takes no payment for a zero-total sale", () => {
    expect(planPayment({ method: "CASH", totalMinor: 0, cashReceivedMinor: null, reference: "" })).toEqual({
      payments: [],
      changeMinor: 0,
    });
  });

  it("enables the charge only for a valid cart and a covered payment", () => {
    const cart: CartLine[] = [{ ...item("a"), qty: 1 }];
    const preview = previewCart(cart, EG);
    const plan = planPayment({ method: "CASH", totalMinor: 1000, cashReceivedMinor: 1000, reference: "" });
    expect(canCharge(cart, preview, plan)).toBe(true);
    expect(canCharge([], previewCart([], EG), plan)).toBe(false);
    expect(canCharge([{ ...cart[0], qty: 0 }], preview, plan)).toBe(false);
    expect(canCharge(cart, preview, null)).toBe(false);
  });
});

describe("errors", () => {
  const error = (code: string, details: unknown = null) =>
    ({ code, message: "x", details }) as Parameters<typeof saleErrorKey>[0];

  it("maps service reasons to till messages", () => {
    expect(saleErrorKey(error("CONFLICT", { reason: "INSUFFICIENT_STOCK" }))).toBe("pos.error.insufficient");
    expect(saleErrorKey(error("CONFLICT", { reason: "SHIFT_NOT_OPEN" }))).toBe("pos.error.shiftNotOpen");
    expect(saleErrorKey(error("VALIDATION_FAILED", { reason: "PAYMENT_MISMATCH" }))).toBe("pos.error.payment");
    expect(saleErrorKey(error("VALIDATION_FAILED", { reason: "ITEM_NOT_SELLABLE" }))).toBe("pos.error.notSellable");
    expect(saleErrorKey(error("VALIDATION_FAILED", { reason: "AMOUNT_TOO_LARGE" }))).toBe("pos.error.tooLarge");
    expect(saleErrorKey(error("IDEMPOTENCY_CONFLICT", { reason: "IDEMPOTENCY_CONFLICT" }))).toBe(
      "pos.error.idempotency",
    );
    expect(saleErrorKey(error("FORBIDDEN"))).toBe("pos.error.forbidden");
    expect(saleErrorKey(error("INTERNAL"))).toBe("pos.error.generic");
  });

  it("keeps the sale key only when the outcome is unknown", () => {
    expect(keepKeyAfter(error("INTERNAL"))).toBe(true);
    expect(keepKeyAfter(error("CONFLICT", { reason: "INSUFFICIENT_STOCK" }))).toBe(false);
    expect(keepKeyAfter(error("VALIDATION_FAILED"))).toBe(false);
  });

  it("names the cart lines that are short of stock", () => {
    const cart: CartLine[] = [
      { ...item("a"), qty: 1 },
      { ...item("b"), qty: 1 },
    ];
    const short = shortLines(
      error("CONFLICT", { reason: "INSUFFICIENT_STOCK", lines: [{ productId: "b", variantId: null }] }),
      cart,
    );
    expect(short.map((line) => line.productId)).toEqual(["b"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  addToCart,
  bumpQty,
  canCharge,
  discountRaw,
  displayName,
  exactCashMinor,
  keepKeyAfter,
  parseCash,
  parseDiscount,
  planPayment,
  planSplit,
  previewCart,
  removeLine,
  saleErrorKey,
  setLineQty,
  shortLines,
  stockShort,
  tillShortcut,
  type CartLine,
  type TillItem,
  type TillSettings,
} from "@/app/(app)/pos/_lib/till";

/** Till screen helpers (client-side preview; the server decides). */

const EG: TillSettings = {
  currency: "EGP",
  vatRateBp: 1400,
  pricesIncludeVat: true,
  discount: { allowed: true, limitBp: 1000 },
};

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
      lineDiscounts: { "a|": 0 },
      discountMinor: 0,
      subtotalMinor: 1754,
      vatMinor: 246,
      totalMinor: 2000,
      overLimit: false,
    });
  });

  it("reports a cart too large to record instead of throwing", () => {
    const cart: CartLine[] = [{ ...item("a", 10_000_000), qty: 300 }];
    expect(previewCart(cart, EG)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("previews line and sale discounts with the server's allocation (discounts-spec DC3–DC5)", () => {
    const cart: CartLine[] = [
      { ...item("a"), qty: 2, discount: { kind: "PERCENT", percentBp: 1000 } },
      { ...item("b"), qty: 1 },
    ];
    const preview = previewCart(cart, EG, { kind: "AMOUNT", amountMinor: 280 });
    // a: 2000 − 200 = 1800; b: 1000. Sale 280 split 1800:1000 → 180 / 100.
    expect(preview).toMatchObject({
      ok: true,
      lineDiscounts: { "a|": 380, "b|": 100 },
      lineTotals: { "a|": 1620, "b|": 900 },
      discountMinor: 480,
      totalMinor: 2520,
      overLimit: true,
    });
    expect(canCharge(cart, preview, { payments: [], changeMinor: 0 })).toBe(false);
  });

  it("flags a discount bigger than its line", () => {
    const cart: CartLine[] = [{ ...item("a"), qty: 1, discount: { kind: "AMOUNT", amountMinor: 1001 } }];
    expect(previewCart(cart, EG)).toEqual({ ok: false, reason: "DISCOUNT_TOO_LARGE" });
  });

  it("puts no limit on an override discounter", () => {
    const cart: CartLine[] = [{ ...item("a"), qty: 1 }];
    const unlimited = { ...EG, discount: { allowed: true, limitBp: null } };
    expect(previewCart(cart, unlimited, { kind: "PERCENT", percentBp: 10_000 })).toMatchObject({
      totalMinor: 0,
      overLimit: false,
    });
  });
});

describe("discount box", () => {
  it("reads percents and amounts, Arabic-Indic digits included", () => {
    expect(parseDiscount("12.5", "PERCENT", "EGP")).toEqual({ kind: "PERCENT", percentBp: 1250 });
    expect(parseDiscount("٥", "AMOUNT", "EGP")).toEqual({ kind: "AMOUNT", amountMinor: 500 });
    expect(parseDiscount(" ", "PERCENT", "EGP")).toBeNull();
    for (const raw of ["0", "101", "1.234", "abc", "-5"]) {
      expect(parseDiscount(raw, "PERCENT", "EGP")).toBe("invalid");
    }
    expect(parseDiscount("0", "AMOUNT", "EGP")).toBe("invalid");
  });

  it("shows an existing discount back in the box", () => {
    expect(discountRaw({ kind: "PERCENT", percentBp: 1250 }, "EGP")).toBe("12.5");
    expect(discountRaw({ kind: "AMOUNT", amountMinor: 500 }, "EGP")).toBe("5.00");
    expect(discountRaw(null, "EGP")).toBe("");
  });

  it("opens with F6 (line) and F7 (sale), also inside a field", () => {
    expect(tillShortcut("F6", true)).toBe("lineDiscount");
    expect(tillShortcut("F7", false)).toBe("saleDiscount");
  });

  it("names a refused discount", () => {
    expect(saleErrorKey({ code: "FORBIDDEN", message: "", details: { reason: "DISCOUNT_LIMIT", limitBp: 1000 } })).toBe(
      "pos.error.discountLimit",
    );
    expect(saleErrorKey({ code: "VALIDATION_FAILED", message: "", details: { reason: "DISCOUNT_TOO_LARGE" } })).toBe(
      "pos.error.discountTooLarge",
    );
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

  it("plans a split: card/wallet up to the total, cash covers the rest with change", () => {
    const cash = (amountMinor: number | null) => ({ method: "CASH" as const, amountMinor, reference: "" });
    const card = (amountMinor: number | null, reference = "") => ({
      method: "CARD_MANUAL" as const,
      amountMinor,
      reference,
    });
    const wallet = (amountMinor: number | null) => ({ method: "WALLET" as const, amountMinor, reference: "" });

    expect(planSplit(1000, [cash(700), card(400, " R1 "), wallet(0)])).toEqual({
      payments: [
        { method: "CASH", amountMinor: 700 },
        { method: "CARD_MANUAL", amountMinor: 400, reference: "R1" },
      ],
      changeMinor: 100,
    });
    expect(planSplit(1000, [cash(0), card(600), wallet(400)])).toEqual({
      payments: [
        { method: "CARD_MANUAL", amountMinor: 600 },
        { method: "WALLET", amountMinor: 400 },
      ],
      changeMinor: 0,
    });
    // Short, over-paid by card, unreadable, or cash with nothing left to pay.
    expect(planSplit(1000, [cash(500), card(400), wallet(0)])).toBeNull();
    expect(planSplit(1000, [cash(0), card(1100), wallet(0)])).toBeNull();
    expect(planSplit(1000, [cash(null), card(1000), wallet(0)])).toBeNull();
    expect(planSplit(1000, [cash(100), card(1000), wallet(0)])).toBeNull();
    expect(planSplit(1000, [cash(0), card(0), wallet(0)])).toBeNull();
    expect(planSplit(0, [cash(0), card(0), wallet(0)])).toEqual({ payments: [], changeMinor: 0 });
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
    // A shop linked to the inventory system (integration spec I17).
    expect(saleErrorKey(error("INVENTORY_UNAVAILABLE", { reason: "INVENTORY_UNAVAILABLE" }))).toBe(
      "pos.error.inventoryUnavailable",
    );
    expect(saleErrorKey(error("CONFLICT", { reason: "INVENTORY_LINK_BROKEN" }))).toBe("pos.error.inventoryLinkBroken");
    expect(saleErrorKey(error("CONFLICT", { reason: "INVENTORY_BRANCH_UNMAPPED" }))).toBe(
      "pos.error.inventoryBranchUnmapped",
    );
  });

  it("keeps the sale key only when the outcome is unknown", () => {
    expect(keepKeyAfter(error("INTERNAL"))).toBe(true);
    // Retry after an inventory-system outage reuses the same IMS keys (I17).
    expect(keepKeyAfter(error("INVENTORY_UNAVAILABLE"))).toBe(true);
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

describe("till quick wins", () => {
  it("exact cash is the total, or in a split what card and wallet leave", () => {
    expect(exactCashMinor(4560)).toBe(4560);
    const split = (card: number | null, cash: number | null) => [
      { method: "CASH" as const, amountMinor: cash, reference: "" },
      { method: "CARD_MANUAL" as const, amountMinor: card, reference: "" },
    ];
    expect(exactCashMinor(4560, split(1000, 9999))).toBe(3560);
    expect(exactCashMinor(4560, split(null, null))).toBe(4560);
    expect(exactCashMinor(4560, split(5000, 0))).toBe(0);
    // The filled amount makes a valid split with no change.
    expect(planSplit(4560, split(1000, exactCashMinor(4560, split(1000, 0))))).toEqual({
      payments: [
        { method: "CASH", amountMinor: 3560 },
        { method: "CARD_MANUAL", amountMinor: 1000 },
      ],
      changeMinor: 0,
    });
  });

  it("flags stock that is zero, negative or below the line's quantity", () => {
    expect(stockShort(5, 0)).toBe(false);
    expect(stockShort(0, 0)).toBe(true);
    expect(stockShort(-2, 0)).toBe(true);
    expect(stockShort(2, 2)).toBe(false);
    expect(stockShort(2, 3)).toBe(true);
  });

  it("+ and - change only the selected line and never go below 1", () => {
    const cart = addToCart(addToCart([], item("a")), item("b"));
    expect(bumpQty(cart, "a|", 1).map((line) => line.qty)).toEqual([2, 1]);
    expect(bumpQty(cart, "b|", -1).map((line) => line.qty)).toEqual([1, 1]);
  });

  it("maps keys; + and - are ignored while typing in a field", () => {
    expect(tillShortcut("F2", true)).toBe("search");
    expect(tillShortcut("F4", true)).toBe("cash");
    expect(tillShortcut("F8", true)).toBe("exact");
    expect(tillShortcut("Escape", true)).toBe("close");
    expect(tillShortcut("+", false)).toBe("inc");
    expect(tillShortcut("-", false)).toBe("dec");
    expect(tillShortcut("+", true)).toBeNull();
    expect(tillShortcut("a", false)).toBeNull();
  });
});

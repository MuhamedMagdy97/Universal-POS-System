import { describe, expect, it } from "vitest";
import { cartFromTicket, minutesOpen, ticketLinesOf } from "@/app/(app)/pos/_lib/tickets";
import { cartKey, previewCart, type TillSettings } from "@/app/(app)/pos/_lib/till";
import { DEFAULT_SCALE_SETTINGS } from "@/lib/scale-label";

/** Tickets at the till (restaurant-cafe-spec R4, R5, R10). Pure, no DB. */

const EG: TillSettings = {
  currency: "EGP",
  vatRateBp: 1400,
  pricesIncludeVat: true,
  discount: { allowed: true, limitBp: 1000 },
  customers: { read: true, create: true },
  scale: DEFAULT_SCALE_SETTINGS,
};
const item = (id: string, price: number) => ({
  productId: id,
  variantId: null,
  sku: `SKU-${id}`,
  name: `Item ${id}`,
  nameAr: null,
  unitType: "EACH" as const,
  unitPriceMinor: price,
  vatCategory: "STANDARD" as const,
  vatApplicable: true,
});
const ticket = {
  lines: [
    {
      key: "c||o:lg",
      item: item("c", 3_000),
      qty: 2,
      sentQty: 1,
      options: ["lg"],
      optionLabels: [{ group: "Size", groupAr: null, name: "Large", nameAr: null, priceDeltaMinor: 500 }],
      note: null,
      unitPriceMinor: 3_500,
    },
    {
      key: "k||n:candle",
      item: item("k", 2_500),
      qty: 1,
      sentQty: 0,
      options: [],
      optionLabels: [],
      note: "candle",
      unitPriceMinor: 2_500,
    },
  ],
};

describe("a ticket in the cart", () => {
  it("loads each line at its price with options, note and what was sent, under the same keys", () => {
    const cart = cartFromTicket(ticket);
    expect(cart.map((line) => [cartKey(line), line.qty, line.sentQty, line.unitPriceMinor])).toEqual([
      ["c||o:lg", 2, 1, 3_500],
      ["k||n:candle", 1, 0, 2_500],
    ]);
    const shown = previewCart(cart, EG);
    expect(shown.ok && shown.totalMinor).toBe(9_500);
  });

  it("saves back as lines with refs, options and notes, leaving out empty quantities", () => {
    const cart = cartFromTicket(ticket);
    expect(ticketLinesOf([...cart, { ...cart[1], qty: 0, note: undefined }])).toEqual([
      { ref: { productId: "c", variantId: null }, qty: 2, options: ["lg"] },
      { ref: { productId: "k", variantId: null }, qty: 1, note: "candle" },
    ]);
  });

  it("counts whole minutes open", () => {
    expect(minutesOpen("2026-10-25T10:00:00.000Z", new Date("2026-10-25T10:12:59.000Z"))).toBe(12);
    expect(minutesOpen("2026-10-25T10:00:00.000Z", new Date("2026-10-25T09:59:00.000Z"))).toBe(0);
  });
});

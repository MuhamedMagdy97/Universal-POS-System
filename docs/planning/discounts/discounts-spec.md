# Discounts at the till: Specification

Status: **Spec approved by the owner (2026-10-19, every decision as recommended). BUILT on the "Checkout: discounts"
PR.**

Source: `docs/planning/phase-8/checkout-spec.md` Q3 ("Discounts: deferred"), `docs/product/known-limitations.md`
("No discounts (`discountMinor` is always 0)"), `docs/product/user-roles-permissions.md` (`discounts.apply/override`),
`docs/quality/acceptance-criteria.md` #4 ("Unauthorized discount → 403 + audit attempt"), and the as-built
`modules/sales` (`totals.ts`, `create.ts`, `refunds.ts`, `receipt.ts`) and `modules/reports`.

## 1. Key facts

- `Sale.discountMinor` and `SaleItem.discountMinor` exist (`>= 0` checks) and are always written as `0`.
- Line pricing (`priceLine`): the shelf amount is `unitPriceMinor × qty`. With `pricesIncludeVat` it is gross and VAT
  is taken out (`vatInGross`); without it the amount is net and VAT is added (`vatOnNet`). Half-up rounding once per
  line, then summed. `subtotal = Σ net`, `total = subtotal + vat`.
- Refunds give back a proportional share of `SaleItem.lineTotalMinor` (and `vatMinor`), the last refund of a line
  taking the remainder. A line's `lineTotalMinor` is what the customer paid for it.
- Profit reports already use `lineTotalMinor − vatMinor` (net of VAT).
- The idempotency request hash is taken over the parsed request body.
- Linked shops (inventory system) reserve and fulfil quantities only; money never goes to the inventory system.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| DC1 | Kinds | A discount on a **line** and/or on the **whole sale**, each either an **amount** (`amountMinor ≥ 1`) or a **percent** (`percentBp`, 1–10000 basis points, so 12.5% = 1250). At most one per line plus one for the sale. |
| DC2 | Base | A discount comes off the **shelf amount** (`unitPriceMinor × qty`): gross in VAT-inclusive shops, net in VAT-exclusive ones. That is the price the cashier and the customer see. |
| DC3 | Order and rounding | Line discounts first: percent → `round_half_up(shelf × bp / 10000)`, amount as given. Then the sale discount on the sum of the lines after their own discounts (percent rounded the same way). A discount larger than its base is refused (422 `DISCOUNT_TOO_LARGE`). A 100% discount is allowed (a free line or sale). |
| DC4 | Allocation | The sale discount is split across lines in proportion to each line's amount after its own discount, by **largest remainder** (floor each share, hand the leftover minor units to the largest fractional remainders, ties to the earlier line). `SaleItem.discountMinor` = the line's own discount + its share, so every line knows exactly what it was discounted. |
| DC5 | VAT | VAT is computed on the **discounted** line amount with the same rule as today (`vatInGross` / `vatOnNet`, half-up per line). `Sale.discountMinor = Σ SaleItem.discountMinor`; `subtotal = Σ net`, `vat = Σ vat`, `total = subtotal + vat` (unchanged). |
| DC6 | Server only | The client sends only the discount choice (kind and value). Every amount is computed on the server; the till's preview uses the same pure function (`priceSale` in `modules/sales/totals.ts`). |
| DC7 | Permission | Any discount needs `discounts.apply` or `discounts.override`. **Cashier gets `discounts.apply` by default** (limited); Manager has `discounts.override`; Owner has both (unlimited). Admin and Reporting cannot sell, so they cannot discount. |
| DC8 | Cashier limit | Shop setting **`maxCashierDiscountBp`** (default **1000 = 10%**, 0–100%), edited by Owner/Admin on Settings → Receipt. With only `discounts.apply`: each line's own discount must be ≤ its cap (`round_half_up(shelf × limit)`), and the sale's whole discount must be ≤ the sale cap (the larger of the sum of line caps and `round_half_up(Σ shelf × limit)`). So "10% off" any line or the sale always passes; stacking a line and a sale discount past the limit does not. 0% means cashiers cannot discount. |
| DC9 | Refusal | Over the limit (or no discount permission) → **403** `FORBIDDEN`, `details.reason = "DISCOUNT_LIMIT"` with `limitBp`, message "This discount is over your limit of N%; ask a manager". The attempt is audited (`sales.discount.denied`) outside the rolled-back transaction. A linked shop refuses before holding stock in the inventory system. |
| DC10 | Audit | `sale.created` metadata carries `discount: { totalMinor, sale, lines: [{ sku, discount, discountMinor }] }` when any discount applies (`sale` and each line's `discount` are the requested kind and value). Settings changes keep the existing `settings.receipt.updated` diff. |
| DC11 | Idempotency | Discounts are part of the request body, so they are part of the request hash: the same key with a different discount is a 409 `IDEMPOTENCY_CONFLICT`. A request with no discount hashes exactly as before. |
| DC12 | Repeated item | The same item twice in one request is merged as today; if either copy carries a line discount the request is refused (422 `DUPLICATE_DISCOUNTED_LINE`). The till never sends that. |
| DC13 | Refunds | Unchanged code: refunds share `lineTotalMinor`, which is now the discounted paid amount, so a refund gives back exactly what was paid and the last refund of a line takes the remainder. No discounts on refunds. |
| DC14 | Receipts | Sale receipts show each discounted line's discount under it and a "Discount" total row. Refund receipts show the paid amounts being refunded (no discount rows). |
| DC15 | Reports | Sales summary gains a **Discounts** column (Σ `Sale.discountMinor` of completed sales, in shelf-price terms). "Gross" stays the amount taken (after discounts, VAT included) so existing totals and "net after refunds" do not move. Profit already uses net-of-VAT paid amounts. |
| DC16 | Linked shops | Same behaviour. Discounts change money only, never quantities, so nothing new goes to the inventory system. |
| DC17 | Migration | One column, `Organization.maxCashierDiscountBp INT NOT NULL DEFAULT 1000` with a 0–10000 check. No other schema change. |

## 3. API

`POST /api/sales` (and the till action) body gains two optional fields:

```jsonc
{
  "lines": [{ "ref": { "productId": "…" }, "qty": 2, "discount": { "kind": "PERCENT", "percentBp": 1000 } }],
  "discount": { "kind": "AMOUNT", "amountMinor": 500 }
}
```

`SaleDetail.lines[]` gains `discountMinor`. `SaleDetail.discountMinor` is the sale's total discount.

## 4. Till

- Each cart line has a "Discount" button; **F6** opens it for the selected line, **F7** for the whole sale. The box
  takes a number and a %/amount switch; Enter applies, Esc cancels, an empty box removes the discount.
- The cart shows the discount under the line; totals show "Discount". A cashier sees "Up to N%" next to the box.
  Over-limit discounts are refused by the server with a clear message; the cart is kept.
- Discount controls are shown only to someone with `discounts.apply` or `discounts.override`.

## 5. Tests

- Unit (`tests/unit/sales-discounts.test.ts`): percent and amount, allocation sums and largest remainder ties, VAT
  inclusive/exclusive on discounted amounts, too-large refusal, cashier limit checks.
- Integration (`tests/integration/sales-discounts.test.ts`): discounted sale totals and audit, cashier over limit →
  403 + denial audit, manager unlimited, setting change, refund of a discounted sale (partial then remainder),
  idempotency with discounts, linked shop.
- E2E: a discounted sale at the till and its refund.

## 6. Out of scope

Promotions and automatic discounts, coupons, per-cashier limits, manager approval prompts at the till, discounts on
refunds or exchanges.

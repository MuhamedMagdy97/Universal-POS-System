# Phase 8 / T8 — Returns, Refunds and Voids (as built)

Parent: [returns-void-spec.md](returns-void-spec.md). Decisions V1–V16 are approved.

## 1. Data model

One migration, `20261011230404_refund_request_and_reference`: adds two nullable columns to `Refund`.

- `requestHash` — canonical hash of the request body (as on `Sale`), so a replay with another body is refused.
- `reference` — the manual card-slip or wallet reference. Never card data.

`RefundItem`, `Refund.shiftId`, `SaleItem` and the `Sale_void_fields` check were already in the schema.

## 2. Expected cash (V12)

    expectedCash = openingFloat + Σ CASH sale payments (COMPLETED sales) + PAY_IN − PAY_OUT − DROP − Σ CASH refunds on the shift

A voided sale drops out through its status. A card or wallet refund does not touch the drawer.

## 3. Rules as built

- **Refund (V3, V6, V9):** each line is refused past `soldQty − refundedQty`, with `REFUND_QTY_EXCEEDED` naming the lines.
  The refund books on the **open** shift of the till paying it out: `registerId` in the body, which must be an active
  till in the sale's branch (else 404), or the sale's own till when omitted. No open shift there: `SHIFT_NOT_OPEN`; a
  chosen till is never silently replaced. Stock returns to the sale's branch with reason `REFUND`, `refType: Refund`,
  `policy: allow`. *Changed by the owner on 2026-10-12* (V6 booked on the sale's till): in a store with several tills,
  the drawer that hands out the cash is the one that must count it.
- **Amounts (V4, refined):** each line refunds `round(lineTotal × qty ÷ soldQty)`, and VAT the same way from the line's
  own VAT. The last refund of a line takes the remainder, so all refunds of a line add up to the line exactly.
  *Deviation:* the spec took VAT from the gross amount at the line rate. Taking the line's own VAT share keeps a full
  refund equal to the original line; the two only differ by a piastre on some amounts.
- **Void (V7):** only for a `COMPLETED` sale whose shift is `OPEN`. The void returns the whole sale's stock with reason
  `SALE_VOID` and sets `status = VOIDED`, `voidedAt`, `voidedById` and `voidReason` (the database requires these).
- **Void refused after refunds:** `SALE_HAS_REFUNDS`. *Addition:* a void would need to refund the money already
  returned, and that isn't designed yet. Refund the remaining lines instead.
- **Zero-total refunds:** a refund that comes to nothing (a free item, or a share that rounds to zero) is refused
  with 422 `REFUND_ZERO_TOTAL`, because the database requires a refund total above zero (`Refund_money_valid`). A
  free item on an open shift can still be voided; after the close, its stock comes back through an inventory adjustment.
- **Closed shifts (V6, V7):** a refund of a closed shift's sale books on the paying till's open shift, and the closed
  shift is not written. A void after its shift closed is refused with `VOID_SHIFT_CLOSED`.

## 4. Locking (V15)

Shift row (`lockShift`), then sale row (`lockSale`), then the inventory seam's locks. The same order as sales, so a
sale, a refund and a void on one shift cannot deadlock. Tests: two concurrent refunds of the last units (one wins); a
void raced against a refund (never both).

## 5. Endpoints

| Method + path | Permission | Body | Success | Errors |
|---|---|---|---|---|
| `POST /api/sales/{saleId}/refunds` (`Idempotency-Key`) | `sales.refund` | `{ lines: [{ saleItemId, qty }] (1–200, no duplicates), registerId?, method, reference?, reason }` | 201 new · 200 replay `RefundDetail` | 409 `REFUND_QTY_EXCEEDED` (`details.lines`), `SALE_NOT_COMPLETED`, `SHIFT_NOT_OPEN`, `IDEMPOTENCY_CONFLICT`; 422 `REFUND_ZERO_TOTAL`, missing key or bad body; 404 for a malformed, unknown, other-org or out-of-scope sale, an unknown line, or a till outside the sale's branch; 403 |
| `POST /api/sales/{saleId}/void` | `sales.void` | `{ reason }` | 200 the sale, `status: VOIDED` | 409 `SALE_HAS_REFUNDS`, `VOID_SHIFT_CLOSED`; 404; 403 |

Roles: `sales.refund` and `sales.void` are held by **Owner and Manager** (V1). Admin holds neither.

## 6. Deviation: void replay (V11)

V11 asked for an `Idempotency-Key` on voids too. `Sale` already stores the key of its creation, so a void has no key
column to hold. A void is replayed **by state**: a sale that is already `VOIDED` returns as it is (200), whatever the
reason. This is the same approach as the T7 close replay. Adding a `voidIdempotencyKey` would need another migration.

## 7. Audit

`refund.create` (sale, shift, method, totals) and `sale.void` (reason, total), in the same transaction.

## 8. Returns screen (as built)

`/returns` (header link **Returns**) for roles with `sales.refund` or `sales.void`: Owner and Manager. It is a
back-office page next to the till. Other roles see "You can't use returns". Since 2026-10-12 Managers can also
work a till (`sales.create`, `registers.open`, `registers.close`; owner decision).

- **Find:** the receipt number, typed with or without leading zeros, in Western or Arabic-Indic digits
  (`getSaleForReturns`). A number from another organization or branch scope is "not found".
- **Refund:** a quantity box per line, up to what is left; the amount per line and the total preview the server's
  rule (share, remainder on the last units). Method (cash, card, wallet), reference for non-cash, and a reason are
  required. **Pay out from till** lists the branch's active tills, the sale's own till first; tills without an open
  shift are shown but disabled. It defaults to the sale's till when open, else the first open till. With no open till
  in the branch, the page says so and the refund button stays disabled. One
  `Idempotency-Key` per form, kept only when the outcome is unknown.
- **Void:** offered only while the sale's shift is open and the sale has no refunds; a reason and a second click
  confirm it.
- After each action, or after an error that means the data moved (refunded, voided or closed meanwhile), the page
  reloads its data.

Tests: `tests/unit/returns-helpers.test.ts` (quantity, preview, plan, errors), `tests/integration/refunds-void.test.ts`
(read model), `tests/e2e/returns.spec.ts` (refund one of two units, void, unknown number, cashier refused).

## 9. Not in this part

- Refund receipts (T10).
- Exchanges, store credit and refunds without an original sale (out of scope in the spec).

## 10. Open product questions

- *Resolved 2026-10-12:* which drawer pays a cash refund (the chosen till, §3) and whether Managers work a till (yes).
- **Card and wallet voids.** A void records no payment reversal. The card or wallet money must be reversed by hand
  outside the POS; the audit row keeps the reason and total.

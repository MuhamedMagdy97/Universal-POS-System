# Phase 8 / T6 — Till Screen and Tests (as built)

Parent: [checkout-spec.md](checkout-spec.md). API and rules: [checkout-data-model-and-api.md](checkout-data-model-and-api.md).

## 1. Screen: `/pos` ("Till")

Header link "Till" for roles with `sales.create` (Owner, Admin, Manager, Cashier). Other roles get a "You can't use the
till" state. The page picks the branch (`?branch=`) and register (`?register=`) with a plain GET form; it is hidden when
there is only one choice.

| State | What the cashier sees |
|---|---|
| Branch has no registers | "This branch has no registers. Ask an admin to add one." |
| Register has no open shift | "No open shift" with an opening-cash field and **Open shift** (`registers.open`). Without that permission: "Ask a manager." |
| Shift open | The till: scan/search box (focused), cart, totals, payment, **Charge**. |
| Sale completed | Receipt: sale number, time, lines, subtotal, VAT, total, paid, change; **Print** and **New sale**. |

**Scan and search.** Enter in the search box queries `GET /api/catalog/search`. Exactly one hit goes straight into the
cart (a barcode scan); several hits show a pick list with prices (variants are separate rows). A second scan of the same
item increments its line.

**Cart.** Quantity boxes accept Arabic-Indic digits; an empty or invalid box blocks the charge. Totals are a preview
using the same arithmetic as the server (`modules/sales/totals.ts`); the receipt shows the server's numbers.

**Payment.** One method per sale on screen: Cash (cash received in major units, change shown live), Card or Wallet (the
exact total, optional reference). The API accepts split tenders; the split UI is deferred. A zero-total sale shows
**Complete free sale** and sends no payment.

**Idempotency on screen.** One `Idempotency-Key` per cart, kept across a retry when the outcome is unknown (network
failure or 500), and replaced after any definite error, so a fixed cart can be charged without a conflict
(`keepKeyAfter`). **New sale** always starts a new key.

**Errors.** Each `details.reason` has its own message (`saleErrorKey`); "Not enough stock" names the short items.
`SHIFT_NOT_OPEN` reloads the page into the open-shift state.

**EN/AR.** All strings are `pos.*` keys in both dictionaries; amounts and SKUs render left-to-right.

## 2. Tests

| Layer | File | Covers |
|---|---|---|
| Unit | `tests/unit/sales-totals.test.ts` | VAT in/out of gross, rounding, payment settlement, edge amounts |
| Unit | `tests/unit/pos-till-helpers.test.ts` | cart ops, preview, cash parsing, payment plan, charge gating, error mapping, key rule |
| Integration | `tests/integration/sales-create.test.ts` | totals, snapshots, change, merge, refusals, idempotency (incl. concurrent), oversell race, zero total, overflow |
| Integration | `tests/integration/sales-routes.test.ts` | 401/403/404/422, 201/200 replay, 409 conflict, no cost in the response |
| Integration | `tests/integration/registers-shift.test.ts` | open, second open refused, permission, negative float |
| Integration | `tests/integration/catalog-inventory-race.test.ts` | R1 variant-switch race |
| E2E | `tests/e2e/pos-till.spec.ts` | open shift → two scans → cash with change → receipt → new sale; stock refusal names the item, then a fixed cart sells; Arabic RTL; reporting user denied |

E2E creates its own register and stocked product per run (`tests/e2e/support/pos.ts`), so parallel workers never share
an open shift.

## 3. Deferred

Split tenders on screen, shift close and cash count (T7), void/refund (T8), receipt print layout (T10), on-hand shown at
the till, keyboard shortcuts beyond Enter.

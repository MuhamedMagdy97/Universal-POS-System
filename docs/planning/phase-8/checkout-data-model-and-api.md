# Phase 8 / T6 — Checkout Data Model, Rules and API

Parent: [checkout-spec.md](checkout-spec.md) (decisions D1–D12, Q1–Q4 approved 2026-10-11).

## 1. Data model

Tables `Sale`, `SaleItem`, `Payment`, `RegisterShift` and the enums already exist (init migration). Checkout adds three
columns in one additive migration `20261011204423_checkout`:

| Table | Column | Why |
|---|---|---|
| `Organization` | `lastSaleNo Int @default(0)` | Gap-free sale numbers. Bumped with `UPDATE … RETURNING` inside the sale transaction, so a rollback reuses the number. |
| `Sale` | `changeMinor Int @default(0)` | Cash handed back. Not derivable from the stored rows, because the till stores only the cash applied to the sale. |
| `Sale` | `requestHash String?` | SHA-256 of the canonical request body. A replayed `Idempotency-Key` must match it. |

No other schema change. `Sale.discountMinor` stays `0` (Q3). `Sale.idempotencyKey` is unique per org.

**Sale number.** `Sale.number` is `String(lastSaleNo).padStart(6, "0")`, unique per org. One org-level counter means every
sale in the org takes the same row lock. That is acceptable for the single-store MVP. Revisit (per-branch counter) before
multi-branch volume.

## 2. Totals (server-computed, D1–D3)

Prices come from the sellable item (`unitPriceMinor`, resolved variant → product). Each line uses `vatApplicable` and the
org's `vatRateBp` (1400 EG, 1500 SA). Rate is zero when `vatApplicable` is false (zero-rated or exempt).

Integer arithmetic, round half up per line:

- `pricesIncludeVat = true` (default, Q4). `gross = unitPriceMinor × qty`.
  `vat = floor((2·gross·rate + (10000 + rate)) / (2·(10000 + rate)))`, `net = gross − vat`. Line total = `gross`.
- `pricesIncludeVat = false`. `net = unitPriceMinor × qty`.
  `vat = floor((2·net·rate + 10000) / 20000)`. Line total = `net + vat`.

Sale: `subtotalMinor = Σ net`, `vatMinor = Σ vat`, `totalMinor = subtotalMinor + vatMinor`. `discountMinor = 0`.
`SaleItem` snapshots `skuSnapshot`, `nameSnapshot`, `nameArSnapshot`, `unitType`, `unitPriceMinor`, `vatRateBp`, `vatMinor`,
`lineTotalMinor` (= line total above). Cost is never stored on a sale-facing response (inventory rule).

## 3. Payments (D6)

Request `payments` is a list with at most one entry per method (`CASH`, `CARD_MANUAL`, `WALLET`).

- Non-cash entries (`CARD_MANUAL`, `WALLET`) apply their full `amountMinor`. `reference` is optional and is stored as given.
  Their sum must be ≤ `totalMinor`.
- Cash: `amountMinor` is the **tendered** cash. Applied cash = `totalMinor − Σ non-cash`. Tendered must be ≥ applied, else
  `PAYMENT_MISMATCH`. Stored `Payment.amountMinor` = applied. `Sale.changeMinor` = tendered − applied.
- With no cash entry, Σ non-cash must equal `totalMinor`, else `PAYMENT_MISMATCH`.
- Zero or negative amounts are rejected by zod (`Payment.amountMinor > 0` is also a DB CHECK). The list may be empty
  only for a zero-total sale (free items); otherwise an empty list is `PAYMENT_MISMATCH`.
- A line or sale total above 2,147,483,647 minor units (the 32-bit money columns) is refused with
  `VALIDATION_FAILED` / `AMOUNT_TOO_LARGE` before anything is written.

## 4. Stock (D4, D7)

Each line calls `recordMovements({ reason: "SALE", refType: "Sale", refId: saleId, policy })`. `policy` is
`Organization.blockNegativeStock` (default `block`). Under `block`, an insufficient line refuses the whole sale with
`CONFLICT` / `INSUFFICIENT_STOCK` and the offending lines in `details.lines`. The seam already locks product rows first,
so a variant switch and a sale serialize (R1, done).

## 5. Shift (D8, Q1)

A sale is recorded against the **OPEN** `RegisterShift` on the request's `registerId` in the request's `branchId`. If none,
`CONFLICT` with `details.reason = "SHIFT_NOT_OPEN"`. Opening a shift is in scope; closing and cash counts are T7.

`POST /api/shifts/open` (`registers.open`) creates one OPEN shift with `openingFloatMinor ≥ 0`. A second open shift on the
same register is refused with `CONFLICT` (`details.reason = "SHIFT_ALREADY_OPEN"`), backed by the partial unique index from
the init migration.

## 6. Idempotency (D5)

`Idempotency-Key` header is required on `POST /api/sales` (`VALIDATION_FAILED` if missing; 1–128 printable characters).

1. Before the transaction: look up `Sale` by `(orgId, idempotencyKey)`.
   - Found, same `requestHash` → return it with **200** and no new movements.
   - Found, different `requestHash` → `IDEMPOTENCY_CONFLICT` (409).
2. Inside the transaction the insert can still hit the unique key (a concurrent duplicate). That raises P2002, the
   transaction rolls back, and step 1 runs again outside it.

A new sale returns **201**.

## 7. Errors

| Situation | Status | Code | `details.reason` |
|---|---|---|---|
| No permission | 403 | FORBIDDEN | (audit `inventory.permission.denied`-style: `sales.permission.denied`) |
| Branch not in scope, register not in branch | 404 | NOT_FOUND | — |
| Missing / malformed `Idempotency-Key` or body | 422 | VALIDATION_FAILED | zod issues |
| Archived or unknown item | 422 / 404 | ITEM_NOT_SELLABLE / NOT_FOUND | `cause` from catalog (`PRODUCT_ARCHIVED`, …) |
| Not enough stock (block) | 409 | CONFLICT | `INSUFFICIENT_STOCK`, `lines` |
| No OPEN shift on the register | 409 | CONFLICT | `SHIFT_NOT_OPEN` |
| Payment amounts do not match | 422 | VALIDATION_FAILED | `PAYMENT_MISMATCH` |
| Line or sale total too large for the money columns | 422 | VALIDATION_FAILED | `AMOUNT_TOO_LARGE` |
| Second open shift on a register | 409 | CONFLICT | `SHIFT_ALREADY_OPEN` |
| Same key, different body | 409 | IDEMPOTENCY_CONFLICT | — |

Archived items are refused as sales (D11). Refusal comes from the catalog seam (`getSellableItems`), not from inventory.

## 8. API

| Method and path | Permission | Body | Success |
|---|---|---|---|
| `POST /api/shifts/open` | `registers.open` | `{ branchId, registerId, openingFloatMinor }` | 201 `ShiftSummary` |
| `POST /api/sales` (+ `Idempotency-Key`) | `sales.create` | `{ branchId, registerId, lines: [{ ref: { productId, variantId? }, qty }] (1–200), payments: [{ method, amountMinor, reference? }] (1–3) }` | 201 new · 200 replay · `SaleDetail` |

`SaleDetail`: `{ id, number, branchId, registerId, shiftId, status, currency, subtotalMinor, discountMinor, vatMinor,
totalMinor, changeMinor, createdAt, lines: [{ productId, variantId, sku, name, nameAr, unitType, qty, unitPriceMinor,
vatRateBp, vatMinor, lineTotalMinor }], payments: [{ method, amountMinor, reference }] }`. It carries no cost, no stock
figures and no org internals.

`qty` is a whole number from 1 (EACH only, KG deferred). Arabic-Indic digits are accepted (`normalizeQty`).

## 9. Audit (D9)

| Action | Entity | Written when |
|---|---|---|
| `sale.created` | `Sale` | in the sale transaction, metadata `{ number, totalMinor, lineCount, paymentMethods }` |
| `shift.opened` | `RegisterShift` | in the open transaction, metadata `{ registerId, openingFloatMinor }` |
| `sales.permission.denied` | `Sale` or `RegisterShift` | denied `sales.create` / `registers.open` attempt (outside the transaction) |

Metadata never holds payment references or card data.

## 10. Out of scope

Void and refund (T8), shift close and cash count (T7), discounts (Q3), receipt printing (T10), payment providers,
history list screens beyond the single-sale response.

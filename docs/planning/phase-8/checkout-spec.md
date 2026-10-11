# Phase 8 / T6 — Checkout Specification

Status: **draft 2026-10-11, awaiting owner review.** Nothing here is built yet. Open decisions are listed in §3 with a
recommendation; the owner's answers turn them into the decision table.

Source: `docs/planning/task-breakdown.md` (T6 "Checkout E2E", deps T4), `docs/product/business-rules.md`,
`docs/architecture/api-contracts.md` (`/api/sales`), and the inventory seam built in Phase 7
([inventory-as-built.md](../phase-7/inventory-as-built.md)).

## 1. Key facts

- `modules/sales` and `modules/payments` are **empty stubs** (index only). Nothing sells yet.
- The schema already has `Sale`, `SaleItem`, `Payment`, `Refund`, `RegisterShift`, `CashMovement`, `Register` and the
  `SaleStatus` / `PaymentMethod` / `ShiftStatus` enums. Check the migrations before adding any column.
- `Sale.shiftId` is **NOT NULL**, so a sale must belong to an open shift. Shifts and cash counts are T7, which depends on
  T6. This is decision Q1 below.
- `Sale.idempotencyKey` is unique per org. `SaleStatus` already has the states T8 needs (void, refund).
- The inventory seam exposes `recordMovements(tx, ctx, { reason: "SALE", policy })` and `getOnHand`. T6 is the first real
  caller of `SALE` movements. It must never write `StockBalance` or `InventoryMovement` directly.
- `Organization.blockNegativeStock` defaults to `true`. Sales are the only inventory writer that follows it.
- Permissions `sales.create` and `registers.open` already exist. The Cashier role holds both.
- Phase 7 left one unclosed race that **must close before checkout ships** (see §4, R1).

## 2. Goal and success

A cashier can open a shift on a register, scan or search items, take a payment (cash, card or wallet, recorded manually),
and get a receipt. The server recomputes every total. Each sale writes its `SaleItem` snapshots, `Payment` rows, `SALE`
stock movements and an audit row in one transaction. Two cashiers taking the last unit produce exactly one sale.
Replaying a request with the same `Idempotency-Key` returns the original sale and does not sell twice.

Out of scope (this phase): shift close and cash count (T7), refunds, voids and returns (T8), discounts beyond the
decision in Q3, printing CSS (T10), and any payment-provider integration (manual payments only, per `mvp-scope.md`).

## 3. Decisions

Proposed defaults are marked **(rec)**. Items marked **Owner** need an answer before the task plan is written.

| # | Topic | Proposal |
|---|---|---|
| D1 | Totals | Server recomputes everything. Client totals are preview only (business rule 2). |
| D2 | VAT | Rate comes from the org at sale time and is snapshotted per line. Round half-up per line, then sum (business rule 3). Prices are VAT-inclusive or exclusive per org setting; **confirm which the presets use.** |
| D3 | Price snapshot | `SaleItem` stores SKU, names, unit type, unit price and VAT at sale time (no cost). Later price edits never change it (business rule 4). **Cost is never stored on the sale-facing response** (inventory rule). |
| D4 | Oversell policy | Follow `Organization.blockNegativeStock` through `recordMovements(policy)`. Default `true` means the sale is refused with `INSUFFICIENT_STOCK` and the offending lines listed. With `false`, the sale goes through, and the stock list already flags the item. **(rec)** keep the default `true`. |
| D5 | Idempotency | `Idempotency-Key` header required on `POST /api/sales`, stored in `Sale.idempotencyKey` (unique per org). A replay with the same key and same body returns the original sale (200). A replay with a different body returns 409. |
| D6 | Payments | Multiple `Payment` rows per sale are allowed (for example cash + card). Non-cash entries apply in full; cash covers the rest and any excess is returned as change (`Sale.changeMinor`). A zero-total sale takes no payment. Detail: data-model part §3. Methods come from the existing `PaymentMethod` enum. |
| D7 | Concurrency | One transaction per sale. Balance rows are locked through `applyLines` in the seam's fixed order. Sales are never oversold under `block` (Phase 7 test I-3 already covers the seam). |
| D8 | Register and shift | A sale is recorded against the cashier's open shift on a register in the current branch. Opening a shift is **in scope** (see Q1). Closing and counting cash is T7. |
| D9 | Audit | `sale.create` audit row in the same transaction. Denials audit-logged, as in catalog and inventory. |
| D10 | Errors | Shared `ErrorCode` set. Cause in `details.reason` (`INSUFFICIENT_STOCK`, `PAYMENT_MISMATCH`, `SHIFT_NOT_OPEN`, `SHIFT_ALREADY_OPEN`, `AMOUNT_TOO_LARGE`; `IDEMPOTENCY_CONFLICT` is its own code). Archived items surface as catalog `ITEM_NOT_SELLABLE`. |
| D11 | Archived items | Sales of archived items are refused with catalog `ITEM_NOT_SELLABLE` (cause `PRODUCT_ARCHIVED` / `VARIANT_ARCHIVED`), per D8 of inventory. |
| D12 | Receipt numbers | `Sale.number` is unique per org. As built: one org-level counter (`Organization.lastSaleNo`), six-digit, gap-free, bumped under the org row lock. Revisit (per-branch) before multi-branch volume. |

### Decided by the owner (2026-10-11)

- **Q1 Shift scope: open shift only.** T6 lets a cashier open a shift on a register. Cash count and shift close are T7.
- **Q2 Base branch: `phase-8/checkout` from `phase-7/inventory`.** Rebase once Phase 7 merges.
- **Q3 Discounts: deferred.** T6 stores `discountMinor = 0`. No `sales.discount` permission yet.

- **Q4 Prices VAT-inclusive.** `Organization.pricesIncludeVat` defaults to `true` for EG and SA (business rule 13,
  `database-design.md`). Checkout reads this flag and computes VAT from gross prices unless an org turns it off.
- **D1–D12 approved by the owner (2026-10-11).**

### Still open

- Nothing blocking. Next: write the data-model, API and UX/test parts, then `checkout-task-plan.md`.

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Variant-switch race (carried from Phase 7).** A sale that commits between `hasUnvariantedStock` and the variant switch can leave a variant-null row on a product that now has variants. | **Done (2026-10-11).** `lockProducts` (catalog seam) locks product rows first in every stock write (`applyLines`, `lockBalances`); `insertVariant` locks, re-reads `hasVariants`, then checks stock. Test: `tests/integration/catalog-inventory-race.test.ts` (reproduced the bug first, then fixed). Full suite 497 green. |
| R2 | Double-submit on a slow network. | D5 idempotency key, plus a UI guard (`safeAction`). Test: two identical POSTs produce one sale and one set of movements. |
| R3 | Stale price shown at the till. | Server recomputes totals and returns the price used. The client shows the server's numbers after submit. |
| R4 | Stock shown as available but sold out by another till. | `getOnHand` is a preview. The sale transaction is the authority, and the error lists the lines that failed. |
| R5 | Cash rounding mismatches with the receipt. | Round per line (D2), compute change from the summed total, and test with Arabic-Indic digit inputs. |

## 5. Interfaces (to be detailed in the API part)

- `POST /api/sales` (`sales.create`, `Idempotency-Key`): body = branch, register, lines `[{ ref, qty }]`, payments
  `[{ method, amountMinor }]`. Response = the sale with server-computed totals and change.
- `GET /api/sales?…` (history): out of scope beyond the receipt lookup needed to show a completed sale.
- `POST /api/shifts/open` (`registers.open`): per Q1.
- Seam used: `recordMovements({ reason: "SALE", refType: "Sale", refId, policy })` and `getOnHand`.

## 6. Next steps

1. Owner answers Q1–Q4 (and reviews D1–D12).
2. Write the data-model, API and UX/test parts in the same layout as Phase 7 (`inventory-data-model.md`,
   `inventory-api-and-rules.md`, `inventory-ux-and-tests.md`).
3. Write `checkout-task-plan.md`, starting with R1 (variant-switch race).
4. Build with the same gates as Phase 7: lint, typecheck, unit and integration tests, E2E on the dedicated test database.

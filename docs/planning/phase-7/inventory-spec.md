# Phase 7 / T4 — Inventory Specification

Status: **spec written 2026-10-11, awaiting owner review.** Design agreed in conversation the same day (D1–D6 below).

This is the entry point for T4 "Ledger + balances + adjust/transfer" (`docs/planning/task-breakdown.md`).
The detail lives in three parts; where they disagree, **this file wins**.

| Part | File |
|---|---|
| Data model, constraints, migration | [inventory-data-model.md](inventory-data-model.md) |
| Services, seam, routes, errors, permissions, audit | [inventory-api-and-rules.md](inventory-api-and-rules.md) |
| Screens, acceptance criteria (I-1…I-20), test plan | [inventory-ux-and-tests.md](inventory-ux-and-tests.md) |
| Build order | `inventory-task-plan.md` (written after this spec is approved) |

## 1. Key facts

- The Phase 5 init migration already created `StockBalance` (unique key `NULLS NOT DISTINCT`) and the append-only
  `InventoryMovement` ledger (UPDATE/DELETE/TRUNCATE rejected by trigger, `qtyDelta <> 0`, transfers must carry a
  `transferGroupId`). `Organization.blockNegativeStock` exists (default `true`). T4 is **one additive migration +
  services + seam + UI**, not new tables.
- `inventory.adjust` / `inventory.transfer` already exist and are granted to Owner, Admin, Manager.
- Catalog provides `assertStockable(client, orgId, ref)` (T3.5) and leaves a `TODO(T4)` in `insertVariant`
  (`modules/catalog/variants.ts`) that T4 resolves.
- Quantities are integers (EACH only; KG deferred, catalog Q5).

## 2. Goal and success

A manager can see on-hand stock per branch, load opening stock, adjust with a structured reason, and transfer between
branches. Every change is a ledger row plus a balance update plus an audit row in one transaction; concurrent writes
cannot oversell under the "block" policy; and T5 (purchasing), T6 (checkout) and T8 (returns/voids) get a tx-aware
seam (`recordMovements`, `getOnHand`) so they never touch inventory tables.

## 3. Decisions (owner, 2026-10-11)

| # | Topic | Decision |
|---|---|---|
| D1 | Transfer model | **Instant transfer**: one action writes `TRANSFER_OUT` + `TRANSFER_IN` in one transaction. Two-step (ship → receive, in-transit) moves to **Next**. |
| D2 | Adjustment reasons | New `AdjustmentReason` enum on the movement: `DAMAGED`, `EXPIRED`, `LOST_OR_STOLEN` (decrease only), `FOUND` (increase only), `COUNT_CORRECTION`, `OTHER` (either way). Note required for `OTHER`. Enforced in service **and** DB CHECK. |
| D3 | Initial stock | `OPENING_BALANCE` is a one-time action per item × branch, allowed only while the item has **no** ledger rows at that branch. Entered per item or via a bulk on-screen grid (one transaction). No CSV import. |
| D4 | Negative stock | Adjustments and transfers-out **never** go below zero. Sales follow `Organization.blockNegativeStock` via a per-call `policy: "block" \| "allow"` on the seam. Refunds, voids and receipts only add, so no check. The `blockNegativeStock` toggle stays **DB-only** (no UI in T4). |
| D5 | Read access | New permission `inventory.read` → Owner, Admin, Manager, Reporting. Cashier gets no back-office stock screens; T6 shows "in stock" through the seam. |
| D6 | Transfer scope | Caller needs access to the **source** branch only; the destination must be an active branch of the same org. |
| D7 | Balance maintenance | Services write ledger + balance in one tx with `SELECT … FOR UPDATE` row locks taken in a fixed key order; a `reconcile()` function checks cache vs ledger. (Chosen over a DB trigger and over no cache.) |

## 4. Refinements made while writing the spec

- **Errors use the shared codes.** `lib/errors.ts` has a fixed `ErrorCode` set; like catalog, inventory raises
  `CONFLICT` (409) or `VALIDATION_FAILED` (422) with the specific cause in `details.reason`
  (`INSUFFICIENT_STOCK`, `STALE_STOCK`, …). The design conversation named these as if they were codes.
- **Catalog → inventory check without a hook.** Instead of a registered callback, `hasUnvariantedStock` lives in
  `modules/inventory/queries.ts`, which imports nothing from catalog. Catalog imports that file directly, so the module
  graph stays acyclic (`inventory → catalog` for `assertStockable`, `catalog → inventory/queries` for the guard) and
  there is no registration that could silently be missing. `modules/inventory/index.ts` re-exports it too.
- **Two extra DB CHECKs** beyond the agreed design: per-reason direction (inflow reasons `> 0`, `SALE` /
  `TRANSFER_OUT` `< 0`) and "only transfer rows carry a `transferGroupId`". Both are cheap backstops for the seam.
- **Transfer idempotency index** is on `(orgId, transferGroupId, reason, productId, variantId)`, with duplicate items
  in one transfer rejected (`DUPLICATE_LINE`), rather than `(orgId, transferGroupId, reason)` — a multi-line transfer
  writes several rows per side.
- **Archived items with stock** stay visible in the stock list (flagged), so stock never silently disappears.

## 5. Out of scope (T4)

Stock counts / count sessions (Next), two-step transfers (Next), reorder points / low-stock alerts, cost valuation
and COGS, CSV import, the `blockNegativeStock` settings UI, the POS "in stock" display (T6 consumes `getOnHand`),
writing `SALE` / `SALE_VOID` / `REFUND` / `PURCHASE_RECEIPT` movements from real documents (T5/T6/T8 call the seam).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Deadlocks between concurrent multi-line writes | Lock balance rows in one global order `(branchId, productId, variantId NULLS FIRST)`; integration test runs crossing transfers in parallel. |
| Cache drift if anything writes the tables outside the module | Seam rule + `reconcile()` asserted after every integration test file. |
| Row lock on a balance row that doesn't exist yet | `INSERT … ON CONFLICT DO NOTHING` first, then `SELECT … FOR UPDATE`, so there is always a row to lock. |
| Ledger growth slows history pages | Existing index `(orgId, branchId, productId, variantId, createdAt)`; cursor pagination. |

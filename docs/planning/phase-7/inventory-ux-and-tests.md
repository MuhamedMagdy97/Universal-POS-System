# Phase 7 / T4 — Inventory Screens, Acceptance Criteria and Tests

Part of [inventory-spec.md](inventory-spec.md). Conventions follow catalog (`docs/planning/phase-6/catalog-ux-and-tests.md`):
Server Components call `modules/inventory` directly; Server Actions are thin adapters (re-run `requireTenant`, same
zod schema); EN/AR typed dictionary; logical CSS for RTL; SKU, barcode and quantity fields are `dir="ltr"`;
Latin digits displayed, Arabic-Indic digits accepted in inputs.

## 1. Navigation and branch

- Header link **Inventory** (`inventory-nav-link.tsx`), shown when the role has `inventory.read`.
- **Branch picker** on every inventory page: `?branch=<id>` URL param, default = session `activeBranchId`, else the
  first accessible branch (by name). Lists only accessible, active branches. Hidden when there is exactly one.
  An inaccessible `?branch=` renders the 404 state.

## 2. Screens

### 2.1 `/inventory` — stock list
- Search box (name / SKU / barcode; a scanner's Enter submits). Filter chips: All · In stock · Zero · Negative.
- Columns: item (name + variant name), SKU, on hand, last movement time. Negative qty in the danger colour with an
  "Oversold" badge; archived items show an "Archived" badge.
- Row actions (permission-gated): **Adjust** (`inventory.adjust`), **Transfer** (`inventory.transfer`), row click →
  history. Page actions: **Opening stock** (`inventory.adjust`), **New transfer** (`inventory.transfer`).
- States: loading skeleton, empty ("No stockable items yet" + link to catalog when `products.create`),
  no-results, error with retry, 403, 404. Cursor pagination, 50 per page.

### 2.2 `/inventory/items/[productId]?variant=&branch=` — item history
- Header: item name, SKU, on-hand for the branch, Adjust / Transfer buttons.
- Table: date-time, reason label (e.g. "Adjustment — Damaged"), change (+/−), balance after, by, note, link
  (transfer → other branch name; documents link from T5/T6 on). Newest first, cursor "Load more".

### 2.3 Adjust dialog (from list or history)
- Shows current on-hand. Reason select (six sub-reasons). For `COUNT_CORRECTION`, mode toggle
  **Change by** / **Set counted quantity** (default: counted). Quantity input; the sign is fixed by the reason
  (DAMAGED/EXPIRED/LOST: "Remove N"; FOUND: "Add N"; others: ± allowed). Note (required for Other, max 500).
- Preview line "On hand: 12 → 9". Submit carries `expectedOnHand`.
- `STALE_STOCK`: dialog stays open, shows "Stock changed to N while you were editing", updates the preview, asks
  to confirm again. `INSUFFICIENT_STOCK`: inline error on quantity. Success: toast, list/history refresh.
- Focus goes to the reason select on open; Esc closes; Enter submits (catalog dialog pattern, incl. the
  confirm-button focus fix from PR #4).

### 2.4 `/inventory/transfer?branch=` — new transfer
- From: current branch (read-only). To: select of other active branches in the org.
- Lines: add by scan/search (reuses catalog search via `GET /api/catalog/search`), qty input, source on-hand shown,
  remove button. Same item scanned twice increments the line.
- Client blocks qty > on-hand as a preview; server is authoritative (`INSUFFICIENT_STOCK` highlights lines).
- `transferId = crypto.randomUUID()` on mount; kept across retries; regenerated after success.
- Success: redirect to `/inventory?branch=` with a toast "Transferred N items to Branch B".

### 2.5 `/inventory/opening?branch=` — opening stock grid
- Lists stockable items with **no** movements at the branch, 50 per page with search/scan jump-to-row.
- One integer input per row; blank = skipped. Edits are kept in client state across pages of the grid.
- Save ⇒ one `recordOpeningBalances` call (≤ 500 lines; above that the button asks to save in batches).
- `OPENING_BALANCE_EXISTS` ⇒ highlight those rows "Stock already recorded" and keep the others' values.
- A "Leave page?" guard when unsaved values exist.
- Single-item entry: from the history page of an item with no movements, a **Set opening stock** button opens a
  one-line version of the same form.

## 3. Acceptance criteria

| # | Criterion |
|---|---|
| I-1 | Each line of every stock change writes exactly one ledger row and one balance update, with the audit row in the same transaction; `reconcile()` reports zero mismatches after every integration test file. |
| I-2 | Adjustment or transfer taking stock below zero ⇒ 409 `INSUFFICIENT_STOCK`, regardless of `blockNegativeStock`. |
| I-3 | Two concurrent `recordMovements(SALE, policy:"block")` for the last unit ⇒ exactly one succeeds; balance 0. |
| I-4 | `policy:"allow"` sale may go negative; the item appears under the Negative filter with the Oversold badge. |
| I-5 | Second opening balance for an item × branch (or one after any movement) ⇒ 409 `OPENING_BALANCE_EXISTS`; concurrent duplicates ⇒ one wins (unique index). |
| I-6 | Sub-reason direction mismatch ⇒ 422 `ADJUSTMENT_DIRECTION` from the service and a CHECK violation on a raw insert. `OTHER` without note ⇒ 422 `NOTE_REQUIRED`. |
| I-7 | Same `transferId` sent twice (sequentially and concurrently) ⇒ applied once; replay returns 200 with the original lines; reused with different content ⇒ 409 `IDEMPOTENCY_CONFLICT`. |
| I-8 | Transfer to the same branch ⇒ 422 `SAME_BRANCH`; to another org's or an inactive branch ⇒ 404; to an active branch outside the caller's scope ⇒ allowed. |
| I-9 | Branch outside the caller's scope ⇒ 404 on every inventory route/page; missing permission ⇒ 403 plus an audited denial; Cashier sees no Inventory link and gets 403 on `/inventory`. |
| I-10 | Adding the first variant to a product with `variantId = NULL` movements ⇒ 409 `PRODUCT_HAS_STOCK`; nothing written. |
| I-11 | `COUNT_CORRECTION` with `countedQty` computes the delta under the lock; `countedQty` equal to on-hand ⇒ 422 `NO_CHANGE`. |
| I-12 | `expectedOnHand` mismatch ⇒ 409 `STALE_STOCK` with the current `onHand`; the dialog shows it and allows re-confirm. |
| I-13 | Archived item (D8): opening, increases and sales ⇒ 422 `ITEM_NOT_SELLABLE`; decreasing adjustments, transfers and `REFUND`/`SALE_VOID` succeed, so its stock can always be written off or moved; the list still shows it if qty ≠ 0. |
| I-14 | Product with variants: ref without `variantId` ⇒ 422 `VARIANT_REQUIRED`. |
| I-15 | Crossing concurrent transfers (A→B and B→A, multiple items) complete without deadlock. |
| I-16 | Ledger rows cannot be updated or deleted (existing trigger) — regression test kept. |
| I-17 | Item history shows correct `balanceAfter` for every row, and the header equals the last `balanceAfter`. |
| I-18 | Cost never appears in any inventory response. |
| I-19 | `getOnHand` returns input-order results, 0 for items with no balance row, and works inside a tx. |
| I-20 | All inventory pages render in Arabic RTL; quantities, SKUs and barcodes stay LTR; Arabic-Indic digits are accepted in quantity inputs. |

## 4. Test plan

**Unit** (`tests/unit/`)
- `inventory-validation.test.ts` — zod: line limits, qty bounds, `qtyDelta` xor `countedQty`, note length, duplicate lines.
- `inventory-rules.test.ts` — direction table (D2), lock-order sort helper.
- `permissions.test.ts` — `inventory.read` matrix.

**Integration** (`tests/integration/`, `pos_test`)
- `inventory-constraints.test.ts` — each new CHECK / index (data-model §5).
- `inventory-opening.test.ts` — I-5, I-13, I-14.
- `inventory-adjust.test.ts` — I-2, I-6, I-11, I-12.
- `inventory-transfer.test.ts` — I-7, I-8, I-15.
- `inventory-seam.test.ts` — I-3, I-4, I-13 (refund of archived), I-19, `recordMovements` input-order result.
- `inventory-queries.test.ts` — `listStock` filters/search/pagination, `getItemLedger` running balance (I-17).
- `inventory-isolation.test.ts` — route 401/403/404 matrix, forged `orgId`/branch, other-tenant item refs, I-9, I-18.
- `catalog-seam.test.ts` / `catalog-products.test.ts` — I-10.
- Shared `afterAll(reconcile)` assertion helper in `helpers.ts` (I-1).

**E2E** (`tests/e2e/`, `E2E_DATABASE_URL`; seed gets a second branch and a branch-scoped manager)
- `inventory-admin.spec.ts` — opening grid → adjust (counted) → transfer → history on both branches.
- `inventory-access.spec.ts` — Cashier no link/403, scoped manager can't open the other branch, Reporting read-only.
- `inventory-rtl.spec.ts` — Arabic layout, LTR quantity fields, Arabic-Indic digit entry.

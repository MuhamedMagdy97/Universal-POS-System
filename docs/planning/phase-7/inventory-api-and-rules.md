# Phase 7 / T4 — Inventory Services, Seam, Routes and Rules

Part of [inventory-spec.md](inventory-spec.md).

## 1. Module layout

```
modules/inventory/
  index.ts      public surface (services + seam + queries re-export)
  schemas.ts    zod inputs, ItemRef, cursor codec
  errors.ts     conflict()/invalid() helpers with details.reason (catalog pattern)
  locking.ts    lockBalances(tx, orgId, branchId, refs) — ensure rows, lock in key order
  ledger.ts     applyLines(tx, ctx, {...}) — the single write path (lock → check → update → insert)
  queries.ts    hasUnvariantedStock, getOnHand (no catalog imports; catalog may import this file)
  stock.ts      listStock, getItemLedger
  opening.ts    recordOpeningBalances
  adjust.ts     adjustStock
  transfer.ts   transferStock
  reconcile.ts  reconcile
```

`ItemRef = { productId: uuid, variantId: uuid | null }` (same shape as catalog's `CatalogItemRef`).

## 2. The write path (`ledger.applyLines`)

Every stock change — back office and seam — goes through one internal function, inside the caller's transaction:

1. **Normalise.** Reject duplicate refs in one call (`DUPLICATE_LINE`, 422).
2. **Catalog check.** `assertStockable(tx, orgId, ref)` per line for `OPENING_BALANCE`, `ADJUSTMENT`, `TRANSFER_*`,
   `SALE`, `PURCHASE_RECEIPT`. Skipped for `SALE_VOID` and `REFUND` (archived items must still come back).
3. **Lock.** For every `(branchId, ref)` touched — both branches for a transfer — run
   `INSERT INTO "StockBalance" … ON CONFLICT DO NOTHING`, then `SELECT id, qty … FOR UPDATE`, **sorted by
   `(branchId, productId, variantId NULLS FIRST)`** across the whole call. One global order ⇒ no deadlocks.
4. **Check.** For each negative delta, if `policy === "block"` and `qty + delta < 0` collect
   `{ref, branchId, onHand, requested}`; after all lines, throw one `INSUFFICIENT_STOCK` with every failing line.
5. **Write.** `UPDATE "StockBalance" SET qty = qty + delta`, insert the `InventoryMovement` row
   (`actorUserId = ctx.userId`).

Back-office services always pass `policy: "block"` (D4).

## 3. Back-office services

All take `(ctx: TenantContext, input, meta?)`, open their own `db.$transaction`, check the permission inside the
service (audit a denial, catalog C-14 pattern), then validate with zod, then call `requireBranch` (branch access → 404
otherwise). Each writes one audit row in the same transaction.

### 3.1 `listStock(ctx, {branchId, q?, filter?, cursor?, limit?})` — `inventory.read`
- Rows: every **stockable** item (active product without variants, or active variant of an active product) left-joined
  to `StockBalance` for the branch (missing row ⇒ `qty 0`). Archived items with a non-zero balance are included and
  flagged `archived: true` so stock never disappears from view.
- `q` matches name / nameAr / SKU (`ILIKE`, like catalog) or an exact barcode.
- `filter`: `all` (default) | `inStock` (`qty > 0`) | `zero` (`qty = 0`) | `negative` (`qty < 0`).
- Sort: product name, then variant sortOrder. Cursor pagination, `limit` default 25, max 100.
- Row: `{productId, variantId, name, variantName, sku, primaryBarcode, qty, archived, updatedAt}`. No cost.

### 3.2 `getItemLedger(ctx, {branchId, ref, cursor?, limit?})` — `inventory.read`
- Newest first. Row: `{id, createdAt, reason, adjustmentReason, qtyDelta, balanceAfter, actor: {id, name}, note,
  refType, refId, transfer: {groupId, otherBranch: {id, name}} | null}`.
- `balanceAfter` = window `SUM(qtyDelta) OVER (ORDER BY createdAt, id)` over the item × branch.
- Header: current `qty` from `StockBalance`. Unknown or other-tenant item ⇒ 404.

### 3.3 `recordOpeningBalances(ctx, {branchId, lines: [{ref, qty}]})` — `inventory.adjust`
- `1 ≤ lines.length ≤ 500`, `1 ≤ qty ≤ 1_000_000`.
- Inside the tx, after locking: any line whose item already has **any** movement at the branch ⇒
  `CONFLICT` `OPENING_BALANCE_EXISTS` with `details.refs`. Nothing is written.
- Writes `reason OPENING_BALANCE`, `qtyDelta = qty`. The unique index catches a race (P2002 ⇒ same error).
- Audit `inventory.opening.recorded` `{branchId, lines: [{ref, qty}]}`.

### 3.4 `adjustStock(ctx, {branchId, ref, adjustmentReason, note?, qtyDelta?, countedQty?, expectedOnHand})` — `inventory.adjust`
- Exactly one of `qtyDelta` (non-zero integer) / `countedQty` (≥ 0). `countedQty` only with `COUNT_CORRECTION`.
- After locking: `expectedOnHand !== qty` ⇒ `CONFLICT` `STALE_STOCK` `{onHand}`.
- `countedQty` ⇒ `delta = countedQty - qty`; `delta = 0` ⇒ `VALIDATION_FAILED` `NO_CHANGE`.
- Direction rule (D2) ⇒ `VALIDATION_FAILED` `ADJUSTMENT_DIRECTION`. `OTHER` without note ⇒ `NOTE_REQUIRED`.
- Result `qty + delta < 0` ⇒ `INSUFFICIENT_STOCK` (always, D4).
- Audit `inventory.adjusted` `{branchId, ref, adjustmentReason, qtyDelta, before, after, note}`.
- Returns `{qty}`.

### 3.5 `transferStock(ctx, {transferId, fromBranchId, toBranchId, lines: [{ref, qty}], note?})` — `inventory.transfer`
- `requireBranch(fromBranchId)` (D6). `toBranchId` must be an **active branch of `ctx.orgId`** (else 404) and
  `≠ fromBranchId` (else `VALIDATION_FAILED` `SAME_BRANCH`). `1 ≤ lines ≤ 200`, `qty ≥ 1`.
- **Idempotency.** First, in the tx: if movements with `transferGroupId = transferId` exist in this org, return the
  original transfer (`{transferId, replayed: true, lines}`) without writing. If they exist with different
  lines/branches ⇒ `IDEMPOTENCY_CONFLICT` (409). A concurrent duplicate hits the unique index (P2002) ⇒ re-read and
  return the original.
- Writes `TRANSFER_OUT` (`-qty`, source) and `TRANSFER_IN` (`+qty`, destination) per line, same `transferGroupId`.
  Source shortfall ⇒ `INSUFFICIENT_STOCK` (always).
- Audit `inventory.transferred` `{transferId, fromBranchId, toBranchId, lines, note}` (audit row's branch = source).

## 4. Seam (exported from `modules/inventory/index.ts`)

Tx-aware; **no permission check** — the calling module has already authorised the operation. No audit rows; the
calling document (sale, receipt, refund) audits itself.

```ts
recordMovements(tx, ctx, {
  branchId,
  reason: "SALE" | "SALE_VOID" | "REFUND" | "PURCHASE_RECEIPT",
  refType: "Sale" | "Refund" | "GoodsReceipt",
  refId: string,
  lines: { ref: ItemRef; qty: number }[],   // qty > 0; sign comes from the reason
  policy: "block" | "allow",                 // only meaningful for SALE; T6 passes org.blockNegativeStock
}): Promise<{ ref: ItemRef; qty: number }[]>   // balances after, input order

getOnHand(client, orgId, branchId, refs): Promise<number[]>          // input order, missing row ⇒ 0; no lock
hasUnvariantedStock(client, orgId, productId): Promise<boolean>      // from queries.ts
reconcile(client, orgId, branchId?): Promise<Mismatch[]>             // {branchId, ref, cached, ledger}
```

`ctx.branchId` is **not** trusted for the target branch; callers pass `branchId` explicitly (already verified by
their own `requireTenant`).

## 5. Catalog change (`TODO(T4)`)

In `insertVariant` (`modules/catalog/variants.ts`), when `!product.hasVariants`:

```ts
if (await hasUnvariantedStock(tx, ctx.orgId, product.id)) throw conflict("PRODUCT_HAS_STOCK");
```

`hasUnvariantedStock` = exists a `StockBalance` row with `variantId IS NULL` and `qty <> 0` **or** any
`InventoryMovement` with `variantId IS NULL` for the product. Add `PRODUCT_HAS_STOCK` to `CatalogConflictReason`
("This product already has stock recorded without variants"). Sales lines (T6) extend the same check later.

## 6. Errors

Shared codes from `lib/errors.ts`; cause in `details.reason`.

| Code | `details.reason` | When |
|---|---|---|
| `CONFLICT` 409 | `INSUFFICIENT_STOCK` | `details.lines: [{ref, branchId, onHand, requested}]` |
| `CONFLICT` 409 | `OPENING_BALANCE_EXISTS` | `details.refs` |
| `CONFLICT` 409 | `STALE_STOCK` | `details.onHand` |
| `CONFLICT` 409 | `PRODUCT_HAS_STOCK` | catalog, switching to variants |
| `IDEMPOTENCY_CONFLICT` 409 | — | `transferId` reused with different content |
| `VALIDATION_FAILED` 422 | `ADJUSTMENT_DIRECTION`, `NOTE_REQUIRED`, `NO_CHANGE`, `SAME_BRANCH`, `DUPLICATE_LINE` | |
| `VALIDATION_FAILED` 422 | `ITEM_NOT_SELLABLE`, `VARIANT_REQUIRED` | passed through from `assertStockable` |
| `NOT_FOUND` 404 | — | branch not accessible / other tenant, unknown item, inactive destination |

## 7. Route Handlers

`handleRoute` → `requireTenant` → service (service checks permission, audits denial, validates). `no-store`.

| Route | Permission | Body / query | Success |
|---|---|---|---|
| `GET /api/inventory/stock` | `inventory.read` | `branchId, q?, filter?, cursor?, limit?` | 200 `Page<StockRow>` |
| `GET /api/inventory/ledger` | `inventory.read` | `branchId, productId, variantId?, cursor?, limit?` | 200 `{qty, page: Page<LedgerRow>}` |
| `POST /api/inventory/opening` | `inventory.adjust` | `{branchId, lines}` | 201 `{lines: [{ref, qty}]}` |
| `POST /api/inventory/adjust` | `inventory.adjust` | `{branchId, ref, adjustmentReason, note?, qtyDelta? \| countedQty?, expectedOnHand}` | 201 `{qty}` |
| `POST /api/inventory/transfer` | `inventory.transfer` | `{transferId, fromBranchId, toBranchId, lines, note?}` | 201 new / 200 replay |

## 8. Permissions

`lib/auth/permissions.ts`: add `"inventory.read"`; grant to OWNER (all), ADMIN, MANAGER, REPORTING. Cashier: none.
Update `tests/unit/permissions.test.ts` and `docs/product/user-roles-permissions.md`.

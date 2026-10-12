# Phase 10 / T5 — Purchasing: Data Model and API

Spec: [purchasing-spec.md](purchasing-spec.md). Decisions are referred to as P1–P15.

## 1. Migration `purchasing`

```sql
ALTER TABLE "Organization"  ADD COLUMN "lastPoNo" INTEGER NOT NULL DEFAULT 0;           -- P7
ALTER TABLE "PurchaseOrder" ADD COLUMN "orderedAt" TIMESTAMP(3),
                            ADD COLUMN "closedAt" TIMESTAMP(3),
                            ADD COLUMN "closeReason" TEXT;
ALTER TABLE "GoodsReceipt"  ADD COLUMN "requestHash" TEXT NOT NULL;                     -- P10 (table is empty)
```

Hand-written rules:

- `Supplier_name_unique_ci`: unique index on `("orgId", lower("name"))` (P12). CHECK name length 1–120 after trim.
- `PurchaseOrder_status_fields`: `orderedAt` is set for every status except DRAFT and CANCELLED-from-DRAFT, and
  `closedAt` is set exactly for CANCELLED and RECEIVED. `closeReason` length ≤ 500.
- `POItem_one_line_per_item`: unique `("purchaseOrderId", "productId", "variantId") NULLS NOT DISTINCT` (P8).
- `POItem_qty_valid` (exists since init) keeps `0 ≤ qtyReceived ≤ qtyOrdered`.
- `GoodsReceipt` and `GoodsReceiptItem` get the `pos_reject_mutation` append-only triggers (P14).
- Indexes: `PurchaseOrder(orgId, status, branchId)` for the list, `PurchaseOrder(orgId, supplierId)`,
  `GoodsReceipt(orgId, branchId, receivedAt)` for the report, `GoodsReceipt(orgId, purchaseOrderId)`.

Status is derived from the lines after a receipt: all lines full means RECEIVED, otherwise PARTIALLY_RECEIVED. Close
short sets RECEIVED with `closeReason` while some line is still short, which is how a short-closed PO is told apart.

## 2. Module layout (`modules/purchasing`)

| File | Role |
|---|---|
| `schemas.ts` | zod inputs: `SupplierInput`, `SupplierPatch`, `SupplierQuery`, `PoInput`, `PoPatch`, `PoQuery`, `CloseInput`, `CancelInput`, `ReceiptInput`, `IdempotencyKey`. Pure; client components import it. |
| `rules.ts` | Pure: `mergePoLines`, `outstanding`, `statusAfterReceipt`, `canEdit`, `canReceive`, `canCancel`, `canClose`, `poTotals`, `formatPoNumber`. Unit-tested. |
| `access.ts` | `requirePermission` (audit-logs `purchasing.permission.denied`), `canView`, `requireBranch`, `branchIdsInScope`. |
| `errors.ts` | `purchasingConflict(reason, …)` → 409 with `details.reason`; 422 helpers. |
| `suppliers.ts` | list, create, update, archive, restore. |
| `orders.ts` | list, get, create, update, order, cancel, close. |
| `receipts.ts` | `receivePurchaseOrder`: idempotent, one transaction. |
| `index.ts` | Barrel. |

**Catalog seam addition.** `applyReceivedCosts(tx, ctx, { receiptId, lines: [{ ref, unitCostMinor }] }, meta)` in
`modules/catalog/costs.ts`, exported from the barrel. It is tx-aware with no permission check, like the other seam
writers. For each line it updates the variant's or the product's `costMinor` when it differs, bumps `updatedAt` (so a
stale catalog editor gets its usual 409), and writes `catalog.cost.received`. The products are already locked by the
inventory call that ran before it in the same transaction.

## 3. Services

All services take `(ctx, …, meta?)`, check their own permission first (P1), then resolve the PO by `id` and `orgId` and
check the PO's branch against the caller's scope (404 outside, R5).

- `listSuppliers(ctx, query)`: needs `purchases.manage` or `purchases.receive`. Filters `q` (name, phone) and
  `includeArchived`; sorted by name.
- `createSupplier` / `updateSupplier` / `archiveSupplier` / `restoreSupplier`: need `purchases.manage`. A duplicate
  name answers 409 `SUPPLIER_NAME_TAKEN`.
- `listPurchaseOrders(ctx, query)`: a viewer. Filters `status` (`open` = ORDERED and PARTIALLY_RECEIVED, the default),
  `branchId`, `supplierId`, `q` (number). Cursor paging by `createdAt desc, id desc`, 50 per page. Each row has number,
  supplier, branch, status, line count, ordered and received units, total value, and `createdAt`/`orderedAt`.
- `getPurchaseOrder(ctx, id)`: a viewer. The PO with lines (item names and SKU through
  `catalog.getItemsForHistory`, ordered, received and outstanding quantities, unit cost, line value), the receipts
  (number of lines, units, value, by whom, when) and totals.
- `createPurchaseOrder(ctx, input)`: `purchases.manage`. Checks branch scope, an active supplier and stockable lines;
  bumps `lastPoNo` under the org row lock; writes a DRAFT with its lines.
- `updatePurchaseOrder(ctx, id, patch)`: `purchases.manage`; `canEdit` (P4). `lines`, when given, replace all lines
  (allowed because nothing has been received). The branch cannot change.
- `orderPurchaseOrder`: DRAFT → ORDERED, sets `orderedAt`. `cancelPurchaseOrder` (optional reason): DRAFT, or
  ORDERED with nothing received → CANCELLED. `closePurchaseOrder` (reason required): PARTIALLY_RECEIVED → RECEIVED.
- `receivePurchaseOrder(ctx, id, idempotencyKey, input, meta)`: `purchases.receive`.
  1. Parse; hash the canonical body; replay if the key is known (P10).
  2. Transaction: lock the PO row; re-read status and lines; `canReceive`; check every `poItemId` belongs to the PO and
     each qty ≤ outstanding (409 `QTY_EXCEEDS_OUTSTANDING` with the line and outstanding); drop zero lines; at least
     one line remains (422 `NOTHING_TO_RECEIVE`).
  3. Write the `GoodsReceipt` and its items; increment `POItem.qtyReceived`.
  4. `inventory.recordMovements(PURCHASE_RECEIPT, refType "GoodsReceipt", refId receiptId, policy "block")`.
  5. `catalog.applyReceivedCosts`.
  6. Set the status from `statusAfterReceipt`; audit `purchasing.receipt.created`.
  7. On a unique violation of the key (a concurrent duplicate), replay the winner.

## 4. Routes

| Method and path | Service | Success |
|---|---|---|
| `GET /api/purchasing/suppliers` | `listSuppliers` | 200 |
| `POST /api/purchasing/suppliers` | `createSupplier` | 201 |
| `PATCH /api/purchasing/suppliers/{id}` | `updateSupplier` | 200 |
| `POST /api/purchasing/suppliers/{id}/archive`, `/restore` | archive / restore | 200 |
| `GET /api/purchasing/pos` | `listPurchaseOrders` | 200 |
| `POST /api/purchasing/pos` | `createPurchaseOrder` | 201 |
| `GET /api/purchasing/pos/{id}` | `getPurchaseOrder` | 200 |
| `PATCH /api/purchasing/pos/{id}` | `updatePurchaseOrder` | 200 |
| `POST /api/purchasing/pos/{id}/order`, `/cancel`, `/close` | transitions | 200 |
| `POST /api/purchasing/pos/{id}/receipts` | `receivePurchaseOrder` | 201 new · 200 replay |
| `GET /api/reports/purchases` | reports framework | 200 |

Write routes leave the permission check to the service, so a refused attempt is audited (as in catalog).

## 5. Errors

| Status | Code / `details.reason` | When |
|---|---|---|
| 403 | `FORBIDDEN` | Missing permission (audited). |
| 404 | `NOT_FOUND` | Unknown, other-org or out-of-scope PO, supplier, branch or item. |
| 409 | `CONFLICT` / `PO_NOT_EDITABLE` | Edit after the first receipt, or of a closed or cancelled PO. |
| 409 | `CONFLICT` / `PO_NOT_RECEIVABLE` | Receive from DRAFT, RECEIVED or CANCELLED. |
| 409 | `CONFLICT` / `PO_BAD_TRANSITION` | Order, cancel or close from the wrong state. |
| 409 | `CONFLICT` / `QTY_EXCEEDS_OUTSTANDING` | A receipt line above what is outstanding. |
| 409 | `CONFLICT` / `SUPPLIER_INACTIVE` | A new PO, or a supplier change, to an archived supplier. |
| 409 | `CONFLICT` / `SUPPLIER_NAME_TAKEN` | Duplicate supplier name. |
| 409 | `IDEMPOTENCY_CONFLICT` | The same key with a different receipt body. |
| 422 | `VALIDATION_FAILED` / `NOTHING_TO_RECEIVE`, `ITEM_NOT_SELLABLE`, `AMOUNT_TOO_LARGE`, zod issues | Bad input. |

## 6. Report `purchases`

Added to `REPORT_NAMES` and `REPORT_COLUMNS`. Rows: local day of `receivedAt`, supplier name, receipts (count), units
(Σ qty) and value (Σ qty × unit cost), over the branches in scope, sorted by day then supplier. Access needs
`reports.view` and `purchases.manage` (P5); a missing grant answers 403 with `reports.permission.denied`. The report is
hidden from the picker for users who cannot run it.

# Receiving without a PO — Specification and as-built note

Status: **built 2026-10-22, every choice taken as recommended (rec).** Builds on
[purchasing-spec.md](../phase-10/purchasing-spec.md) (P1–P15) and closes the known limitation "No receiving without a
PO".

## 1. Goal

A user with `purchases.receive` records goods that arrived from a supplier with no purchase order: supplier, branch,
lines of product or variant, quantity and unit cost. Stock goes in through the inventory ledger and each item's last cost
is set through the catalog seam, in one transaction, exactly like receiving against a PO.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Data model | A direct receipt is an ordinary `GoodsReceipt` with `purchaseOrderId` null; its lines have `poItemId` null. No new table: the receipt rows, append-only trigger, Idempotency-Key index and every reader stay shared. **(rec)** |
| D2 | Supplier | `GoodsReceipt.supplierId` (new, required) holds the supplier: the PO's supplier for a PO receipt (backfilled by the migration), the chosen supplier for a direct one. It must be active. Input has the same shape as a new PO (`branchId`, `supplierId`, `note`, `lines`), so repeated items merge (P8) and only stockable items are accepted. **(rec)** |
| D3 | Who | `purchases.receive` (Owner, Admin, Manager), a branch in the caller's scope; refused for a shop whose stock is sourced from the inventory system (409 `MANAGED_BY_INVENTORY`, the existing purchasing write guard). Refusals are audited like PO receiving. **(rec)** |
| D4 | Effect | One transaction: receipt rows → `recordMovements` (`PURCHASE_RECEIPT`, `refType "GoodsReceipt"`) → `applyReceivedCosts` → audit `purchasing.receipt.created` with `direct: true`. The same `postReceipt` helper serves PO receipts. **(rec)** |
| D5 | Number | No counter: shown as `GR-` and the first 8 hex digits of the receipt id (`formatDirectReceiptNumber`). **(rec)** |
| D6 | Where it shows | Purchases received report, supplier balances, supplier statement and the uninvoiced receipts a supplier invoice can cover — all read `GoodsReceipt.supplierId` now, so direct receipts count with no special case. **(rec)** |
| D7 | Screens | `/purchasing/receive` (the PO editor in "receive now" mode, linked as **Receive without PO** on the purchasing list) and a **Direct receipts** section on the purchasing list (latest 50 in the caller's branches). **(rec)** |
| D8 | Idempotency | One key per form, kept across retries; the same key and body replay the first receipt, another body answers 409 `IDEMPOTENCY_CONFLICT`. Concurrent duplicates resolve to one receipt via the unique key index. **(rec)** |

## 3. Not built

- Purchase returns stay PO-only (purchase-returns-spec R1): goods from a direct receipt are corrected with a stock
  adjustment.
- No REST route and no detail page for a direct receipt: the server action and the list are the only surfaces.
- No gap-free direct-receipt numbers (D5).

## 4. As built

- Migration `20261022062822_direct_receipts`: `GoodsReceipt.supplierId` (backfilled, then NOT NULL, FK to Supplier),
  `purchaseOrderId` and `GoodsReceiptItem.poItemId` nullable. Prisma's drop of the hand-written `POItem_one_line_per_item`
  index was removed.
- `modules/purchasing/receipts.ts`: `receiveWithoutPo`, `listDirectReceipts`; PO receiving now shares `postReceipt` and
  the replay/race helper.
- Tests: `tests/integration/direct-receipts.test.ts`, `tests/e2e/direct-receipts.spec.ts`.

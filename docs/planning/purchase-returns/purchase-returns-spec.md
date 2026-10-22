# Purchase returns — Specification

Status: **approved by the owner 2026-10-19.** The owner asked that every choice be taken as recommended; those are
marked **(rec)** and can still be overridden. Builds on [purchasing-spec.md](../phase-10/purchasing-spec.md) (P1–P15)
and the inventory ledger.

## 1. Goal

An owner or admin sends goods that were received on a purchase order back to the supplier: damaged, faulty, the wrong
item, expired. The return takes the stock out of the PO's branch through the ledger in one transaction, prints as an A4
document to hand to the supplier, and shows in the **Purchases received** report so the received value is net of
returns.

Out of scope: supplier credit notes, refunds or balances, returns without a PO (later built for direct receipts:
[direct-receipt-returns-spec.md](direct-receipt-returns-spec.md)), exchanging goods on the same PO
(raise a new PO for replacements), editing or cancelling a return.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| R1 | What can be returned | Only goods received on a PO. Per PO line, `0 ≤ qty ≤ qtyReceived − qtyReturned`; at least one line > 0. Any PO with something still returnable (PARTIALLY_RECEIVED or RECEIVED, closed short included). No free-form returns. **(rec)** |
| R2 | Effect on the PO | `POItem.qtyReturned` goes up. `qtyReceived`, outstanding and the PO status do not change: a return does not reopen the line. Replacements come on a new PO. **(rec)** |
| R3 | Stock | Through the inventory seam `recordMovements` with the new reason `PURCHASE_RETURN` (negative rows), `refType "PurchaseReturn"`, `refId` the return. Negative stock follows the shop's `blockNegativeStock` setting, as for a sale (block → 409 `INSUFFICIENT_STOCK`). Archived items can be returned: a return only removes stock, like a write-off. **(rec)** |
| R4 | Value | Each return line is valued at the PO line's unit cost (`POItem.unitCostMinor`), stored on the return line. The item's last cost is not changed. **(rec)** |
| R5 | Reason | One reason per return: `DAMAGED`, `DEFECTIVE`, `WRONG_ITEM`, `EXPIRED`, `OTHER`, plus an optional note (≤ 500 characters). **(rec)** |
| R6 | Who | `purchases.manage` (Owner, Admin), branch-scoped like every PO write. Viewing the return follows PO viewing (either purchasing permission). Refused for a shop linked to the inventory system (integration spec I18) with 409 `MANAGED_BY_INVENTORY`, by the purchasing write guard and again by the ledger. **(rec)** |
| R7 | Idempotency | `POST /api/purchasing/pos/{poId}/returns` requires an `Idempotency-Key`. The same key and body replay the first return (200); the same key with another body answers 409 `IDEMPOTENCY_CONFLICT`. Stored as `PurchaseReturn.requestHash`, like receipts (P10). **(rec)** |
| R8 | Concurrency | The return locks the PO row (P11) and re-reads received and returned quantities under the lock, so two returns racing for the same units cannot both pass. A DB CHECK keeps `0 ≤ qtyReturned ≤ qtyReceived`. **(rec)** |
| R9 | Number | Per PO: `PO-000123-R1`, `-R2`, … (`PurchaseReturn.seq`, unique per PO, taken under the PO lock). No org counter needed. **(rec)** |
| R10 | History | `PurchaseReturn` and `PurchaseReturnItem` are append-only (DB trigger), like receipts (P14). A mistaken return is corrected with a stock adjustment. **(rec)** |
| R11 | Audit | `purchasing.return.created` (PO, number, reason, lines, units, value). Refusals write `purchasing.permission.denied` with `entityType "PurchaseReturn"`. **(rec)** |
| R12 | Report | **Purchases received** keeps one row per local day and supplier and gains three columns: *Returned units*, *Returned value* and *Net value* (received − returned). Recommended over negative rows: the receipts count and received units keep their meaning, totals stay simple, and the CSV keeps one row per day and supplier. A day with only returns shows a row with zero received. Returns count on their own date. **(rec)** |
| R13 | Screens | PO page: a **Return to supplier** button (purchases.manage, when something is returnable), a *Returned* column on the lines, and a list of returns linking to each one. Return form at `/purchasing/{poId}/return`: returnable lines, quantities (start at 0), reason, note. Return page at `/purchasing/{poId}/returns/{returnId}` with an A4 print like the PO print. EN/AR, RTL. **(rec)** |

## 3. Data

- `enum MovementReason` + `PURCHASE_RETURN`; `enum PurchaseReturnReason`.
- `POItem.qtyReturned Int @default(0)`, CHECK `0 ≤ qtyReturned ≤ qtyReceived`.
- `PurchaseReturn` (orgId, branchId, purchaseOrderId, seq, reason, note, idempotencyKey, requestHash, returnedById,
  returnedAt); unique (orgId, idempotencyKey) and (orgId, purchaseOrderId, seq).
- `PurchaseReturnItem` (purchaseReturnId, poItemId, productId, variantId, qty, unitCostMinor).
- One migration; append-only triggers on both new tables. The ledger's `InventoryMovement_reason_direction` CHECK is
  re-created with `PURCHASE_RETURN` among the decreasing reasons.

## 4. API

`POST /api/purchasing/pos/{poId}/returns` body `{ reason, note?, lines: [{ poItemId, qty }] }` → 201
`{ returnId, purchaseOrder }`, 200 on replay. Errors: 404 (PO or line not in scope), 409 `QTY_EXCEEDS_RETURNABLE`
(`details.returnable`), 409 `INSUFFICIENT_STOCK`, 422 `NOTHING_TO_RETURN`, 403 (permission), 409 `MANAGED_BY_INVENTORY` (linked shop). The PO
detail (`GET /api/purchasing/pos/{poId}`) lists the returns and each line's `qtyReturned` and `returnable`.

## 5. Tests

- Unit: returnable quantity and the return-number format.
- Integration: a return removes stock, writes the ledger and audit, values at PO cost and leaves last cost alone;
  over-return refused (also across two returns); concurrent returns of the last units (one wins); idempotent replay
  and key conflict; negative stock blocked or allowed by the shop setting; manager refused (audited); linked shop
  refused; another org's or branch's PO answers 404; the report shows returned and net value.
- E2E: receive a PO, return part of it, see the stock and the return page with its print.

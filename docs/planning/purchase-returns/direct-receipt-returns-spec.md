# Returns against a direct receipt — Specification addendum

Status: **approved by the owner 2026-10-22, every choice taken as recommended (rec).** Extends
[purchase-returns-spec.md](purchase-returns-spec.md) (R1–R13) to goods received without a PO
([direct-receipt-spec.md](../purchasing-direct-receipt/direct-receipt-spec.md), D1–D8), and closes its §3 "Purchase
returns stay PO-only".

## 1. Goal

An owner or admin sends goods from a direct receipt back to the supplier with the same rules, document and effects as
a PO return: stock out through the ledger, the supplier's balance goes down, a supplier credit note can cover it (input
VAT, supplier-invoices-spec I4), and the purchases report nets it. Still no returns without any receipt.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| DR1 | What can be returned | Only lines of a direct receipt (`GoodsReceipt.purchaseOrderId` null). Per receipt line, `0 ≤ qty ≤ qtyReceived − returned so far`; at least one line > 0. A PO's goods keep going back through the PO (R1). **(rec)** |
| DR2 | Data model | The same `PurchaseReturn` / `PurchaseReturnItem` tables: a return points at a PO (`purchaseOrderId`, lines `poItemId`) **or** a direct receipt (`goodsReceiptId`, lines `goodsReceiptItemId`), exactly one, by DB CHECK. Every reader, trigger and key index stays shared. **(rec)** |
| DR3 | Supplier | `PurchaseReturn.supplierId` (new, required; backfilled from the PO), like `GoodsReceipt.supplierId` (D2), so the supplier account and both reports read returns by supplier with no special case. **(rec)** |
| DR4 | Returned so far | Summed from the return lines of that receipt line: receipt rows are append-only (P14), so no counter column. The return locks the receipt row and re-sums under the lock (R8), so two returns racing for the same units cannot both pass. **(rec)** |
| DR5 | Stock, value, reason | As R3–R5: `recordMovements` with `PURCHASE_RETURN`, `refType "PurchaseReturn"`, the shop's negative-stock rule; valued at the receipt line's unit cost; last cost unchanged; one reason and an optional note. **(rec)** |
| DR6 | Who | As R6: `purchases.manage`, the receipt's branch in the caller's scope, refused for a linked shop (409 `MANAGED_BY_INVENTORY`). Viewing needs either purchasing permission. Refusals audited. **(rec)** |
| DR7 | Idempotency | As R7: one key per form in the same key index; the request hash includes the receipt id. **(rec)** |
| DR8 | Number | `GR-1A2B3C4D-R1`, `-R2`, … : the receipt number (D5) and a `seq` per receipt taken under the receipt lock; unique (orgId, goodsReceiptId, seq). **(rec)** |
| DR9 | History and audit | Append-only (R10). `purchasing.return.created` with `direct: true`, `goodsReceiptId`, number, reason, lines, units, value (R11). **(rec)** |
| DR10 | Supplier account | Exactly as a PO return: a `RETURN` entry on the balance and statement; listed among the returns a credit note can link (I4, one live credit note per return); input VAT through that credit note. Supplier balances and the purchases report's *Returned* / *Net* columns include it. **(rec)** |
| DR11 | Screens | New direct receipt page `/purchasing/receipts/{receiptId}` (lines with received, returned, cost; returns list; **Return to supplier** for purchases.manage when something is returnable), linked from the Direct receipts list. Return form `/purchasing/receipts/{receiptId}/return`, return page `…/returns/{returnId}` with the same A4 print. EN/AR, RTL. **(rec)** |
| DR12 | API | No REST route, like direct receipts (D, §3): a server action over `returnDirectReceipt`. **(rec)** |

## 3. Data

- `PurchaseReturn`: `supplierId` (NOT NULL, FK, backfilled), `purchaseOrderId` nullable, `goodsReceiptId` (FK);
  unique (orgId, goodsReceiptId, seq); CHECK one source.
- `PurchaseReturnItem`: `poItemId` nullable, `goodsReceiptItemId` (FK, indexed); CHECK one source.
- One migration; Prisma's drop of `POItem_one_line_per_item` removed.

## 4. Tests

- Unit: the direct return number.
- Integration: stock, ledger, audit, receipt cost, last cost alone; over-return across two returns; concurrent returns
  of the last units; replay and key conflict; PO receipt refused; manager refused (audited); linked shop refused;
  another branch answers 404; balance, statement, credit note and both reports include it.
- E2E: receive without a PO, return part of it from the receipt page, see the return page and its print.

## 5. As built

- Migration `20261022150500_direct_receipt_returns`: `PurchaseReturn.supplierId` (backfilled, NOT NULL, FK),
  `goodsReceiptId`, nullable `purchaseOrderId`; `PurchaseReturnItem.goodsReceiptItemId`, nullable `poItemId`;
  `GoodsReceiptItem` unique (orgId, id) for the FK; CHECKs `PurchaseReturn_one_source`, `PurchaseReturnItem_one_source`.
  Prisma's drop of `POItem_one_line_per_item` removed.
- `modules/purchasing/returns.ts`: `returnDirectReceipt`, `getDirectReturn`; PO and direct returns share `postReturn`
  and the replay/race helper. `modules/purchasing/receipts.ts`: `getDirectReceipt`. The supplier account and both
  reports read `PurchaseReturn.supplierId`.
- A PO return's `QTY_EXCEEDS_RETURNABLE` details now name the line as `lineId` (was `poItemId`).
- Tests: `tests/integration/direct-receipt-returns.test.ts`, `tests/e2e/direct-receipt-returns.spec.ts`.

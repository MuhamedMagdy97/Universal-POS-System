# Database Design (MVP)

## Tables
Organization, Branch, Register, User, Membership (`UNIQUE(orgId,userId)`),
Category, Product (`UNIQUE(orgId,sku)`), ProductVariant, Barcode
(`UNIQUE(orgId,code)`), StockBalance (`UNIQUE(orgId,branchId,productId,variantId)`),
InventoryMovement (append-only ledger, `transferGroupId` pairs transfers),
Supplier, PurchaseOrder, POItem, GoodsReceipt, Sale (`UNIQUE(orgId,idempotencyKey)`),
SaleItem (snapshots), Payment (split tender rows), Refund + RefundItem,
RegisterShift (open→closed immutable), CashMovement, AuditEvent (append-only).

## Excluded in MVP
Customer, PriceList, Loyalty, Recipe, Tables — deferred per scope.

## Invariants
Ledger insert-only; balances reconciled; snapshots preserve history;
idempotency on sales; block-negative-stock default. Full spec: Phase 4 report.

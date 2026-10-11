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

## Catalog hardening (Phase 6, migration `*_catalog_hardening`)

Additive on top of the init migration. Design: [catalog-data-model.md](../planning/phase-6/catalog-data-model.md).

- **Archive, not delete.** Products, variants and categories are archived (`isActive=false`); archived SKUs and
  barcodes stay reserved. Barcodes are the only catalog rows that are hard-deleted (sales snapshot the SKU, not the code).
- **`Product.hasVariants`** (backfilled from existing variants). Set when the first variant is created and not cleared
  by archiving, so the variant rule ("stock/sale lines name a variant iff `hasVariants`") is O(1).
  `ProductVariant.sortOrder` and `Category.sortOrder` added.
- **VAT.** `Product.vatCategory` (`STANDARD | ZERO_RATED | EXEMPT`; backfill: `vatApplicable=false` → `ZERO_RATED`).
  `vatApplicable` is kept and derived, enforced by CHECK `Product_vatApplicable_matches_category`
  (`vatApplicable = (vatCategory = 'STANDARD')`). The rate is never on the product: checkout uses
  `Organization.vatRateBp`.
- **`Organization.pricesIncludeVat`** (default `true`): shelf prices are VAT-inclusive unless the org says otherwise.
  Nothing reads it yet; checkout (T6) will.
- **Barcode → variant.** `ProductVariant UNIQUE(orgId, productId, id)` plus FK
  `Barcode(orgId, productId, variantId) → ProductVariant(orgId, productId, id)`: a barcode's variant must belong to the
  barcode's product. A NULL `variantId` skips the check (MATCH SIMPLE). `Barcode.updatedAt` and
  `@@index([orgId, productId])` added.
- **Primary barcode.** `Barcode.isPrimary` with partial unique index `Barcode_one_primary_per_item` on
  `(orgId, productId, variantId) NULLS NOT DISTINCT WHERE isPrimary`: at most one primary per product or per variant.
  Rule (being implemented in parallel with these docs): an item's first barcode becomes primary automatically, and
  removing the primary promotes the next one. Setting `isPrimary` on a new barcode demotes the previous primary in the
  same transaction; a concurrent clash surfaces as 409 `PRIMARY_BARCODE_TAKEN`.
- **Category names.** `Category_sibling_name_key` unique on `(orgId, parentId, lower(name)) NULLS NOT DISTINCT`: unique
  among *all* siblings (archived included), case-insensitive; two roots cannot share a name. Depth ≤ 3 and no cycles
  are service-enforced.
- **SKU format.** CHECK `sku = upper(btrim(sku))` and length 1–64 on `Product` and `ProductVariant`; services
  upper-case on write.
- **One SKU namespace.** Trigger function `pos_guard_sku_namespace` (BEFORE INSERT/UPDATE OF `sku`, `orgId` on both
  tables) takes a per-(org, sku) advisory lock and raises `unique_violation` with constraint name `sku_namespace` if
  the other table already has the SKU. Services map it to 409 `SKU_TAKEN`.
- **Other CHECKs.** `Barcode_code_format` (printable ASCII, 1–64), `Product_name_nonblank`.
- Pre-flight for databases that already hold catalog data: `prisma/sql/catalog-hardening-preflight.sql`.

## Inventory (Phase 7, migration `*_inventory`)

Additive on the init migration. Design: [inventory-data-model.md](../planning/phase-7/inventory-data-model.md).
As built: [inventory-as-built.md](../planning/phase-7/inventory-as-built.md).

- **`AdjustmentReason` enum** and `InventoryMovement.adjustmentReason`, set exactly for `ADJUSTMENT` rows (CHECK
  `InventoryMovement_adjustment_reason_present`).
- **Sign rules.** `InventoryMovement_adjustment_direction`: `DAMAGED`, `EXPIRED`, `LOST_OR_STOLEN` only decrease;
  `FOUND` only increases; `COUNT_CORRECTION` and `OTHER` go either way. `InventoryMovement_reason_direction`: inflow
  reasons are positive, `SALE` and `TRANSFER_OUT` negative, `ADJUSTMENT` either way.
- **Notes.** `InventoryMovement_other_needs_note` (a non-blank note for `OTHER`); `InventoryMovement_note_length` (≤ 500).
- **Transfers.** `InventoryMovement_group_only_on_transfer` (a `transferGroupId` only on `TRANSFER_OUT`/`TRANSFER_IN`).
  The existing `InventoryMovement_transfer_grouped` CHECK requires one on transfers. Partial unique index
  `InventoryMovement_transfer_line_once` on `(orgId, transferGroupId, reason, productId, variantId) NULLS NOT DISTINCT`
  makes a retried transfer apply once.
- **One opening balance.** Partial unique index `InventoryMovement_one_opening_balance` on
  `(orgId, branchId, productId, variantId) NULLS NOT DISTINCT WHERE reason = 'OPENING_BALANCE'`.
- **Balance lookup.** `StockBalance_orgId_branchId_idx` for the stock list.
- **No `qty ≥ 0` CHECK on `StockBalance`:** `policy: "allow"` sales may oversell by design. The ledger stays append-only
  (existing triggers); `reconcile()` compares the cache with `SUM(qtyDelta)`.
- Pre-flight for databases that already hold ledger rows: `scripts/preflight-inventory.sql`.

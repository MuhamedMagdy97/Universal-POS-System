# Phase 7 / T4 — Inventory Data Model

Part of [inventory-spec.md](inventory-spec.md). One additive migration: `prisma/migrations/<ts>_inventory/`
(`prisma migrate dev --create-only`, then hand-written SQL for CHECKs and partial indexes, as in `_catalog_hardening`).

## 1. Existing (init migration) — unchanged

- `StockBalance(orgId, branchId, productId, variantId?, qty Int default 0, updatedAt)`,
  unique `(orgId, branchId, productId, variantId) NULLS NOT DISTINCT`, composite tenant FKs.
- `InventoryMovement(orgId, branchId, productId, variantId?, qtyDelta, reason MovementReason, refType?, refId?,
  transferGroupId?, note?, actorUserId, createdAt)`.
  - CHECK `InventoryMovement_qtyDelta_nonzero` (`qtyDelta <> 0`).
  - CHECK `InventoryMovement_transfer_grouped` (transfer rows need `transferGroupId`).
  - Triggers reject UPDATE, DELETE, TRUNCATE.
  - Indexes `(orgId, branchId, productId, variantId, createdAt)`, `(orgId, refType, refId)`, `(orgId, transferGroupId)`.
- `Organization.blockNegativeStock Boolean default true`.

## 2. Schema changes

```prisma
enum AdjustmentReason {
  DAMAGED
  EXPIRED
  LOST_OR_STOLEN
  COUNT_CORRECTION
  FOUND
  OTHER
}

model InventoryMovement {
  // … existing fields …
  adjustmentReason AdjustmentReason?
}

model StockBalance {
  // … existing fields …
  @@index([orgId, branchId])
}
```

## 3. Hand-written SQL

```sql
-- Sub-reason present exactly for adjustments.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_adjustment_reason_present"
  CHECK (("reason" = 'ADJUSTMENT') = ("adjustmentReason" IS NOT NULL));

-- Direction rules (D2).
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_adjustment_direction"
  CHECK ("adjustmentReason" IS NULL
         OR ("adjustmentReason" IN ('DAMAGED', 'EXPIRED', 'LOST_OR_STOLEN') AND "qtyDelta" < 0)
         OR ("adjustmentReason" = 'FOUND' AND "qtyDelta" > 0)
         OR "adjustmentReason" IN ('COUNT_CORRECTION', 'OTHER'));

-- OTHER needs an explanation.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_other_needs_note"
  CHECK ("adjustmentReason" IS DISTINCT FROM 'OTHER' OR length(trim(coalesce("note", ''))) > 0);

-- Note length cap (UI limit 500).
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_note_length"
  CHECK ("note" IS NULL OR length("note") <= 500);

-- Direction per document reason: inflows positive, outflows negative.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_reason_direction"
  CHECK (("reason" IN ('OPENING_BALANCE', 'SALE_VOID', 'REFUND', 'PURCHASE_RECEIPT', 'TRANSFER_IN') AND "qtyDelta" > 0)
      OR ("reason" IN ('SALE', 'TRANSFER_OUT') AND "qtyDelta" < 0)
      OR "reason" = 'ADJUSTMENT');

-- Non-transfer rows carry no transferGroupId (the existing CHECK covers the other direction).
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_group_only_on_transfer"
  CHECK ("reason" IN ('TRANSFER_OUT', 'TRANSFER_IN') OR "transferGroupId" IS NULL);

-- One opening balance per item × branch (D3). The service also requires "no prior rows".
CREATE UNIQUE INDEX "InventoryMovement_one_opening_balance"
  ON "InventoryMovement"("orgId", "branchId", "productId", "variantId") NULLS NOT DISTINCT
  WHERE "reason" = 'OPENING_BALANCE';

-- Transfer idempotency (I-7): a transferGroupId is used once per side, per item.
CREATE UNIQUE INDEX "InventoryMovement_transfer_line_once"
  ON "InventoryMovement"("orgId", "transferGroupId", "reason", "productId", "variantId") NULLS NOT DISTINCT
  WHERE "transferGroupId" IS NOT NULL;
```

Notes:
- A transfer may list the same item only once (service rejects duplicates with `DUPLICATE_LINE`), so the
  transfer index is a true "applied once" guard: a retried `transferId` hits P2002 and the service returns the
  original transfer (see API part §3.5).
- No `StockBalance.qty >= 0` CHECK: `policy: "allow"` sales may go negative (D4).
- The same-branch rule for transfers is service-only (the OUT and IN rows can't see each other in a CHECK).
- `refType` values used from T5 on: `"Sale"`, `"Refund"`, `"GoodsReceipt"`. T4 itself writes `refType = NULL`.

## 4. Pre-flight

Dev databases may hold movements from manual testing. The migration's CHECKs would fail on bad rows, so ship
`scripts/preflight-inventory.sql` that lists rows violating each new CHECK/index. Expected result on `pos_dev`,
`pos_test` and the E2E DB: zero rows (nothing writes the ledger before T4).

## 5. Constraint tests

New `tests/integration/inventory-constraints.test.ts` (catalog has its own `catalog-constraints.test.ts`): one
rejected insert per new CHECK and index, plus a cross-tenant FK failure for `StockBalance` and `InventoryMovement`
(variant from another org).

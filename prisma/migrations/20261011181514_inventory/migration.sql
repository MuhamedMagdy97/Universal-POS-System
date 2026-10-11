-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('DAMAGED', 'EXPIRED', 'LOST_OR_STOLEN', 'COUNT_CORRECTION', 'FOUND', 'OTHER');

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "adjustmentReason" "AdjustmentReason";

-- CreateIndex
CREATE INDEX "StockBalance_orgId_branchId_idx" ON "StockBalance"("orgId", "branchId");

-- ── Inventory rules (inventory-data-model.md §3) ──

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

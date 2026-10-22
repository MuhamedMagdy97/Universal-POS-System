-- Receiving without a PO (docs/planning/purchasing-direct-receipt/direct-receipt-spec.md D1, D2).
-- Hand-trimmed: Prisma's DROP INDEX "POItem_one_line_per_item" removed (hand-written partial index).

-- AlterTable: supplier on the receipt itself, backfilled from the PO for existing receipts.
ALTER TABLE "GoodsReceipt" ADD COLUMN "supplierId" UUID,
ALTER COLUMN "purchaseOrderId" DROP NOT NULL;

-- GoodsReceipt is append-only: lift the trigger for this one-off backfill only (same transaction).
ALTER TABLE "GoodsReceipt" DISABLE TRIGGER "GoodsReceipt_append_only";
UPDATE "GoodsReceipt" g SET "supplierId" = p."supplierId"
FROM "PurchaseOrder" p WHERE p."orgId" = g."orgId" AND p."id" = g."purchaseOrderId";
ALTER TABLE "GoodsReceipt" ENABLE TRIGGER "GoodsReceipt_append_only";

ALTER TABLE "GoodsReceipt" ALTER COLUMN "supplierId" SET NOT NULL;

-- AlterTable
ALTER TABLE "GoodsReceiptItem" ALTER COLUMN "poItemId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "GoodsReceipt_orgId_supplierId_idx" ON "GoodsReceipt"("orgId", "supplierId");

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orgId_supplierId_fkey" FOREIGN KEY ("orgId", "supplierId") REFERENCES "Supplier"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

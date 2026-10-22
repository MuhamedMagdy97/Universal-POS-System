-- Returns against a direct receipt (docs/planning/purchase-returns/direct-receipt-returns-spec.md DR2, DR3, DR8).
-- Hand-trimmed: Prisma's DROP INDEX "POItem_one_line_per_item" removed (hand-written partial index).

-- AlterTable: supplier on the return itself, backfilled from the PO for existing returns (DR3).
ALTER TABLE "PurchaseReturn" ADD COLUMN "goodsReceiptId" UUID,
ADD COLUMN "supplierId" UUID,
ALTER COLUMN "purchaseOrderId" DROP NOT NULL;

UPDATE "PurchaseReturn" r SET "supplierId" = p."supplierId"
FROM "PurchaseOrder" p WHERE p."orgId" = r."orgId" AND p."id" = r."purchaseOrderId";

ALTER TABLE "PurchaseReturn" ALTER COLUMN "supplierId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PurchaseReturnItem" ADD COLUMN "goodsReceiptItemId" UUID,
ALTER COLUMN "poItemId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptItem_orgId_id_key" ON "GoodsReceiptItem"("orgId", "id");

-- CreateIndex
CREATE INDEX "PurchaseReturn_orgId_supplierId_idx" ON "PurchaseReturn"("orgId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_orgId_goodsReceiptId_seq_key" ON "PurchaseReturn"("orgId", "goodsReceiptId", "seq");

-- CreateIndex
CREATE INDEX "PurchaseReturnItem_orgId_goodsReceiptItemId_idx" ON "PurchaseReturnItem"("orgId", "goodsReceiptItemId");

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_orgId_supplierId_fkey" FOREIGN KEY ("orgId", "supplierId") REFERENCES "Supplier"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_orgId_goodsReceiptId_fkey" FOREIGN KEY ("orgId", "goodsReceiptId") REFERENCES "GoodsReceipt"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_orgId_goodsReceiptItemId_fkey" FOREIGN KEY ("orgId", "goodsReceiptItemId") REFERENCES "GoodsReceiptItem"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A return goes back against exactly one source: a PO or a direct receipt, and its lines match (DR2).
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_one_source"
  CHECK (("purchaseOrderId" IS NULL) <> ("goodsReceiptId" IS NULL));
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_one_source"
  CHECK (("poItemId" IS NULL) <> ("goodsReceiptItemId" IS NULL));

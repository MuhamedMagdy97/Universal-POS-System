/*
  Warnings:

  - Added the required column `requestHash` to the `GoodsReceipt` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "requestHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "lastPoNo" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "orderedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "GoodsReceipt_orgId_branchId_receivedAt_idx" ON "GoodsReceipt"("orgId", "branchId", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceipt_orgId_purchaseOrderId_idx" ON "GoodsReceipt"("orgId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_orgId_status_branchId_idx" ON "PurchaseOrder"("orgId", "status", "branchId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_orgId_supplierId_idx" ON "PurchaseOrder"("orgId", "supplierId");

-- ── Purchasing rules (phase-10/purchasing-data-model-and-api.md §1) ──

-- Supplier names are unique per org ignoring case, and never blank (P12).
CREATE UNIQUE INDEX "Supplier_name_unique_ci" ON "Supplier"("orgId", lower("name"));
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_name_length"
  CHECK (length(trim("name")) BETWEEN 1 AND 120);

-- Status and dates agree: a draft was never ordered; ordered states carry orderedAt; only closed states carry closedAt.
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_status_fields"
  CHECK (("status" <> 'DRAFT' OR "orderedAt" IS NULL)
     AND ("status" NOT IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED') OR "orderedAt" IS NOT NULL)
     AND (("status" IN ('CANCELLED', 'RECEIVED')) = ("closedAt" IS NOT NULL)));
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_text_length"
  CHECK (("note" IS NULL OR length("note") <= 500) AND ("closeReason" IS NULL OR length("closeReason") <= 500));

-- One line per item on a PO (P8).
CREATE UNIQUE INDEX "POItem_one_line_per_item"
  ON "POItem"("purchaseOrderId", "productId", "variantId") NULLS NOT DISTINCT;

-- Receipts are history (P14).
CREATE TRIGGER "GoodsReceipt_append_only" BEFORE UPDATE OR DELETE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "GoodsReceiptItem_append_only" BEFORE UPDATE OR DELETE ON "GoodsReceiptItem"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();

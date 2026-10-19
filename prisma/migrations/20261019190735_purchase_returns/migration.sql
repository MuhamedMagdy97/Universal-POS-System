-- Purchase returns (docs/planning/purchase-returns/purchase-returns-spec.md). `migrate dev` also proposes
-- dropping "POItem_one_line_per_item" (an index Prisma does not model); that line is removed.

-- CreateEnum
CREATE TYPE "PurchaseReturnReason" AS ENUM ('DAMAGED', 'DEFECTIVE', 'WRONG_ITEM', 'EXPIRED', 'OTHER');

-- AlterEnum
ALTER TYPE "MovementReason" ADD VALUE 'PURCHASE_RETURN';

-- AlterTable
ALTER TABLE "POItem" ADD COLUMN     "qtyReturned" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PurchaseReturn" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "reason" "PurchaseReturnReason" NOT NULL,
    "note" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "returnedById" UUID NOT NULL,
    "returnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturnItem" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "purchaseReturnId" UUID NOT NULL,
    "poItemId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "qty" INTEGER NOT NULL,
    "unitCostMinor" INTEGER NOT NULL,

    CONSTRAINT "PurchaseReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseReturn_orgId_branchId_returnedAt_idx" ON "PurchaseReturn"("orgId", "branchId", "returnedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_orgId_id_key" ON "PurchaseReturn"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_orgId_idempotencyKey_key" ON "PurchaseReturn"("orgId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_orgId_purchaseOrderId_seq_key" ON "PurchaseReturn"("orgId", "purchaseOrderId", "seq");

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_orgId_purchaseOrderId_fkey" FOREIGN KEY ("orgId", "purchaseOrderId") REFERENCES "PurchaseOrder"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_orgId_purchaseReturnId_fkey" FOREIGN KEY ("orgId", "purchaseReturnId") REFERENCES "PurchaseReturn"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_orgId_poItemId_fkey" FOREIGN KEY ("orgId", "poItemId") REFERENCES "POItem"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Purchase return rules (purchase-returns-spec §2) ──

-- Never more back than was received (R1, R8).
ALTER TABLE "POItem" ADD CONSTRAINT "POItem_qty_returned"
  CHECK ("qtyReturned" >= 0 AND "qtyReturned" <= "qtyReceived");
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_fields"
  CHECK ("seq" >= 1 AND ("note" IS NULL OR length("note") <= 500));
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_fields"
  CHECK ("qty" >= 1 AND "unitCostMinor" >= 0);

-- Returns are history (R10).
CREATE TRIGGER "PurchaseReturn_append_only" BEFORE UPDATE OR DELETE ON "PurchaseReturn"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "PurchaseReturnItem_append_only" BEFORE UPDATE OR DELETE ON "PurchaseReturnItem"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();

-- A purchase return only takes stock out (R3). Same rule as before, plus PURCHASE_RETURN < 0.
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_reason_direction";
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_reason_direction"
  CHECK (("reason" IN ('OPENING_BALANCE', 'SALE_VOID', 'REFUND', 'PURCHASE_RECEIPT', 'TRANSFER_IN') AND "qtyDelta" > 0)
      OR ("reason" IN ('SALE', 'TRANSFER_OUT', 'PURCHASE_RETURN') AND "qtyDelta" < 0)
      OR "reason" = 'ADJUSTMENT');

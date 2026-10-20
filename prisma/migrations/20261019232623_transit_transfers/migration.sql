-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('SENT', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "fromBranchId" UUID NOT NULL,
    "toBranchId" UUID NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'SENT',
    "note" TEXT,
    "sentByUserId" UUID NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedByUserId" UUID,
    "receivedAt" TIMESTAMP(3),
    "receiveKey" UUID,
    "receiveNote" TEXT,
    "cancelledByUserId" UUID,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "qtySent" INTEGER NOT NULL,
    "qtyReceived" INTEGER,
    "shortfallReason" "AdjustmentReason",

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockTransfer_orgId_fromBranchId_sentAt_idx" ON "StockTransfer"("orgId", "fromBranchId", "sentAt");

-- CreateIndex
CREATE INDEX "StockTransfer_orgId_toBranchId_status_idx" ON "StockTransfer"("orgId", "toBranchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_orgId_id_key" ON "StockTransfer"("orgId", "id");

-- CreateIndex
-- NULLS NOT DISTINCT: one line per item per transfer, also for products without variants.
CREATE UNIQUE INDEX "StockTransferLine_orgId_transferId_productId_variantId_key" ON "StockTransferLine"("orgId", "transferId", "productId", "variantId") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_orgId_fromBranchId_fkey" FOREIGN KEY ("orgId", "fromBranchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_orgId_toBranchId_fkey" FOREIGN KEY ("orgId", "toBranchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_orgId_transferId_fkey" FOREIGN KEY ("orgId", "transferId") REFERENCES "StockTransfer"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Two-step transfer rules (docs/planning/transfers/transit-transfers-spec.md) ──

ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_other_branch"
  CHECK ("fromBranchId" <> "toBranchId");

-- T4, T7: the status and its timestamps (and the receive key) move together.
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_received"
  CHECK (("status" = 'RECEIVED') = ("receivedAt" IS NOT NULL AND "receiveKey" IS NOT NULL AND "receivedByUserId" IS NOT NULL));

ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_cancelled"
  CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledByUserId" IS NOT NULL));

ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_note_length"
  CHECK (("note" IS NULL OR length("note") <= 500) AND ("receiveNote" IS NULL OR length("receiveNote") <= 500));

ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_sent_range"
  CHECK ("qtySent" BETWEEN 1 AND 1000000);

-- T5, T6: received 0 … sent; a reason exactly on the short lines, from the shortfall list.
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_received_range"
  CHECK ("qtyReceived" IS NULL OR "qtyReceived" BETWEEN 0 AND "qtySent");

ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_shortfall_reason"
  CHECK (("shortfallReason" IS NOT NULL) = ("qtyReceived" IS NOT NULL AND "qtyReceived" < "qtySent")
     AND ("shortfallReason" IS NULL OR "shortfallReason" IN ('DAMAGED', 'LOST_OR_STOLEN', 'OTHER')));

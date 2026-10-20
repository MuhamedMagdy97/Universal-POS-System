-- CreateEnum
CREATE TYPE "SupplierPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER');

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "method" "SupplierPaymentMethod" NOT NULL,
    "paidOn" DATE NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "purchaseOrderId" UUID,
    "reversalOfId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPayment_orgId_supplierId_paidOn_idx" ON "SupplierPayment"("orgId", "supplierId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_orgId_id_key" ON "SupplierPayment"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_orgId_idempotencyKey_key" ON "SupplierPayment"("orgId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_orgId_reversalOfId_key" ON "SupplierPayment"("orgId", "reversalOfId");

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_orgId_supplierId_fkey" FOREIGN KEY ("orgId", "supplierId") REFERENCES "Supplier"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_orgId_purchaseOrderId_fkey" FOREIGN KEY ("orgId", "purchaseOrderId") REFERENCES "PurchaseOrder"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_orgId_reversalOfId_fkey" FOREIGN KEY ("orgId", "reversalOfId") REFERENCES "SupplierPayment"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- supplier-payments-spec S4, S9: positive amounts, bounded text, a reversal never points at itself.
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_fields"
  CHECK ("amountMinor" > 0
     AND ("reference" IS NULL OR length("reference") <= 80)
     AND ("note" IS NULL OR length("note") <= 500)
     AND ("reversalOfId" IS NULL OR "reversalOfId" <> "id"));

-- Append-only (S9): a mistake is corrected with a reversal row.
CREATE TRIGGER "SupplierPayment_append_only" BEFORE UPDATE OR DELETE ON "SupplierPayment"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();

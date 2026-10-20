-- CreateEnum
CREATE TYPE "SupplierDocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "kind" "SupplierDocumentKind" NOT NULL,
    "number" TEXT NOT NULL,
    "issuedOn" DATE NOT NULL,
    "dueOn" DATE,
    "netMinor" INTEGER NOT NULL,
    "vatMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "note" TEXT,
    "purchaseReturnId" UUID,
    "appliesToInvoiceId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceReceipt" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "goodsReceiptId" UUID NOT NULL,

    CONSTRAINT "SupplierInvoiceReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPaymentAllocation" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierInvoice_orgId_supplierId_issuedOn_idx" ON "SupplierInvoice"("orgId", "supplierId", "issuedOn");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_orgId_id_key" ON "SupplierInvoice"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_orgId_idempotencyKey_key" ON "SupplierInvoice"("orgId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SupplierInvoiceReceipt_orgId_goodsReceiptId_idx" ON "SupplierInvoiceReceipt"("orgId", "goodsReceiptId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoiceReceipt_invoiceId_goodsReceiptId_key" ON "SupplierInvoiceReceipt"("invoiceId", "goodsReceiptId");

-- CreateIndex
CREATE INDEX "SupplierPaymentAllocation_orgId_paymentId_idx" ON "SupplierPaymentAllocation"("orgId", "paymentId");

-- CreateIndex
CREATE INDEX "SupplierPaymentAllocation_orgId_invoiceId_idx" ON "SupplierPaymentAllocation"("orgId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPaymentAllocation_orgId_idempotencyKey_invoiceId_key" ON "SupplierPaymentAllocation"("orgId", "idempotencyKey", "invoiceId");

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_orgId_supplierId_fkey" FOREIGN KEY ("orgId", "supplierId") REFERENCES "Supplier"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_orgId_purchaseReturnId_fkey" FOREIGN KEY ("orgId", "purchaseReturnId") REFERENCES "PurchaseReturn"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_orgId_appliesToInvoiceId_fkey" FOREIGN KEY ("orgId", "appliesToInvoiceId") REFERENCES "SupplierInvoice"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceReceipt" ADD CONSTRAINT "SupplierInvoiceReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceReceipt" ADD CONSTRAINT "SupplierInvoiceReceipt_orgId_invoiceId_fkey" FOREIGN KEY ("orgId", "invoiceId") REFERENCES "SupplierInvoice"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceReceipt" ADD CONSTRAINT "SupplierInvoiceReceipt_orgId_goodsReceiptId_fkey" FOREIGN KEY ("orgId", "goodsReceiptId") REFERENCES "GoodsReceipt"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_orgId_paymentId_fkey" FOREIGN KEY ("orgId", "paymentId") REFERENCES "SupplierPayment"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_orgId_invoiceId_fkey" FOREIGN KEY ("orgId", "invoiceId") REFERENCES "SupplierInvoice"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- supplier-invoices-spec I1, I4, I6: totals add up, bounded text, kind-specific links, void all-or-nothing.
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_fields"
  CHECK ("netMinor" >= 0 AND "vatMinor" >= 0 AND "totalMinor" > 0
     AND "totalMinor"::bigint = "netMinor"::bigint + "vatMinor"
     AND length("number") BETWEEN 1 AND 40
     AND ("note" IS NULL OR length("note") <= 500)
     AND ("kind" = 'CREDIT_NOTE' OR ("purchaseReturnId" IS NULL AND "appliesToInvoiceId" IS NULL))
     AND ("kind" = 'INVOICE' OR "dueOn" IS NULL)
     AND ("dueOn" IS NULL OR "dueOn" >= "issuedOn")
     AND ("appliesToInvoiceId" IS NULL OR "appliesToInvoiceId" <> "id")
     AND (("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL)
       OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND length("voidReason") BETWEEN 1 AND 500)));

ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_amount" CHECK ("amountMinor" > 0);

-- I2: one live document per supplier, kind and number, ignoring case.
CREATE UNIQUE INDEX "SupplierInvoice_live_number" ON "SupplierInvoice"("orgId", "supplierId", "kind", lower("number"))
  WHERE "voidedAt" IS NULL;

-- I6: never deleted; the only update sets the void columns, once.
CREATE FUNCTION pos_supplier_invoice_void_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."voidedAt" IS NULL AND NEW."voidedAt" IS NOT NULL
     AND (to_jsonb(NEW) - 'voidedAt' - 'voidedById' - 'voidReason')
       = (to_jsonb(OLD) - 'voidedAt' - 'voidedById' - 'voidReason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on "%" is not allowed: only a single void is', TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "SupplierInvoice_void_only" BEFORE UPDATE OR DELETE ON "SupplierInvoice"
  FOR EACH ROW EXECUTE FUNCTION pos_supplier_invoice_void_only();
CREATE TRIGGER "SupplierInvoiceReceipt_append_only" BEFORE UPDATE OR DELETE ON "SupplierInvoiceReceipt"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "SupplierPaymentAllocation_append_only" BEFORE UPDATE OR DELETE ON "SupplierPaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();

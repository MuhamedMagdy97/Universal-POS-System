-- Customer records (docs/planning/customers/customers-spec.md). `migrate dev` also proposes dropping
-- "POItem_one_line_per_item" (an index Prisma does not model); that line is removed.

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "customerId" UUID,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "customerTaxNumber" TEXT;

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "taxNumber" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_orgId_name_idx" ON "Customer"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_orgId_id_key" ON "Customer"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_orgId_phone_key" ON "Customer"("orgId", "phone");

-- CreateIndex
CREATE INDEX "Sale_orgId_customerId_createdAt_idx" ON "Sale"("orgId", "customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_orgId_customerId_fkey" FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phone is stored in E.164 (CU2).
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_phone_e164" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_name_not_blank" CHECK (btrim("name") <> '');

-- A sale names its customer only together with the snapshot (CU8).
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customer_snapshot" CHECK (("customerId" IS NULL) = ("customerName" IS NULL));

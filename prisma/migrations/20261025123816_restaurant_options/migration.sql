-- Options on a dish and line notes (docs/planning/ui-refresh/restaurant-cafe-spec.md R7, R8, R14). No backfill.
-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "note" TEXT,
ADD COLUMN     "options" JSONB;

-- CreateTable
CREATE TABLE "OptionGroup" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionChoice" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "priceDeltaMinor" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptionChoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOptionGroup" (
    "orgId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductOptionGroup_pkey" PRIMARY KEY ("orgId","productId","groupId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OptionGroup_orgId_id_key" ON "OptionGroup"("orgId", "id");

-- CreateIndex
CREATE INDEX "OptionChoice_orgId_groupId_idx" ON "OptionChoice"("orgId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionChoice_orgId_id_key" ON "OptionChoice"("orgId", "id");

-- CreateIndex
CREATE INDEX "ProductOptionGroup_orgId_groupId_idx" ON "ProductOptionGroup"("orgId", "groupId");

-- AddForeignKey
ALTER TABLE "OptionGroup" ADD CONSTRAINT "OptionGroup_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionChoice" ADD CONSTRAINT "OptionChoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionChoice" ADD CONSTRAINT "OptionChoice_orgId_groupId_fkey" FOREIGN KEY ("orgId", "groupId") REFERENCES "OptionGroup"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOptionGroup" ADD CONSTRAINT "ProductOptionGroup_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOptionGroup" ADD CONSTRAINT "ProductOptionGroup_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOptionGroup" ADD CONSTRAINT "ProductOptionGroup_orgId_groupId_fkey" FOREIGN KEY ("orgId", "groupId") REFERENCES "OptionGroup"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OptionGroup" ADD CONSTRAINT "OptionGroup_select_range"
  CHECK ("minSelect" >= 0 AND "maxSelect" >= GREATEST("minSelect", 1) AND "maxSelect" <= 20);
ALTER TABLE "OptionChoice" ADD CONSTRAINT "OptionChoice_price_delta_nonneg" CHECK ("priceDeltaMinor" >= 0);
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_note_length" CHECK (char_length("note") <= 140);

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'COUNTING', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockCountScope" AS ENUM ('FULL', 'CATEGORY', 'ITEMS');

-- CreateTable
CREATE TABLE "StockCount" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "scope" "StockCountScope" NOT NULL,
    "categoryId" UUID,
    "note" TEXT,
    "createdByUserId" UUID NOT NULL,
    "postedByUserId" UUID,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "countId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "countedQty" INTEGER,
    "expectedQty" INTEGER,
    "countedAt" TIMESTAMP(3),
    "onHandAtPost" INTEGER,
    "qtyDelta" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockCount_orgId_branchId_createdAt_idx" ON "StockCount"("orgId", "branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_orgId_id_key" ON "StockCount"("orgId", "id");

-- CreateIndex
-- NULLS NOT DISTINCT: one line per item per count, also for products without variants.
CREATE UNIQUE INDEX "StockCountLine_orgId_countId_productId_variantId_key" ON "StockCountLine"("orgId", "countId", "productId", "variantId") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_orgId_countId_fkey" FOREIGN KEY ("orgId", "countId") REFERENCES "StockCount"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Stock count rules (docs/planning/stock-counts/stock-counts-spec.md) ──

-- C3: at most one open (draft or counting) count per branch.
CREATE UNIQUE INDEX "StockCount_one_open_per_branch"
  ON "StockCount"("orgId", "branchId") WHERE "status" IN ('DRAFT', 'COUNTING');

-- C2: a category count names its category; the other scopes do not.
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_category_scope"
  CHECK (("scope" = 'CATEGORY') = ("categoryId" IS NOT NULL));

ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_posted_at"
  CHECK (("status" = 'POSTED') = ("postedAt" IS NOT NULL));

ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_note_length"
  CHECK ("note" IS NULL OR length("note") <= 500);

-- C4, C5: a counted line has its expected snapshot; counted quantities are 0 … 1,000,000.
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_counted_has_expected"
  CHECK (("countedQty" IS NULL) = ("expectedQty" IS NULL));

ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_counted_range"
  CHECK ("countedQty" IS NULL OR "countedQty" BETWEEN 0 AND 1000000);

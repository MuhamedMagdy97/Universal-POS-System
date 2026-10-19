-- CreateEnum
CREATE TYPE "InventorySource" AS ENUM ('BUILT_IN', 'EXTERNAL');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "inventorySource" "InventorySource" NOT NULL DEFAULT 'BUILT_IN';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "externalProductId" TEXT,
ADD COLUMN     "externalVariantId" TEXT,
ADD COLUMN     "notSellableReason" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "externalVariantId" TEXT,
ADD COLUMN     "notSellableReason" TEXT;

-- CreateTable
CREATE TABLE "InventoryLink" (
    "orgId" UUID NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyCiphertext" BYTEA NOT NULL,
    "apiKeyKeyId" TEXT NOT NULL,
    "apiKeyLast4" TEXT NOT NULL,
    "lastCheckAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN NOT NULL DEFAULT false,
    "syncLockedUntil" TIMESTAMP(3),
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncFinishedAt" TIMESTAMP(3),
    "lastSyncOk" BOOLEAN,
    "lastSyncSummary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLink_pkey" PRIMARY KEY ("orgId")
);

-- AddForeignKey
ALTER TABLE "InventoryLink" ADD CONSTRAINT "InventoryLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 13 (I7): each inventory-system id maps to at most one POS row per org.
CREATE UNIQUE INDEX "Product_orgId_externalProductId_key" ON "Product"("orgId", "externalProductId")
  WHERE "externalProductId" IS NOT NULL;
CREATE UNIQUE INDEX "Product_orgId_externalVariantId_key" ON "Product"("orgId", "externalVariantId")
  WHERE "externalVariantId" IS NOT NULL;
CREATE UNIQUE INDEX "ProductVariant_orgId_externalVariantId_key" ON "ProductVariant"("orgId", "externalVariantId")
  WHERE "externalVariantId" IS NOT NULL;

-- CreateEnum
CREATE TYPE "PostingKind" AS ENUM ('FULFIL', 'CANCEL', 'RETURN');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "externalWarehouseId" TEXT;

-- CreateTable
CREATE TABLE "ExternalStockPosting" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "kind" "PostingKind" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL DEFAULT 0,
    "saleItemId" UUID,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "reservationId" TEXT,
    "reservationVersion" INTEGER,
    "externalOrderRefId" TEXT,
    "externalReturnId" TEXT,
    "status" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalStockPosting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalStockPosting_status_nextAttemptAt_idx" ON "ExternalStockPosting"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ExternalStockPosting_orgId_sourceType_sourceId_idx" ON "ExternalStockPosting"("orgId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalStockPosting_orgId_idempotencyKey_key" ON "ExternalStockPosting"("orgId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExternalStockPosting" ADD CONSTRAINT "ExternalStockPosting_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 13 (I5): two branches may not sell from one warehouse.
CREATE UNIQUE INDEX "Branch_orgId_externalWarehouseId_key" ON "Branch"("orgId", "externalWarehouseId")
  WHERE "externalWarehouseId" IS NOT NULL;

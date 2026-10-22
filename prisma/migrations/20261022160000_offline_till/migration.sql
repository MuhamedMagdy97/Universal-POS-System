-- Offline till slice 1 (docs/planning/offline-till/offline-till-spec.md OF5, OF8, OF12, OF16, OF20).
-- Hand-trimmed: Prisma's DROP INDEX "POItem_one_line_per_item" removed (hand-written partial index).

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "allowOfflineSales" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Register" ADD COLUMN     "lastOfflineSaleNo" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "offlineCode" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "offlineFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "receivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RegisterDevice" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "secretHash" TEXT NOT NULL,
    "enrolledById" UUID NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,

    CONSTRAINT "RegisterDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegisterDevice_orgId_registerId_idx" ON "RegisterDevice"("orgId", "registerId");

-- CreateIndex
CREATE UNIQUE INDEX "Register_orgId_offlineCode_key" ON "Register"("orgId", "offlineCode");

-- AddForeignKey
ALTER TABLE "RegisterDevice" ADD CONSTRAINT "RegisterDevice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterDevice" ADD CONSTRAINT "RegisterDevice_orgId_registerId_fkey" FOREIGN KEY ("orgId", "registerId") REFERENCES "Register"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: at most one device per register that is not revoked (OF16).
CREATE UNIQUE INDEX "RegisterDevice_one_active_per_register" ON "RegisterDevice"("orgId", "registerId") WHERE "revokedAt" IS NULL;

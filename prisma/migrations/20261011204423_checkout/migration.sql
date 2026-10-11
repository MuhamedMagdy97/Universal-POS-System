-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "lastSaleNo" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "changeMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requestHash" TEXT;

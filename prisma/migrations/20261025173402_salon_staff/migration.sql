-- Staff members and staff on sale lines (docs/planning/ui-refresh/salon-spec.md S3, S4, S8, S11). No backfill.
-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "commissionBp" INTEGER,
ADD COLUMN     "staffMemberId" UUID,
ADD COLUMN     "staffName" TEXT;

-- CreateTable
CREATE TABLE "StaffMember" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "commissionBp" INTEGER NOT NULL DEFAULT 0,
    "userId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffMemberBranch" (
    "orgId" UUID NOT NULL,
    "staffMemberId" UUID NOT NULL,
    "branchId" UUID NOT NULL,

    CONSTRAINT "StaffMemberBranch_pkey" PRIMARY KEY ("orgId","staffMemberId","branchId")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_orgId_id_key" ON "StaffMember"("orgId", "id");

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMemberBranch" ADD CONSTRAINT "StaffMemberBranch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMemberBranch" ADD CONSTRAINT "StaffMemberBranch_orgId_staffMemberId_fkey" FOREIGN KEY ("orgId", "staffMemberId") REFERENCES "StaffMember"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMemberBranch" ADD CONSTRAINT "StaffMemberBranch_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_commission_range" CHECK ("commissionBp" BETWEEN 0 AND 10000);
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_commission_range" CHECK ("commissionBp" IS NULL OR "commissionBp" BETWEEN 0 AND 10000);

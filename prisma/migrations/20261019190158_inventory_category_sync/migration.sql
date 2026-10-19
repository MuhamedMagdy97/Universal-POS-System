-- Category sync from the inventory system: the IMS category id, unique per org.
-- (The generated DROP INDEX "POItem_one_line_per_item" was removed: that index is raw SQL Prisma cannot see.)
ALTER TABLE "Category" ADD COLUMN "externalCategoryId" TEXT;

CREATE UNIQUE INDEX "Category_orgId_externalCategoryId_key" ON "Category"("orgId", "externalCategoryId")
  WHERE "externalCategoryId" IS NOT NULL;

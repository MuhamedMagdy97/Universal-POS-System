-- P12 profit and margin: cost per unit at the moment of sale (profit-margin-spec.md §4).
-- Created with `migrate dev --create-only` and trimmed: the generated DROP INDEX
-- "POItem_one_line_per_item" is removed (a partial index Prisma does not model).
-- A nullable column rewrites no rows and fires no row trigger; existing lines read NULL (M6).

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN "unitCostMinor" INTEGER;
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_unitCostMinor_nonneg" CHECK ("unitCostMinor" IS NULL OR "unitCostMinor" >= 0);

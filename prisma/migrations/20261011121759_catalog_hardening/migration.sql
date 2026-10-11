-- CreateEnum
CREATE TYPE "VatCategory" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');

-- AlterTable
ALTER TABLE "Barcode" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "hasVariants" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vatCategory" "VatCategory" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Barcode_orgId_productId_idx" ON "Barcode"("orgId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_orgId_productId_id_key" ON "ProductVariant"("orgId", "productId", "id");

-- AddForeignKey
-- The barcode's variant must belong to the barcode's product. A NULL variantId
-- skips the check (MATCH SIMPLE), so product-level barcodes keep working.
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_orgId_productId_variantId_fkey" FOREIGN KEY ("orgId", "productId", "variantId") REFERENCES "ProductVariant"("orgId", "productId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/planning/phase-6/catalog-data-model.md §2–§5 and catalog-spec.md §3.
-- Run prisma/sql/catalog-hardening-preflight.sql first on databases that
-- already hold catalog data. Do not relax these to make tests pass.
-- ════════════════════════════════════════════════════════════════════

-- ── Backfills (additive) ──
UPDATE "Product" p SET "hasVariants" = true
  WHERE EXISTS (SELECT 1 FROM "ProductVariant" v WHERE v."orgId" = p."orgId" AND v."productId" = p."id");

-- vatApplicable = false meant "0% VAT"; the safe reading for reporting is zero-rated.
UPDATE "Product" SET "vatCategory" = 'ZERO_RATED' WHERE NOT "vatApplicable";

-- ── VAT: the legacy flag is derived from the category ──
ALTER TABLE "Product" ADD CONSTRAINT "Product_vatApplicable_matches_category"
  CHECK ("vatApplicable" = ("vatCategory" = 'STANDARD'));

-- ── SKUs: upper-case, trimmed, 1–64 chars (owner decision Q4) ──
ALTER TABLE "Product" ADD CONSTRAINT "Product_sku_format"
  CHECK ("sku" = upper(btrim("sku")) AND length("sku") BETWEEN 1 AND 64);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_sku_format"
  CHECK ("sku" = upper(btrim("sku")) AND length("sku") BETWEEN 1 AND 64);

-- ── Barcode code: printable ASCII, no spaces, 1–64 chars ──
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_code_format" CHECK ("code" ~ '^[\x21-\x7E]{1,64}$');

-- ── Product name must not be blank ──
ALTER TABLE "Product" ADD CONSTRAINT "Product_name_nonblank" CHECK (length(btrim("name")) > 0);

-- ── At most one primary barcode per product / variant ──
-- NULLS NOT DISTINCT: a product without variants (variantId NULL) also gets one primary.
CREATE UNIQUE INDEX "Barcode_one_primary_per_item" ON "Barcode"("orgId", "productId", "variantId")
  NULLS NOT DISTINCT WHERE "isPrimary";

-- ── Category sibling names unique, case-insensitive; two roots cannot share a name ──
CREATE UNIQUE INDEX "Category_sibling_name_key" ON "Category"("orgId", "parentId", lower("name"))
  NULLS NOT DISTINCT;

-- ── One SKU namespace per org across Product and ProductVariant ──
-- Per-table uniqueness is already enforced by UNIQUE(orgId, sku). The advisory
-- lock serialises concurrent writers of the same (org, sku) so the cross-table
-- check is race-safe under READ COMMITTED: each statement in this (volatile)
-- function takes a fresh snapshot after the lock is granted, and the lock is
-- released only after the holder's row is committed and visible.
CREATE FUNCTION pos_guard_sku_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  clash_id uuid;
  other_table text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pos_sku_namespace'), hashtext(NEW."orgId"::text || ':' || NEW."sku"));
  IF TG_TABLE_NAME = 'Product' THEN
    other_table := 'ProductVariant';
    SELECT "id" INTO clash_id FROM "ProductVariant" WHERE "orgId" = NEW."orgId" AND "sku" = NEW."sku" LIMIT 1;
  ELSE
    other_table := 'Product';
    SELECT "id" INTO clash_id FROM "Product" WHERE "orgId" = NEW."orgId" AND "sku" = NEW."sku" LIMIT 1;
  END IF;
  IF clash_id IS NOT NULL THEN
    RAISE EXCEPTION 'SKU "%" is already used by a % in this organization', NEW."sku", other_table
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'sku_namespace',
            TABLE = TG_TABLE_NAME,
            COLUMN = 'sku',
            DETAIL = format('Key ("orgId", sku)=(%s, %s) already exists in "%s" (id %s).',
                            NEW."orgId", NEW."sku", other_table, clash_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Product_sku_namespace" BEFORE INSERT OR UPDATE OF "sku", "orgId" ON "Product"
  FOR EACH ROW EXECUTE FUNCTION pos_guard_sku_namespace();
CREATE TRIGGER "ProductVariant_sku_namespace" BEFORE INSERT OR UPDATE OF "sku", "orgId" ON "ProductVariant"
  FOR EACH ROW EXECUTE FUNCTION pos_guard_sku_namespace();

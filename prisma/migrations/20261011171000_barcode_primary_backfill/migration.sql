-- Data fix only (no DDL) for the owner decision "first barcode is primary".
-- Every item (product-level barcodes, or one variant's barcodes) that has
-- barcodes but no primary gets its oldest barcode (createdAt, then id) as
-- primary. Idempotent: items that already have a primary are untouched, and
-- at most one row per item is set, so "Barcode_one_primary_per_item" holds.
UPDATE "Barcode" AS b
SET "isPrimary" = true,
    "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (x."orgId", x."productId", x."variantId") x."id"
  FROM "Barcode" AS x
  WHERE NOT EXISTS (
    SELECT 1
    FROM "Barcode" AS p
    WHERE p."orgId" = x."orgId"
      AND p."productId" = x."productId"
      AND p."variantId" IS NOT DISTINCT FROM x."variantId"
      AND p."isPrimary"
  )
  ORDER BY x."orgId", x."productId", x."variantId", x."createdAt", x."id"
) AS first_code
WHERE b."id" = first_code."id";

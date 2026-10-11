-- Pre-flight check for migration 20261011121759_catalog_hardening.
--
-- Read-only. Run against a database that already holds catalog data BEFORE
-- applying the migration, e.g.
--   npx prisma db execute --file prisma/sql/catalog-hardening-preflight.sql
-- or paste into psql. Every row returned is a row that would make the
-- migration fail; fix the data first (an empty result means it is safe).
-- `prisma db execute` does not print SELECT results, so use psql or another
-- SQL client to see the rows.

SELECT 'Product SKU not upper-case/trimmed or not 1-64 chars' AS problem,
       "orgId", "id", "sku" AS value
FROM "Product"
WHERE "sku" <> upper(btrim("sku")) OR length("sku") NOT BETWEEN 1 AND 64

UNION ALL
SELECT 'ProductVariant SKU not upper-case/trimmed or not 1-64 chars',
       "orgId", "id", "sku"
FROM "ProductVariant"
WHERE "sku" <> upper(btrim("sku")) OR length("sku") NOT BETWEEN 1 AND 64

UNION ALL
-- Normalising would make two SKUs equal inside one table.
SELECT 'Product SKUs collide after upper(btrim())', "orgId", NULL, upper(btrim("sku"))
FROM "Product"
GROUP BY "orgId", upper(btrim("sku"))
HAVING count(*) > 1

UNION ALL
SELECT 'ProductVariant SKUs collide after upper(btrim())', "orgId", NULL, upper(btrim("sku"))
FROM "ProductVariant"
GROUP BY "orgId", upper(btrim("sku"))
HAVING count(*) > 1

UNION ALL
-- One SKU namespace across products and variants.
SELECT 'SKU used by both a product and a variant', p."orgId", p."id", p."sku" || ' (variant ' || v."id" || ')'
FROM "Product" p
JOIN "ProductVariant" v ON v."orgId" = p."orgId" AND upper(btrim(v."sku")) = upper(btrim(p."sku"))

UNION ALL
SELECT 'Barcode code not printable ASCII 1-64 chars', "orgId", "id", "code"
FROM "Barcode"
WHERE "code" !~ '^[\x21-\x7E]{1,64}$'

UNION ALL
SELECT 'Barcode variant belongs to a different product', b."orgId", b."id",
       b."code" || ' (product ' || b."productId" || ', variant of ' || v."productId" || ')'
FROM "Barcode" b
JOIN "ProductVariant" v ON v."orgId" = b."orgId" AND v."id" = b."variantId"
WHERE v."productId" <> b."productId"

UNION ALL
SELECT 'Product name is blank', "orgId", "id", "name"
FROM "Product"
WHERE length(btrim("name")) = 0

UNION ALL
SELECT 'Duplicate sibling category name (case-insensitive)', "orgId", NULL,
       lower("name") || ' under parent ' || coalesce("parentId"::text, '<root>')
FROM "Category"
GROUP BY "orgId", "parentId", lower("name")
HAVING count(*) > 1

ORDER BY 1, 2;

-- Run BEFORE `prisma migrate deploy` of the inventory migration: rows that would violate its new
-- CHECKs / unique indexes. Expected result on every database: zero for each rule.
-- (Sub-reason rules need no check: the new column is NULL on every existing row, and
--  ADJUSTMENT rows are counted below, because they would need a sub-reason.)
SELECT 'adjustment_rows_without_subreason' AS rule, count(*) FROM "InventoryMovement" WHERE "reason" = 'ADJUSTMENT'
UNION ALL SELECT 'reason_direction', count(*) FROM "InventoryMovement"
  WHERE NOT ((("reason" IN ('OPENING_BALANCE','SALE_VOID','REFUND','PURCHASE_RECEIPT','TRANSFER_IN')) AND "qtyDelta" > 0)
    OR (("reason" IN ('SALE','TRANSFER_OUT')) AND "qtyDelta" < 0)
    OR "reason" = 'ADJUSTMENT')
UNION ALL SELECT 'group_only_on_transfer', count(*) FROM "InventoryMovement"
  WHERE NOT ("reason" IN ('TRANSFER_OUT','TRANSFER_IN') OR "transferGroupId" IS NULL)
UNION ALL SELECT 'duplicate_opening_balance', count(*) FROM (
  SELECT 1 FROM "InventoryMovement" WHERE "reason" = 'OPENING_BALANCE'
  GROUP BY "orgId", "branchId", "productId", "variantId" HAVING count(*) > 1) d
UNION ALL SELECT 'duplicate_transfer_line', count(*) FROM (
  SELECT 1 FROM "InventoryMovement" WHERE "transferGroupId" IS NOT NULL
  GROUP BY "orgId", "transferGroupId", "reason", "productId", "variantId" HAVING count(*) > 1) d;

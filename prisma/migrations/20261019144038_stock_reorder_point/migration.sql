-- Reorder point (min qty) per item per branch; null = not tracked (docs/planning/low-stock/low-stock-spec.md L1).
ALTER TABLE "StockBalance" ADD COLUMN "reorderPoint" INTEGER;
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_reorderPoint_range"
  CHECK ("reorderPoint" IS NULL OR "reorderPoint" BETWEEN 0 AND 1000000);

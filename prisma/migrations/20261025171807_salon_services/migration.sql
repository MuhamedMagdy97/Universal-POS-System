-- Service items (docs/planning/ui-refresh/salon-spec.md S2, S11). No backfill.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "durationMin" INTEGER,
ADD COLUMN     "isService" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Product" ADD CONSTRAINT "Product_service_duration"
  CHECK ("durationMin" IS NULL OR ("isService" AND "durationMin" BETWEEN 5 AND 480));
ALTER TABLE "Product" ADD CONSTRAINT "Product_service_each" CHECK (NOT "isService" OR ("unitType" = 'EACH' AND NOT "hasVariants"));

-- Service charge on dine-in orders (docs/planning/ui-refresh/restaurant-cafe-spec.md R11, R14). No backfill.
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "serviceChargeBp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "serviceChargeMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeVatMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "serviceChargeMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeVatMinor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_serviceChargeBp_range" CHECK ("serviceChargeBp" BETWEEN 0 AND 2500);
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_service_charge_nonneg" CHECK ("serviceChargeMinor" >= 0 AND "serviceChargeVatMinor" BETWEEN 0 AND "serviceChargeMinor");
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_service_charge_nonneg" CHECK ("serviceChargeMinor" >= 0 AND "serviceChargeVatMinor" BETWEEN 0 AND "serviceChargeMinor");

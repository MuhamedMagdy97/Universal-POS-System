-- Most a cashier (discounts.apply only) may take off, in basis points (discounts-spec DC8, DC17).
ALTER TABLE "Organization" ADD COLUMN     "maxCashierDiscountBp" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_maxCashierDiscountBp_valid"
  CHECK ("maxCashierDiscountBp" BETWEEN 0 AND 10000);

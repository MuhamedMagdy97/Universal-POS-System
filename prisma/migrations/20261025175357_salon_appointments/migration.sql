-- Appointments and opening hours (docs/planning/ui-refresh/salon-spec.md S5-S7, S11). No backfill.
-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'ARRIVED', 'DONE', 'CANCELLED', 'NO_SHOW');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "closesAt" INTEGER NOT NULL DEFAULT 1260,
ADD COLUMN     "opensAt" INTEGER NOT NULL DEFAULT 540;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "appointmentId" UUID;

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "staffMemberId" UUID,
    "customerId" UUID,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "note" TEXT,
    "saleId" UUID,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentService" (
    "orgId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "AppointmentService_pkey" PRIMARY KEY ("orgId","appointmentId","sortOrder")
);

-- CreateIndex
CREATE INDEX "Appointment_orgId_branchId_startsAt_idx" ON "Appointment"("orgId", "branchId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_orgId_staffMemberId_startsAt_idx" ON "Appointment"("orgId", "staffMemberId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_orgId_id_key" ON "Appointment"("orgId", "id");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_orgId_staffMemberId_fkey" FOREIGN KEY ("orgId", "staffMemberId") REFERENCES "StaffMember"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_orgId_customerId_fkey" FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentService" ADD CONSTRAINT "AppointmentService_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentService" ADD CONSTRAINT "AppointmentService_orgId_appointmentId_fkey" FOREIGN KEY ("orgId", "appointmentId") REFERENCES "Appointment"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentService" ADD CONSTRAINT "AppointmentService_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_ends_after_start" CHECK ("endsAt" > "startsAt");
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customer" CHECK ("customerId" IS NOT NULL OR ("customerName" IS NOT NULL AND "customerPhone" IS NOT NULL));
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_opening_hours" CHECK ("opensAt" >= 0 AND "closesAt" <= 1440 AND "opensAt" < "closesAt");

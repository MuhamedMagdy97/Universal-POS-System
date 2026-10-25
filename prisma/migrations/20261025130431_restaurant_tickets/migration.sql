-- Tables, open tickets and order types (docs/planning/ui-refresh/restaurant-cafe-spec.md R2-R6, R14). No backfill.
-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "lastTicketNo" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "deliveryNote" TEXT,
ADD COLUMN     "orderType" "OrderType",
ADD COLUMN     "tableName" TEXT,
ADD COLUMN     "ticketId" UUID;

-- CreateTable
CREATE TABLE "DiningTable" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "tableId" UUID,
    "customerId" UUID,
    "deliveryAddress" TEXT,
    "deliveryNote" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "saleId" UUID,
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLine" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "qty" INTEGER NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "sentAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TicketLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_orgId_id_key" ON "DiningTable"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_orgId_branchId_name_key" ON "DiningTable"("orgId", "branchId", "name");

-- CreateIndex
CREATE INDEX "Ticket_orgId_branchId_status_idx" ON "Ticket"("orgId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_orgId_id_key" ON "Ticket"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_orgId_number_key" ON "Ticket"("orgId", "number");

-- CreateIndex
CREATE INDEX "TicketLine_orgId_ticketId_idx" ON "TicketLine"("orgId", "ticketId");

-- AddForeignKey
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_tableId_fkey" FOREIGN KEY ("orgId", "tableId") REFERENCES "DiningTable"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_customerId_fkey" FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLine" ADD CONSTRAINT "TicketLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLine" ADD CONSTRAINT "TicketLine_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLine" ADD CONSTRAINT "TicketLine_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one open ticket per table (R4).
CREATE UNIQUE INDEX "Ticket_one_open_per_table" ON "Ticket"("tableId") WHERE "status" = 'OPEN' AND "tableId" IS NOT NULL;
ALTER TABLE "TicketLine" ADD CONSTRAINT "TicketLine_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "TicketLine" ADD CONSTRAINT "TicketLine_note_length" CHECK (char_length("note") <= 140);

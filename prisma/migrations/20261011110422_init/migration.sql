-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RETAIL', 'GROCERY', 'FRUIT_VEG', 'BAKERY_BUTCHER', 'RESTAURANT_CAFE', 'SALON');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('EGP', 'SAR');

-- CreateEnum
CREATE TYPE "CountryCode" AS ENUM ('EG', 'SA');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'REPORTING');

-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('EACH', 'KG');

-- CreateEnum
CREATE TYPE "MovementReason" AS ENUM ('OPENING_BALANCE', 'SALE', 'SALE_VOID', 'REFUND', 'PURCHASE_RECEIPT', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD_MANUAL', 'WALLET');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('PAY_IN', 'PAY_OUT', 'DROP');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,
    "activeOrganizationId" UUID,
    "activeBranchId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "businessType" "BusinessType" NOT NULL,
    "countryCode" "CountryCode" NOT NULL,
    "currency" "Currency" NOT NULL,
    "vatRateBp" INTEGER NOT NULL,
    "blockNegativeStock" BOOLEAN NOT NULL DEFAULT true,
    "legalName" TEXT,
    "taxNumber" TEXT,
    "receiptHeader" TEXT,
    "receiptFooter" TEXT,
    "receiptAddress" TEXT,
    "receiptPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Register" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "allBranches" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipBranch" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "categoryId" UUID,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "unitType" "UnitType" NOT NULL DEFAULT 'EACH',
    "priceMinor" INTEGER NOT NULL,
    "costMinor" INTEGER NOT NULL DEFAULT 0,
    "vatApplicable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "priceMinor" INTEGER,
    "costMinor" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Barcode" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Barcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "qtyDelta" INTEGER NOT NULL,
    "reason" "MovementReason" NOT NULL,
    "refType" TEXT,
    "refId" UUID,
    "transferGroupId" UUID,
    "note" TEXT,
    "actorUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "taxNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POItem" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "qtyOrdered" INTEGER NOT NULL,
    "qtyReceived" INTEGER NOT NULL DEFAULT 0,
    "unitCostMinor" INTEGER NOT NULL,

    CONSTRAINT "POItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "receivedById" UUID NOT NULL,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptItem" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "goodsReceiptId" UUID NOT NULL,
    "poItemId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "qtyReceived" INTEGER NOT NULL,
    "unitCostMinor" INTEGER NOT NULL,

    CONSTRAINT "GoodsReceiptItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "cashierId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "currency" "Currency" NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "vatMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "skuSnapshot" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "nameArSnapshot" TEXT,
    "unitType" "UnitType" NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "vatRateBp" INTEGER NOT NULL,
    "vatMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "shiftId" UUID,
    "processedById" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reason" TEXT NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "vatMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundItem" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "saleItemId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "vatMinor" INTEGER NOT NULL,

    CONSTRAINT "RefundItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisterShift" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloatMinor" INTEGER NOT NULL,
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),
    "expectedCashMinor" INTEGER,
    "countedCashMinor" INTEGER,
    "discrepancyMinor" INTEGER,
    "discrepancyNote" TEXT,

    CONSTRAINT "RegisterShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "branchId" UUID,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "requestId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_orgId_id_key" ON "Branch"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_orgId_code_key" ON "Branch"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Register_orgId_id_key" ON "Register"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Register_orgId_branchId_id_key" ON "Register"("orgId", "branchId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Register_orgId_branchId_name_key" ON "Register"("orgId", "branchId", "name");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_orgId_userId_key" ON "Membership"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_orgId_id_key" ON "Membership"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipBranch_membershipId_branchId_key" ON "MembershipBranch"("membershipId", "branchId");

-- CreateIndex
CREATE INDEX "Category_orgId_parentId_idx" ON "Category"("orgId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_orgId_id_key" ON "Category"("orgId", "id");

-- CreateIndex
CREATE INDEX "Product_orgId_categoryId_idx" ON "Product"("orgId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_orgId_id_key" ON "Product"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_orgId_sku_key" ON "Product"("orgId", "sku");

-- CreateIndex
CREATE INDEX "ProductVariant_orgId_productId_idx" ON "ProductVariant"("orgId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_orgId_id_key" ON "ProductVariant"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_orgId_sku_key" ON "ProductVariant"("orgId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Barcode_orgId_code_key" ON "Barcode"("orgId", "code");

-- CreateIndex
-- NULLS NOT DISTINCT so a product without variants has exactly one balance row per branch (PostgreSQL 15+).
CREATE UNIQUE INDEX "StockBalance_orgId_branchId_productId_variantId_key" ON "StockBalance"("orgId", "branchId", "productId", "variantId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "InventoryMovement_orgId_branchId_productId_variantId_create_idx" ON "InventoryMovement"("orgId", "branchId", "productId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_orgId_refType_refId_idx" ON "InventoryMovement"("orgId", "refType", "refId");

-- CreateIndex
CREATE INDEX "InventoryMovement_orgId_transferGroupId_idx" ON "InventoryMovement"("orgId", "transferGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_orgId_id_key" ON "Supplier"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orgId_id_key" ON "PurchaseOrder"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orgId_number_key" ON "PurchaseOrder"("orgId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "POItem_orgId_id_key" ON "POItem"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_orgId_id_key" ON "GoodsReceipt"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_orgId_idempotencyKey_key" ON "GoodsReceipt"("orgId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Sale_orgId_branchId_createdAt_idx" ON "Sale"("orgId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "Sale_orgId_shiftId_idx" ON "Sale"("orgId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_orgId_id_key" ON "Sale"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_orgId_idempotencyKey_key" ON "Sale"("orgId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_orgId_number_key" ON "Sale"("orgId", "number");

-- CreateIndex
CREATE INDEX "SaleItem_orgId_saleId_idx" ON "SaleItem"("orgId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleItem_orgId_id_key" ON "SaleItem"("orgId", "id");

-- CreateIndex
CREATE INDEX "Payment_orgId_saleId_idx" ON "Payment"("orgId", "saleId");

-- CreateIndex
CREATE INDEX "Refund_orgId_saleId_idx" ON "Refund"("orgId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_orgId_id_key" ON "Refund"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_orgId_idempotencyKey_key" ON "Refund"("orgId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "RefundItem_orgId_saleItemId_idx" ON "RefundItem"("orgId", "saleItemId");

-- CreateIndex
CREATE INDEX "RegisterShift_orgId_registerId_status_idx" ON "RegisterShift"("orgId", "registerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RegisterShift_orgId_id_key" ON "RegisterShift"("orgId", "id");

-- CreateIndex
CREATE INDEX "CashMovement_orgId_shiftId_idx" ON "CashMovement"("orgId", "shiftId");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_createdAt_idx" ON "AuditEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_entityType_entityId_idx" ON "AuditEvent"("orgId", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Register" ADD CONSTRAINT "Register_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Register" ADD CONSTRAINT "Register_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipBranch" ADD CONSTRAINT "MembershipBranch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipBranch" ADD CONSTRAINT "MembershipBranch_orgId_membershipId_fkey" FOREIGN KEY ("orgId", "membershipId") REFERENCES "Membership"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipBranch" ADD CONSTRAINT "MembershipBranch_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_orgId_parentId_fkey" FOREIGN KEY ("orgId", "parentId") REFERENCES "Category"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_orgId_categoryId_fkey" FOREIGN KEY ("orgId", "categoryId") REFERENCES "Category"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_orgId_supplierId_fkey" FOREIGN KEY ("orgId", "supplierId") REFERENCES "Supplier"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POItem" ADD CONSTRAINT "POItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POItem" ADD CONSTRAINT "POItem_orgId_purchaseOrderId_fkey" FOREIGN KEY ("orgId", "purchaseOrderId") REFERENCES "PurchaseOrder"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POItem" ADD CONSTRAINT "POItem_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POItem" ADD CONSTRAINT "POItem_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orgId_purchaseOrderId_fkey" FOREIGN KEY ("orgId", "purchaseOrderId") REFERENCES "PurchaseOrder"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_orgId_goodsReceiptId_fkey" FOREIGN KEY ("orgId", "goodsReceiptId") REFERENCES "GoodsReceipt"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_orgId_poItemId_fkey" FOREIGN KEY ("orgId", "poItemId") REFERENCES "POItem"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_orgId_branchId_registerId_fkey" FOREIGN KEY ("orgId", "branchId", "registerId") REFERENCES "Register"("orgId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_orgId_shiftId_fkey" FOREIGN KEY ("orgId", "shiftId") REFERENCES "RegisterShift"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_orgId_saleId_fkey" FOREIGN KEY ("orgId", "saleId") REFERENCES "Sale"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_orgId_productId_fkey" FOREIGN KEY ("orgId", "productId") REFERENCES "Product"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_orgId_variantId_fkey" FOREIGN KEY ("orgId", "variantId") REFERENCES "ProductVariant"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orgId_saleId_fkey" FOREIGN KEY ("orgId", "saleId") REFERENCES "Sale"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orgId_saleId_fkey" FOREIGN KEY ("orgId", "saleId") REFERENCES "Sale"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orgId_shiftId_fkey" FOREIGN KEY ("orgId", "shiftId") REFERENCES "RegisterShift"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_orgId_refundId_fkey" FOREIGN KEY ("orgId", "refundId") REFERENCES "Refund"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_orgId_saleItemId_fkey" FOREIGN KEY ("orgId", "saleItemId") REFERENCES "SaleItem"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterShift" ADD CONSTRAINT "RegisterShift_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterShift" ADD CONSTRAINT "RegisterShift_orgId_branchId_fkey" FOREIGN KEY ("orgId", "branchId") REFERENCES "Branch"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterShift" ADD CONSTRAINT "RegisterShift_orgId_branchId_registerId_fkey" FOREIGN KEY ("orgId", "branchId", "registerId") REFERENCES "Register"("orgId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_orgId_shiftId_fkey" FOREIGN KEY ("orgId", "shiftId") REFERENCES "RegisterShift"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════
-- Hand-written invariants (not expressible in schema.prisma).
-- See docs/product/business-rules.md. Do not relax these to make tests pass.
-- ════════════════════════════════════════════════════════════════════

-- ── CHECK constraints: integer money is non-negative, quantities positive ──
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_vatRateBp_range" CHECK ("vatRateBp" BETWEEN 0 AND 10000);

ALTER TABLE "Product" ADD CONSTRAINT "Product_money_nonneg" CHECK ("priceMinor" >= 0 AND "costMinor" >= 0);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_money_nonneg"
  CHECK (("priceMinor" IS NULL OR "priceMinor" >= 0) AND ("costMinor" IS NULL OR "costMinor" >= 0));

ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_qtyDelta_nonzero" CHECK ("qtyDelta" <> 0);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_transfer_grouped"
  CHECK ("reason" NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') OR "transferGroupId" IS NOT NULL);

ALTER TABLE "POItem" ADD CONSTRAINT "POItem_qty_valid"
  CHECK ("qtyOrdered" > 0 AND "qtyReceived" >= 0 AND "qtyReceived" <= "qtyOrdered" AND "unitCostMinor" >= 0);
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_qty_valid"
  CHECK ("qtyReceived" > 0 AND "unitCostMinor" >= 0);

ALTER TABLE "Sale" ADD CONSTRAINT "Sale_money_nonneg"
  CHECK ("subtotalMinor" >= 0 AND "discountMinor" >= 0 AND "vatMinor" >= 0 AND "totalMinor" >= 0);
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_void_fields"
  CHECK (("status" = 'VOIDED') = ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL));
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_values_valid"
  CHECK ("qty" > 0 AND "unitPriceMinor" >= 0 AND "discountMinor" >= 0 AND "vatRateBp" BETWEEN 0 AND 10000
         AND "vatMinor" >= 0 AND "lineTotalMinor" >= 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_money_valid" CHECK ("totalMinor" > 0 AND "vatMinor" >= 0);
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_values_valid" CHECK ("qty" > 0 AND "amountMinor" >= 0 AND "vatMinor" >= 0);

ALTER TABLE "RegisterShift" ADD CONSTRAINT "RegisterShift_money_nonneg"
  CHECK ("openingFloatMinor" >= 0 AND ("countedCashMinor" IS NULL OR "countedCashMinor" >= 0));
-- A closed shift carries its full close record; a non-zero discrepancy needs a note (journey J4).
ALTER TABLE "RegisterShift" ADD CONSTRAINT "RegisterShift_close_record"
  CHECK ("status" = 'OPEN' OR (
    "closedAt" IS NOT NULL AND "closedById" IS NOT NULL
    AND "expectedCashMinor" IS NOT NULL AND "countedCashMinor" IS NOT NULL
    AND "discrepancyMinor" = "countedCashMinor" - "expectedCashMinor"
    AND ("discrepancyMinor" = 0 OR length(trim(coalesce("discrepancyNote", ''))) > 0)
  ));
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_amount_positive" CHECK ("amountMinor" > 0);

-- ── At most one OPEN shift per register ──
CREATE UNIQUE INDEX "RegisterShift_one_open_per_register" ON "RegisterShift"("orgId", "registerId") WHERE "status" = 'OPEN';

-- ── Append-only tables: ledger, audit, sale lines, payments, refunds ──
CREATE FUNCTION pos_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on "%" is not allowed: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "InventoryMovement_append_only" BEFORE UPDATE OR DELETE ON "InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "InventoryMovement_no_truncate" BEFORE TRUNCATE ON "InventoryMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "AuditEvent_append_only" BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "AuditEvent_no_truncate" BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "SaleItem_append_only" BEFORE UPDATE OR DELETE ON "SaleItem"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "Payment_append_only" BEFORE UPDATE OR DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "Refund_append_only" BEFORE UPDATE OR DELETE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();
CREATE TRIGGER "RefundItem_append_only" BEFORE UPDATE OR DELETE ON "RefundItem"
  FOR EACH ROW EXECUTE FUNCTION pos_reject_mutation();

-- ── Sale: never deleted; the only allowed update is COMPLETED → VOIDED ──
CREATE FUNCTION pos_guard_sale_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on "Sale" is not allowed; void the sale instead';
  END IF;
  IF OLD."status" <> 'COMPLETED' OR NEW."status" <> 'VOIDED'
     OR (to_jsonb(NEW) - ARRAY['status', 'voidedAt', 'voidedById', 'voidReason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'voidedAt', 'voidedById', 'voidReason']) THEN
    RAISE EXCEPTION 'Sale % may only transition COMPLETED -> VOIDED; financial fields are immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Sale_guard" BEFORE UPDATE OR DELETE ON "Sale"
  FOR EACH ROW EXECUTE FUNCTION pos_guard_sale_update();

-- ── RegisterShift: closed shifts are immutable and never deleted ──
CREATE FUNCTION pos_guard_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on "RegisterShift" is not allowed';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'RegisterShift % is closed and immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "RegisterShift_guard" BEFORE UPDATE OR DELETE ON "RegisterShift"
  FOR EACH ROW EXECUTE FUNCTION pos_guard_shift();

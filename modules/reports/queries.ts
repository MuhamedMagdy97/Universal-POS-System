import "server-only";
import { getDb } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { divideRoundHalfUp } from "@/lib/money";
import { col, inRange, inScope, localDay, num, type ReportScope } from "./sql";

/**
 * The eight canned reports (P1). Each is one or two `$queryRaw` statements over stored integer
 * amounts; nothing is recomputed from prices (P10). Which rows count: a sale on its own local day
 * and only while COMPLETED; a refund on its own day (P3). See reports-audit-data-model-and-api.md §3–§4.
 */

type Big = bigint | number | null;

export const PAYMENT_METHODS = ["CASH", "CARD_MANUAL", "WALLET"] as const;
export type PaymentMethodName = (typeof PAYMENT_METHODS)[number];

// ---------- sales-summary ----------

export type SalesSummaryRow = {
  day: string;
  salesCount: number;
  grossMinor: number;
  vatMinor: number;
  netMinor: number;
  refundsCount: number;
  refundsMinor: number;
  voidsCount: number;
  voidsMinor: number;
  netAfterRefundsMinor: number;
};

export async function salesSummary(scope: ReportScope): Promise<SalesSummaryRow[]> {
  const rows = await getDb().$queryRaw<
    { day: string; sn: Big; sg: Big; sv: Big; snet: Big; rn: Big; ra: Big; vn: Big; va: Big }[]
  >`
    WITH s AS (
      SELECT ${localDay(col("s", "createdAt"), scope.zone)} AS day, COUNT(*) AS n, SUM(s."totalMinor") AS gross,
             SUM(s."vatMinor") AS vat, SUM(s."subtotalMinor") AS net
      FROM "Sale" s
      WHERE ${inScope("s", scope)} AND s."status" = 'COMPLETED' AND ${inRange(col("s", "createdAt"), scope)}
      GROUP BY 1
    ), r AS (
      SELECT ${localDay(col("r", "createdAt"), scope.zone)} AS day, COUNT(*) AS n, SUM(r."totalMinor") AS amount
      FROM "Refund" r
      WHERE ${inScope("r", scope)} AND ${inRange(col("r", "createdAt"), scope)}
      GROUP BY 1
    ), v AS (
      SELECT ${localDay(col("s", "voidedAt"), scope.zone)} AS day, COUNT(*) AS n, SUM(s."totalMinor") AS amount
      FROM "Sale" s
      WHERE ${inScope("s", scope)} AND s."status" = 'VOIDED' AND ${inRange(col("s", "voidedAt"), scope)}
      GROUP BY 1
    ), days AS (SELECT day FROM s UNION SELECT day FROM r UNION SELECT day FROM v)
    SELECT d.day, s.n AS sn, s.gross AS sg, s.vat AS sv, s.net AS snet, r.n AS rn, r.amount AS ra, v.n AS vn, v.amount AS va
    FROM days d LEFT JOIN s USING (day) LEFT JOIN r USING (day) LEFT JOIN v USING (day)
    ORDER BY d.day`;
  return rows.map((row) => {
    const grossMinor = num(row.sg);
    const refundsMinor = num(row.ra);
    return {
      day: row.day,
      salesCount: num(row.sn),
      grossMinor,
      vatMinor: num(row.sv),
      netMinor: num(row.snet),
      refundsCount: num(row.rn),
      refundsMinor,
      voidsCount: num(row.vn),
      voidsMinor: num(row.va),
      netAfterRefundsMinor: grossMinor - refundsMinor,
    };
  });
}

// ---------- payments ----------

export type PaymentsRow = {
  method: PaymentMethodName;
  salesCount: number;
  salesMinor: number;
  refundsCount: number;
  refundsMinor: number;
  netMinor: number;
};

export async function payments(scope: ReportScope): Promise<PaymentsRow[]> {
  const db = getDb();
  // Payment rows hold the applied amount, so cash change is never counted.
  const sold = await db.$queryRaw<{ method: string; n: Big; amount: Big }[]>`
    SELECT p."method"::text AS method, COUNT(DISTINCT p."saleId") AS n, SUM(p."amountMinor") AS amount
    FROM "Payment" p JOIN "Sale" s ON s."orgId" = p."orgId" AND s."id" = p."saleId"
    WHERE ${inScope("s", scope)} AND s."status" = 'COMPLETED' AND ${inRange(col("s", "createdAt"), scope)}
    GROUP BY 1`;
  const refunded = await db.$queryRaw<{ method: string; n: Big; amount: Big }[]>`
    SELECT r."method"::text AS method, COUNT(*) AS n, SUM(r."totalMinor") AS amount
    FROM "Refund" r
    WHERE ${inScope("r", scope)} AND ${inRange(col("r", "createdAt"), scope)}
    GROUP BY 1`;
  return PAYMENT_METHODS.map((method) => {
    const s = sold.find((row) => row.method === method);
    const r = refunded.find((row) => row.method === method);
    const salesMinor = num(s?.amount);
    const refundsMinor = num(r?.amount);
    return {
      method,
      salesCount: num(s?.n),
      salesMinor,
      refundsCount: num(r?.n),
      refundsMinor,
      netMinor: salesMinor - refundsMinor,
    };
  });
}

// ---------- line facts: products, categories, VAT ----------

/**
 * Sale lines of completed sales in range, and refund lines of refunds in range, as one set.
 * Refund lines carry the product and VAT rate of the sale line they refund.
 */
function lineFacts(scope: ReportScope): Prisma.Sql {
  return Prisma.sql`
    SELECT si."productId", si."variantId", si."vatRateBp" AS rate,
           si."qty" AS sq, si."lineTotalMinor" AS sa, si."vatMinor" AS sv, 0 AS rq, 0 AS ra, 0 AS rv
    FROM "SaleItem" si JOIN "Sale" s ON s."orgId" = si."orgId" AND s."id" = si."saleId"
    WHERE ${inScope("s", scope)} AND s."status" = 'COMPLETED' AND ${inRange(col("s", "createdAt"), scope)}
    UNION ALL
    SELECT si."productId", si."variantId", si."vatRateBp",
           0, 0, 0, ri."qty", ri."amountMinor", ri."vatMinor"
    FROM "RefundItem" ri
    JOIN "Refund" r ON r."orgId" = ri."orgId" AND r."id" = ri."refundId"
    JOIN "SaleItem" si ON si."orgId" = ri."orgId" AND si."id" = ri."saleItemId"
    WHERE ${inScope("r", scope)} AND ${inRange(col("r", "createdAt"), scope)}`;
}

type LineTotals = { qtySold: number; qtyRefunded: number; grossMinor: number; refundsMinor: number; netMinor: number };

function lineTotals(row: { sq: Big; sa: Big; rq: Big; ra: Big }): LineTotals {
  const grossMinor = num(row.sa);
  const refundsMinor = num(row.ra);
  return {
    qtySold: num(row.sq),
    qtyRefunded: num(row.rq),
    grossMinor,
    refundsMinor,
    netMinor: grossMinor - refundsMinor,
  };
}

export type ProductsRow = LineTotals & {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  nameAr: string | null;
};

const byNetDesc = <T extends { netMinor: number; name: string }>(a: T, b: T) =>
  b.netMinor - a.netMinor || a.name.localeCompare(b.name);

/** Names and SKU are the current catalog ones, so a renamed product stays one row (§11.1). */
export async function products(scope: ReportScope): Promise<ProductsRow[]> {
  const rows = await getDb().$queryRaw<
    {
      productId: string;
      variantId: string | null;
      sq: Big;
      sa: Big;
      rq: Big;
      ra: Big;
      psku: string;
      pname: string;
      pnameAr: string | null;
      vsku: string | null;
      vname: string | null;
      vnameAr: string | null;
    }[]
  >`
    WITH f AS (${lineFacts(scope)}),
    k AS (
      SELECT "productId", "variantId", SUM(sq) AS sq, SUM(sa) AS sa, SUM(rq) AS rq, SUM(ra) AS ra
      FROM f GROUP BY 1, 2
    )
    SELECT k.*, p."sku" AS psku, p."name" AS pname, p."nameAr" AS "pnameAr",
           v."sku" AS vsku, v."name" AS vname, v."nameAr" AS "vnameAr"
    FROM k
    JOIN "Product" p ON p."orgId" = ${scope.orgId}::uuid AND p."id" = k."productId"
    LEFT JOIN "ProductVariant" v ON v."orgId" = ${scope.orgId}::uuid AND v."id" = k."variantId"`;
  return rows
    .map((row) => ({
      productId: row.productId,
      variantId: row.variantId,
      sku: row.vsku ?? row.psku,
      name: row.vname === null ? row.pname : `${row.pname} — ${row.vname}`,
      nameAr:
        row.pnameAr === null ? null : row.vname === null ? row.pnameAr : `${row.pnameAr} — ${row.vnameAr ?? row.vname}`,
      ...lineTotals(row),
    }))
    .sort(byNetDesc);
}

export type CategoriesRow = LineTotals & { categoryId: string | null; name: string; nameAr: string | null };

/** By the product's current category; no category is one row with `categoryId: null` (§11.1). */
export async function categories(scope: ReportScope): Promise<CategoriesRow[]> {
  const rows = await getDb().$queryRaw<
    { categoryId: string | null; sq: Big; sa: Big; rq: Big; ra: Big; name: string | null; nameAr: string | null }[]
  >`
    WITH f AS (${lineFacts(scope)}),
    k AS (
      SELECT p."categoryId", SUM(f.sq) AS sq, SUM(f.sa) AS sa, SUM(f.rq) AS rq, SUM(f.ra) AS ra
      FROM f JOIN "Product" p ON p."orgId" = ${scope.orgId}::uuid AND p."id" = f."productId"
      GROUP BY 1
    )
    SELECT k.*, c."name", c."nameAr"
    FROM k LEFT JOIN "Category" c ON c."orgId" = ${scope.orgId}::uuid AND c."id" = k."categoryId"`;
  return rows
    .map((row) => ({ categoryId: row.categoryId, name: row.name ?? "", nameAr: row.nameAr, ...lineTotals(row) }))
    .sort(byNetDesc);
}

export type VatRow = {
  rateBp: number;
  netSalesMinor: number;
  vatSalesMinor: number;
  netRefundsMinor: number;
  vatRefundsMinor: number;
  netVatMinor: number;
};

/** Output VAT by rate. Rate 0 covers zero-rated and exempt alike (no category snapshot, §11.2). */
export async function vat(scope: ReportScope): Promise<VatRow[]> {
  const rows = await getDb().$queryRaw<{ rate: number; sa: Big; sv: Big; ra: Big; rv: Big }[]>`
    WITH f AS (${lineFacts(scope)})
    SELECT rate, SUM(sa) AS sa, SUM(sv) AS sv, SUM(ra) AS ra, SUM(rv) AS rv
    FROM f GROUP BY 1 ORDER BY 1 DESC`;
  return rows.map((row) => {
    const vatSalesMinor = num(row.sv);
    const vatRefundsMinor = num(row.rv);
    return {
      rateBp: Number(row.rate),
      netSalesMinor: num(row.sa) - vatSalesMinor,
      vatSalesMinor,
      netRefundsMinor: num(row.ra) - vatRefundsMinor,
      vatRefundsMinor,
      netVatMinor: vatSalesMinor - vatRefundsMinor,
    };
  });
}

// ---------- cashiers ----------

export type CashiersRow = {
  userId: string;
  name: string;
  salesCount: number;
  grossMinor: number;
  averageMinor: number;
  refundsCount: number;
  refundsMinor: number;
};

/** Sales by `Sale.cashierId`, refunds by `Refund.processedById`. */
export async function cashiers(scope: ReportScope): Promise<CashiersRow[]> {
  const rows = await getDb().$queryRaw<{ userId: string; name: string; sn: Big; sa: Big; rn: Big; ra: Big }[]>`
    WITH f AS (
      SELECT s."cashierId" AS "userId", 1 AS sn, s."totalMinor" AS sa, 0 AS rn, 0 AS ra
      FROM "Sale" s
      WHERE ${inScope("s", scope)} AND s."status" = 'COMPLETED' AND ${inRange(col("s", "createdAt"), scope)}
      UNION ALL
      SELECT r."processedById", 0, 0, 1, r."totalMinor"
      FROM "Refund" r
      WHERE ${inScope("r", scope)} AND ${inRange(col("r", "createdAt"), scope)}
    )
    SELECT f."userId", u."name", SUM(sn) AS sn, SUM(sa) AS sa, SUM(rn) AS rn, SUM(ra) AS ra
    FROM f JOIN "User" u ON u."id" = f."userId"
    GROUP BY 1, 2`;
  return rows
    .map((row) => {
      const salesCount = num(row.sn);
      const grossMinor = num(row.sa);
      return {
        userId: row.userId,
        name: row.name,
        salesCount,
        grossMinor,
        averageMinor: salesCount === 0 ? 0 : Number(divideRoundHalfUp(BigInt(grossMinor), BigInt(salesCount))),
        refundsCount: num(row.rn),
        refundsMinor: num(row.ra),
      };
    })
    .sort((a, b) => b.grossMinor - a.grossMinor || a.name.localeCompare(b.name));
}

// ---------- shifts ----------

export type ShiftsRow = {
  shiftId: string;
  registerName: string;
  status: "OPEN" | "CLOSED";
  openedAt: Date;
  openedBy: string;
  closedAt: Date | null;
  closedBy: string | null;
  openingFloatMinor: number;
  cashSalesMinor: number;
  payInMinor: number;
  payOutMinor: number;
  dropMinor: number;
  cashRefundsMinor: number;
  expectedCashMinor: number;
  countedCashMinor: number | null;
  discrepancyMinor: number | null;
  discrepancyNote: string | null;
};

/**
 * Z-report per shift opened in range (§11.3). The cash terms are the shift close's formula
 * (registers `cashBreakdown`) in one set-based query; a closed shift reports its stored expected
 * cash, an open one the live figure. Tests check both against the registers module.
 */
export async function shifts(scope: ReportScope): Promise<ShiftsRow[]> {
  const rows = await getDb().$queryRaw<
    {
      shiftId: string;
      registerName: string;
      status: "OPEN" | "CLOSED";
      openedAt: Date;
      openedBy: string;
      closedAt: Date | null;
      closedBy: string | null;
      openingFloatMinor: number;
      expectedCashMinor: number | null;
      countedCashMinor: number | null;
      discrepancyMinor: number | null;
      discrepancyNote: string | null;
      cashSales: Big;
      payIn: Big;
      payOut: Big;
      drops: Big;
      cashRefunds: Big;
    }[]
  >`
    SELECT sh."id" AS "shiftId", rg."name" AS "registerName", sh."status"::text AS status,
           sh."openedAt", ou."name" AS "openedBy", sh."closedAt", cu."name" AS "closedBy",
           sh."openingFloatMinor", sh."expectedCashMinor", sh."countedCashMinor", sh."discrepancyMinor",
           sh."discrepancyNote",
           (SELECT SUM(p."amountMinor") FROM "Payment" p
              JOIN "Sale" s ON s."orgId" = p."orgId" AND s."id" = p."saleId"
             WHERE s."orgId" = sh."orgId" AND s."shiftId" = sh."id" AND s."status" = 'COMPLETED'
               AND p."method" = 'CASH') AS "cashSales",
           cm."payIn", cm."payOut", cm."drops",
           (SELECT SUM(r."totalMinor") FROM "Refund" r
             WHERE r."orgId" = sh."orgId" AND r."shiftId" = sh."id" AND r."method" = 'CASH') AS "cashRefunds"
    FROM "RegisterShift" sh
    JOIN "Register" rg ON rg."orgId" = sh."orgId" AND rg."id" = sh."registerId"
    JOIN "User" ou ON ou."id" = sh."openedById"
    LEFT JOIN "User" cu ON cu."id" = sh."closedById"
    LEFT JOIN LATERAL (
      SELECT SUM(m."amountMinor") FILTER (WHERE m."type" = 'PAY_IN') AS "payIn",
             SUM(m."amountMinor") FILTER (WHERE m."type" = 'PAY_OUT') AS "payOut",
             SUM(m."amountMinor") FILTER (WHERE m."type" = 'DROP') AS "drops"
      FROM "CashMovement" m WHERE m."orgId" = sh."orgId" AND m."shiftId" = sh."id"
    ) cm ON TRUE
    WHERE ${inScope("sh", scope)} AND ${inRange(col("sh", "openedAt"), scope)}
    ORDER BY sh."openedAt", sh."id"`;
  return rows.map((row) => {
    const cashSalesMinor = num(row.cashSales);
    const payInMinor = num(row.payIn);
    const payOutMinor = num(row.payOut);
    const dropMinor = num(row.drops);
    const cashRefundsMinor = num(row.cashRefunds);
    const live = row.openingFloatMinor + cashSalesMinor + payInMinor - payOutMinor - dropMinor - cashRefundsMinor;
    return {
      shiftId: row.shiftId,
      registerName: row.registerName,
      status: row.status,
      openedAt: row.openedAt,
      openedBy: row.openedBy,
      closedAt: row.closedAt,
      closedBy: row.closedBy,
      openingFloatMinor: row.openingFloatMinor,
      cashSalesMinor,
      payInMinor,
      payOutMinor,
      dropMinor,
      cashRefundsMinor,
      expectedCashMinor: row.expectedCashMinor ?? live,
      countedCashMinor: row.countedCashMinor,
      discrepancyMinor: row.discrepancyMinor,
      discrepancyNote: row.discrepancyNote,
    };
  });
}

// ---------- refunds-voids ----------

export type RefundsVoidsRow = {
  kind: "REFUND" | "VOID";
  id: string;
  at: Date;
  saleNumber: string;
  totalMinor: number;
  vatMinor: number;
  method: PaymentMethodName | null;
  reference: string | null;
  reason: string;
  byName: string;
  registerName: string | null;
};

export async function refundsVoids(scope: ReportScope): Promise<RefundsVoidsRow[]> {
  const rows = await getDb().$queryRaw<
    (Omit<RefundsVoidsRow, "totalMinor" | "vatMinor"> & { totalMinor: number; vatMinor: number })[]
  >`
    SELECT 'REFUND' AS kind, r."id", r."createdAt" AS at, s."number" AS "saleNumber", r."totalMinor", r."vatMinor",
           r."method"::text AS method, r."reference", r."reason", u."name" AS "byName", rg."name" AS "registerName"
    FROM "Refund" r
    JOIN "Sale" s ON s."orgId" = r."orgId" AND s."id" = r."saleId"
    JOIN "User" u ON u."id" = r."processedById"
    LEFT JOIN "RegisterShift" sh ON sh."orgId" = r."orgId" AND sh."id" = r."shiftId"
    LEFT JOIN "Register" rg ON rg."orgId" = sh."orgId" AND rg."id" = sh."registerId"
    WHERE ${inScope("r", scope)} AND ${inRange(col("r", "createdAt"), scope)}
    UNION ALL
    SELECT 'VOID', s."id", s."voidedAt", s."number", s."totalMinor", s."vatMinor",
           NULL, NULL, COALESCE(s."voidReason", ''), u."name", rg."name"
    FROM "Sale" s
    JOIN "User" u ON u."id" = s."voidedById"
    JOIN "Register" rg ON rg."orgId" = s."orgId" AND rg."id" = s."registerId"
    WHERE ${inScope("s", scope)} AND s."status" = 'VOIDED' AND ${inRange(col("s", "voidedAt"), scope)}
    ORDER BY 3 DESC, 2 DESC`;
  return rows.map((row) => ({ ...row, totalMinor: Number(row.totalMinor), vatMinor: Number(row.vatMinor) }));
}

// ---------- dashboard ----------

/** Open shifts right now in the given branches (dashboard tile). */
export async function openShiftCount(orgId: string, branchIds: string[]): Promise<number> {
  return getDb().registerShift.count({ where: { orgId, branchId: { in: branchIds }, status: "OPEN" } });
}

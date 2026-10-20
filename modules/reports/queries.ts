import "server-only";
import { getDb } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { divideRoundHalfUp } from "@/lib/money";
import { marginBp } from "./columns";
import { col, inRange, inScope, localDay, localMidnight, num, type ReportScope } from "./sql";

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
  /** Taken off shelf prices on these sales (discounts-spec DC15); `grossMinor` is already after it. */
  discountsMinor: number;
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
    { day: string; sn: Big; sd: Big; sg: Big; sv: Big; snet: Big; rn: Big; ra: Big; vn: Big; va: Big }[]
  >`
    WITH s AS (
      SELECT ${localDay(col("s", "createdAt"), scope.zone)} AS day, COUNT(*) AS n, SUM(s."totalMinor") AS gross,
             SUM(s."discountMinor") AS disc, SUM(s."vatMinor") AS vat, SUM(s."subtotalMinor") AS net
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
    SELECT d.day, s.n AS sn, s.disc AS sd, s.gross AS sg, s.vat AS sv, s.net AS snet, r.n AS rn, r.amount AS ra, v.n AS vn, v.amount AS va
    FROM days d LEFT JOIN s USING (day) LEFT JOIN r USING (day) LEFT JOIN v USING (day)
    ORDER BY d.day`;
  return rows.map((row) => {
    const grossMinor = num(row.sg);
    const refundsMinor = num(row.ra);
    return {
      day: row.day,
      salesCount: num(row.sn),
      discountsMinor: num(row.sd),
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

// ---------- profit: products, categories, days (P12) ----------

/**
 * `lineFacts` with net-of-VAT revenue and cost (profit-margin-spec.md M1–M5). A sale line's cost
 * is its `unitCostMinor × qty`; a refund line reverses `unitCostMinor × refunded qty` of the sale
 * line it refunds, on the refund's day. `cost` is NULL when the sale line has no cost (M2, M6).
 * Products and categories skip the local-day conversion they do not group by.
 */
function profitFacts(scope: ReportScope, byDay: boolean): Prisma.Sql {
  const saleDay = byDay ? localDay(col("s", "createdAt"), scope.zone) : Prisma.sql`NULL::text`;
  const refundDay = byDay ? localDay(col("r", "createdAt"), scope.zone) : Prisma.sql`NULL::text`;
  return Prisma.sql`
    SELECT si."productId", si."variantId", ${saleDay} AS day, si."qty" AS sq, 0 AS rq,
           (si."lineTotalMinor" - si."vatMinor")::bigint AS net,
           si."unitCostMinor"::bigint * si."qty" AS cost,
           CASE WHEN si."unitCostMinor" IS NULL THEN 1 ELSE 0 END AS nc
    FROM "SaleItem" si JOIN "Sale" s ON s."orgId" = si."orgId" AND s."id" = si."saleId"
    WHERE ${inScope("s", scope)} AND s."status" = 'COMPLETED' AND ${inRange(col("s", "createdAt"), scope)}
    UNION ALL
    SELECT si."productId", si."variantId", ${refundDay}, 0, ri."qty",
           -(ri."amountMinor" - ri."vatMinor")::bigint,
           -(si."unitCostMinor"::bigint * ri."qty"),
           0
    FROM "RefundItem" ri
    JOIN "Refund" r ON r."orgId" = ri."orgId" AND r."id" = ri."refundId"
    JOIN "SaleItem" si ON si."orgId" = ri."orgId" AND si."id" = ri."saleItemId"
    WHERE ${inScope("r", scope)} AND ${inRange(col("r", "createdAt"), scope)}`;
}

const PROFIT_SUMS = Prisma.sql`SUM(f.sq) AS sq, SUM(f.rq) AS rq, SUM(f.net) AS net,
  SUM(f.net) FILTER (WHERE f.cost IS NOT NULL) AS netc, SUM(f.cost) AS cost, SUM(f.nc) AS nc`;

type ProfitSums = { sq: Big; rq: Big; net: Big; netc: Big; cost: Big; nc: Big };

export type ProfitTotals = {
  qtySold: number;
  qtyRefunded: number;
  netRevenueMinor: number;
  revenueNoCostMinor: number;
  costMinor: number;
  grossProfitMinor: number;
  marginBp: number | null;
};

/** Profit and margin only over revenue that has a cost; the rest is shown apart (M2, M5). */
function profitTotals(row: ProfitSums): ProfitTotals {
  const netRevenueMinor = num(row.net);
  const withCost = num(row.netc);
  const costMinor = num(row.cost);
  const grossProfitMinor = withCost - costMinor;
  return {
    qtySold: num(row.sq),
    qtyRefunded: num(row.rq),
    netRevenueMinor,
    revenueNoCostMinor: netRevenueMinor - withCost,
    costMinor,
    grossProfitMinor,
    marginBp: marginBp(grossProfitMinor, withCost),
  };
}

const byProfitDesc = <T extends { grossProfitMinor: number; netRevenueMinor: number; name: string }>(a: T, b: T) =>
  b.grossProfitMinor - a.grossProfitMinor || b.netRevenueMinor - a.netRevenueMinor || a.name.localeCompare(b.name);

export type ProfitProductsRow = ProfitTotals & {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  nameAr: string | null;
};

/** Names and SKU are the current catalog ones, as in `products`. */
export async function profitProducts(scope: ReportScope): Promise<ProfitProductsRow[]> {
  const rows = await getDb().$queryRaw<
    (ProfitSums & {
      productId: string;
      variantId: string | null;
      psku: string;
      pname: string;
      pnameAr: string | null;
      vsku: string | null;
      vname: string | null;
      vnameAr: string | null;
    })[]
  >`
    WITH f AS (${profitFacts(scope, false)}),
    k AS (SELECT f."productId", f."variantId", ${PROFIT_SUMS} FROM f GROUP BY 1, 2)
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
      ...profitTotals(row),
    }))
    .sort(byProfitDesc);
}

export type ProfitCategoriesRow = ProfitTotals & { categoryId: string | null; name: string; nameAr: string | null };

/** By the product's current category, as in `categories`. */
export async function profitCategories(scope: ReportScope): Promise<ProfitCategoriesRow[]> {
  const rows = await getDb().$queryRaw<
    (ProfitSums & { categoryId: string | null; name: string | null; nameAr: string | null })[]
  >`
    WITH f AS (${profitFacts(scope, false)}),
    k AS (
      SELECT p."categoryId", ${PROFIT_SUMS}
      FROM f JOIN "Product" p ON p."orgId" = ${scope.orgId}::uuid AND p."id" = f."productId"
      GROUP BY 1
    )
    SELECT k.*, c."name", c."nameAr"
    FROM k LEFT JOIN "Category" c ON c."orgId" = ${scope.orgId}::uuid AND c."id" = k."categoryId"`;
  return rows
    .map((row) => ({ categoryId: row.categoryId, name: row.name ?? "", nameAr: row.nameAr, ...profitTotals(row) }))
    .sort(byProfitDesc);
}

export type ProfitDaysRow = ProfitTotals & { day: string; linesNoCost: number };

/** By the shop's local day; a refund counts on its own day, so a day can lose money (M3). */
export async function profitDays(scope: ReportScope): Promise<ProfitDaysRow[]> {
  const rows = await getDb().$queryRaw<(ProfitSums & { day: string })[]>`
    WITH f AS (${profitFacts(scope, true)})
    SELECT f.day, ${PROFIT_SUMS} FROM f GROUP BY 1 ORDER BY 1`;
  return rows.map((row) => ({ day: row.day, ...profitTotals(row), linesNoCost: num(row.nc) }));
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

// ---------- customers ----------

export type CustomersRow = {
  customerId: string;
  name: string;
  phone: string;
  salesCount: number;
  grossMinor: number;
  refundsCount: number;
  refundsMinor: number;
  netMinor: number;
};

/** Completed sales by `Sale.customerId` on their day, refunds of those customers' sales on theirs (CU15). */
export async function customers(scope: ReportScope): Promise<CustomersRow[]> {
  const rows = await getDb().$queryRaw<
    { customerId: string; name: string; phone: string; sn: Big; sa: Big; rn: Big; ra: Big }[]
  >`
    WITH f AS (
      SELECT s."customerId", 1 AS sn, s."totalMinor" AS sa, 0 AS rn, 0 AS ra
      FROM "Sale" s
      WHERE ${inScope("s", scope)} AND s."customerId" IS NOT NULL AND s."status" = 'COMPLETED'
        AND ${inRange(col("s", "createdAt"), scope)}
      UNION ALL
      SELECT s."customerId", 0, 0, 1, r."totalMinor"
      FROM "Refund" r JOIN "Sale" s ON s."orgId" = r."orgId" AND s."id" = r."saleId"
      WHERE ${inScope("r", scope)} AND s."customerId" IS NOT NULL AND ${inRange(col("r", "createdAt"), scope)}
    )
    SELECT f."customerId", c."name", c."phone", SUM(sn) AS sn, SUM(sa) AS sa, SUM(rn) AS rn, SUM(ra) AS ra
    FROM f JOIN "Customer" c ON c."orgId" = ${scope.orgId}::uuid AND c."id" = f."customerId"
    GROUP BY 1, 2, 3`;
  return rows
    .map((row) => {
      const grossMinor = num(row.sa);
      const refundsMinor = num(row.ra);
      return {
        customerId: row.customerId,
        name: row.name,
        phone: row.phone,
        salesCount: num(row.sn),
        grossMinor,
        refundsCount: num(row.rn),
        refundsMinor,
        netMinor: grossMinor - refundsMinor,
      };
    })
    .sort((a, b) => b.netMinor - a.netMinor || a.name.localeCompare(b.name));
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

// ---------- purchases (T5 P5) ----------

export type PurchasesRow = {
  day: string;
  supplierId: string;
  supplierName: string;
  receiptsCount: number;
  units: number;
  valueMinor: number;
  returnedUnits: number;
  returnedValueMinor: number;
  netValueMinor: number;
};

/**
 * Goods received per local day and supplier: receipts, units and value at the received unit cost.
 * Returns to the supplier go in their own columns on their own day, valued at the PO cost
 * (purchase-returns-spec R12); a day with only returns has a row with nothing received.
 */
export async function purchases(scope: ReportScope): Promise<PurchasesRow[]> {
  const rows = await getDb().$queryRaw<
    {
      day: string;
      supplierId: string;
      supplierName: string;
      n: Big;
      units: Big;
      value: Big;
      returnedUnits: Big;
      returnedValue: Big;
    }[]
  >`
    WITH received AS (
      SELECT ${localDay(col("g", "receivedAt"), scope.zone)} AS day, p."supplierId",
             COUNT(DISTINCT g."id") AS n, SUM(i."qtyReceived") AS units,
             SUM(i."qtyReceived"::bigint * i."unitCostMinor") AS value
      FROM "GoodsReceipt" g
      JOIN "GoodsReceiptItem" i ON i."orgId" = g."orgId" AND i."goodsReceiptId" = g."id"
      JOIN "PurchaseOrder" p ON p."orgId" = g."orgId" AND p."id" = g."purchaseOrderId"
      WHERE ${inScope("g", scope)} AND ${inRange(col("g", "receivedAt"), scope)}
      GROUP BY 1, 2
    ), returned AS (
      SELECT ${localDay(col("r", "returnedAt"), scope.zone)} AS day, p."supplierId",
             SUM(i."qty") AS units, SUM(i."qty"::bigint * i."unitCostMinor") AS value
      FROM "PurchaseReturn" r
      JOIN "PurchaseReturnItem" i ON i."orgId" = r."orgId" AND i."purchaseReturnId" = r."id"
      JOIN "PurchaseOrder" p ON p."orgId" = r."orgId" AND p."id" = r."purchaseOrderId"
      WHERE ${inScope("r", scope)} AND ${inRange(col("r", "returnedAt"), scope)}
      GROUP BY 1, 2
    )
    SELECT COALESCE(rc.day, rt.day) AS day, s."id"::text AS "supplierId", s."name" AS "supplierName",
           rc.n, rc.units, rc.value, rt.units AS "returnedUnits", rt.value AS "returnedValue"
    FROM received rc
    FULL OUTER JOIN returned rt ON rt.day = rc.day AND rt."supplierId" = rc."supplierId"
    JOIN "Supplier" s ON s."orgId" = ${scope.orgId}::uuid AND s."id" = COALESCE(rc."supplierId", rt."supplierId")
    ORDER BY 1, s."name", s."id"`;
  return rows.map((row) => {
    const valueMinor = num(row.value);
    const returnedValueMinor = num(row.returnedValue);
    return {
      day: row.day,
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      receiptsCount: num(row.n),
      units: num(row.units),
      valueMinor,
      returnedUnits: num(row.returnedUnits),
      returnedValueMinor,
      netValueMinor: valueMinor - returnedValueMinor,
    };
  });
}

// ---------- supplier balances (supplier-payments-spec S14) ----------

export type SupplierBalanceRow = {
  supplierId: string;
  supplierName: string;
  openingMinor: number;
  receivedMinor: number;
  returnedMinor: number;
  /** Invoices and credit notes beyond the at-cost value they replace, net of voids (supplier-invoices-spec I7). */
  adjustedMinor: number;
  paidMinor: number;
  closingMinor: number;
  /** Receipts on no live invoice at the end of the range, at cost (I8). Not part of the closing sum. */
  uninvoicedMinor: number;
};

/**
 * One row per supplier with an opening balance or movements in the range. The account is org-wide
 * (S2): every branch counts and `scope.branchIds` is not applied. Paid is net of reversals. Mirrors
 * `balanceEffect` in modules/purchasing/rules.ts: an invoice adds its total less the receipts it
 * covers on its issue day, a credit note the reverse, and a void undoes it on the void's local day.
 */
export async function supplierBalances(scope: ReportScope): Promise<SupplierBalanceRow[]> {
  const start = localMidnight(scope.from, scope.zone);
  const end = localMidnight(scope.to, scope.zone, 1);
  const rows = await getDb().$queryRaw<
    {
      supplierId: string;
      supplierName: string;
      opening: Big;
      received: Big;
      returned: Big;
      adjusted: Big;
      paid: Big;
      uninvoiced: Big | null;
    }[]
  >`
    WITH rvalue AS (
      SELECT i."goodsReceiptId" AS id, SUM(i."qtyReceived"::bigint * i."unitCostMinor") AS v
      FROM "GoodsReceiptItem" i WHERE i."orgId" = ${scope.orgId}::uuid GROUP BY 1
    ), tvalue AS (
      SELECT i."purchaseReturnId" AS id, SUM(i."qty"::bigint * i."unitCostMinor") AS v
      FROM "PurchaseReturnItem" i WHERE i."orgId" = ${scope.orgId}::uuid GROUP BY 1
    ), docs AS (
      SELECT d."supplierId", d."issuedOn", d."voidedAt",
             (CASE WHEN d."kind" = 'INVOICE' THEN 1 ELSE -1 END)
               * (d."totalMinor" - COALESCE(CASE WHEN d."kind" = 'INVOICE'
                   THEN (SELECT SUM(rv.v) FROM "SupplierInvoiceReceipt" l JOIN rvalue rv ON rv.id = l."goodsReceiptId"
                         WHERE l."orgId" = d."orgId" AND l."invoiceId" = d."id")
                   ELSE (SELECT tv.v FROM tvalue tv WHERE tv.id = d."purchaseReturnId") END, 0)) AS effect
      FROM "SupplierInvoice" d WHERE d."orgId" = ${scope.orgId}::uuid
    ), flows AS (
      SELECT p."supplierId", g."receivedAt" < ${start} AS early,
             rv.v AS received, 0::bigint AS returned, 0::bigint AS adjusted, 0::bigint AS paid
      FROM "GoodsReceipt" g
      JOIN rvalue rv ON rv.id = g."id"
      JOIN "PurchaseOrder" p ON p."orgId" = g."orgId" AND p."id" = g."purchaseOrderId"
      WHERE g."orgId" = ${scope.orgId}::uuid AND g."receivedAt" < ${end}
      UNION ALL
      SELECT p."supplierId", r."returnedAt" < ${start}, 0, tv.v, 0, 0
      FROM "PurchaseReturn" r
      JOIN tvalue tv ON tv.id = r."id"
      JOIN "PurchaseOrder" p ON p."orgId" = r."orgId" AND p."id" = r."purchaseOrderId"
      WHERE r."orgId" = ${scope.orgId}::uuid AND r."returnedAt" < ${end}
      UNION ALL
      SELECT d."supplierId", d."issuedOn" < ${scope.from}::date, 0, 0, d.effect, 0
      FROM docs d WHERE d."issuedOn" <= ${scope.to}::date
      UNION ALL
      SELECT d."supplierId", d."voidedAt" < ${start}, 0, 0, -d.effect, 0
      FROM docs d WHERE d."voidedAt" < ${end}
      UNION ALL
      SELECT sp."supplierId", sp."paidOn" < ${scope.from}::date, 0, 0, 0,
             CASE WHEN sp."reversalOfId" IS NULL THEN sp."amountMinor" ELSE -sp."amountMinor" END
      FROM "SupplierPayment" sp
      WHERE sp."orgId" = ${scope.orgId}::uuid AND sp."paidOn" <= ${scope.to}::date
    ), uninvoiced AS (
      SELECT p."supplierId", SUM(rv.v) AS v
      FROM "GoodsReceipt" g
      JOIN rvalue rv ON rv.id = g."id"
      JOIN "PurchaseOrder" p ON p."orgId" = g."orgId" AND p."id" = g."purchaseOrderId"
      WHERE g."orgId" = ${scope.orgId}::uuid AND g."receivedAt" < ${end}
        AND NOT EXISTS (
          SELECT 1 FROM "SupplierInvoiceReceipt" l
          JOIN "SupplierInvoice" d ON d."orgId" = l."orgId" AND d."id" = l."invoiceId"
          WHERE l."orgId" = g."orgId" AND l."goodsReceiptId" = g."id"
            AND d."issuedOn" <= ${scope.to}::date AND (d."voidedAt" IS NULL OR d."voidedAt" >= ${end}))
      GROUP BY 1
    )
    SELECT s."id"::text AS "supplierId", s."name" AS "supplierName",
           SUM(CASE WHEN f.early THEN f.received - f.returned + f.adjusted - f.paid ELSE 0 END) AS opening,
           SUM(CASE WHEN f.early THEN 0 ELSE f.received END) AS received,
           SUM(CASE WHEN f.early THEN 0 ELSE f.returned END) AS returned,
           SUM(CASE WHEN f.early THEN 0 ELSE f.adjusted END) AS adjusted,
           SUM(CASE WHEN f.early THEN 0 ELSE f.paid END) AS paid,
           MAX(u.v) AS uninvoiced
    FROM flows f
    JOIN "Supplier" s ON s."orgId" = ${scope.orgId}::uuid AND s."id" = f."supplierId"
    LEFT JOIN uninvoiced u ON u."supplierId" = s."id"
    GROUP BY s."id", s."name"
    HAVING bool_or(NOT f.early)
        OR SUM(CASE WHEN f.early THEN f.received - f.returned + f.adjusted - f.paid ELSE 0 END) <> 0
    ORDER BY s."name", s."id"`;
  return rows.map((row) => {
    const openingMinor = num(row.opening);
    const receivedMinor = num(row.received);
    const returnedMinor = num(row.returned);
    const adjustedMinor = num(row.adjusted);
    const paidMinor = num(row.paid);
    return {
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      openingMinor,
      receivedMinor,
      returnedMinor,
      adjustedMinor,
      paidMinor,
      closingMinor: openingMinor + receivedMinor - returnedMinor + adjustedMinor - paidMinor,
      uninvoicedMinor: num(row.uninvoiced),
    };
  });
}

export type InputVatRow = {
  month: string;
  invoicesCount: number;
  invoiceNetMinor: number;
  invoiceVatMinor: number;
  creditNetMinor: number;
  creditVatMinor: number;
  inputVatMinor: number;
  outputVatMinor: number;
  netVatMinor: number;
};

/** The shop-local `YYYY-MM` of a UTC timestamp column. */
function localMonth(column: Prisma.Sql, zone: string): Prisma.Sql {
  return Prisma.sql`to_char(((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${zone}::text), 'YYYY-MM')`;
}

/**
 * Input VAT by shop-local month of the issue date (supplier-invoices-spec I14), with the month's
 * output VAT (sales VAT − refund VAT over `scope.branchIds`, as the VAT summary) for net VAT. Voided
 * documents are left out. Issue dates are already shop-local days, so they need no time-zone shift.
 */
export async function inputVat(scope: ReportScope): Promise<InputVatRow[]> {
  const rows = await getDb().$queryRaw<
    { month: string; n: Big; inet: Big; ivat: Big; cnet: Big; cvat: Big; out: Big }[]
  >`
    WITH f AS (
      SELECT to_char(d."issuedOn", 'YYYY-MM') AS month,
             (d."kind" = 'INVOICE')::int AS n,
             CASE WHEN d."kind" = 'INVOICE' THEN d."netMinor" ELSE 0 END AS inet,
             CASE WHEN d."kind" = 'INVOICE' THEN d."vatMinor" ELSE 0 END AS ivat,
             CASE WHEN d."kind" = 'CREDIT_NOTE' THEN d."netMinor" ELSE 0 END AS cnet,
             CASE WHEN d."kind" = 'CREDIT_NOTE' THEN d."vatMinor" ELSE 0 END AS cvat,
             0 AS out
      FROM "SupplierInvoice" d
      WHERE d."orgId" = ${scope.orgId}::uuid AND d."voidedAt" IS NULL
        AND d."issuedOn" BETWEEN ${scope.from}::date AND ${scope.to}::date
      UNION ALL
      SELECT ${localMonth(col("s", "createdAt"), scope.zone)}, 0, 0, 0, 0, 0, si."vatMinor"
      FROM "SaleItem" si JOIN "Sale" s ON s."orgId" = si."orgId" AND s."id" = si."saleId"
      WHERE ${inScope("s", scope)} AND s."status" = 'COMPLETED' AND ${inRange(col("s", "createdAt"), scope)}
      UNION ALL
      SELECT ${localMonth(col("r", "createdAt"), scope.zone)}, 0, 0, 0, 0, 0, -ri."vatMinor"
      FROM "RefundItem" ri JOIN "Refund" r ON r."orgId" = ri."orgId" AND r."id" = ri."refundId"
      WHERE ${inScope("r", scope)} AND ${inRange(col("r", "createdAt"), scope)}
    )
    SELECT month, SUM(n) AS n, SUM(inet) AS inet, SUM(ivat) AS ivat, SUM(cnet) AS cnet, SUM(cvat) AS cvat,
           SUM(out) AS out
    FROM f GROUP BY 1 ORDER BY 1`;
  return rows.map((row) => {
    const invoiceVatMinor = num(row.ivat);
    const creditVatMinor = num(row.cvat);
    const outputVatMinor = num(row.out);
    const inputVatMinor = invoiceVatMinor - creditVatMinor;
    return {
      month: row.month,
      invoicesCount: num(row.n),
      invoiceNetMinor: num(row.inet),
      invoiceVatMinor,
      creditNetMinor: num(row.cnet),
      creditVatMinor,
      inputVatMinor,
      outputVatMinor,
      netVatMinor: outputVatMinor - inputVatMinor,
    };
  });
}

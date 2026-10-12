import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { Prisma } from "@/lib/generated/prisma/client";
import { getReport, REPORT_NAMES } from "@/modules/reports";
import { col, inRange, inScope } from "@/modules/reports/sql";
import { createMember, createProduct, createTenant, testDb } from "./helpers";

/**
 * R3 (reports-audit-spec.md): every report over 366 days on a seeded volume. Opt-in and slow,
 * so CI skips it: `REPORTS_PERF=1 npx vitest run tests/integration/reports-perf.test.ts`.
 * Writes timings and the sales query plan to REPORTS_PERF_OUT (default reports-perf.txt).
 */

const SALES = 100_000;
const REFUNDS = 2_000;
const FROM = "2025-03-11";
const TO = "2026-03-11";

let db: Db;
let owner: TenantContext;
let branchId: string;

describe.skipIf(!process.env.REPORTS_PERF)("reports on 100 000 sales (R3)", () => {
  beforeAll(async () => {
    db = testDb();
    const t = await createTenant(db, "Perf");
    branchId = t.branchA.id;
    owner = await createMember(db, t.org.id, "OWNER");
    const product = await createProduct(db, t.org.id);
    const shift = await db.registerShift.create({
      data: { orgId: t.org.id, branchId, registerId: t.register.id, openedById: owner.userId, openingFloatMinor: 0 },
    });
    const org = t.org.id;
    // Sales spread evenly over the year, one line and one cash payment each (1140 incl. 140 VAT).
    await db.$executeRaw`
      INSERT INTO "Sale" ("id", "orgId", "branchId", "registerId", "shiftId", "cashierId", "number", "idempotencyKey",
                          "status", "currency", "subtotalMinor", "vatMinor", "totalMinor", "createdAt")
      SELECT gen_random_uuid(), ${org}::uuid, ${branchId}::uuid, ${t.register.id}::uuid, ${shift.id}::uuid,
             ${owner.userId}::uuid, lpad(g::text, 6, '0'), 'perf-' || g, 'COMPLETED', 'EGP', 1000, 140, 1140,
             ${FROM}::timestamp + (g * interval '1 second' * (366 * 86400 / ${SALES}::int))
      FROM generate_series(1, ${SALES}::int) g`;
    await db.$executeRaw`
      INSERT INTO "SaleItem" ("id", "orgId", "saleId", "productId", "skuSnapshot", "nameSnapshot", "unitType", "qty",
                              "unitPriceMinor", "vatRateBp", "vatMinor", "lineTotalMinor")
      SELECT gen_random_uuid(), s."orgId", s."id", ${product.id}::uuid, 'PERF', 'Perf', 'EACH', 1, 1140, 1400, 140, 1140
      FROM "Sale" s WHERE s."orgId" = ${org}::uuid`;
    await db.$executeRaw`
      INSERT INTO "Payment" ("id", "orgId", "saleId", "method", "amountMinor")
      SELECT gen_random_uuid(), s."orgId", s."id", 'CASH', 1140 FROM "Sale" s WHERE s."orgId" = ${org}::uuid`;
    await db.$executeRaw`
      INSERT INTO "Refund" ("id", "orgId", "branchId", "saleId", "shiftId", "processedById", "idempotencyKey", "method",
                            "reason", "totalMinor", "vatMinor", "createdAt")
      SELECT gen_random_uuid(), s."orgId", s."branchId", s."id", s."shiftId", s."cashierId", 'perf-r-' || s."number",
             'CASH', 'perf', 1140, 140, s."createdAt" + interval '1 hour'
      FROM "Sale" s WHERE s."orgId" = ${org}::uuid ORDER BY s."number" LIMIT ${REFUNDS}::int`;
    await db.$executeRaw`
      INSERT INTO "RefundItem" ("id", "orgId", "refundId", "saleItemId", "qty", "amountMinor", "vatMinor")
      SELECT gen_random_uuid(), r."orgId", r."id", si."id", 1, 1140, 140
      FROM "Refund" r JOIN "SaleItem" si ON si."orgId" = r."orgId" AND si."saleId" = r."saleId"
      WHERE r."orgId" = ${org}::uuid`;
    await db.$executeRawUnsafe(`ANALYZE "Sale", "SaleItem", "Payment", "Refund", "RefundItem"`);
  }, 600_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("answers each report within 2 seconds", async () => {
    const lines: string[] = [];
    for (const report of REPORT_NAMES) {
      const started = performance.now();
      const result = await getReport(owner, report, { branchId, from: FROM, to: TO });
      const ms = Math.round(performance.now() - started);
      lines.push(`${report}: ${ms} ms, ${result.rows.length} rows`);
      expect(ms).toBeLessThan(2_000);
    }
    const scope = { orgId: owner.orgId, branchIds: [branchId], zone: "Africa/Cairo", from: FROM, to: TO };
    const plan = await db.$queryRaw<{ "QUERY PLAN": string }[]>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) SELECT COUNT(*), SUM(s."totalMinor") FROM "Sale" s
                 WHERE ${inScope("s", scope)} AND s."status" = 'COMPLETED' AND ${inRange(col("s", "createdAt"), scope)}`,
    );
    lines.push("", "Sales range scan:", ...plan.map((row) => row["QUERY PLAN"]));
    writeFileSync(process.env.REPORTS_PERF_OUT ?? "reports-perf.txt", lines.join("\n"));
  }, 120_000);
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { Role } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/auth";
import * as report from "@/app/api/reports/[report]/route";
import * as audit from "@/app/api/audit/route";
import { testDb } from "./helpers";
import { DAY, seedReportsFixture, type ReportsFixture } from "./reports-fixture";

/**
 * Route-level auth, JSON envelope and CSV download for reports and the audit trail.
 * Real Better-Auth sessions and real Postgres; handlers are called directly, as Next.js does.
 */

const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";

let db: Db;
let f: ReportsFixture;
let owner: string;
let manager: string;
let cashier: string;

function randomIp() {
  const n = () => Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

async function sessionFor(orgId: string, role: Role) {
  const email = `reports-${role.toLowerCase()}-${randomUUID()}@example.test`;
  const response = await getAuth().handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": randomIp() },
      body: JSON.stringify({ email, password: PASSWORD, name: role }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
  const { user } = (await response.json()) as { user: { id: string } };
  const token = response.headers.getSetCookie().find((c) => c.includes("session_token="));
  if (!token) throw new Error("no session cookie returned");
  await db.membership.create({ data: { orgId, userId: user.id, role, allBranches: true } });
  await db.session.updateMany({ where: { userId: user.id }, data: { activeOrganizationId: orgId } });
  return { cookie: token.split(";")[0] ?? "", userId: user.id };
}

function get(url: string, cookie?: string): Request {
  return new Request(`${BASE}${url}`, { headers: cookie ? { cookie } : {} });
}

const reportGet = (name: string, qs: string, cookie?: string) =>
  report.GET(get(`/api/reports/${name}?${qs}`, cookie), { params: Promise.resolve({ report: name }) });

const auditGet = (qs: string, cookie?: string) => audit.GET(get(`/api/audit?${qs}`, cookie), {});

async function code(response: Response, status: number): Promise<string> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return ((await response.json()) as { code: string }).code;
}

beforeAll(async () => {
  db = testDb();
  f = await seedReportsFixture(db);
  owner = (await sessionFor(f.orgId, "OWNER")).cookie;
  manager = (await sessionFor(f.orgId, "MANAGER")).cookie;
  cashier = (await sessionFor(f.orgId, "CASHIER")).cookie;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /api/reports/{report}", () => {
  it("answers 401, 403, 404 and 422", async () => {
    expect(await code(await reportGet("payments", "", undefined), 401)).toBe("UNAUTHENTICATED");
    expect(await code(await reportGet("payments", "", cashier), 403)).toBe("FORBIDDEN");
    expect(await code(await reportGet("profit", "", owner), 404)).toBe("NOT_FOUND");
    expect(await code(await reportGet("payments", "from=2026-03-10&to=2026-03-01", owner), 422)).toBe(
      "VALIDATION_FAILED",
    );
    expect(await code(await reportGet("payments", "colour=red", owner), 422)).toBe("VALIDATION_FAILED");
    expect(await code(await reportGet("payments", `branchId=${randomUUID()}`, owner), 404)).toBe("NOT_FOUND");
  });

  it("returns the report as JSON", async () => {
    const response = await reportGet("sales-summary", `branchId=${f.branchA}&from=${DAY}&to=${DAY}`, manager);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { rows: { grossMinor: number }[]; truncated: boolean; currency: string };
    expect(body.rows[0]?.grossMinor).toBe(42_480);
    expect(body.truncated).toBe(false);
    expect(body.currency).toBe("EGP");
  });

  it("downloads CSV with a BOM, Arabic headers, money in major units and a total line", async () => {
    const response = await reportGet(
      "payments",
      `branchId=${f.branchA}&from=${DAY}&to=${DAY}&format=csv&locale=ar`,
      owner,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="payments_${DAY}_${DAY}.csv"`);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("طريقة الدفع,المبيعات,قيمة المبيعات,المرتجعات,المسترد,صافي المقبوض");
    expect(lines[1]).toBe("نقدي,2,292.00,1,114.00,178.00");
    expect(lines.at(-1)).toBe("الإجمالي,5,424.80,1,114.00,310.80");
    const exported = await db.auditEvent.findFirst({
      where: { orgId: f.orgId, action: "reports.exported", entityId: "payments" },
    });
    expect(exported?.metadata).toMatchObject({ from: DAY, to: DAY, branchId: f.branchA, rows: 3 });
  });
});

describe("GET /api/audit", () => {
  it("is for Owner and Admin only", async () => {
    expect(await code(await auditGet("", undefined), 401)).toBe("UNAUTHENTICATED");
    expect(await code(await auditGet("", manager), 403)).toBe("FORBIDDEN");
    expect(await code(await auditGet("cursor=nope", owner), 422)).toBe("VALIDATION_FAILED");
  });

  it("lists the org's events and exports them", async () => {
    // The fixture's services wrote today's events (sale.created, refund.create, sale.void, …).
    const response = await auditGet("action=sale.void", owner);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: { action: string; entityId: string }[]; nextCursor: null };
    expect(body.rows.map((r) => [r.action, r.entityId])).toEqual([["sale.void", f.sales.s5.id]]);
    expect(body.nextCursor).toBeNull();
    const csv = await auditGet("action=sale.void&format=csv", owner);
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="audit_\d{4}-\d{2}-\d{2}_/);
    expect(await csv.text()).toContain("sale.void");
  });
});

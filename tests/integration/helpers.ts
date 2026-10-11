import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Role } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { reconcile } from "@/modules/inventory";

export function testDb(): Db {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");
  return createDb(url);
}

const short = () => randomUUID().slice(0, 8);
/** Upper-case unique suffix: SKUs must satisfy the DB CHECK sku = upper(btrim(sku)). */
export const shortUpper = () => short().toUpperCase();

/** Creates an isolated tenant (org + 2 branches + register). Unique per call, so tests never collide. */
export async function createTenant(db: Db, label = "Org") {
  const org = await db.organization.create({
    data: {
      name: `${label} ${short()}`,
      businessType: "RETAIL",
      countryCode: "EG",
      currency: "EGP",
      vatRateBp: 1400,
    },
  });
  const branchA = await db.branch.create({ data: { orgId: org.id, name: "Main", code: `M-${short()}` } });
  const branchB = await db.branch.create({ data: { orgId: org.id, name: "Second", code: `S-${short()}` } });
  const register = await db.register.create({ data: { orgId: org.id, branchId: branchA.id, name: "Till 1" } });
  return { org, branchA, branchB, register };
}

export async function createUser(db: Db, name = "Test User") {
  return db.user.create({ data: { name, email: `user-${randomUUID()}@example.test` } });
}

export async function createProduct(db: Db, orgId: string, sku = `SKU-${shortUpper()}`) {
  return db.product.create({ data: { orgId, sku, name: `Product ${sku}`, priceMinor: 1000 } });
}

/** Creates a user + membership with `role` in `orgId` and returns the matching tenant context. */
export async function createMember(
  db: Db,
  orgId: string,
  role: Role,
  opts: { branchId?: string | null } = {},
): Promise<TenantContext> {
  const user = await createUser(db, `${role} ${short()}`);
  const membership = await db.membership.create({ data: { orgId, userId: user.id, role, allBranches: true } });
  return { userId: user.id, orgId, membershipId: membership.id, role, branchId: opts.branchId ?? null };
}

export async function createCategory(db: Db, orgId: string, name = `Cat ${short()}`, parentId: string | null = null) {
  return db.category.create({ data: { orgId, name, parentId } });
}

/** Inserts a variant directly (and sets hasVariants, as the service would). */
export async function createVariant(db: Db, orgId: string, productId: string, sku = `VAR-${shortUpper()}`) {
  await db.product.update({ where: { id: productId }, data: { hasVariants: true } });
  return db.productVariant.create({ data: { orgId, productId, sku, name: `Variant ${sku}` } });
}

/** Unique printable-ASCII barcode. */
export const uniqueCode = () => `${Date.now()}${shortUpper()}`;

/** Awaits a rejection and checks it is an AppError with `status` (and `details.reason` when given). */
export async function expectAppError(promise: Promise<unknown>, status: number, reason?: string): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof AppError)) throw new Error(`Expected AppError ${status}, got ${String(err)}`);
  if (err.status !== status) throw new Error(`Expected status ${status}, got ${err.status} (${err.message})`);
  if (reason !== undefined) {
    const actual = (err.details as { reason?: string } | null)?.reason;
    if (actual !== reason) throw new Error(`Expected reason ${reason}, got ${String(actual)}`);
  }
  return err;
}

/** Details of a catalog AppError, typed loosely for assertions. */
export function detailsOf(err: AppError): Record<string, unknown> {
  return (err.details ?? {}) as Record<string, unknown>;
}

/** Asserts that every StockBalance row matches the sum of its ledger rows (inventory I-1). */
export async function expectReconciled(db: Db, orgId: string): Promise<void> {
  const mismatches = await reconcile(db, orgId);
  if (mismatches.length > 0) throw new Error(`stock ledger mismatch: ${JSON.stringify(mismatches)}`);
}

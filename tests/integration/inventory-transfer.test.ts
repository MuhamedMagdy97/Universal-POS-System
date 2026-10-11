import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createMember, createProduct, createTenant, expectAppError, expectReconciled, testDb } from "./helpers";

/** Instant transfers (T4.4 / I-7, I-8, I-15, D6). */
let db: Db;
let orgId: string;
let otherOrgId: string;
let branchA: string;
let branchB: string;
let admin: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Inv Transfer");
  const other = await createTenant(db, "Inv Transfer Other");
  orgId = tenant.org.id;
  otherOrgId = other.org.id;
  branchA = tenant.branchA.id;
  branchB = tenant.branchB.id;
  admin = await createMember(db, orgId, "ADMIN");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const ref = (productId: string) => ({ productId, variantId: null });

/** Stock at a branch through the real opening-balance service. */
async function stockedAt(branchId: string, qty: number) {
  const product = await createProduct(db, orgId);
  await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty }] });
  return product;
}

const onHand = (productId: string, branch: string) =>
  inventory.getOnHand(db, orgId, branch, [ref(productId)]).then((qty) => qty[0]);

describe("transferStock", () => {
  it("moves stock as an OUT and an IN row sharing one transferGroupId", async () => {
    const product = await stockedAt(branchA, 10);
    const transferId = randomUUID();
    const result = await inventory.transferStock(admin, {
      transferId,
      fromBranchId: branchA,
      toBranchId: branchB,
      lines: [{ ref: ref(product.id), qty: 4 }],
    });
    expect(result).toMatchObject({ transferId, replayed: false });
    expect(await onHand(product.id, branchA)).toBe(6);
    expect(await onHand(product.id, branchB)).toBe(4);

    const rows = await db.inventoryMovement.findMany({ where: { orgId, transferGroupId: transferId } });
    expect(rows.map((row) => [row.reason, row.branchId, row.qtyDelta]).sort()).toEqual(
      [
        ["TRANSFER_IN", branchB, 4],
        ["TRANSFER_OUT", branchA, -4],
      ].sort(),
    );
    await expectReconciled(db, orgId);
  });

  it("applies a retried transfer once and replays the original result (I-7)", async () => {
    const product = await stockedAt(branchA, 5);
    const transferId = randomUUID();
    const input = {
      transferId,
      fromBranchId: branchA,
      toBranchId: branchB,
      lines: [{ ref: ref(product.id), qty: 2 }],
    };
    const first = await inventory.transferStock(admin, input);
    const replay = await inventory.transferStock(admin, input);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ transferId, replayed: true });
    expect(await onHand(product.id, branchA)).toBe(3);
    expect(await onHand(product.id, branchB)).toBe(2);
  });

  it("applies one transferId exactly once when two copies race (I-7)", async () => {
    const product = await stockedAt(branchA, 5);
    const input = {
      transferId: randomUUID(),
      fromBranchId: branchA,
      toBranchId: branchB,
      lines: [{ ref: ref(product.id), qty: 2 }],
    };
    const results = await Promise.allSettled([
      inventory.transferStock(admin, input),
      inventory.transferStock(admin, input),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await onHand(product.id, branchA)).toBe(3);
    expect(await onHand(product.id, branchB)).toBe(2);
  });

  it("rejects a reused transferId with different content (IDEMPOTENCY_CONFLICT)", async () => {
    const product = await stockedAt(branchA, 5);
    const transferId = randomUUID();
    await inventory.transferStock(admin, {
      transferId,
      fromBranchId: branchA,
      toBranchId: branchB,
      lines: [{ ref: ref(product.id), qty: 1 }],
    });
    await expectAppError(
      inventory.transferStock(admin, {
        transferId,
        fromBranchId: branchA,
        toBranchId: branchB,
        lines: [{ ref: ref(product.id), qty: 2 }],
      }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("rejects a transfer to the same branch (SAME_BRANCH)", async () => {
    const product = await stockedAt(branchA, 5);
    await expectAppError(
      inventory.transferStock(admin, {
        transferId: randomUUID(),
        fromBranchId: branchA,
        toBranchId: branchA,
        lines: [{ ref: ref(product.id), qty: 1 }],
      }),
      422,
      "SAME_BRANCH",
    );
  });

  it("returns 404 for a destination in another org or an inactive branch (I-8)", async () => {
    const product = await stockedAt(branchA, 5);
    const otherTenantBranch = (await createTenant(db, "Inv Transfer Foreign")).branchA.id;
    await expectAppError(
      inventory.transferStock(admin, {
        transferId: randomUUID(),
        fromBranchId: branchA,
        toBranchId: otherTenantBranch,
        lines: [{ ref: ref(product.id), qty: 1 }],
      }),
      404,
    );
    await db.branch.update({ where: { id: branchB }, data: { isActive: false } });
    try {
      await expectAppError(
        inventory.transferStock(admin, {
          transferId: randomUUID(),
          fromBranchId: branchA,
          toBranchId: branchB,
          lines: [{ ref: ref(product.id), qty: 1 }],
        }),
        404,
      );
    } finally {
      await db.branch.update({ where: { id: branchB }, data: { isActive: true } });
    }
  });

  it("requires access to the source branch only (D6)", async () => {
    const product = await stockedAt(branchA, 5);
    const scoped = await createMember(db, orgId, "MANAGER", { branchId: branchA });
    await db.membership.update({ where: { id: scoped.membershipId }, data: { allBranches: false } });
    await db.membershipBranch.create({
      data: { orgId, membershipId: scoped.membershipId, branchId: branchA },
    });

    // Source is in scope, destination is not in the membership: allowed.
    await expect(
      inventory.transferStock(scoped, {
        transferId: randomUUID(),
        fromBranchId: branchA,
        toBranchId: branchB,
        lines: [{ ref: ref(product.id), qty: 1 }],
      }),
    ).resolves.toMatchObject({ replayed: false });

    // Source outside the membership: 404, exactly like an unknown branch.
    await expectAppError(
      inventory.transferStock(scoped, {
        transferId: randomUUID(),
        fromBranchId: branchB,
        toBranchId: branchA,
        lines: [{ ref: ref(product.id), qty: 1 }],
      }),
      404,
    );
  });

  it("does not deadlock when two transfers cross in opposite directions (I-15)", async () => {
    // Both items are stocked at both branches, so each direction has enough to move.
    const x = await stockedAt(branchA, 20);
    const y = await stockedAt(branchA, 20);
    await inventory.recordOpeningBalances(admin, {
      branchId: branchB,
      lines: [
        { ref: ref(x.id), qty: 20 },
        { ref: ref(y.id), qty: 20 },
      ],
    });
    const results = await Promise.allSettled([
      inventory.transferStock(admin, {
        transferId: randomUUID(),
        fromBranchId: branchA,
        toBranchId: branchB,
        lines: [
          { ref: ref(x.id), qty: 1 },
          { ref: ref(y.id), qty: 1 },
        ],
      }),
      inventory.transferStock(admin, {
        transferId: randomUUID(),
        fromBranchId: branchB,
        toBranchId: branchA,
        lines: [
          { ref: ref(y.id), qty: 1 },
          { ref: ref(x.id), qty: 1 },
        ],
      }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    await expectReconciled(db, orgId);
  });

  it("rejects the whole transfer when the source is short on one line (INSUFFICIENT_STOCK)", async () => {
    const enough = await stockedAt(branchA, 5);
    const short = await stockedAt(branchA, 1);
    await expectAppError(
      inventory.transferStock(admin, {
        transferId: randomUUID(),
        fromBranchId: branchA,
        toBranchId: branchB,
        lines: [
          { ref: ref(enough.id), qty: 2 },
          { ref: ref(short.id), qty: 3 },
        ],
      }),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await onHand(enough.id, branchA)).toBe(5);
    expect(await onHand(enough.id, branchB)).toBe(0);
  });

  it("rejects a transfer from another org's branch as not found", async () => {
    const otherAdmin = await createMember(db, otherOrgId, "ADMIN");
    const product = await stockedAt(branchA, 1);
    await expectAppError(
      inventory.transferStock(otherAdmin, {
        transferId: randomUUID(),
        fromBranchId: branchA,
        toBranchId: branchB,
        lines: [{ ref: ref(product.id), qty: 1 }],
      }),
      404,
    );
  });
});

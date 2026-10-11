import { describe, expect, it } from "vitest";
import { record, toAuditEventData, type AuditWriter } from "@/modules/audit";

const ctx = { orgId: "org-1", branchId: "branch-1", userId: "user-1" };

describe("audit event mapping", () => {
  it("fills tenant, actor and request id from context and meta", () => {
    const data = toAuditEventData({
      ctx,
      meta: { requestId: "req-1" },
      action: "catalog.product.price_changed",
      entityType: "Product",
      entityId: "p-1",
      metadata: { priceMinor: [1000, 1250] },
    });
    expect(data).toEqual({
      orgId: "org-1",
      branchId: "branch-1",
      actorUserId: "user-1",
      action: "catalog.product.price_changed",
      entityType: "Product",
      entityId: "p-1",
      requestId: "req-1",
      metadata: { priceMinor: [1000, 1250] },
    });
  });

  it("defaults optional fields to null / empty metadata", () => {
    const data = toAuditEventData({
      ctx: { ...ctx, branchId: null },
      action: "catalog.category.created",
      entityType: "Category",
    });
    expect(data).toMatchObject({ branchId: null, entityId: null, requestId: null, metadata: {} });
  });

  it("redacts secret-looking keys at any depth and drops undefined values", () => {
    const data = toAuditEventData({
      ctx,
      action: "catalog.product.updated",
      entityType: "Product",
      metadata: { sku: "A-1", token: "abc", nested: { password: "x", note: undefined } },
    });
    expect(data.metadata).toEqual({ sku: "A-1", token: "[REDACTED]", nested: { password: "[REDACTED]" } });
  });

  it("caps an oversized client-supplied request id", () => {
    const data = toAuditEventData({ ctx, meta: { requestId: "r".repeat(500) }, action: "a.b", entityType: "X" });
    expect(data.requestId).toHaveLength(128);
  });

  it("rejects malformed actions and empty entity types", () => {
    expect(() => toAuditEventData({ ctx, action: "Catalog.Created" as "a.b", entityType: "Product" })).toThrow();
    expect(() => toAuditEventData({ ctx, action: "nodot" as "a.b", entityType: "Product" })).toThrow();
    expect(() => toAuditEventData({ ctx, action: "catalog.product.created", entityType: " " })).toThrow();
  });
});

describe("record()", () => {
  it("inserts exactly one row through the given (transaction) client", async () => {
    const calls: unknown[] = [];
    const tx = {
      auditEvent: {
        create: async (args: unknown) => {
          calls.push(args);
          return { id: "e-1" };
        },
      },
    } as unknown as AuditWriter;

    await record(tx, { ctx, action: "catalog.barcode.added", entityType: "Barcode", entityId: "b-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ data: { action: "catalog.barcode.added", orgId: "org-1", entityId: "b-1" } });
  });
});

import "server-only";
/**
 * Settings → Inventory system (integration spec I2–I4, I20, I21; slice 1). The API key is write-only:
 * sealed at rest, decrypted per call on the server, never returned, logged or audited (I3).
 */
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { AppError, forbidden, notFound } from "@/lib/errors";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import type { InventorySource } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { imsGet, type ImsLink } from "./client";
import { drainPostings } from "./postings";
import { open, seal } from "./secret";
import { syncWithLock, type SyncSummary } from "./sync";

export type InventoryLinkStatus = {
  source: InventorySource;
  /** False when the server has no INTEGRATION_ENCRYPTION_KEY: linking is refused. */
  encryptionReady: boolean;
  canManage: boolean;
  link: {
    baseUrl: string;
    keyLast4: string;
    lastCheckAt: string | null;
    lastCheckOk: boolean;
    lastSyncStartedAt: string | null;
    lastSyncFinishedAt: string | null;
    lastSyncOk: boolean | null;
    lastSyncSummary: Partial<SyncSummary>;
    syncRunning: boolean;
  } | null;
  /** Each branch and the IMS warehouse it sells from (I5). */
  branches: { id: string; name: string; code: string; isActive: boolean; warehouseId: string | null }[];
  /** Inventory-system calls not yet made (retried), refused (they wait for a person), and pending over 10 minutes. */
  postings: { pending: number; failed: number; stale: number };
};

export type ImsWarehouse = { id: string; code: string; name: string; status: string };

export const BranchMapInput = z.strictObject({
  map: z
    .array(z.strictObject({ branchId: z.uuid(), warehouseId: z.uuid().nullable() }))
    .min(1)
    .max(200)
    .refine((rows) => new Set(rows.map((row) => row.branchId)).size === rows.length, "Each branch once")
    .refine((rows) => {
      const ids = rows.flatMap((row) => (row.warehouseId ? [row.warehouseId] : []));
      return new Set(ids).size === ids.length;
    }, "Two branches cannot share a warehouse"),
});

export type CheckResult = { ok: true } | { ok: false; problem: "UNREACHABLE" | "REFUSED" | "UNEXPECTED" };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, or http on this machine (a local inventory system); stored as the bare origin. */
const BaseUrl = z
  .url()
  .trim()
  .max(200)
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) && !url.username;
  }, "Use an https:// address")
  .transform((value) => new URL(value).origin);

export const InventoryLinkInput = z.strictObject({
  baseUrl: BaseUrl,
  apiKey: z.string().trim().min(8).max(500).optional(),
});

export const InventorySourceInput = z.strictObject({ source: z.enum(["BUILT_IN", "EXTERNAL"]) });

function conflict(reason: string, message: string): AppError {
  return new AppError("CONFLICT", message, { reason });
}

async function requirePermission(
  ctx: TenantContext,
  permission: Extract<Permission, "settings.manage" | "integrations.manage">,
  operation: string,
  meta?: AuditRequestMeta,
): Promise<void> {
  if (hasPermission(ctx.role, permission)) return;
  try {
    await record(getDb(), {
      ctx,
      meta,
      action: "integration.inventory.permission.denied",
      entityType: "InventoryLink",
      entityId: ctx.orgId,
      metadata: { permission, operation },
    });
  } catch {
    // A failed audit write must not turn a 403 into a 500.
  }
  throw forbidden("Missing permission for this action");
}

function encryptionKey(): { key: Buffer; keyId: string } | null {
  const config = getConfig();
  if (!config.INTEGRATION_ENCRYPTION_KEY) return null;
  return { key: Buffer.from(config.INTEGRATION_ENCRYPTION_KEY, "base64"), keyId: config.INTEGRATION_ENCRYPTION_KEY_ID };
}

type LinkRow = NonNullable<Awaited<ReturnType<typeof loadLink>>>;

export function loadLink(orgId: string) {
  return getDb().inventoryLink.findUnique({ where: { orgId } });
}

/** Decrypts the key for one call. A missing or rotated server key answers 409 KEY_UNREADABLE. */
export function openLink(row: LinkRow): ImsLink {
  const secret = encryptionKey();
  try {
    if (!secret || secret.keyId !== row.apiKeyKeyId) throw new Error("key id");
    return { baseUrl: row.baseUrl, apiKey: open(row.apiKeyCiphertext, secret.key) };
  } catch {
    throw conflict("KEY_UNREADABLE", "The saved API key cannot be read on this server. Enter it again");
  }
}

export async function getInventoryLinkStatus(ctx: TenantContext): Promise<InventoryLinkStatus> {
  await requirePermission(ctx, "settings.manage", "inventory.read");
  const db = getDb();
  const [org, row, branches, postings, stale] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { inventorySource: true } }),
    loadLink(ctx.orgId),
    db.branch.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { code: "asc" },
      select: { id: true, name: true, code: true, isActive: true, externalWarehouseId: true },
    }),
    db.externalStockPosting.groupBy({
      by: ["status"],
      where: { orgId: ctx.orgId, status: { in: ["PENDING", "FAILED"] } },
      _count: { _all: true },
    }),
    db.externalStockPosting.count({
      where: { orgId: ctx.orgId, status: "PENDING", createdAt: { lt: new Date(Date.now() - STALE_MS) } },
    }),
  ]);
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const count = (status: string) => postings.find((p) => p.status === status)?._count._all ?? 0;
  return {
    branches: branches.map(({ externalWarehouseId, ...branch }) => ({ ...branch, warehouseId: externalWarehouseId })),
    postings: { pending: count("PENDING"), failed: count("FAILED"), stale },
    source: org.inventorySource,
    encryptionReady: encryptionKey() !== null,
    canManage: hasPermission(ctx.role, "integrations.manage"),
    link: row && {
      baseUrl: row.baseUrl,
      keyLast4: row.apiKeyLast4,
      lastCheckAt: iso(row.lastCheckAt),
      lastCheckOk: row.lastCheckOk,
      lastSyncStartedAt: iso(row.lastSyncStartedAt),
      lastSyncFinishedAt: iso(row.lastSyncFinishedAt),
      lastSyncOk: row.lastSyncOk,
      lastSyncSummary: row.lastSyncSummary as Partial<SyncSummary>,
      syncRunning: row.syncLockedUntil !== null && row.syncLockedUntil > new Date(),
    },
  };
}

/**
 * I4: the key is accepted and may read products and stock. Write permissions (`sales.reserve`, …) are
 * not probed: the IMS has no "who am I" route (D3 `GET /api/me`, checked slice 4) and a write probe
 * would hold or move stock. A key without them answers INVENTORY_LINK_BROKEN at the first sale.
 */
async function probe(link: ImsLink): Promise<CheckResult> {
  try {
    await imsGet(link, "/api/products?page=1&per_page=1", 5_000);
    // A random variant id: 404 means the stock-read permission passed (the IMS checks it first).
    await imsGet(link, `/api/availability?variantId=${crypto.randomUUID()}`, 5_000).catch((err: unknown) => {
      if (!(err instanceof AppError && err.code === "NOT_FOUND")) throw err;
    });
    return { ok: true };
  } catch (err) {
    const reason = (err instanceof AppError ? (err.details as { reason?: string }) : null)?.reason;
    if (reason === "INVENTORY_UNAVAILABLE") return { ok: false, problem: "UNREACHABLE" };
    if (reason === "INVENTORY_LINK_BROKEN") return { ok: false, problem: "REFUSED" };
    return { ok: false, problem: "UNEXPECTED" };
  }
}

async function runCheck(ctx: TenantContext, row: LinkRow, meta?: AuditRequestMeta): Promise<CheckResult> {
  const result = await probe(openLink(row));
  await getDb().$transaction(async (tx) => {
    await tx.inventoryLink.update({
      where: { orgId: ctx.orgId },
      data: { lastCheckAt: new Date(), lastCheckOk: result.ok },
    });
    await record(tx, {
      ctx,
      meta,
      action: "integration.inventory.checked",
      entityType: "InventoryLink",
      entityId: ctx.orgId,
      metadata: result,
    });
  });
  return result;
}

/** Saves the address and (optionally) a new key, then runs the connection check. */
export async function saveInventoryLink(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<CheckResult> {
  await requirePermission(ctx, "integrations.manage", "inventory.link", meta);
  const { baseUrl, apiKey } = InventoryLinkInput.parse(input);
  const secret = encryptionKey();
  if (!secret) throw conflict("ENCRYPTION_KEY_MISSING", "This server is not set up to store integration keys");

  const row = await getDb().$transaction(async (tx) => {
    const current = await tx.inventoryLink.findUnique({ where: { orgId: ctx.orgId } });
    const keyFields = apiKey
      ? { apiKeyCiphertext: seal(apiKey, secret.key), apiKeyKeyId: secret.keyId, apiKeyLast4: apiKey.slice(-4) }
      : null;
    let saved;
    if (current) {
      saved = await tx.inventoryLink.update({
        where: { orgId: ctx.orgId },
        data: { baseUrl, ...keyFields, lastCheckOk: false },
      });
    } else if (keyFields) {
      saved = await tx.inventoryLink.create({ data: { orgId: ctx.orgId, baseUrl, ...keyFields } });
    } else {
      throw new AppError("VALIDATION_FAILED", "Enter the API key", { reason: "API_KEY_REQUIRED", field: "apiKey" });
    }
    await record(tx, {
      ctx,
      meta,
      action: current ? "integration.inventory.link_changed" : "integration.inventory.link_saved",
      entityType: "InventoryLink",
      entityId: ctx.orgId,
      // Never the key: only whether it changed and its last 4 characters.
      metadata: { baseUrl, keyChanged: Boolean(apiKey), keyLast4: saved.apiKeyLast4 },
    });
    return saved;
  });
  return runCheck(ctx, row, meta);
}

export async function checkInventoryLink(ctx: TenantContext, meta?: AuditRequestMeta): Promise<CheckResult> {
  await requirePermission(ctx, "integrations.manage", "inventory.check", meta);
  const row = await loadLink(ctx.orgId);
  if (!row) throw notFound("Inventory link");
  return runCheck(ctx, row, meta);
}

/**
 * The toggle (I1, I20, I21). To EXTERNAL: a saved link that passed its check, no open shift and no open
 * purchase order; the first sync runs straight after (its failure leaves the shop linked, shown on the
 * status). Back to BUILT_IN: no open shift; the POS catalog and stock are as they were (external ids kept).
 */
export async function setInventorySource(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ source: InventorySource; sync: SyncSummary | null; syncError: string | null }> {
  await requirePermission(ctx, "integrations.manage", "inventory.source", meta);
  const { source } = InventorySourceInput.parse(input);
  const row = await getDb().$transaction(async (tx) => {
    // Serialise with sales and purchasing writes on this org row while the checks run.
    const org = await tx.$queryRaw<{ inventorySource: InventorySource; allowOfflineSales: boolean }[]>`
      SELECT "inventorySource", "allowOfflineSales" FROM "Organization" WHERE id = ${ctx.orgId}::uuid FOR UPDATE`;
    if (org[0]?.inventorySource === source)
      throw conflict("ALREADY_SET", "The shop already uses this inventory source");
    // Offline till OF15: a linked shop never sells offline, so offline must be off and every device revoked.
    if (
      source === "EXTERNAL" &&
      (org[0]?.allowOfflineSales || (await tx.registerDevice.count({ where: { orgId: ctx.orgId, revokedAt: null } })))
    ) {
      throw conflict("OFFLINE_ENABLED", "Turn off offline sales and revoke every till device first");
    }
    const link = await tx.inventoryLink.findUnique({ where: { orgId: ctx.orgId } });
    if (source === "EXTERNAL" && !link?.lastCheckOk) {
      throw conflict("CHECK_FAILED", "Save the link and pass the connection check first");
    }
    if (await tx.registerShift.count({ where: { orgId: ctx.orgId, status: "OPEN" } })) {
      throw conflict("OPEN_SHIFTS", "Close every open shift first");
    }
    // I21: sales, refunds or voids still owed to the inventory system would be lost.
    if (
      source === "BUILT_IN" &&
      (await tx.externalStockPosting.count({ where: { orgId: ctx.orgId, status: "PENDING" } }))
    ) {
      throw conflict("PENDING_POSTINGS", "Wait until every sale and refund has reached the inventory system");
    }
    if (
      source === "EXTERNAL" &&
      (await tx.purchaseOrder.count({
        where: { orgId: ctx.orgId, status: { in: ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED"] } },
      }))
    ) {
      throw conflict("OPEN_PURCHASE_ORDERS", "Receive, close or cancel every open purchase order first");
    }
    await tx.organization.update({ where: { id: ctx.orgId }, data: { inventorySource: source } });
    await record(tx, {
      ctx,
      meta,
      action: source === "EXTERNAL" ? "integration.inventory.linked" : "integration.inventory.unlinked",
      entityType: "Organization",
      entityId: ctx.orgId,
      metadata: { from: org[0]?.inventorySource, to: source },
    });
    return link;
  });
  if (source === "BUILT_IN" || !row) return { source, sync: null, syncError: null };
  try {
    return { source, sync: await syncWithLock(ctx, meta, openLink(row)), syncError: null };
  } catch (err) {
    const reason = (err instanceof AppError ? (err.details as { reason?: string }) : null)?.reason;
    return { source, sync: null, syncError: reason ?? "UNEXPECTED" };
  }
}

/** "Sync now" (I6): Owner and Admin. Only for a linked shop. */
export async function syncInventoryNow(ctx: TenantContext, meta?: AuditRequestMeta): Promise<SyncSummary> {
  await requirePermission(ctx, "settings.manage", "inventory.sync", meta);
  const db = getDb();
  const [org, row] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { inventorySource: true } }),
    loadLink(ctx.orgId),
  ]);
  if (org.inventorySource !== "EXTERNAL" || !row) {
    throw conflict("NOT_LINKED", "Switch the shop to the inventory system first");
  }
  const link = openLink(row);
  // Also sends what is still owed (I19); the scheduler route does the same every minute.
  await drainPostings({ orgId: ctx.orgId }).catch(() => undefined);
  return syncWithLock(ctx, meta, link);
}

/** The IMS's warehouses for the branch map (I5). Owner and Admin; null when the IMS cannot be read. */
export async function listInventoryWarehouses(ctx: TenantContext): Promise<ImsWarehouse[] | null> {
  await requirePermission(ctx, "settings.manage", "inventory.warehouses");
  const row = await loadLink(ctx.orgId);
  if (!row) return null;
  try {
    const res = await imsGet<{ items: ImsWarehouse[] }>(openLink(row), "/api/warehouses", 5_000);
    return res.items.map(({ id, code, name, status }) => ({ id, code, name, status }));
  } catch {
    return null;
  }
}

/**
 * Maps branches to IMS warehouses (I5): each branch sells from at most one active warehouse, never
 * shared. `warehouseId: null` unmaps (that branch cannot sell while the shop is linked).
 */
export async function mapInventoryBranches(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<InventoryLinkStatus["branches"]> {
  await requirePermission(ctx, "integrations.manage", "inventory.branches", meta);
  const { map } = BranchMapInput.parse(input);
  const row = await loadLink(ctx.orgId);
  if (!row) throw notFound("Inventory link");
  const wanted = map.flatMap((m) => (m.warehouseId ? [m.warehouseId] : []));
  if (wanted.length > 0) {
    const res = await imsGet<{ items: ImsWarehouse[] }>(openLink(row), "/api/warehouses", 5_000);
    const active = new Set(res.items.filter((w) => w.status === "active").map((w) => w.id));
    const unknown = wanted.filter((id) => !active.has(id));
    if (unknown.length > 0) {
      throw new AppError("VALIDATION_FAILED", "Choose an active warehouse of the inventory system", {
        reason: "WAREHOUSE_UNKNOWN",
        warehouseIds: unknown,
      });
    }
  }
  try {
    await getDb().$transaction(async (tx) => {
      const branches = await tx.branch.findMany({
        where: { orgId: ctx.orgId, id: { in: map.map((m) => m.branchId) } },
        select: { id: true, externalWarehouseId: true },
      });
      if (branches.length !== map.length) throw notFound("Branch");
      // Clear first, so swapping two branches' warehouses does not trip the unique index.
      await tx.branch.updateMany({
        where: { orgId: ctx.orgId, id: { in: map.map((m) => m.branchId) } },
        data: { externalWarehouseId: null },
      });
      for (const m of map) {
        if (m.warehouseId) {
          await tx.branch.update({ where: { id: m.branchId }, data: { externalWarehouseId: m.warehouseId } });
        }
      }
      await record(tx, {
        ctx,
        meta,
        action: "integration.inventory.branch_mapped",
        entityType: "InventoryLink",
        entityId: ctx.orgId,
        metadata: {
          changes: map
            .map((m) => ({ ...m, from: branches.find((b) => b.id === m.branchId)?.externalWarehouseId ?? null }))
            .filter((m) => m.from !== m.warehouseId),
        },
      });
    });
  } catch (err) {
    // A branch left out of `map` already sells from that warehouse.
    if ((err as { code?: unknown } | null)?.code === "P2002") {
      throw conflict("WAREHOUSE_TAKEN", "Another branch already sells from this warehouse");
    }
    throw err;
  }
  return (await getInventoryLinkStatus(ctx)).branches;
}

const STALE_MS = 10 * 60_000;
const SYNC_EVERY_MS = 15 * 60_000;
const POSTINGS_PAGE = 20;

export type InventoryPosting = {
  id: string;
  kind: "FULFIL" | "CANCEL" | "RETURN";
  status: "PENDING" | "FAILED";
  /** The POS document: a sale (its fulfils, a void's return), a refund of a sale, or a refused sale's holds. */
  document: "SALE" | "REFUND" | "REFUSED_SALE";
  saleNumber: string | null;
  attempts: number;
  lastErrorCode: string | null;
  nextAttemptAt: string;
  createdAt: string;
  /** Still pending after 10 minutes (I19): a fulfil's reservation expires at 15. */
  stale: boolean;
};

/** Postings waiting or refused, oldest first, 20 a page (Owner, Admin). */
export async function listInventoryPostings(
  ctx: TenantContext,
  page = 1,
): Promise<{ items: InventoryPosting[]; page: number; hasMore: boolean }> {
  await requirePermission(ctx, "settings.manage", "inventory.postings");
  const db = getDb();
  const current = Number.isInteger(page) && page > 0 ? page : 1;
  const rows = await db.externalStockPosting.findMany({
    where: { orgId: ctx.orgId, status: { in: ["PENDING", "FAILED"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: (current - 1) * POSTINGS_PAGE,
    take: POSTINGS_PAGE + 1,
  });
  const shown = rows.slice(0, POSTINGS_PAGE);
  const refundIds = shown.filter((row) => row.sourceType === "Refund").map((row) => row.sourceId);
  const refunds = await db.refund.findMany({
    where: { orgId: ctx.orgId, id: { in: refundIds } },
    select: { id: true, saleId: true },
  });
  const saleIdOf = (row: (typeof shown)[number]) =>
    row.sourceType === "Sale" ? row.sourceId : refunds.find((refund) => refund.id === row.sourceId)?.saleId;
  const saleIds = shown.flatMap((row) => saleIdOf(row) ?? []);
  const sales = await db.sale.findMany({
    where: { orgId: ctx.orgId, id: { in: saleIds } },
    select: { id: true, number: true },
  });
  const staleBefore = Date.now() - STALE_MS;
  return {
    page: current,
    hasMore: rows.length > POSTINGS_PAGE,
    items: shown.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status as InventoryPosting["status"],
      document: row.sourceType === "Refund" ? "REFUND" : row.sourceType === "Sale" ? "SALE" : "REFUSED_SALE",
      saleNumber: sales.find((sale) => sale.id === saleIdOf(row))?.number ?? null,
      attempts: row.attempts,
      lastErrorCode: row.lastErrorCode,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      stale: row.status === "PENDING" && row.createdAt.getTime() < staleBefore,
    })),
  };
}

/**
 * Retry (I22, Owner and Admin): a refused or waiting posting is due now; then the shop's due
 * postings are sent. Answers the posting's status afterwards.
 */
export async function retryInventoryPosting(
  ctx: TenantContext,
  postingId: unknown,
  meta?: AuditRequestMeta,
): Promise<{ status: "PENDING" | "DONE" | "FAILED" }> {
  await requirePermission(ctx, "settings.manage", "inventory.posting.retry", meta);
  const id = z.uuid().safeParse(postingId);
  if (!id.success) throw notFound("Posting");
  const db = getDb();
  await db.$transaction(async (tx) => {
    const row = await tx.externalStockPosting.findFirst({
      where: { id: id.data, orgId: ctx.orgId, status: { in: ["PENDING", "FAILED"] } },
    });
    if (!row) throw notFound("Posting");
    await tx.externalStockPosting.update({
      where: { id: row.id },
      data: { status: "PENDING", nextAttemptAt: new Date() },
    });
    await record(tx, {
      ctx,
      meta,
      action: "integration.inventory.posting.retried",
      entityType: "ExternalStockPosting",
      entityId: row.id,
      metadata: { kind: row.kind, from: row.status, attempts: row.attempts, code: row.lastErrorCode },
    });
  });
  await drainPostings({ orgId: ctx.orgId, timeoutMs: 10_000 }).catch(() => undefined);
  const after = await db.externalStockPosting.findUniqueOrThrow({ where: { id: id.data }, select: { status: true } });
  return { status: after.status };
}

/**
 * The scheduler's run (I19), every minute: sends due postings of every linked shop, then syncs the
 * catalog of each linked shop whose last sync started over 15 minutes ago (the per-org claim still
 * applies, so a running "Sync now" is left alone). No actor: audit rows carry no user (I22).
 */
export async function runInventorySchedule(): Promise<{ sent: number; synced: number; failed: number; stale: number }> {
  const db = getDb();
  const { sent } = await drainPostings();
  const due = await db.inventoryLink.findMany({
    where: {
      org: { inventorySource: "EXTERNAL" },
      OR: [{ lastSyncStartedAt: null }, { lastSyncStartedAt: { lt: new Date(Date.now() - SYNC_EVERY_MS) } }],
    },
    orderBy: { lastSyncStartedAt: { sort: "asc", nulls: "first" } },
  });
  let synced = 0;
  let failed = 0;
  // ponytail: shops sync one after another; a slow IMS delays the next shop to the next minute's run.
  for (const row of due) {
    try {
      await syncWithLock({ orgId: row.orgId, branchId: null, userId: null }, undefined, openLink(row));
      synced += 1;
    } catch (err) {
      // SYNC_RUNNING: another run holds the claim. Anything else is recorded on the link and audited.
      if ((err instanceof AppError ? (err.details as { reason?: string }) : null)?.reason !== "SYNC_RUNNING") {
        failed += 1;
      }
    }
  }
  const stale = await db.externalStockPosting.count({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - STALE_MS) } },
  });
  return { sent, synced, failed, stale };
}

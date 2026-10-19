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
};

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

function loadLink(orgId: string) {
  return getDb().inventoryLink.findUnique({ where: { orgId } });
}

/** Decrypts the key for one call. A missing or rotated server key answers 409 KEY_UNREADABLE. */
function openLink(row: LinkRow): ImsLink {
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
  const [org, row] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { inventorySource: true } }),
    loadLink(ctx.orgId),
  ]);
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
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

/** I4 (slice 1): the key is accepted and may read products and stock. Write permissions are checked by slice 2. */
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
    const org = await tx.$queryRaw<{ inventorySource: InventorySource }[]>`
      SELECT "inventorySource" FROM "Organization" WHERE id = ${ctx.orgId}::uuid FOR UPDATE`;
    if (org[0]?.inventorySource === source)
      throw conflict("ALREADY_SET", "The shop already uses this inventory source");
    const link = await tx.inventoryLink.findUnique({ where: { orgId: ctx.orgId } });
    if (source === "EXTERNAL" && !link?.lastCheckOk) {
      throw conflict("CHECK_FAILED", "Save the link and pass the connection check first");
    }
    if (await tx.registerShift.count({ where: { orgId: ctx.orgId, status: "OPEN" } })) {
      throw conflict("OPEN_SHIFTS", "Close every open shift first");
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
  return syncWithLock(ctx, meta, openLink(row));
}

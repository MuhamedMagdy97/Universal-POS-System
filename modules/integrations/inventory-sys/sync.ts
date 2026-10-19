import "server-only";
/**
 * Catalog sync, inventory system → POS (integration spec I6–I11, I23). Pull only: page through
 * `GET /api/products`, read each product, apply it in its own short transaction. No POS lock is held
 * across an HTTP call; one sync per org at a time (claimed on `InventoryLink.syncLockedUntil`).
 * Stock quantities are never read or copied here.
 */
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { record, type AuditActor, type AuditRequestMeta } from "@/modules/audit";
import { applyExternalItem, archiveUnlisted, ShapeChanged } from "@/modules/catalog";
import { imsGet, type ImsLink } from "./client";
import { mapImsProduct, type ImsProduct } from "./mapping";

export type SyncSummary = {
  listed: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  skipped: { id: string; reason: string }[];
  notes: string[];
};

const PAGE_SIZE = 200;
const PARALLEL = 4;
const MAX_LISTED = 50; // skipped items and notes kept in the summary
const LOCK_MS = 10 * 60_000;

type ImsPage = { total: number; items: { id: string }[] };

async function listProductIds(link: ImsLink): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const res = await imsGet<ImsPage>(link, `/api/products?page=${page}&per_page=${PAGE_SIZE}`);
    ids.push(...res.items.map((item) => item.id));
    if (res.items.length < PAGE_SIZE || ids.length >= res.total) return ids;
  }
}

function skipReason(err: unknown): string | null {
  if (err instanceof ShapeChanged) return "SHAPE_CHANGED";
  if ((err as { code?: unknown })?.code === "P2002") return "SKU_OR_BARCODE_TAKEN";
  if (err instanceof AppError && err.code === "NOT_FOUND") return "GONE";
  return null;
}

/** Runs one full pass. IMS outages abort it (rethrown); a product that cannot be applied is skipped. */
export async function runCatalogSync(
  actor: AuditActor,
  meta: AuditRequestMeta | undefined,
  link: ImsLink,
): Promise<SyncSummary> {
  const summary: SyncSummary = { listed: 0, created: 0, updated: 0, unchanged: 0, archived: 0, skipped: [], notes: [] };
  const skip = (id: string, reason: string) => {
    if (summary.skipped.length < MAX_LISTED) summary.skipped.push({ id, reason });
  };
  const ids = await listProductIds(link);
  summary.listed = ids.length;

  for (let i = 0; i < ids.length; i += PARALLEL) {
    // allSettled: let the batch finish before an outage aborts the pass, so nothing runs on after it.
    const results = await Promise.allSettled(
      ids.slice(i, i + PARALLEL).map(async (id) => {
        try {
          const product = await imsGet<ImsProduct>(link, `/api/products/${encodeURIComponent(id)}`);
          const { item, notes } = mapImsProduct(product);
          summary.notes.push(...notes.slice(0, Math.max(0, MAX_LISTED - summary.notes.length)));
          if (!item) return skip(id, "SHAPE_UNSUPPORTED");
          const outcome = await getDb().$transaction((tx) => applyExternalItem(tx, actor, meta, item));
          summary[outcome] += 1;
        } catch (err) {
          const reason = skipReason(err);
          if (!reason) throw err;
          skip(id, reason);
        }
      }),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }
  summary.archived = await getDb().$transaction((tx) => archiveUnlisted(tx, actor, meta, ids));
  return summary;
}

/** Claims the org's sync slot (409 SYNC_RUNNING if taken), runs, records the outcome and audits it. */
export async function syncWithLock(
  actor: AuditActor,
  meta: AuditRequestMeta | undefined,
  link: ImsLink,
): Promise<SyncSummary> {
  const db = getDb();
  const now = new Date();
  const claimed = await db.inventoryLink.updateMany({
    where: { orgId: actor.orgId, OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: now } }] },
    data: { syncLockedUntil: new Date(now.getTime() + LOCK_MS), lastSyncStartedAt: now },
  });
  if (claimed.count !== 1) {
    throw new AppError("CONFLICT", "A sync is already running", { reason: "SYNC_RUNNING" });
  }
  let summary: SyncSummary | null = null;
  let failure: unknown = null;
  try {
    summary = await runCatalogSync(actor, meta, link);
  } catch (err) {
    failure = err;
  }
  const failedReason = (failure as AppError | null)?.details as { reason?: string } | undefined;
  await db.$transaction(async (tx) => {
    await tx.inventoryLink.update({
      where: { orgId: actor.orgId },
      data: {
        syncLockedUntil: null,
        lastSyncFinishedAt: new Date(),
        lastSyncOk: failure === null,
        ...(summary ? { lastSyncSummary: summary } : {}),
      },
    });
    await record(tx, {
      ctx: actor,
      meta,
      action: failure ? "integration.inventory.sync.failed" : "integration.inventory.sync.completed",
      entityType: "InventoryLink",
      entityId: actor.orgId,
      metadata: summary
        ? { ...summary, skipped: summary.skipped.length, notes: summary.notes.length }
        : { reason: failedReason?.reason ?? "UNEXPECTED" },
    });
  });
  if (failure) throw failure;
  return summary as SyncSummary;
}

import "server-only";
/**
 * Catalog writes for the inventory-system sync (integration spec I7–I11). The inventory system is
 * master, so synced fields are overwritten; POS-owned fields (Arabic names, VAT category, category,
 * variant sort order) are never touched. Called by modules/integrations/inventory-sys only, one
 * product per transaction. Audit rows are the usual catalog actions with `metadata.source`.
 */
import type { AuditActor, AuditRequestMeta } from "@/modules/audit";
import { record } from "@/modules/audit";
import type { Prisma } from "@/lib/generated/prisma/client";

type Tx = Prisma.TransactionClient;

export type NotSellableReason = "STATUS" | "NO_PRICE" | "SERIALIZED" | "UNIT" | "REMOVED";

export type ExternalVariant = {
  externalVariantId: string;
  sku: string;
  name: string;
  priceMinor: number;
  costMinor: number;
  isActive: boolean;
  notSellableReason: NotSellableReason | null;
  /** First code is the primary barcode. */
  barcodes: string[];
};

/** A product without variants carries its one IMS variant inline (`variants: null`). */
export type ExternalItem = Omit<ExternalVariant, "externalVariantId"> & {
  externalProductId: string;
  externalVariantId: string | null;
  unitType: "EACH" | "KG";
  variants: ExternalVariant[] | null;
};

export type ApplyOutcome = "created" | "updated" | "unchanged";

/** The product exists in the POS with another shape (variants ↔ none, or unit): left alone and reported. */
export class ShapeChanged extends Error {}

type Writer = { tx: Tx; actor: AuditActor; meta?: AuditRequestMeta };

const SOURCE = { source: "inventory-sync" } as const;

function changes<T extends Record<string, unknown>>(current: T, next: T): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of Object.keys(next)) if (current[key] !== next[key]) out[key] = [current[key], next[key]];
  return out;
}

async function audit(w: Writer, action: `catalog.${string}`, entityType: string, entityId: string, data: object) {
  await record(w.tx, { ctx: w.actor, meta: w.meta, action, entityType, entityId, metadata: { ...data, ...SOURCE } });
}

/** Writes the fields that changed, with the catalog's audit actions; `kind` is "product" or "variant". */
async function auditChanges(
  w: Writer,
  kind: "product" | "variant",
  id: string,
  diff: Record<string, [unknown, unknown]>,
): Promise<void> {
  const entity = kind === "product" ? "Product" : "ProductVariant";
  const { priceMinor, costMinor, isActive, ...rest } = diff;
  const prices = Object.fromEntries(Object.entries({ priceMinor, costMinor }).filter(([, v]) => v !== undefined));
  if (Object.keys(prices).length > 0) await audit(w, `catalog.${kind}.price_changed`, entity, id, prices);
  if (Object.keys(rest).length > 0) await audit(w, `catalog.${kind}.updated`, entity, id, { changes: rest });
  if (isActive) await audit(w, `catalog.${kind}.${isActive[1] ? "restored" : "archived"}`, entity, id, {});
}

/**
 * Makes the item's barcodes exactly `desired` (first = primary). A code held by another POS item is
 * taken from it (I11: the linked row wins; a stale linked row is corrected when its own product syncs).
 */
async function syncBarcodes(
  w: Writer,
  target: { productId: string; variantId: string | null },
  desired: string[],
): Promise<boolean> {
  const { tx, actor } = w;
  const current = await tx.barcode.findMany({ where: { orgId: actor.orgId, ...target } });
  const removed = current.filter((b) => !desired.includes(b.code)).map((b) => b.code);
  const added = desired.filter((code) => !current.some((b) => b.code === code));
  const primary = desired[0] ?? null;
  const primaryChanged = current.find((b) => b.isPrimary)?.code !== (primary ?? undefined);
  if (removed.length === 0 && added.length === 0 && !primaryChanged) return false;

  await tx.barcode.deleteMany({ where: { orgId: actor.orgId, ...target, code: { in: removed } } });
  await tx.barcode.updateMany({
    where: { orgId: actor.orgId, ...target, isPrimary: true },
    data: { isPrimary: false },
  });
  const taken = await tx.barcode.findMany({ where: { orgId: actor.orgId, code: { in: added } } });
  for (const other of taken) {
    await tx.barcode.delete({ where: { id: other.id } });
    await audit(w, "catalog.barcode.removed", "Barcode", other.id, {
      code: other.code,
      productId: other.productId,
      variantId: other.variantId,
      reason: "TAKEN_BY_SYNC",
    });
  }
  for (const code of added) {
    await tx.barcode.create({ data: { orgId: actor.orgId, ...target, code, isPrimary: false } });
  }
  if (primary) {
    await tx.barcode.updateMany({ where: { orgId: actor.orgId, ...target, code: primary }, data: { isPrimary: true } });
  }
  await audit(w, "catalog.barcode.item", "Product", target.productId, {
    variantId: target.variantId,
    added,
    removed,
    primary,
  });
  return true;
}

/** Creates or updates one synced product (and its variants and barcodes) inside `tx`. */
export async function applyExternalItem(
  tx: Tx,
  actor: AuditActor,
  meta: AuditRequestMeta | undefined,
  item: ExternalItem,
): Promise<ApplyOutcome> {
  const w: Writer = { tx, actor, meta };
  const orgId = actor.orgId;
  const hasVariants = item.variants !== null;

  // Linked row first; otherwise adopt an unlinked POS product with the same SKU (keeps its id and history, I20).
  const existing =
    (await tx.product.findFirst({ where: { orgId, externalProductId: item.externalProductId } })) ??
    (await tx.product.findFirst({ where: { orgId, externalProductId: null, sku: item.sku } }));
  if (existing && (existing.hasVariants !== hasVariants || existing.unitType !== item.unitType)) {
    throw new ShapeChanged(item.externalProductId);
  }

  const fields = {
    sku: item.sku,
    name: item.name,
    priceMinor: item.priceMinor,
    costMinor: item.costMinor,
    isActive: item.isActive,
    notSellableReason: item.notSellableReason,
    externalProductId: item.externalProductId,
    externalVariantId: item.externalVariantId,
  };
  let outcome: ApplyOutcome = "unchanged";
  let productId: string;
  if (!existing) {
    const created = await tx.product.create({
      data: { orgId, ...fields, unitType: item.unitType, hasVariants },
    });
    productId = created.id;
    outcome = "created";
    await audit(w, "catalog.product.created", "Product", productId, {
      sku: item.sku,
      name: item.name,
      priceMinor: item.priceMinor,
      costMinor: item.costMinor,
      externalProductId: item.externalProductId,
    });
  } else {
    productId = existing.id;
    const diff = changes(existing as unknown as Record<string, unknown>, fields);
    if (Object.keys(diff).length > 0) {
      await tx.product.update({ where: { id: productId }, data: fields });
      await auditChanges(w, "product", productId, diff);
      outcome = "updated";
    }
  }

  const barcodesChanged = await syncBarcodes(w, { productId, variantId: null }, item.barcodes);
  const variantsChanged = item.variants ? await syncVariants(w, productId, item.variants) : false;
  return outcome === "unchanged" && (barcodesChanged || variantsChanged) ? "updated" : outcome;
}

async function syncVariants(w: Writer, productId: string, variants: ExternalVariant[]): Promise<boolean> {
  const { tx, actor } = w;
  let changed = false;
  const orgId = actor.orgId;
  const current = await tx.productVariant.findMany({ where: { orgId, productId } });
  for (const [index, v] of variants.entries()) {
    const fields = {
      sku: v.sku,
      name: v.name,
      priceMinor: v.priceMinor,
      costMinor: v.costMinor,
      isActive: v.isActive,
      notSellableReason: v.notSellableReason,
      externalVariantId: v.externalVariantId,
    };
    const existing =
      current.find((row) => row.externalVariantId === v.externalVariantId) ??
      current.find((row) => row.externalVariantId === null && row.sku === v.sku);
    let variantId: string;
    if (!existing) {
      variantId = (await tx.productVariant.create({ data: { orgId, productId, sortOrder: index, ...fields } })).id;
      await audit(w, "catalog.variant.created", "ProductVariant", variantId, {
        productId,
        sku: v.sku,
        priceMinor: v.priceMinor,
        externalVariantId: v.externalVariantId,
      });
      changed = true;
    } else {
      variantId = existing.id;
      const diff = changes(existing as unknown as Record<string, unknown>, fields);
      if (Object.keys(diff).length > 0) {
        await tx.productVariant.update({ where: { id: variantId }, data: fields });
        await auditChanges(w, "variant", variantId, diff);
        changed = true;
      }
    }
    if (await syncBarcodes(w, { productId, variantId }, v.barcodes)) changed = true;
  }
  const listed = new Set(variants.map((v) => v.externalVariantId));
  for (const row of current) {
    if (row.isActive && (!row.externalVariantId || !listed.has(row.externalVariantId))) {
      await tx.productVariant.update({
        where: { id: row.id },
        data: { isActive: false, notSellableReason: "REMOVED" },
      });
      await audit(w, "catalog.variant.archived", "ProductVariant", row.id, {});
      changed = true;
    }
  }
  return changed;
}

/**
 * I10 + I20: every active product the inventory system did not list — removed there, or a POS-only
 * item — is archived (never deleted; its barcodes stay so the till says "archived"). Returns the count.
 */
export async function archiveUnlisted(
  tx: Tx,
  actor: AuditActor,
  meta: AuditRequestMeta | undefined,
  listedExternalProductIds: string[],
): Promise<number> {
  const rows = await tx.product.findMany({
    where: {
      orgId: actor.orgId,
      isActive: true,
      OR: [{ externalProductId: null }, { externalProductId: { notIn: listedExternalProductIds } }],
    },
    select: { id: true, sku: true },
  });
  if (rows.length === 0) return 0;
  await tx.product.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { isActive: false, notSellableReason: "REMOVED" },
  });
  const w: Writer = { tx, actor, meta };
  for (const row of rows) await audit(w, "catalog.product.archived", "Product", row.id, { sku: row.sku });
  return rows.length;
}

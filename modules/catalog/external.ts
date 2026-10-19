import "server-only";
/**
 * Catalog writes for the inventory-system sync (integration spec I7–I11). The inventory system is
 * master, so synced fields (and, since category sync, categories and a product's category) are
 * overwritten; POS-owned fields (Arabic names, VAT category, variant sort order) are never touched. Called by modules/integrations/inventory-sys only, one
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
  /** IMS category id; resolved to the POS category by `applyExternalItem`'s `categoryIds`. */
  externalCategoryId: string | null;
  externalVariantId: string | null;
  unitType: "EACH" | "KG";
  variants: ExternalVariant[] | null;
};

export type ApplyOutcome = "created" | "updated" | "unchanged";

/** One IMS category, already fitted to the POS tree (depth ≤ 3); parents are applied before children. */
export type ExternalCategory = {
  externalCategoryId: string;
  externalParentId: string | null;
  name: string;
  isActive: boolean;
  sortOrder: number;
  depth: number;
};

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
  /** IMS category id → POS category id (from `applyExternalCategory`); unknown ids leave the product uncategorised. */
  categoryIds: ReadonlyMap<string, string> = new Map(),
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
    categoryId: (item.externalCategoryId && categoryIds.get(item.externalCategoryId)) || null,
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

/**
 * Creates or updates one synced category inside `tx`; returns its POS id. Linked row first; otherwise
 * adopts an unlinked POS category with the same name (case-insensitive) under the same parent, like
 * products adopt by SKU. `parentId` is the POS id of the IMS parent (null for a root, or a parent that
 * could not be applied). A sibling-name clash throws P2002; the caller skips that category.
 */
export async function applyExternalCategory(
  tx: Tx,
  actor: AuditActor,
  meta: AuditRequestMeta | undefined,
  category: ExternalCategory,
  parentId: string | null,
): Promise<{ id: string; outcome: ApplyOutcome }> {
  const w: Writer = { tx, actor, meta };
  const orgId = actor.orgId;
  const existing =
    (await tx.category.findFirst({ where: { orgId, externalCategoryId: category.externalCategoryId } })) ??
    (await tx.category.findFirst({
      where: { orgId, externalCategoryId: null, parentId, name: { equals: category.name, mode: "insensitive" } },
    }));
  const fields = {
    name: category.name,
    parentId,
    isActive: category.isActive,
    sortOrder: category.sortOrder,
    externalCategoryId: category.externalCategoryId,
  };
  if (!existing) {
    const created = await tx.category.create({ data: { orgId, ...fields } });
    await audit(w, "catalog.category.created", "Category", created.id, {
      name: created.name,
      parentId,
      externalCategoryId: category.externalCategoryId,
    });
    return { id: created.id, outcome: "created" };
  }
  const { isActive, ...diff } = changes(existing as unknown as Record<string, unknown>, fields);
  if (!isActive && Object.keys(diff).length === 0) return { id: existing.id, outcome: "unchanged" };
  await tx.category.update({ where: { id: existing.id }, data: fields });
  if (Object.keys(diff).length > 0) {
    await audit(w, "catalog.category.updated", "Category", existing.id, { name: fields.name, parentId, changes: diff });
  }
  if (isActive) {
    await audit(w, `catalog.category.${fields.isActive ? "restored" : "archived"}`, "Category", existing.id, {
      name: fields.name,
      parentId,
    });
  }
  return { id: existing.id, outcome: "updated" };
}

/**
 * Every active category the inventory system did not list (removed there, or POS-only and not adopted) is
 * archived; products keep their category (R5). Returns the count.
 */
export async function archiveUnlistedCategories(
  tx: Tx,
  actor: AuditActor,
  meta: AuditRequestMeta | undefined,
  listedExternalCategoryIds: string[],
): Promise<number> {
  const rows = await tx.category.findMany({
    where: {
      orgId: actor.orgId,
      isActive: true,
      OR: [{ externalCategoryId: null }, { externalCategoryId: { notIn: listedExternalCategoryIds } }],
    },
    select: { id: true, name: true, parentId: true },
  });
  if (rows.length === 0) return 0;
  await tx.category.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { isActive: false } });
  const w: Writer = { tx, actor, meta };
  for (const row of rows) {
    await audit(w, "catalog.category.archived", "Category", row.id, { name: row.name, parentId: row.parentId });
  }
  return rows.length;
}

/**
 * The inventory-system variant id of each item (sale posting, stock at the till), in input order;
 * null for an item the sync never linked. Tx-aware, no permission check: the caller authorises first.
 */
export async function externalVariantIdsOf(
  client: Pick<Prisma.TransactionClient, "product" | "productVariant">,
  orgId: string,
  refs: readonly { productId: string; variantId: string | null }[],
): Promise<(string | null)[]> {
  const [products, variants] = await Promise.all([
    client.product.findMany({
      where: { orgId, id: { in: refs.map((ref) => ref.productId) } },
      select: { id: true, externalVariantId: true },
    }),
    client.productVariant.findMany({
      where: { orgId, id: { in: refs.flatMap((ref) => (ref.variantId ? [ref.variantId] : [])) } },
      select: { id: true, externalVariantId: true },
    }),
  ]);
  const byProduct = new Map(products.map((row) => [row.id, row.externalVariantId]));
  const byVariant = new Map(variants.map((row) => [row.id, row.externalVariantId]));
  return refs.map((ref) => (ref.variantId ? byVariant.get(ref.variantId) : byProduct.get(ref.productId)) ?? null);
}

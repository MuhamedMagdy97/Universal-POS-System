import "server-only";
/**
 * Category services (T3.4): a tree of at most 3 levels, no cycles, sibling names
 * unique case-insensitively (DB index), archive blocked only by active child
 * categories (resolution R5 — products do not block). Tree edits take a per-org
 * advisory lock so concurrent re-parents cannot sneak past the depth/cycle checks.
 */
import type { z } from "zod";
import { notFound } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import { assertFresh, conflict, invalid } from "./errors";
import {
  audit,
  db,
  inTx,
  lockKey,
  parseId,
  requirePermission,
  withUniqueMapping,
  type CatalogMeta,
  type Tx,
} from "./internal";
import { diffFields, exceedsMaxDepth, nextUpdatedAt, wouldCreateCycle, type CategoryParentMap } from "./rules";
import { ArchiveInput, CreateCategory, ListCategoriesQuery, UpdateCategory } from "./schemas";

export type CategoryNode = {
  id: string;
  parentId: string | null;
  name: string;
  nameAr: string | null;
  isActive: boolean;
  sortOrder: number;
  /** Root = 1. */
  depth: number;
  updatedAt: string;
  children: CategoryNode[];
};

export type CategoryDetail = Omit<CategoryNode, "children" | "depth">;

type CategoryRow = {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  nameAr: string | null;
  isActive: boolean;
  sortOrder: number;
  updatedAt: Date;
};

function toDetail(row: CategoryRow): CategoryDetail {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    nameAr: row.nameAr,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const TREE_LOCK = "pos_category_tree";

async function parentMap(tx: Tx, orgId: string): Promise<Map<string, string | null>> {
  const rows = await tx.category.findMany({ where: { orgId }, select: { id: true, parentId: true } });
  return new Map(rows.map((r) => [r.id, r.parentId]));
}

/**
 * A category a product (or a child category) may be newly assigned to:
 * unknown/other-tenant → 404, archived → 422 CATEGORY_INACTIVE.
 */
export async function assertAssignableCategory(tx: Tx, ctx: TenantContext, categoryId: string): Promise<void> {
  const category = await tx.category.findFirst({
    where: { id: categoryId, orgId: ctx.orgId },
    select: { isActive: true },
  });
  if (!category) throw notFound("Category");
  if (!category.isActive) throw invalid("CATEGORY_INACTIVE", { field: "categoryId" });
}

/** Checks a (new) parent for `id` (null for a new category): exists, active, no cycle, depth ≤ 3. */
function assertPlacement(parents: CategoryParentMap, id: string | null, parentId: string | null): void {
  if (!parentId) {
    if (exceedsMaxDepth(parents, id, null)) throw invalid("CATEGORY_TOO_DEEP", { field: "parentId" });
    return;
  }
  if (id && wouldCreateCycle(parents, id, parentId)) throw invalid("CATEGORY_CYCLE", { field: "parentId" });
  if (exceedsMaxDepth(parents, id, parentId)) throw invalid("CATEGORY_TOO_DEEP", { field: "parentId" });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The whole tree (catalogs have few categories; no cursor). Ordered by
 * sortOrder, name, id at every level. With a status filter, a node whose parent
 * is filtered out is returned as a root.
 */
export async function listCategories(
  ctx: TenantContext,
  input: z.input<typeof ListCategoriesQuery> = {},
): Promise<CategoryNode[]> {
  await requirePermission(ctx, "products.read");
  const { status } = ListCategoriesQuery.parse(input);
  const rows = await db().category.findMany({
    where: {
      orgId: ctx.orgId,
      ...(status === "active" ? { isActive: true } : status === "archived" ? { isActive: false } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
  });

  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) nodes.set(row.id, { ...toDetail(row), depth: 1, children: [] });
  const roots: CategoryNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const setDepth = (list: CategoryNode[], depth: number) => {
    for (const node of list) {
      node.depth = depth;
      setDepth(node.children, depth + 1);
    }
  };
  setDepth(roots, 1);
  return roots;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createCategory(
  ctx: TenantContext,
  input: z.input<typeof CreateCategory>,
  meta?: CatalogMeta,
): Promise<CategoryDetail> {
  await requirePermission(ctx, "products.create", { entityType: "Category", operation: "create", meta });
  const data = CreateCategory.parse(input);

  return withUniqueMapping(ctx, { category: { name: data.name, parentId: data.parentId } }, () =>
    inTx(async (tx) => {
      await lockKey(tx, TREE_LOCK, ctx.orgId);
      if (data.parentId) await assertAssignableCategory(tx, ctx, data.parentId);
      assertPlacement(await parentMap(tx, ctx.orgId), null, data.parentId);
      const row = await tx.category.create({
        data: { orgId: ctx.orgId, name: data.name, nameAr: data.nameAr ?? null, parentId: data.parentId },
      });
      await audit(tx, ctx, meta, "catalog.category.created", "Category", row.id, {
        name: row.name,
        nameAr: row.nameAr,
        parentId: row.parentId,
      });
      return toDetail(row);
    }),
  );
}

/** Rename and/or re-parent. Re-parenting checks the whole moved subtree against the depth limit. */
export async function updateCategory(
  ctx: TenantContext,
  categoryId: string,
  input: z.input<typeof UpdateCategory>,
  meta?: CatalogMeta,
): Promise<CategoryDetail> {
  await requirePermission(ctx, "products.update", { entityType: "Category", operation: "update", meta });
  const id = parseId(categoryId, "Category");
  const { expectedUpdatedAt, ...patch } = UpdateCategory.parse(input);

  let hints: { name: string; parentId: string | null } | undefined;
  return withUniqueMapping(
    ctx,
    () => ({ category: hints }),
    () =>
      inTx(async (tx) => {
        await lockKey(tx, TREE_LOCK, ctx.orgId);
        const current = await tx.category.findFirst({ where: { id, orgId: ctx.orgId } });
        if (!current) throw notFound("Category");
        assertFresh(current.updatedAt, expectedUpdatedAt);
        hints = {
          name: patch.name ?? current.name,
          parentId: patch.parentId !== undefined ? patch.parentId : current.parentId,
        };

        if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
          if (patch.parentId) {
            if (patch.parentId === id) throw invalid("CATEGORY_CYCLE", { field: "parentId" });
            await assertAssignableCategory(tx, ctx, patch.parentId);
          }
          assertPlacement(await parentMap(tx, ctx.orgId), id, patch.parentId);
        }

        const changes = diffFields({ name: current.name, nameAr: current.nameAr, parentId: current.parentId }, patch);
        if (Object.keys(changes).length === 0) return toDetail(current);

        const updated = await tx.category.update({
          where: { id },
          data: { ...patch, updatedAt: nextUpdatedAt(current.updatedAt) },
        });
        await audit(tx, ctx, meta, "catalog.category.updated", "Category", id, {
          name: updated.name,
          parentId: updated.parentId,
          changes,
        });
        return toDetail(updated);
      }),
  );
}

async function setCategoryActive(
  ctx: TenantContext,
  categoryId: string,
  input: z.input<typeof ArchiveInput>,
  active: boolean,
  meta?: CatalogMeta,
): Promise<CategoryDetail> {
  await requirePermission(ctx, "products.update", {
    entityType: "Category",
    operation: active ? "restore" : "archive",
    meta,
  });
  const id = parseId(categoryId, "Category");
  const { expectedUpdatedAt } = ArchiveInput.parse(input);

  return inTx(async (tx) => {
    await lockKey(tx, TREE_LOCK, ctx.orgId);
    const current = await tx.category.findFirst({ where: { id, orgId: ctx.orgId } });
    if (!current) throw notFound("Category");
    if (current.isActive === active) throw conflict(active ? "NOT_ARCHIVED" : "ALREADY_ARCHIVED");
    assertFresh(current.updatedAt, expectedUpdatedAt);

    if (active) {
      // Restoring under an archived parent would create an active child of an archived node.
      if (current.parentId) {
        const parent = await tx.category.findFirst({
          where: { id: current.parentId, orgId: ctx.orgId },
          select: { isActive: true },
        });
        if (!parent?.isActive) throw invalid("CATEGORY_INACTIVE", { field: "parentId" });
      }
    } else {
      const activeChildren = await tx.category.count({ where: { orgId: ctx.orgId, parentId: id, isActive: true } });
      if (activeChildren > 0) throw conflict("CATEGORY_HAS_ACTIVE_CHILDREN", { count: activeChildren });
    }

    const updated = await tx.category.update({
      where: { id },
      data: { isActive: active, updatedAt: nextUpdatedAt(current.updatedAt) },
    });
    await audit(tx, ctx, meta, active ? "catalog.category.restored" : "catalog.category.archived", "Category", id, {
      name: updated.name,
      parentId: updated.parentId,
    });
    return toDetail(updated);
  });
}

/** Archive. Blocked (409) only by active child categories; products keep their category (R5). */
export function archiveCategory(
  ctx: TenantContext,
  categoryId: string,
  input: z.input<typeof ArchiveInput>,
  meta?: CatalogMeta,
): Promise<CategoryDetail> {
  return setCategoryActive(ctx, categoryId, input, false, meta);
}

/** Restore. The parent (if any) must be active (422 CATEGORY_INACTIVE). */
export function restoreCategory(
  ctx: TenantContext,
  categoryId: string,
  input: z.input<typeof ArchiveInput>,
  meta?: CatalogMeta,
): Promise<CategoryDetail> {
  return setCategoryActive(ctx, categoryId, input, true, meta);
}

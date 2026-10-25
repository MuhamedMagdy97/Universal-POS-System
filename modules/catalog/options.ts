import "server-only";
/**
 * Option groups (docs/planning/ui-refresh/restaurant-cafe-spec.md R7): "Size" (exactly one), "Extras" (up to three).
 * `products.update` manages them; a removed choice is deactivated, never deleted, so old sale snapshots and offline
 * tills keep working. Weighed products and products with variants cannot have groups. A shop linked to the inventory
 * system answers 409 MANAGED_BY_INVENTORY, as for categories.
 */
import { notFound } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import { assertBuiltIn } from "@/modules/integrations/inventory-sys/source";
import { invalid } from "./errors";
import { audit, db, inTx, parseId, requirePermission, type CatalogMeta } from "./internal";
import { OptionGroupInput, Uuid, type OptionGroupView } from "./schemas";

export type OptionGroupDetail = OptionGroupView & { isActive: boolean; productCount: number };

const GROUP_SELECT = {
  id: true,
  name: true,
  nameAr: true,
  minSelect: true,
  maxSelect: true,
  isActive: true,
  choices: {
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }],
    select: { id: true, name: true, nameAr: true, priceDeltaMinor: true },
  },
  _count: { select: { products: true } },
};

type GroupRow = {
  id: string;
  name: string;
  nameAr: string | null;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  choices: OptionGroupView["choices"];
  _count: { products: number };
};

const toDetail = ({ _count, ...row }: GroupRow): OptionGroupDetail => ({ ...row, productCount: _count.products });

/** Every group (active first, then by name) with its active choices. */
export async function listOptionGroups(ctx: TenantContext): Promise<OptionGroupDetail[]> {
  await requirePermission(ctx, "products.read");
  const rows = await db().optionGroup.findMany({
    where: { orgId: ctx.orgId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
    select: GROUP_SELECT,
  });
  return rows.map(toDetail);
}

export async function createOptionGroup(
  ctx: TenantContext,
  input: unknown,
  meta?: CatalogMeta,
): Promise<OptionGroupDetail> {
  await requirePermission(ctx, "products.update", { entityType: "OptionGroup", operation: "create", meta });
  await assertBuiltIn(ctx.orgId);
  const data = OptionGroupInput.parse(input);
  return inTx(async (tx) => {
    const group = await tx.optionGroup.create({
      data: {
        orgId: ctx.orgId,
        name: data.name,
        nameAr: data.nameAr ?? null,
        minSelect: data.minSelect,
        maxSelect: data.maxSelect,
      },
    });
    await tx.optionChoice.createMany({
      data: data.choices.map((choice, index) => ({
        orgId: ctx.orgId,
        groupId: group.id,
        name: choice.name,
        nameAr: choice.nameAr ?? null,
        priceDeltaMinor: choice.priceDeltaMinor,
        sortOrder: index,
      })),
    });
    await audit(tx, ctx, meta, "catalog.option_group.created", "OptionGroup", group.id, { group: data });
    return toDetail(await tx.optionGroup.findUniqueOrThrow({ where: { id: group.id }, select: GROUP_SELECT }));
  });
}

/** Replaces the group's fields and choices; `isActive: false` archives the group (it leaves every till). */
export async function updateOptionGroup(
  ctx: TenantContext,
  groupId: string,
  input: unknown,
  meta?: CatalogMeta,
): Promise<OptionGroupDetail> {
  await requirePermission(ctx, "products.update", { entityType: "OptionGroup", operation: "update", meta });
  await assertBuiltIn(ctx.orgId);
  const id = parseId(groupId, "OptionGroup");
  const { isActive, ...rest } = (input ?? {}) as { isActive?: unknown };
  const data = OptionGroupInput.parse(rest);
  return inTx(async (tx) => {
    const current = await tx.optionGroup.findFirst({
      where: { id, orgId: ctx.orgId },
      select: { id: true, choices: { select: { id: true } } },
    });
    if (!current) throw notFound("OptionGroup");
    const known = new Set(current.choices.map((choice) => choice.id));
    const kept = new Set(data.choices.flatMap((choice) => (choice.id ? [choice.id] : [])));
    for (const choiceId of kept) if (!known.has(choiceId)) throw notFound("OptionChoice");

    await tx.optionGroup.update({
      where: { id },
      data: {
        name: data.name,
        nameAr: data.nameAr ?? null,
        minSelect: data.minSelect,
        maxSelect: data.maxSelect,
        ...(typeof isActive === "boolean" && { isActive }),
      },
    });
    await tx.optionChoice.updateMany({
      where: { orgId: ctx.orgId, groupId: id, id: { notIn: [...kept] } },
      data: { isActive: false },
    });
    for (const [index, choice] of data.choices.entries()) {
      const fields = {
        name: choice.name,
        nameAr: choice.nameAr ?? null,
        priceDeltaMinor: choice.priceDeltaMinor,
        sortOrder: index,
        isActive: true,
      };
      if (choice.id) await tx.optionChoice.update({ where: { id: choice.id }, data: fields });
      else await tx.optionChoice.create({ data: { orgId: ctx.orgId, groupId: id, ...fields } });
    }
    await audit(tx, ctx, meta, "catalog.option_group.updated", "OptionGroup", id, {
      group: data,
      ...(typeof isActive === "boolean" && { isActive }),
    });
    return toDetail(await tx.optionGroup.findUniqueOrThrow({ where: { id }, select: GROUP_SELECT }));
  });
}

/** The product's groups in this order (an empty list removes them all). */
export async function setProductOptionGroups(
  ctx: TenantContext,
  productId: string,
  groupIds: unknown,
  meta?: CatalogMeta,
): Promise<{ groupIds: string[] }> {
  await requirePermission(ctx, "products.update", { entityType: "Product", operation: "option_groups", meta });
  await assertBuiltIn(ctx.orgId);
  const id = parseId(productId, "Product");
  const ids = Uuid.array()
    .max(10)
    .refine((list) => new Set(list).size === list.length)
    .parse(groupIds);
  return inTx(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id, orgId: ctx.orgId },
      select: { unitType: true, hasVariants: true },
    });
    if (!product) throw notFound("Product");
    if (ids.length > 0 && product.unitType === "KG") throw invalid("UNIT_NOT_SUPPORTED", { field: "optionGroups" });
    if (ids.length > 0 && product.hasVariants) throw invalid("OPTIONS_NOT_SUPPORTED", { field: "optionGroups" });
    const found = await tx.optionGroup.count({ where: { orgId: ctx.orgId, id: { in: ids } } });
    if (found !== ids.length) throw notFound("OptionGroup");
    await tx.productOptionGroup.deleteMany({ where: { orgId: ctx.orgId, productId: id } });
    await tx.productOptionGroup.createMany({
      data: ids.map((groupId, index) => ({ orgId: ctx.orgId, productId: id, groupId, sortOrder: index })),
    });
    await audit(tx, ctx, meta, "catalog.product.option_groups.set", "Product", id, { groupIds: ids });
    return { groupIds: ids };
  });
}

/** The product's linked group ids, in order. */
export async function getProductOptionGroupIds(ctx: TenantContext, productId: string): Promise<string[]> {
  await requirePermission(ctx, "products.read");
  const rows = await db().productOptionGroup.findMany({
    where: { orgId: ctx.orgId, productId: parseId(productId, "Product") },
    orderBy: [{ sortOrder: "asc" }, { groupId: "asc" }],
    select: { groupId: true },
  });
  return rows.map((row) => row.groupId);
}

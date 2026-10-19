import { Suspense } from "react";
import { listCategories, MAX_CATEGORY_DEPTH } from "@/modules/catalog";
import { translator } from "@/lib/i18n";
import { isForbidden, loadCatalogContext } from "../_lib/context";
import { flattenCategories } from "../_lib/category-options";
import { CatalogPage, CatalogSubnav, PermissionDenied, TableSkeleton } from "../_components/shell";
import { CategoriesManager } from "../_components/categories-manager";
import { ManagedNotice } from "../../_components/managed-notice";

export default function CategoriesPage() {
  return (
    <Suspense fallback={<TableSkeleton rows={6} />}>
      <CategoriesContent />
    </Suspense>
  );
}

async function CategoriesContent() {
  const page = await loadCatalogContext("/catalog/categories");
  if (page.kind === "denied") return <PermissionDenied locale={page.locale} />;
  const { ctx, locale, can, managed } = page;
  const tr = translator(locale);

  let tree;
  try {
    tree = await listCategories(ctx, { status: "all" });
  } catch (err) {
    if (isForbidden(err)) return <PermissionDenied locale={locale} />;
    throw err;
  }

  const rows = flattenCategories(tree).map((c) => ({
    id: c.id,
    parentId: c.parentId,
    name: c.name,
    nameAr: c.nameAr,
    isActive: c.isActive,
    depth: c.depth,
    updatedAt: c.updatedAt,
  }));

  return (
    <CatalogPage locale={locale}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("catalog.categories.title")}</h1>
        <CatalogSubnav locale={locale} current="categories" />
      </div>
      {managed ? <ManagedNotice locale={locale} area="categories" /> : null}
      <CategoriesManager
        // Remount after a server refresh so rows reflect the new tree.
        key={rows.map((r) => `${r.id}:${r.updatedAt}`).join("|")}
        locale={locale}
        rows={rows}
        maxDepth={MAX_CATEGORY_DEPTH}
        canCreate={can.create}
        canUpdate={can.update}
      />
    </CatalogPage>
  );
}

import { Suspense } from "react";
import { listCategories } from "@/modules/catalog";
import { isForbidden, loadCatalogContext } from "../../_lib/context";
import { categoryOptions } from "../../_lib/category-options";
import { CatalogPage, PermissionDenied, TableSkeleton } from "../../_components/shell";
import { ProductForm } from "../../_components/product-form";

export default function NewProductPage() {
  return (
    <Suspense fallback={<TableSkeleton rows={6} />}>
      <NewProductContent />
    </Suspense>
  );
}

async function NewProductContent() {
  const page = await loadCatalogContext("/catalog/products/new");
  if (page.kind === "denied" || !page.can.create) return <PermissionDenied locale={page.locale} />;
  const { ctx, locale, currency, can } = page;

  let categories;
  try {
    categories = await listCategories(ctx, { status: "active" });
  } catch (err) {
    if (isForbidden(err)) return <PermissionDenied locale={locale} />;
    throw err;
  }

  return (
    <CatalogPage locale={locale}>
      <ProductForm
        locale={locale}
        currency={currency}
        categories={categoryOptions(categories, locale)}
        canSeeCost={can.seeCost}
        readOnly={false}
      />
    </CatalogPage>
  );
}

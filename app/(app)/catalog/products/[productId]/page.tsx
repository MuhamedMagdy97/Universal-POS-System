import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getProduct, listCategories } from "@/modules/catalog";
import { isForbidden, isNotFound, loadCatalogContext } from "../../_lib/context";
import { categoryOptions } from "../../_lib/category-options";
import { CatalogPage, PermissionDenied, TableSkeleton } from "../../_components/shell";
import { ProductForm } from "../../_components/product-form";
import { ManagedNotice } from "../../../_components/managed-notice";

type Params = Promise<{ productId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ProductPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<TableSkeleton rows={6} />}>
      <ProductContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ProductContent({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ productId }, query] = await Promise.all([params, searchParams]);
  const page = await loadCatalogContext(`/catalog/products/${encodeURIComponent(productId)}`);
  if (page.kind === "denied") return <PermissionDenied locale={page.locale} />;
  const { ctx, locale, currency, can, managed } = page;

  let product;
  let categories;
  try {
    [product, categories] = await Promise.all([getProduct(ctx, productId), listCategories(ctx, { status: "all" })]);
  } catch (err) {
    // Unknown, malformed and other-tenant ids all look the same (C-8).
    if (isNotFound(err)) notFound();
    if (isForbidden(err)) return <PermissionDenied locale={locale} />;
    throw err;
  }

  return (
    <CatalogPage locale={locale}>
      {managed ? <ManagedNotice locale={locale} area="catalog" /> : null}
      <ProductForm
        // Remount when a different product is opened.
        key={product.id}
        locale={locale}
        currency={currency}
        categories={categoryOptions(categories, locale)}
        canSeeCost={can.seeCost}
        readOnly={!can.update}
        product={product}
        initialNotice={{
          saved: query.saved === "1",
          priceBelowCost: query.warn === "PRICE_BELOW_COST",
        }}
      />
    </CatalogPage>
  );
}

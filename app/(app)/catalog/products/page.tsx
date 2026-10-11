import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Cursor, listCategories, listProducts, Uuid, type ProductStatus } from "@/modules/catalog";
import { formatMinor } from "@/lib/money";
import { translator } from "@/lib/i18n";
import { isForbidden, loadCatalogContext } from "../_lib/context";
import { displayName, exactMatchId } from "../_lib/form-helpers";
import { flattenCategories } from "../_lib/category-options";
import { CatalogPage, CatalogSubnav, PermissionDenied, StatusBadge, TableSkeleton } from "../_components/shell";
import { ProductsToolbar } from "../_components/products-toolbar";

/** Back-office list requests 50 per page (resolution R13; API default stays 25). */
const PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <ProductsContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

function toStatus(value: string | undefined): ProductStatus {
  return value === "archived" || value === "all" ? value : "active";
}

async function ProductsContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  // Malformed URL values are dropped rather than turned into a 422 error page.
  const q = one(params.q)?.trim().slice(0, 64);
  const categoryId = Uuid.safeParse(one(params.categoryId)).data;
  const status = toStatus(one(params.status));
  const cursor = Cursor.safeParse(one(params.cursor)).success ? one(params.cursor) : undefined;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ q, categoryId, status: status === "active" ? undefined : status })) {
    if (value) query.set(key, value);
  }
  const listPath = `/catalog/products${query.size ? `?${query}` : ""}`;

  const page = await loadCatalogContext(listPath);
  if (page.kind === "denied") return <PermissionDenied locale={page.locale} />;
  const { ctx, locale, currency, can } = page;
  const tr = translator(locale);

  let result;
  let categories;
  try {
    [result, categories] = await Promise.all([
      listProducts(ctx, { q, categoryId, status, cursor, limit: PAGE_SIZE }),
      listCategories(ctx, { status: "all" }),
    ]);
  } catch (err) {
    if (isForbidden(err)) return <PermissionDenied locale={locale} />;
    throw err;
  }

  // A scanned barcode or exact SKU opens the product (replace: Back returns to the list).
  if (q && !cursor) {
    const exact = exactMatchId(q, result.items);
    if (exact) redirect(`/catalog/products/${exact}`);
  }

  const allCategories = flattenCategories(categories);
  const categoryName = new Map(allCategories.map((c) => [c.id, displayName(locale, c)]));
  const filtered = Boolean(q || categoryId || status !== "active");
  const nextHref = result.nextCursor
    ? `/catalog/products?${new URLSearchParams([...query, ["cursor", result.nextCursor]])}`
    : null;

  return (
    <CatalogPage locale={locale}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("catalog.products.title")}</h1>
        <CatalogSubnav locale={locale} current="products" />
        {can.create ? (
          <Link href="/catalog/products/new" className="ms-auto rounded-md bg-foreground px-4 py-2 text-background">
            {tr("catalog.products.add")}
          </Link>
        ) : null}
      </div>

      <ProductsToolbar
        // Remount on navigation so the inputs reflect the URL (back/forward safe).
        key={listPath}
        locale={locale}
        q={q ?? ""}
        categoryId={categoryId ?? ""}
        status={status}
        canCreate={can.create}
        categories={allCategories
          .filter((c) => c.isActive || c.id === categoryId)
          .map((c) => ({ id: c.id, label: `${"— ".repeat(c.depth - 1)}${displayName(locale, c)}` }))}
      />

      {result.items.length === 0 ? (
        filtered || cursor ? (
          <div className="flex flex-col items-start gap-2 rounded-md border border-border p-6">
            <p>{q ? tr("catalog.state.noResults", { q }) : tr("catalog.state.noResultsFiltered")}</p>
            <Link href="/catalog/products" className="underline">
              {tr("catalog.state.clearFilters")}
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 rounded-md border border-border p-6">
            <p className="text-lg font-medium">{tr("catalog.state.empty.title")}</p>
            <p className="text-muted">{tr("catalog.state.empty.body")}</p>
            {can.create ? (
              <Link href="/catalog/products/new" className="rounded-md bg-foreground px-4 py-2 text-background">
                {tr("catalog.products.add")}
              </Link>
            ) : null}
          </div>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-start">
                <th className="px-2 py-2 text-start font-medium">{tr("catalog.products.column.name")}</th>
                <th className="px-2 py-2 text-start font-medium">{tr("catalog.products.column.sku")}</th>
                <th className="px-2 py-2 text-start font-medium">{tr("catalog.products.column.category")}</th>
                <th className="px-2 py-2 text-end font-medium">{tr("catalog.products.column.price")}</th>
                <th className="px-2 py-2 text-start font-medium">{tr("catalog.products.column.vat")}</th>
                <th className="px-2 py-2 text-start font-medium">{tr("catalog.products.column.status")}</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id} className="border-b border-border">
                  <td className="px-2 py-2">
                    <Link
                      href={`/catalog/products/${item.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {displayName(locale, item)}
                    </Link>
                    {item.variantCount > 0 ? (
                      <span className="ms-2 text-xs text-muted">
                        {tr("catalog.products.variantCount", { count: item.variantCount })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2" dir="ltr">
                    <bdi className="font-mono">{item.sku}</bdi>
                  </td>
                  <td className="px-2 py-2">
                    {item.categoryId
                      ? (categoryName.get(item.categoryId) ?? tr("catalog.category.none"))
                      : tr("catalog.category.none")}
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    <bdi>{formatMinor(item.priceMinor, currency, locale)}</bdi>
                  </td>
                  <td className="px-2 py-2">{tr(`catalog.vatCategory.${item.vatCategory}`)}</td>
                  <td className="px-2 py-2">
                    <StatusBadge locale={locale} active={item.isActive} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor || nextHref ? (
        <div className="flex gap-3">
          {cursor ? (
            <Link href={listPath} className="rounded-md border border-border px-3 py-1">
              {tr("catalog.products.firstPage")}
            </Link>
          ) : null}
          {nextHref ? (
            <Link href={nextHref} className="rounded-md border border-border px-3 py-1">
              {tr("catalog.products.loadMore")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </CatalogPage>
  );
}

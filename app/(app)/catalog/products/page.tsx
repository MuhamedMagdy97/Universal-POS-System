import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Cursor, listCategories, listProducts, Uuid, VatCategory, type ProductStatus } from "@/modules/catalog";
import { formatMinor } from "@/lib/money";
import { translator } from "@/lib/i18n";
import { isForbidden, loadCatalogContext } from "../_lib/context";
import { displayName, exactMatchId } from "../_lib/form-helpers";
import { flattenCategories } from "../_lib/category-options";
import { CatalogPage, CatalogSubnav, PermissionDenied, StatusBadge, TableSkeleton } from "../_components/shell";
import { ProductsToolbar } from "../_components/products-toolbar";
import { ManagedNotice } from "../../_components/managed-notice";
import { ITEM_WORD_KEYS } from "../../_lib/business";
import { orgBusinessType } from "@/modules/org";
import { profileOf } from "@/modules/presets";

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
  const vatCategory = VatCategory.safeParse(one(params.vatCategory)).data;
  const status = toStatus(one(params.status));
  const cursor = Cursor.safeParse(one(params.cursor)).success ? one(params.cursor) : undefined;

  const query = new URLSearchParams();
  const filters = { q, categoryId, vatCategory, status: status === "active" ? undefined : status };
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const listPath = `/catalog/products${query.size ? `?${query}` : ""}`;

  const page = await loadCatalogContext(listPath);
  if (page.kind === "denied") return <PermissionDenied locale={page.locale} />;
  const { ctx, locale, currency, can, managed } = page;
  const tr = translator(locale);
  const words = ITEM_WORD_KEYS[profileOf(await orgBusinessType(ctx.orgId)).itemWord];

  let result;
  let categories;
  try {
    [result, categories] = await Promise.all([
      listProducts(ctx, { q, categoryId, vatCategory, status, cursor, limit: PAGE_SIZE }),
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
  const filtered = Boolean(q || categoryId || vatCategory || status !== "active");
  const nextHref = result.nextCursor
    ? `/catalog/products?${new URLSearchParams([...query, ["cursor", result.nextCursor]])}`
    : null;

  return (
    <CatalogPage locale={locale}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr(words.title)}</h1>
        <CatalogSubnav locale={locale} current="products" />
        {can.create ? (
          <div className="ms-auto flex gap-2">
            <Link href="/catalog/products/import" className="btn">
              {tr("catalog.import.link")}
            </Link>
            <Link href="/catalog/products/new" className="btn btn-primary">
              {tr(words.add)}
            </Link>
          </div>
        ) : null}
      </div>
      {managed ? <ManagedNotice locale={locale} area="catalog" /> : null}

      <ProductsToolbar
        // Remount on navigation so the inputs reflect the URL (back/forward safe).
        key={listPath}
        locale={locale}
        q={q ?? ""}
        categoryId={categoryId ?? ""}
        vatCategory={vatCategory ?? ""}
        status={status}
        canCreate={can.create}
        categories={allCategories
          .filter((c) => c.isActive || c.id === categoryId)
          .map((c) => ({ id: c.id, label: `${"— ".repeat(c.depth - 1)}${displayName(locale, c)}` }))}
      />

      {result.items.length === 0 ? (
        filtered || cursor ? (
          <div className="card flex flex-col items-start gap-2">
            <p>{q ? tr("catalog.state.noResults", { q }) : tr("catalog.state.noResultsFiltered")}</p>
            <Link href="/catalog/products" className="underline">
              {tr("catalog.state.clearFilters")}
            </Link>
          </div>
        ) : (
          <div className="card flex flex-col items-start gap-2">
            <p className="text-lg font-medium">{tr("catalog.state.empty.title")}</p>
            <p className="text-muted">{tr("catalog.state.empty.body")}</p>
            {can.create ? (
              <Link href="/catalog/products/new" className="btn btn-primary">
                {tr(words.add)}
              </Link>
            ) : null}
          </div>
        )
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr className="border-b border-border text-start">
                <th>{tr("catalog.products.column.name")}</th>
                <th>{tr("catalog.products.column.sku")}</th>
                <th>{tr("catalog.products.column.barcode")}</th>
                <th>{tr("catalog.products.column.category")}</th>
                <th className="text-end">{tr("catalog.products.column.price")}</th>
                <th>{tr("catalog.products.column.vat")}</th>
                <th>{tr("catalog.products.column.status")}</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id}>
                  <td>
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
                    {item.isService ? <span className="badge ms-2">{tr("catalog.service.badge")}</span> : null}
                  </td>
                  <td dir="ltr">
                    <bdi className="font-mono">{item.sku}</bdi>
                  </td>
                  <td dir="ltr">
                    {item.primaryBarcode ? (
                      <bdi className="font-mono">{item.primaryBarcode}</bdi>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td>
                    {item.categoryId
                      ? (categoryName.get(item.categoryId) ?? tr("catalog.category.none"))
                      : tr("catalog.category.none")}
                  </td>
                  <td className="text-end tabular-nums">
                    <bdi>{formatMinor(item.priceMinor, currency, locale)}</bdi>
                  </td>
                  <td>{tr(`catalog.vatCategory.${item.vatCategory}`)}</td>
                  <td>
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
            <Link href={listPath} className="btn btn-sm">
              {tr("catalog.products.firstPage")}
            </Link>
          ) : null}
          {nextHref ? (
            <Link href={nextHref} className="btn btn-sm">
              {tr("catalog.products.loadMore")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </CatalogPage>
  );
}

import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { loadCatalogContext } from "../../_lib/context";
import { CatalogPage, PermissionDenied, TableSkeleton } from "../../_components/shell";
import { ProductImport } from "../../_components/product-import";
import { ManagedNotice } from "../../../_components/managed-notice";

export default function ImportProductsPage() {
  return (
    <Suspense fallback={<TableSkeleton rows={6} />}>
      <ImportContent />
    </Suspense>
  );
}

async function ImportContent() {
  const page = await loadCatalogContext("/catalog/products/import");
  if (page.kind === "denied") return <PermissionDenied locale={page.locale} />;
  const { locale, can, managed } = page;
  const tr = translator(locale);

  return (
    <CatalogPage locale={locale}>
      <h1 className="text-2xl font-semibold">{tr("catalog.import.title")}</h1>
      {managed ? (
        <ManagedNotice locale={locale} area="catalog" />
      ) : can.create ? (
        <ProductImport locale={locale} />
      ) : (
        <PermissionDenied locale={locale} />
      )}
    </CatalogPage>
  );
}

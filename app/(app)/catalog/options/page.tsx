import { Suspense } from "react";
import { listOptionGroups } from "@/modules/catalog";
import { translator } from "@/lib/i18n";
import { isForbidden, loadCatalogContext } from "../_lib/context";
import { CatalogPage, CatalogSubnav, PermissionDenied, TableSkeleton } from "../_components/shell";
import { OptionsManager } from "../_components/options-manager";
import { ManagedNotice } from "../../_components/managed-notice";

/** Catalog → Options (restaurant-cafe-spec R7): option groups such as "Size" or "Extras" and their prices. */
export default function OptionsPage() {
  return (
    <Suspense fallback={<TableSkeleton rows={4} />}>
      <OptionsContent />
    </Suspense>
  );
}

async function OptionsContent() {
  const page = await loadCatalogContext("/catalog/options");
  if (page.kind === "denied") return <PermissionDenied locale={page.locale} />;
  const { ctx, locale, can, managed, currency } = page;
  const tr = translator(locale);

  let groups;
  try {
    groups = await listOptionGroups(ctx);
  } catch (err) {
    if (isForbidden(err)) return <PermissionDenied locale={locale} />;
    throw err;
  }

  return (
    <CatalogPage locale={locale}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("catalog.options.title")}</h1>
        <CatalogSubnav locale={locale} current="options" />
      </div>
      <p className="max-w-2xl text-muted">{tr("catalog.options.intro")}</p>
      {managed ? <ManagedNotice locale={locale} area="categories" /> : null}
      <OptionsManager
        key={groups.map((group) => `${group.id}:${group.choices.length}:${group.isActive}`).join("|")}
        locale={locale}
        currency={currency}
        groups={groups}
        canEdit={can.update && !managed}
      />
    </CatalogPage>
  );
}

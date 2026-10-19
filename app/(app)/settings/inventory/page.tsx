import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import {
  getInventoryLinkStatus,
  listInventoryPostings,
  listInventoryWarehouses,
} from "@/modules/integrations/inventory-sys";
import { formatLocalDateTime, reportSettings } from "@/modules/reports";
import { SettingsDenied } from "../_components/denied";
import { loadSettingsPage } from "../_lib/context";
import { InventorySettings } from "./inventory-settings";
import { PostingsList } from "./postings-list";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Settings → Inventory system (Phase 13 slices 1–4): the optional link to the separate inventory system.
 * Owner and Admin see it (`settings.manage`); only the Owner changes the link (`integrations.manage`).
 * `?page=N` pages the postings list.
 */
export default function InventorySettingsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <InventorySettingsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function InventorySettingsContent({ searchParams }: { searchParams: SearchParams }) {
  const page = await loadSettingsPage("settings.manage", "/settings/inventory");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const tr = translator(page.locale);
  const params = await searchParams;
  const status = await getInventoryLinkStatus(page.ctx);
  // The branch map needs the IMS's warehouses; null (not checked yet, or unreachable) hides the choice.
  const warehouses = status.link?.lastCheckOk ? await listInventoryWarehouses(page.ctx) : null;
  // Postings exist only once the shop has sold while linked; they stay listed after an unlink.
  const postings = status.link ? await listInventoryPostings(page.ctx, Number(params.page ?? 1)) : null;
  const { zone } = postings ? await reportSettings(page.ctx.orgId) : { zone: "UTC" };
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("settings.inventory.title")}</h1>
      <p className="max-w-2xl text-muted">{tr("settings.inventory.intro")}</p>
      <InventorySettings locale={page.locale} status={status} warehouses={warehouses} />
      {postings ? (
        <PostingsList
          locale={page.locale}
          page={postings.page}
          hasMore={postings.hasMore}
          rows={postings.items.map((row) => ({
            ...row,
            nextAttemptLocal: formatLocalDateTime(new Date(row.nextAttemptAt), zone),
          }))}
        />
      ) : null}
    </div>
  );
}

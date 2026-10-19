import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { getInventoryLinkStatus, listInventoryWarehouses } from "@/modules/integrations/inventory-sys";
import { SettingsDenied } from "../_components/denied";
import { loadSettingsPage } from "../_lib/context";
import { InventorySettings } from "./inventory-settings";

/**
 * Settings → Inventory system (Phase 13 slices 1–2): the optional link to the separate inventory system.
 * Owner and Admin see it (`settings.manage`); only the Owner changes the link (`integrations.manage`).
 */
export default function InventorySettingsPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <InventorySettingsContent />
    </Suspense>
  );
}

async function InventorySettingsContent() {
  const page = await loadSettingsPage("settings.manage", "/settings/inventory");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const tr = translator(page.locale);
  const status = await getInventoryLinkStatus(page.ctx);
  // The branch map needs the IMS's warehouses; null (not checked yet, or unreachable) hides the choice.
  const warehouses = status.link?.lastCheckOk ? await listInventoryWarehouses(page.ctx) : null;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("settings.inventory.title")}</h1>
      <p className="max-w-2xl text-muted">{tr("settings.inventory.intro")}</p>
      <InventorySettings locale={page.locale} status={status} warehouses={warehouses} />
    </div>
  );
}

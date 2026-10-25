import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { listBranches, listTables } from "@/modules/org";
import { currentProfile } from "../../_lib/business";
import { loadSettingsPage } from "../_lib/context";
import { SettingsDenied } from "../_components/denied";
import { TablesManager } from "./tables-manager";

/** Settings → Tables (restaurant-cafe-spec R3): each branch's tables, for café shops. Owner and Admin. */
export default function TablesPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <TablesContent />
    </Suspense>
  );
}

async function TablesContent() {
  const page = await loadSettingsPage("settings.manage", "/settings/tables");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const tr = translator(page.locale);
  const profile = await currentProfile();
  if (!profile?.tickets) {
    return <p className="notice">{tr("settings.tables.notCafe")}</p>;
  }
  const branches = (await listBranches(page.ctx)).filter((branch) => branch.isActive);
  const tables = await Promise.all(branches.map((branch) => listTables(page.ctx, branch.id)));
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("settings.tables.title")}</h1>
      <p className="max-w-2xl text-muted">{tr("settings.tables.intro")}</p>
      {branches.map((branch, index) => (
        <TablesManager
          key={`${branch.id}:${tables[index].map((table) => `${table.id}${table.name}${table.isActive}`).join("|")}`}
          locale={page.locale}
          branch={{ id: branch.id, name: branch.name }}
          tables={tables[index].filter((table) => table.isActive)}
        />
      ))}
    </div>
  );
}

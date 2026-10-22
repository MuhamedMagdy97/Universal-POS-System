import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { getOfflineSettings } from "@/modules/org";
import { formatLocalDateTime, reportSettings } from "@/modules/reports";
import { SettingsDenied } from "../_components/denied";
import { loadSettingsPage } from "../_lib/context";
import { OfflineSettingsForm } from "./offline-settings";

/**
 * Settings → Offline till (offline-till-spec OF5, OF16; slice 1): the shop's "Allow offline sales" and each till's
 * offline series and device. Owner and Admin see it (`settings.manage`); only the Owner changes it.
 */
export default function OfflineSettingsPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <OfflineSettingsContent />
    </Suspense>
  );
}

async function OfflineSettingsContent() {
  const page = await loadSettingsPage("settings.manage", "/settings/offline");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const tr = translator(page.locale);
  const [settings, { zone }] = await Promise.all([getOfflineSettings(page.ctx), reportSettings(page.ctx.orgId)]);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("settings.offline.title")}</h1>
      <p className="max-w-2xl text-muted">{tr("settings.offline.intro")}</p>
      <OfflineSettingsForm
        locale={page.locale}
        settings={{
          ...settings,
          registers: settings.registers.map((register) => ({
            ...register,
            enrolledLocal: register.device ? formatLocalDateTime(new Date(register.device.enrolledAt), zone) : null,
          })),
        }}
      />
    </div>
  );
}

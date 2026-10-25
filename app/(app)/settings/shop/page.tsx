import { Suspense } from "react";
import { hasPermission } from "@/lib/auth/permissions";
import { translator } from "@/lib/i18n";
import { getBusinessType, getScaleSettings, getServiceCharge } from "@/modules/org";
import { profileOf } from "@/modules/presets";
import { SettingsDenied } from "../_components/denied";
import { loadSettingsPage } from "../_lib/context";
import { ScaleSettingsForm } from "./scale-settings";
import { ServiceChargeForm } from "./service-charge";
import { ShopSettingsForm } from "./shop-settings";

/**
 * Settings → Shop (business-profiles-spec BP3): the business type, which picks the accent, till layout, item word
 * and dashboard tiles; and scale labels (weighed-selling-spec W6). Owner and Admin see it (`settings.manage`); only the Owner changes it (`shop.manage`).
 */
export default function ShopSettingsPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ShopSettingsContent />
    </Suspense>
  );
}

async function ShopSettingsContent() {
  const page = await loadSettingsPage("settings.manage", "/settings/shop");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const tr = translator(page.locale);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("settings.shop.title")}</h1>
      <p className="max-w-2xl text-muted">{tr("settings.shop.intro")}</p>
      <ShopSettingsForm
        locale={page.locale}
        businessType={await getBusinessType(page.ctx)}
        canManage={hasPermission(page.ctx.role, "shop.manage")}
      />
      {profileOf(await getBusinessType(page.ctx)).tickets ? (
        <ServiceChargeForm
          locale={page.locale}
          serviceChargeBp={(await getServiceCharge(page.ctx)).serviceChargeBp}
          canManage={hasPermission(page.ctx.role, "shop.manage")}
        />
      ) : null}
      <ScaleSettingsForm
        locale={page.locale}
        settings={await getScaleSettings(page.ctx)}
        canManage={hasPermission(page.ctx.role, "shop.manage")}
      />
    </div>
  );
}

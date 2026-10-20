import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { getReceiptSettings } from "@/modules/org";
import { isSaudiVatNumber } from "@/modules/sales/zatca";
import { ReceiptSettingsForm } from "./receipt-settings-form";

/** Receipt settings (T10 H3): what every printed receipt carries. Owner and Admin (`settings.manage`). */
export default function ReceiptSettingsPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReceiptSettingsContent />
    </Suspense>
  );
}

async function ReceiptSettingsContent() {
  const [locale, requestHeaders] = await Promise.all([getLocale(), headers()]);
  const tr = translator(locale);
  let ctx: TenantContext | null = null;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect("/login?next=%2Fsettings%2Freceipt");
    if (!(err instanceof AppError && err.code === "FORBIDDEN")) throw err;
  }
  if (!ctx || !hasPermission(ctx.role, "settings.manage")) {
    return (
      <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
        <h1 className="text-xl font-semibold">{tr("settings.state.forbidden")}</h1>
        <p className="text-muted">{tr("settings.state.forbiddenBody")}</p>
      </section>
    );
  }
  const settings = await getReceiptSettings(ctx);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("settings.receipt.title")}</h1>
      <p className="text-muted">{tr("settings.receipt.intro")}</p>
      {settings.countryCode === "SA" && !isSaudiVatNumber(settings.taxNumber ?? "") ? (
        <p role="alert" data-testid="zatca-warning" className="rounded-md border border-amber-600 p-3 text-amber-900">
          {tr("settings.receipt.zatcaWarning")}
        </p>
      ) : null}
      <ReceiptSettingsForm locale={locale} initial={settings} />
    </div>
  );
}

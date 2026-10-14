import { Suspense } from "react";
import { getDb } from "@/lib/db";
import { translator } from "@/lib/i18n";
import { listStaff } from "@/modules/org";
import { loadSettingsPage } from "../_lib/context";
import { SettingsDenied } from "../_components/denied";
import { StaffManager } from "./staff-manager";

/** Staff logins (onboarding O3, O4): Owner and Admin (`users.manage`). */
export default function StaffPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <StaffContent />
    </Suspense>
  );
}

async function StaffContent() {
  const page = await loadSettingsPage("users.manage", "/settings/staff");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const { ctx, locale } = page;
  const tr = translator(locale);
  const [staff, branches] = await Promise.all([
    listStaff(ctx),
    getDb().branch.findMany({
      where: { orgId: ctx.orgId },
      select: { id: true, name: true, isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("staff.title")}</h1>
      <p className="text-muted">{tr("staff.intro")}</p>
      <StaffManager locale={locale} actorRole={ctx.role} staff={staff} branches={branches} />
    </div>
  );
}

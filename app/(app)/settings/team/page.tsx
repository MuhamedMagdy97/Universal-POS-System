import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { listBranches, listStaffMembers } from "@/modules/org";
import { currentProfile } from "../../_lib/business";
import { loadSettingsPage } from "../_lib/context";
import { SettingsDenied } from "../_components/denied";
import { TeamManager } from "./team-manager";

/** Settings → Team (salon-spec S3): the staff members who do the work, their branches and commission. */
export default function TeamPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <TeamContent />
    </Suspense>
  );
}

async function TeamContent() {
  const page = await loadSettingsPage("settings.manage", "/settings/team");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const tr = translator(page.locale);
  if (!(await currentProfile())?.appointments) return <p className="notice">{tr("settings.team.notSalon")}</p>;
  const [members, branches] = await Promise.all([listStaffMembers(page.ctx), listBranches(page.ctx)]);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("settings.team.title")}</h1>
      <p className="max-w-2xl text-muted">{tr("settings.team.intro")}</p>
      <TeamManager
        locale={page.locale}
        members={members}
        branches={branches.filter((branch) => branch.isActive).map(({ id, name }) => ({ id, name }))}
      />
    </div>
  );
}

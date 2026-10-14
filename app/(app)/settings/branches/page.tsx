import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { listBranches } from "@/modules/org";
import { loadSettingsPage } from "../_lib/context";
import { SettingsDenied } from "../_components/denied";
import { BranchesManager } from "./branches-manager";

/** Branches and tills (onboarding O5): Owner and Admin (`settings.manage`). */
export default function BranchesPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <BranchesContent />
    </Suspense>
  );
}

async function BranchesContent() {
  const page = await loadSettingsPage("settings.manage", "/settings/branches");
  if (page.kind === "denied") return <SettingsDenied locale={page.locale} />;
  const tr = translator(page.locale);
  const branches = await listBranches(page.ctx);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("branches.title")}</h1>
      <p className="text-muted">{tr("branches.intro")}</p>
      <BranchesManager locale={page.locale} branches={branches} />
    </div>
  );
}

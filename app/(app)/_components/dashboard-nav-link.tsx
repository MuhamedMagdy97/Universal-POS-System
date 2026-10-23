import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { NavItem } from "./nav-item";

/** "Dashboard" sidebar link: every signed-in user has a dashboard. */
export async function DashboardNavLink() {
  return <NavItem href="/dashboard" label={translator(await getLocale())("dashboard.title")} icon="dashboard" />;
}

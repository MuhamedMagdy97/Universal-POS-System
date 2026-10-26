import { headers } from "next/headers";
import { NavItem } from "./nav-item";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { orgBusinessType } from "@/modules/org";
import { profileOf } from "@/modules/presets";

/** "Appointments" sidebar link (salon-spec S6): salon shops, with `sales.create` (the page and services re-check). */
export async function AppointmentsNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let allowed = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    allowed = hasPermission(ctx.role, "sales.create") && profileOf(await orgBusinessType(ctx.orgId)).appointments;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  if (!allowed) return null;
  return <NavItem href="/appointments" label={translator(locale)("appointments.nav")} icon="calendar" />;
}

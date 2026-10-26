import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { listDay, listServices } from "@/modules/appointments";
import { listStaffMembers, orgBusinessType } from "@/modules/org";
import { profileOf } from "@/modules/presets";
import { branchesInScope, reportSettings, todayIn } from "@/modules/reports";
import { PageHeader } from "@/app/_ui/page-header";
import { DayCalendar } from "./_components/day-calendar";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Appointments (salon-spec S5, S6): a branch's day, a column per staff member plus "Any". */
export default function AppointmentsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <AppointmentsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function AppointmentsContent({ searchParams }: { searchParams: SearchParams }) {
  const [params, locale, h] = await Promise.all([searchParams, getLocale(), headers()]);
  const tr = translator(locale);
  let ctx;
  try {
    ctx = await requireTenant(h);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect("/sign-in?next=/appointments");
    throw err;
  }
  if (!hasPermission(ctx.role, "sales.create") || !profileOf(await orgBusinessType(ctx.orgId)).appointments) {
    return (
      <section role="alert" className="card flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{tr("appointments.denied")}</h1>
      </section>
    );
  }
  const branches = await branchesInScope(ctx);
  const branch = branches.find((row) => row.id === one(params.branch)) ?? branches[0];
  if (!branch) return <p className="notice">{tr("appointments.noBranch")}</p>;
  const settings = await reportSettings(ctx.orgId);
  const day = one(params.day) ?? todayIn(settings.zone);
  const [data, staff, services] = await Promise.all([
    listDay(ctx, branch.id, day),
    listStaffMembers(ctx, branch.id),
    listServices(ctx),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={tr("appointments.title")} />
      <DayCalendar
        locale={locale}
        currency={settings.currency}
        branchId={branch.id}
        branches={branches}
        data={data}
        staff={staff.map((member) => ({ id: member.id, name: (locale === "ar" && member.nameAr) || member.name }))}
        services={services}
      />
    </div>
  );
}

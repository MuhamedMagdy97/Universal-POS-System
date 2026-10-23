import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { translator, type Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { getSaleForReturns, type SaleForReturns } from "@/modules/sales";
import { ReturnPanel } from "./_components/return-panel";

/**
 * Returns (T8): find a sale by its receipt number, refund some of its lines, or void it.
 * Shown to roles with `sales.refund` or `sales.void` (Owner, Manager). UI gating only: the
 * services re-check permission, scope and every rule under their locks.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ReturnsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReturnsContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function Denied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="card flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{tr("returns.state.forbidden")}</h1>
      <p className="text-muted">{tr("returns.state.forbiddenBody")}</p>
    </section>
  );
}

async function ReturnsContent({ searchParams }: { searchParams: SearchParams }) {
  const [params, locale, requestHeaders] = await Promise.all([searchParams, getLocale(), headers()]);
  const tr = translator(locale);

  let ctx: TenantContext;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect("/login?next=%2Freturns");
    if (err instanceof AppError && err.code === "FORBIDDEN") return <Denied locale={locale} />;
    throw err;
  }
  const canRefund = hasPermission(ctx.role, "sales.refund");
  const canVoid = hasPermission(ctx.role, "sales.void");
  if (!canRefund && !canVoid) return <Denied locale={locale} />;

  const number = one(params.number);
  let sale: SaleForReturns | null = null;
  let missing = false;
  if (number) {
    try {
      sale = await getSaleForReturns(ctx, number);
    } catch (err) {
      if (err instanceof AppError && err.code === "NOT_FOUND") missing = true;
      else throw err;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("returns.title")}</h1>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="field">
          <span>{tr("returns.search.label")}</span>
          <input
            name="number"
            defaultValue={number ?? ""}
            placeholder={tr("returns.search.placeholder")}
            dir="ltr"
            autoFocus={sale === null}
            className="input w-48"
          />
        </label>
        <button type="submit" className="btn">
          {tr("returns.search.submit")}
        </button>
      </form>
      <p className="text-sm text-muted">{tr("returns.search.hint")}</p>
      {missing ? (
        <p role="alert" className="notice notice-error">
          {tr("returns.notFound")}
        </p>
      ) : null}
      {sale ? <ReturnPanel key={sale.id} locale={locale} sale={sale} canRefund={canRefund} canVoid={canVoid} /> : null}
    </div>
  );
}

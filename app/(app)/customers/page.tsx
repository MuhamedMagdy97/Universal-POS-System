import { Suspense } from "react";
import Link from "next/link";
import { translator } from "@/lib/i18n";
import { listCustomers } from "@/modules/customers";
import { loadCustomersContext } from "./_lib/context";
import { CustomerForm } from "./_components/customer-form";
import { Denied } from "./_components/denied";

/**
 * Customers (customers-spec CU13): search by name or phone, `?archived=1` lists archived ones too.
 * `customers.read`; adding needs `customers.create`. The service re-checks every call.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <CustomersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function CustomersContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 120) : "";
  const showArchived = params.archived === "1";
  const page = await loadCustomersContext("/customers");
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const { ctx, locale, can } = page;
  const tr = translator(locale);
  const customers = await listCustomers(ctx, {
    ...(q ? { q } : {}),
    ...(showArchived ? { includeArchived: "true" } : {}),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("customers.title")}</h1>
        <Link
          href={showArchived ? "/customers" : "/customers?archived=1"}
          className="ms-auto text-sm underline-offset-4 hover:underline"
        >
          {showArchived ? tr("customers.activeOnly") : tr("customers.showArchived")}
        </Link>
      </div>
      <form role="search" className="flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={q}
          aria-label={tr("customers.search")}
          placeholder={tr("customers.searchPlaceholder")}
          className="min-w-64 flex-1 rounded-md border border-border bg-background px-3 py-2"
        />
        {showArchived ? <input type="hidden" name="archived" value="1" /> : null}
        <button type="submit" className="rounded-md border border-border px-4 py-2">
          {tr("customers.searchSubmit")}
        </button>
      </form>
      {can.create ? <CustomerForm locale={locale} /> : null}
      {customers.length === 0 ? (
        <p className="text-muted">{tr("customers.none")}</p>
      ) : (
        <table className="w-full text-start">
          <thead>
            <tr className="text-sm text-muted">
              <th className="py-2 text-start">{tr("customers.field.name")}</th>
              <th className="text-start">{tr("customers.field.phone")}</th>
              <th className="text-start">{tr("customers.field.taxNumber")}</th>
              <th className="text-start">{tr("customers.status")}</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="py-2">
                  <Link href={`/customers/${row.id}`} className="underline-offset-4 hover:underline">
                    {row.name}
                  </Link>
                </td>
                <td dir="ltr" className="text-start">
                  {row.phone}
                </td>
                <td dir="ltr" className="text-start">
                  {row.taxNumber}
                </td>
                <td>{row.isActive ? tr("customers.active") : tr("customers.archived")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

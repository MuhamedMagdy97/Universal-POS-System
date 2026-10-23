import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import { getCustomer, HISTORY_LIMIT, type CustomerDetail } from "@/modules/customers";
import { formatLocalDateTime } from "@/modules/reports";
import { loadCustomersContext } from "../_lib/context";
import { CustomerForm } from "../_components/customer-form";
import { Denied } from "../_components/denied";

/** One customer: details, totals and purchase history in the caller's branches (customers-spec CU14). */

type Params = Promise<{ customerId: string }>;

export default function CustomerPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <CustomerContent params={params} />
    </Suspense>
  );
}

async function CustomerContent({ params }: { params: Params }) {
  const { customerId } = await params;
  const page = await loadCustomersContext(`/customers/${customerId}`);
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const { ctx, locale, zone, can } = page;
  const tr = translator(locale);
  let customer: CustomerDetail;
  try {
    customer = await getCustomer(ctx, customerId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const money = (minor: number) => formatMoney(minor, customer.currency, locale);
  const when = (iso: string) => formatLocalDateTime(new Date(iso), zone);
  const { totals } = customer;
  const tiles: [string, string, string][] = [
    [tr("customers.totals.sales"), money(totals.salesMinor), String(totals.salesCount)],
    [tr("customers.totals.refunds"), money(totals.refundsMinor), String(totals.refundsCount)],
    [tr("customers.totals.net"), money(totals.netMinor), ""],
  ];

  return (
    <div className="flex flex-col gap-6">
      <Link href="/customers" className="text-sm underline-offset-4 hover:underline">
        {tr("customers.title")}
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">
          {customer.name}
          {customer.isActive ? null : (
            <span className="ms-2 text-base font-normal text-muted">{tr("customers.archived")}</span>
          )}
        </h1>
        <p dir="ltr" className="self-start">
          {customer.phone}
        </p>
        {customer.email ? (
          <p dir="ltr" className="self-start">
            {customer.email}
          </p>
        ) : null}
        {customer.taxNumber ? <p>{tr("customers.vatNo", { number: customer.taxNumber })}</p> : null}
        {customer.note ? <p className="text-muted">{customer.note}</p> : null}
      </div>
      {can.manage ? <CustomerForm key={JSON.stringify(customer)} locale={locale} customer={customer} /> : null}

      <dl className="grid gap-3 sm:grid-cols-3" data-testid="customer-totals">
        {tiles.map(([label, amount, count]) => (
          <div key={label} className="card p-4">
            <dt className="text-sm text-muted">{label}</dt>
            <dd dir="ltr" className="text-end text-xl font-semibold">
              {amount}
            </dd>
            {count ? <dd className="text-sm text-muted">{tr("customers.totals.count", { count })}</dd> : null}
          </div>
        ))}
      </dl>

      <section aria-labelledby="customer-sales" className="flex flex-col gap-2">
        <h2 id="customer-sales" className="text-lg font-semibold">
          {tr("customers.history.sales")}
        </h2>
        {customer.sales.length === 0 ? (
          <p className="text-muted">{tr("customers.history.noSales")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="customer-sales">
              <thead>
                <tr className="text-sm text-muted">
                  <th>{tr("customers.history.number")}</th>
                  <th className="text-start">{tr("customers.history.time")}</th>
                  <th className="text-start">{tr("customers.history.branch")}</th>
                  <th className="text-start">{tr("customers.status")}</th>
                  <th className="text-end">{tr("customers.history.total")}</th>
                </tr>
              </thead>
              <tbody>
                {customer.sales.map((sale) => (
                  <tr key={sale.id}>
                    <td dir="ltr" className="py-2 text-start">
                      {sale.number}
                    </td>
                    <td dir="ltr" className="text-start">
                      {when(sale.createdAt)}
                    </td>
                    <td>{sale.branchName}</td>
                    <td>
                      {sale.status === "VOIDED" ? tr("customers.history.voided") : tr("customers.history.completed")}
                    </td>
                    <td dir="ltr" className="text-end">
                      {money(sale.totalMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="customer-refunds" className="flex flex-col gap-2">
        <h2 id="customer-refunds" className="text-lg font-semibold">
          {tr("customers.history.refunds")}
        </h2>
        {customer.refunds.length === 0 ? (
          <p className="text-muted">{tr("customers.history.noRefunds")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="customer-refunds">
              <thead>
                <tr className="text-sm text-muted">
                  <th>{tr("customers.history.number")}</th>
                  <th className="text-start">{tr("customers.history.time")}</th>
                  <th className="text-end">{tr("customers.history.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {customer.refunds.map((refund) => (
                  <tr key={refund.id}>
                    <td dir="ltr" className="py-2 text-start">
                      {refund.saleNumber}
                    </td>
                    <td dir="ltr" className="text-start">
                      {when(refund.createdAt)}
                    </td>
                    <td dir="ltr" className="text-end">
                      {money(refund.totalMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-sm text-muted">{tr("customers.history.limit", { limit: String(HISTORY_LIMIT) })}</p>
    </div>
  );
}

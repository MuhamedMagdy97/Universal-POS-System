import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { translator, type Locale } from "@/lib/i18n";
import { formatMinor, type CurrencyCode } from "@/lib/money";
import {
  getSupplierStatement,
  listPurchaseOrders,
  listSupplierInvoices,
  type InvoiceRow,
  type StatementEntry,
  type SupplierInvoices,
  type SupplierStatement,
} from "@/modules/purchasing";
import { balanceEffect, oldestFirst, type OpenInvoice } from "@/modules/purchasing/rules";
import { todayIn } from "@/modules/reports";
import { loadPurchasingContext } from "../../_lib/context";
import { Denied } from "../../_components/states";
import { PaymentForm, ReversePayment } from "../../_components/supplier-account";
import { AllocatePayment, InvoiceForm, VoidInvoice } from "../../_components/supplier-invoices";

/**
 * A supplier's account (supplier-payments-spec S13, S15): balance, statement for a date range,
 * record and reverse payments; invoices and credit notes, allocation (supplier-invoices-spec I16).
 * purchases.manage with every branch; the service re-checks.
 */

type Props = {
  params: Promise<{ supplierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function SupplierAccountPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <SupplierAccount {...props} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

async function SupplierAccount({ params, searchParams }: Props) {
  const [{ supplierId }, query] = await Promise.all([params, searchParams]);
  const page = await loadPurchasingContext(`/purchasing/suppliers/${supplierId}`);
  if (page.kind === "denied" || !hasPermission(page.ctx.role, "purchases.manage")) {
    return <Denied locale={page.locale} />;
  }
  const { ctx, locale, currency, zone } = page;
  const tr = translator(locale);

  let statement: SupplierStatement;
  let rangeError = false;
  try {
    try {
      statement = await getSupplierStatement(ctx, supplierId, { from: one(query.from), to: one(query.to) });
    } catch (err) {
      if (!(err instanceof AppError && err.code === "VALIDATION_FAILED")) throw err;
      rangeError = true;
      statement = await getSupplierStatement(ctx, supplierId);
    }
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    if (err instanceof AppError && err.code === "FORBIDDEN") return <Denied locale={locale} />;
    throw err;
  }
  const { supplier } = statement;
  const [pos, docs] = await Promise.all([
    page.can.manage ? listPurchaseOrders(ctx, { supplierId: supplier.id, status: "all" }).then((p) => p.rows) : [],
    listSupplierInvoices(ctx, supplier.id),
  ]);
  const openInvoices: OpenInvoice[] = oldestFirst(
    docs.invoices.filter((doc) => doc.kind === "INVOICE" && doc.openMinor > 0),
  ).map(({ id, number, issuedOn, dueOn, openMinor }) => ({ id, number, issuedOn, dueOn, openMinor }));
  const pick = (rows: SupplierInvoices["uninvoicedReceipts"]) =>
    rows.map((r) => ({ id: r.id, number: r.number, day: todayIn(zone, r.at), valueMinor: r.valueMinor }));
  const unallocated = new Map(docs.unallocatedPayments.map((p) => [p.id, p.unallocatedMinor]));
  const money = (minor: number) => formatMinor(minor, currency, locale);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/purchasing/suppliers" className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.suppliers")}
      </Link>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{supplier.name}</h1>
        {supplier.isActive ? null : <span className="text-sm text-muted">{tr("purchasing.supplier.archived")}</span>}
        <Link
          href="/reports?report=supplier-balances&range=thisMonth"
          className="ms-auto text-sm underline-offset-4 hover:underline"
        >
          {tr("purchasing.account.allBalances")}
        </Link>
      </div>
      <p className="text-sm text-muted" dir="ltr">
        {[supplier.phone, supplier.email, supplier.taxNumber].filter(Boolean).join(" · ")}
      </p>

      <section aria-labelledby="balance" className="card flex flex-col gap-1 p-4">
        <h2 id="balance" className="text-sm text-muted">
          {tr("purchasing.account.balance")}
        </h2>
        <p className="text-2xl font-semibold tabular-nums" dir="ltr" data-testid="supplier-balance">
          {money(statement.balanceMinor)}
        </p>
        {statement.balanceMinor < 0 ? <p className="text-sm text-muted">{tr("purchasing.account.credit")}</p> : null}
        <p className="text-sm text-muted">
          {tr("purchasing.account.uninvoiced")}{" "}
          <span className="tabular-nums" dir="ltr" data-testid="supplier-uninvoiced">
            {money(sumValues(docs.uninvoicedReceipts))}
          </span>
        </p>
      </section>

      <InvoicesTable
        docs={docs.invoices}
        locale={locale}
        currency={currency}
        supplierId={supplier.id}
        canVoid={page.can.manage}
      />

      {page.can.manage ? (
        <InvoiceForm
          locale={locale}
          currency={currency}
          supplierId={supplier.id}
          today={docs.today}
          vatRateBp={docs.vatRateBp}
          receipts={pick(docs.uninvoicedReceipts)}
          returns={pick(docs.uncreditedReturns)}
          openInvoices={openInvoices}
        />
      ) : null}

      {page.can.manage ? (
        <PaymentForm
          locale={locale}
          currency={currency}
          supplierId={supplier.id}
          today={todayIn(zone)}
          pos={pos.filter((po) => po.status !== "DRAFT" && po.status !== "CANCELLED")}
          openInvoices={openInvoices}
        />
      ) : null}

      <h2 className="text-lg font-semibold">{tr("purchasing.account.statement")}</h2>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="field">
          <span>{tr("purchasing.account.from")}</span>
          <input type="date" name="from" dir="ltr" defaultValue={statement.from} className="input" />
        </label>
        <label className="field">
          <span>{tr("purchasing.account.to")}</span>
          <input type="date" name="to" dir="ltr" defaultValue={statement.to} className="input" />
        </label>
        <button type="submit" className="btn">
          {tr("purchasing.account.apply")}
        </button>
      </form>
      {rangeError ? (
        <p role="alert" className="notice notice-error">
          {tr("reports.error.range")}
        </p>
      ) : null}

      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">{tr("purchasing.account.statement")}</caption>
          <thead>
            <tr>
              <th scope="col">{tr("purchasing.account.col.date")}</th>
              <th scope="col">{tr("purchasing.account.col.entry")}</th>
              <th scope="col">{tr("purchasing.account.col.details")}</th>
              <th scope="col" className="text-end">
                {tr("purchasing.account.col.amount")}
              </th>
              <th scope="col" className="text-end">
                {tr("purchasing.account.col.balance")}
              </th>
              <th scope="col" className="print:hidden" />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td dir="ltr">{statement.from}</td>
              <td colSpan={3}>{tr("purchasing.account.opening")}</td>
              <td className="text-end tabular-nums" dir="ltr">
                {money(statement.openingMinor)}
              </td>
              <td />
            </tr>
            {statement.entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                locale={locale}
                currency={currency}
                supplierId={supplier.id}
                canReverse={page.can.manage}
                unallocatedMinor={unallocated.get(entry.id) ?? 0}
                openInvoices={openInvoices}
              />
            ))}
            {statement.entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-2 text-muted">
                  {tr("purchasing.account.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td dir="ltr">{statement.to}</td>
              <td colSpan={3}>{tr("purchasing.account.closing")}</td>
              <td className="text-end tabular-nums" dir="ltr" data-testid="statement-closing">
                {money(statement.closingMinor)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function EntryRow(props: {
  entry: StatementEntry;
  locale: Locale;
  currency: CurrencyCode;
  supplierId: string;
  canReverse: boolean;
  unallocatedMinor: number;
  openInvoices: OpenInvoice[];
}) {
  const { entry, locale, currency } = props;
  const tr = translator(locale);
  const isPayment = entry.kind === "PAYMENT" || entry.kind === "REVERSAL";
  // An invoice or credit note shows its total less the cost it replaces (supplier-invoices-spec I7).
  const covers =
    entry.coveredMinor && entry.coveredMinor > 0
      ? `${formatMinor(entry.amountMinor, currency, locale)} − ${formatMinor(entry.coveredMinor, currency, locale)}`
      : null;
  const details = [
    entry.method ? tr(`purchasing.method.${entry.method}`) : null,
    entry.number,
    covers,
    entry.reference,
    entry.note,
  ].filter(Boolean);
  return (
    <tr>
      <td className="whitespace-nowrap" dir="ltr">
        {entry.day}
      </td>
      <td>{tr(`purchasing.account.kind.${entry.kind}`)}</td>
      <td>
        {entry.purchaseOrderId && !isPayment ? (
          <Link href={`/purchasing/${entry.purchaseOrderId}`} className="underline-offset-4 hover:underline" dir="ltr">
            {entry.number}
          </Link>
        ) : (
          details.join(" · ")
        )}
      </td>
      <td className="text-end tabular-nums" dir="ltr">
        {formatMinor(balanceEffect(entry), currency, locale)}
      </td>
      <td className="text-end tabular-nums" dir="ltr">
        {formatMinor(entry.balanceMinor, currency, locale)}
      </td>
      <td className="px-2 py-2 print:hidden">
        {entry.kind === "PAYMENT" && entry.reversed ? (
          <span className="text-xs text-muted">{tr("purchasing.payment.reversed")}</span>
        ) : entry.kind === "PAYMENT" && props.canReverse ? (
          <div className="flex flex-col items-start gap-1">
            <ReversePayment
              locale={locale}
              supplierId={props.supplierId}
              paymentId={entry.id}
              label={`${entry.day} ${formatMinor(entry.amountMinor, currency, locale)}`}
            />
            {props.unallocatedMinor > 0 && props.openInvoices.length > 0 ? (
              <AllocatePayment
                locale={locale}
                currency={currency}
                supplierId={props.supplierId}
                paymentId={entry.id}
                unallocatedMinor={props.unallocatedMinor}
                invoices={props.openInvoices}
              />
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function sumValues(rows: readonly { valueMinor: number }[]): number {
  return rows.reduce((total, row) => total + row.valueMinor, 0);
}

const STATUS_TONE: Record<InvoiceRow["status"], string> = {
  OPEN: "border-accent text-accent",
  PAID: "border-success text-success",
  OVERDUE: "border-danger text-danger",
  VOID: "border-border text-muted line-through",
};

/** The supplier's invoices and credit notes, newest first (I10, I16). */
function InvoicesTable(props: {
  docs: InvoiceRow[];
  locale: Locale;
  currency: CurrencyCode;
  supplierId: string;
  canVoid: boolean;
}) {
  const { docs, locale, currency } = props;
  const tr = translator(locale);
  const money = (minor: number) => formatMinor(minor, currency, locale);
  const th = "px-2 py-2 text-start font-medium";
  const thEnd = "px-2 py-2 text-end font-medium";
  const num = "px-2 py-2 text-end tabular-nums";
  return (
    <section aria-labelledby="invoices" className="flex flex-col gap-2">
      <h2 id="invoices" className="text-lg font-semibold">
        {tr("purchasing.invoice.title")}
      </h2>
      {docs.length === 0 ? (
        <p className="text-sm text-muted">{tr("purchasing.invoice.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{tr("purchasing.invoice.title")}</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>
                  {tr("purchasing.invoice.number")}
                </th>
                <th scope="col" className={th}>
                  {tr("purchasing.invoice.kind")}
                </th>
                <th scope="col" className={th}>
                  {tr("purchasing.invoice.issuedOn")}
                </th>
                <th scope="col" className={th}>
                  {tr("purchasing.invoice.dueOn")}
                </th>
                <th scope="col" className={thEnd}>
                  {tr("purchasing.invoice.vat")}
                </th>
                <th scope="col" className={thEnd}>
                  {tr("purchasing.invoice.total")}
                </th>
                <th scope="col" className={thEnd}>
                  {tr("purchasing.invoice.paid")}
                </th>
                <th scope="col" className={thEnd}>
                  {tr("purchasing.invoice.open")}
                </th>
                <th scope="col" className={th}>
                  {tr("purchasing.invoice.status")}
                </th>
                <th scope="col" className="print:hidden" />
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} data-testid={`invoice-${doc.number}`}>
                  <td dir="ltr">{doc.number}</td>
                  <td>{tr(`purchasing.invoice.kind.${doc.kind}`)}</td>
                  <td className="whitespace-nowrap" dir="ltr">
                    {doc.issuedOn}
                  </td>
                  <td className="whitespace-nowrap" dir="ltr">
                    {doc.dueOn ?? "—"}
                  </td>
                  <td className={num} dir="ltr">
                    {money(doc.vatMinor)}
                  </td>
                  <td className={num} dir="ltr">
                    {money(doc.totalMinor)}
                  </td>
                  <td className={num} dir="ltr">
                    {doc.kind === "INVOICE" ? money(doc.paidMinor + doc.creditedMinor) : "—"}
                  </td>
                  <td className={num} dir="ltr">
                    {doc.kind === "INVOICE" ? money(doc.openMinor) : "—"}
                  </td>
                  <td>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_TONE[doc.status]}`}
                      data-testid="invoice-status"
                    >
                      {doc.kind === "INVOICE" || doc.status === "VOID"
                        ? tr(`purchasing.invoice.status.${doc.status}`)
                        : tr("purchasing.invoice.status.CREDITED")}
                    </span>
                    {doc.voidReason ? <span className="ms-2 text-xs text-muted">{doc.voidReason}</span> : null}
                  </td>
                  <td className="px-2 py-2 print:hidden">
                    {props.canVoid && doc.status !== "VOID" ? (
                      <VoidInvoice
                        locale={locale}
                        supplierId={props.supplierId}
                        invoiceId={doc.id}
                        label={doc.number}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

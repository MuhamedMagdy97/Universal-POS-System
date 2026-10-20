import { Suspense } from "react";
import Link from "next/link";
import { translator } from "@/lib/i18n";
import { listTransfers } from "@/modules/inventory";
import { loadInventoryContext } from "../_lib/context";
import { BranchPicker } from "../_components/branch-picker";
import { NotAllowed, NotFound } from "../_components/states";

/** Outgoing and incoming two-step transfers of one branch (transit-transfers-spec §5). */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const DIRECTIONS = ["outgoing", "incoming"] as const;
type Direction = (typeof DIRECTIONS)[number];

export default function TransfersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <TransfersContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

async function TransfersContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requestedBranch = one(params.branch);
  const direction: Direction = one(params.dir) === "incoming" ? "incoming" : "outgoing";
  const page = await loadInventoryContext(
    `/inventory/transfers${requestedBranch ? `?branch=${requestedBranch}` : ""}`,
    requestedBranch,
  );
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, can, branches, branch } = page;
  const tr = translator(locale);
  const rows = await listTransfers(ctx, { branchId: branch.id, direction });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("inventory.transfers.title")}</h1>
        {can.transfer ? (
          <Link
            href={`/inventory/transfer?branch=${branch.id}`}
            className="ms-auto rounded-md bg-foreground px-3 py-2 text-background"
          >
            {tr("inventory.action.newTransfer")}
          </Link>
        ) : null}
      </div>
      <BranchPicker locale={locale} action="/inventory/transfers" branches={branches} currentId={branch.id} />

      <nav aria-label={tr("inventory.transfers.title")} className="flex gap-2">
        {DIRECTIONS.map((value) => (
          <Link
            key={value}
            href={`/inventory/transfers?branch=${branch.id}&dir=${value}`}
            aria-current={value === direction ? "page" : undefined}
            className={`rounded-md px-3 py-1 text-sm ${value === direction ? "bg-foreground text-background" : "border border-border"}`}
          >
            {tr(`inventory.transfers.${value}` as const)}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-muted">{tr("inventory.transfers.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="py-2 text-start">{tr("inventory.transfers.column.reference")}</th>
                <th className="text-start">
                  {direction === "outgoing"
                    ? tr("inventory.transfers.column.to")
                    : tr("inventory.transfers.column.from")}
                </th>
                <th className="text-start">{tr("inventory.transfers.column.sent")}</th>
                <th className="text-end">{tr("inventory.transfers.column.units")}</th>
                <th className="text-start">{tr("inventory.transfers.column.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border">
                  <td className="py-2">
                    <Link href={`/inventory/transfers/${row.id}`} className="underline-offset-4 hover:underline">
                      <bdi>{row.reference}</bdi>
                    </Link>
                  </td>
                  <td>{direction === "outgoing" ? row.toBranch.name : row.fromBranch.name}</td>
                  <td>{dateFormat.format(row.sentAt)}</td>
                  <td dir="ltr" className="text-end">
                    {row.unitsSent}
                  </td>
                  <td>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${row.status === "SENT" ? "bg-amber-100 text-amber-800" : "bg-gray-200 text-gray-700"}`}
                    >
                      {tr(`inventory.transfers.status.${row.status}` as const)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

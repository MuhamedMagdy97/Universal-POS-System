import { Suspense } from "react";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { listCounts } from "@/modules/inventory";
import { loadInventoryContext } from "../_lib/context";
import { BranchPicker } from "../_components/branch-picker";
import { NewCountForm } from "../_components/new-count-form";
import { NotAllowed, NotFound } from "../_components/states";
import { ManagedNotice } from "../../_components/managed-notice";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Stock counts at one branch (stock-counts-spec §5): newest 50, and "New count" for inventory.adjust. */
export default function CountsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <CountsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function CountsContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const raw = Array.isArray(params.branch) ? params.branch[0] : params.branch;
  const requestedBranch = raw?.trim() || undefined;
  const page = await loadInventoryContext(
    `/inventory/counts${requestedBranch ? `?branch=${requestedBranch}` : ""}`,
    requestedBranch,
  );
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, can, managed, branches, branch } = page;
  const tr = translator(locale);
  let rows;
  try {
    rows = await listCounts(ctx, { branchId: branch.id });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return <NotAllowed locale={locale} />;
    if (err instanceof AppError && err.code === "NOT_FOUND") return <NotFound locale={locale} branches={branches} />;
    throw err;
  }
  const hasOpen = rows.some((row) => row.status === "DRAFT" || row.status === "COUNTING");
  const categories =
    can.adjust && !hasOpen
      ? await getDb().category.findMany({
          where: { orgId: ctx.orgId, isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true, nameAr: true },
        })
      : [];
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/inventory?branch=${branch.id}`} className="underline">
          {tr("inventory.title")}
        </Link>
        <h1 className="text-2xl font-semibold">{tr("inventory.count.title")}</h1>
      </div>
      {managed ? <ManagedNotice locale={locale} area="stock" /> : null}
      <BranchPicker locale={locale} action="/inventory/counts" branches={branches} currentId={branch.id} />

      {can.adjust && !hasOpen ? (
        <NewCountForm
          locale={locale}
          branchId={branch.id}
          categories={categories.map((c) => ({ id: c.id, name: locale === "ar" && c.nameAr ? c.nameAr : c.name }))}
        />
      ) : null}

      {rows.length === 0 ? (
        <p className="card text-muted">{tr("inventory.count.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="py-2">{tr("inventory.count.column.created")}</th>
                <th>{tr("inventory.count.column.scope")}</th>
                <th>{tr("inventory.count.column.status")}</th>
                <th>{tr("inventory.count.column.items")}</th>
                <th>{tr("inventory.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{dateFormat.format(row.createdAt)}</td>
                  <td>
                    {tr(`inventory.count.scope.${row.scope}` as const)}
                    {row.categoryName ? `: ${row.categoryName}` : ""}
                  </td>
                  <td>{tr(`inventory.count.status.${row.status}` as const)}</td>
                  <td dir="ltr">{row.counted}</td>
                  <td>
                    <Link href={`/inventory/counts/${row.id}`} className="underline">
                      {tr("inventory.count.open")}
                    </Link>
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

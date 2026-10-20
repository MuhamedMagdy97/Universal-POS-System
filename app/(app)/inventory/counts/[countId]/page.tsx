import { Suspense } from "react";
import Link from "next/link";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getCount } from "@/modules/inventory";
import { loadInventoryContext } from "../../_lib/context";
import { CountSession } from "../../_components/count-session";
import { NotAllowed, NotFound } from "../../_components/states";
import { CountSheetPrint } from "./count-sheet";

type Params = Promise<{ countId: string }>;

/** One stock count: draft, counting, review or the posted/cancelled summary (stock-counts-spec §5). */
export default function CountPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <CountContent params={params} />
    </Suspense>
  );
}

async function CountContent({ params }: { params: Params }) {
  const { countId } = await params;
  const page = await loadInventoryContext(`/inventory/counts/${countId}`, undefined);
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, can, branches } = page;
  const tr = translator(locale);
  let count;
  try {
    count = await getCount(ctx, countId);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return <NotAllowed locale={locale} />;
    if (err instanceof AppError && err.code === "NOT_FOUND") return <NotFound locale={locale} branches={branches} />;
    throw err;
  }
  const branch = branches.find((b) => b.id === count.branchId);
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const heading = [
    branch ? `${tr("inventory.branch")}: ${branch.name}` : null,
    `${tr(`inventory.count.scope.${count.scope}` as const)}${count.categoryName ? `: ${count.categoryName}` : ""}`,
    dateFormat.format(count.createdAt),
    count.note,
  ]
    .filter(Boolean)
    .join(" · ");
  const open = count.status === "DRAFT" || count.status === "COUNTING";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/inventory/counts?branch=${count.branchId}`} className="underline">
          {tr("inventory.count.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{tr("inventory.count.detailTitle")}</h1>
        <span className="rounded-full border border-border px-2 py-0.5 text-sm" data-testid="count-status">
          {tr(`inventory.count.status.${count.status}` as const)}
        </span>
      </div>
      <p className="text-muted">{heading}</p>
      {open ? <CountSheetPrint locale={locale} countId={count.id} heading={heading} /> : null}
      <CountSession locale={locale} count={count} canEdit={can.adjust} />
    </div>
  );
}

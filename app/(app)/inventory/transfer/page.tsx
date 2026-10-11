import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { loadInventoryContext } from "../_lib/context";
import { NotAllowed, NotFound } from "../_components/states";
import { TransferForm } from "../_components/transfer-form";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function TransferPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <TransferContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

async function TransferContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requestedBranch = one(params.branch);
  const page = await loadInventoryContext(
    `/inventory/transfer${requestedBranch ? `?branch=${requestedBranch}` : ""}`,
    requestedBranch,
  );
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { locale, can, branches, branch } = page;
  const tr = translator(locale);
  if (!can.transfer) return <NotAllowed locale={locale} />;
  const destinations = branches.filter((b) => b.id !== branch.id);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("inventory.transfer.title")}</h1>
      {destinations.length === 0 ? (
        <p className="text-muted">{tr("inventory.transfer.noDestination")}</p>
      ) : (
        <TransferForm
          locale={locale}
          fromBranch={{ id: branch.id, name: branch.name }}
          destinations={destinations.map((b) => ({ id: b.id, name: b.name }))}
        />
      )}
    </div>
  );
}

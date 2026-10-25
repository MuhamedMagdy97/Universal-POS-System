import { Suspense } from "react";
import Link from "next/link";
import { AppError } from "@/lib/errors";
import { translator, type MessageKey } from "@/lib/i18n";
import { formatQty } from "@/lib/quantity";
import { Uuid, getItemLedger } from "@/modules/inventory";
import { transferReference } from "@/modules/inventory/schemas";
import { itemLabel, loadInventoryContext } from "../../_lib/context";
import { plain } from "../../_lib/form";
import { NotAllowed, NotFound } from "../../_components/states";
import { StockRowActions } from "../../_components/stock-row-actions";

/** Item history at one branch: header, running balances, newest first. */
const PAGE_SIZE = 25;

type Props = {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function ItemHistoryPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ItemHistoryContent {...props} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

async function ItemHistoryContent({ params, searchParams }: Props) {
  const { productId: rawProductId } = await params;
  const query = await searchParams;
  const requestedBranch = one(query.branch);
  const variant = one(query.variant);
  const cursor = one(query.cursor);

  const productIdCheck = Uuid.safeParse(rawProductId);
  const variantParsed = variant === undefined ? null : Uuid.safeParse(variant);
  const variantValid = variantParsed === null || variantParsed.success;
  const variantId = variantParsed?.success ? variantParsed.data : null;
  const path = `/inventory/items/${rawProductId}${requestedBranch ? `?branch=${requestedBranch}` : ""}`;
  const page = await loadInventoryContext(path, requestedBranch);
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, can, branches, branch } = page;
  const tr = translator(locale);
  const label = productIdCheck.success && variantValid ? await itemLabel(ctx.orgId, rawProductId, variantId) : null;
  if (!productIdCheck.success || !label) return <NotFound locale={locale} branches={branches} />;

  let history;
  try {
    history = await getItemLedger(ctx, {
      branchId: branch.id,
      productId: rawProductId,
      variantId: variantId,
      cursor,
      limit: PAGE_SIZE,
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return <NotAllowed locale={locale} />;
    if (err instanceof AppError && err.code === "NOT_FOUND") return <NotFound locale={locale} branches={branches} />;
    throw err;
  }

  const displayName = label.variantName ? `${label.name} — ${label.variantName}` : label.name;
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const reasonLabel = (row: (typeof history.rows)[number]) => {
    if (row.refType === "StockCount") return tr("inventory.count.ledgerReason");
    if (row.adjustmentReason) return plain(locale, `inventory.reason.${row.adjustmentReason}` as MessageKey);
    return plain(locale, `inventory.movement.${row.reason}` as MessageKey);
  };
  const nextQuery = new URLSearchParams({ branch: branch.id });
  if (variantId) nextQuery.set("variant", variantId);
  if (history.nextCursor) nextQuery.set("cursor", history.nextCursor);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/inventory?branch=${branch.id}`} className="underline">
          {tr("inventory.title")}
        </Link>
        <h1 className="text-2xl font-semibold">
          {tr("inventory.history.title")}: {displayName}
        </h1>
        <span dir="ltr" className="text-muted">
          {label.sku}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <p className="text-lg">
          {tr("inventory.history.current", { qty: formatQty(history.qty, history.unitType, locale) })}
        </p>
        <StockRowActions
          locale={locale}
          branchId={branch.id}
          itemRef={{ productId: rawProductId, variantId: variantId }}
          itemLabel={displayName}
          onHand={history.qty}
          unitType={history.unitType}
          reorderPoint={history.reorderPoint}
          archived={label.archived}
          canAdjust={can.adjust}
          canTransfer={can.transfer}
          historyHref={`/inventory/items/${rawProductId}?branch=${branch.id}${variantId ? `&variant=${variantId}` : ""}`}
          transferHref={`/inventory/transfer?branch=${branch.id}`}
        />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="py-2">{tr("inventory.history.columns.date")}</th>
              <th>{tr("inventory.history.columns.reason")}</th>
              <th>{tr("inventory.history.columns.change")}</th>
              <th>{tr("inventory.history.columns.balance")}</th>
              <th>{tr("inventory.history.columns.by")}</th>
              <th>{tr("inventory.history.columns.note")}</th>
            </tr>
          </thead>
          <tbody>
            {history.rows.map((row) => (
              <tr key={row.id} className="border-b border-border align-top">
                <td>{dateFormat.format(row.createdAt)}</td>
                <td>
                  {reasonLabel(row)}
                  {row.transfer?.otherBranch ? (
                    <span className="block text-muted">
                      {row.qtyDelta < 0
                        ? tr("inventory.history.transferTo", { branch: row.transfer.otherBranch.name })
                        : tr("inventory.history.transferFrom", { branch: row.transfer.otherBranch.name })}
                    </span>
                  ) : null}
                  {row.refType === "StockTransfer" && row.refId ? (
                    <Link
                      href={`/inventory/transfers/${row.refId}`}
                      className="block underline-offset-4 hover:underline"
                    >
                      {tr("inventory.history.transferLink", { reference: transferReference(row.refId) })}
                    </Link>
                  ) : null}
                </td>
                <td dir="ltr" className={row.qtyDelta < 0 ? "text-danger" : ""}>
                  {row.qtyDelta > 0 ? "+" : ""}
                  {formatQty(row.qtyDelta, history.unitType, locale)}
                </td>
                <td dir="ltr">{formatQty(row.balanceAfter, history.unitType, locale)}</td>
                <td>{row.actor.name}</td>
                <td>{row.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {history.nextCursor ? (
        <Link href={`/inventory/items/${rawProductId}?${nextQuery}`} className="btn self-start">
          {tr("inventory.state.loadMore")}
        </Link>
      ) : null}
    </div>
  );
}

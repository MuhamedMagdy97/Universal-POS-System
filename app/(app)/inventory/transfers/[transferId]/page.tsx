import { Suspense } from "react";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getTransfer, type TransferDetail } from "@/modules/inventory";
import { loadInventoryContext } from "../../_lib/context";
import { NotAllowed } from "../../_components/states";
import { CancelTransferButton, ReceiveTransferForm } from "../../_components/transfer-receive";
import { PrintButton } from "../../../_components/printing";

/** One two-step transfer: header, lines, receive form, cancel and the A4 transfer note (spec §5, T15). */

type Props = {
  params: Promise<{ transferId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type Line = TransferDetail["lines"][number];

export default function TransferDetailPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <TransferContent {...props} />
    </Suspense>
  );
}

async function TransferContent({ params, searchParams }: Props) {
  const [{ transferId }, query] = await Promise.all([params, searchParams]);
  const page = await loadInventoryContext(`/inventory/transfers/${transferId}`, undefined);
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  const locale = page.locale;
  const tr = translator(locale);
  if (page.kind === "notFound") return <p role="alert">{tr("inventory.transfers.notFound")}</p>;
  const { ctx, can, branches } = page;

  let transfer: TransferDetail;
  try {
    transfer = await getTransfer(ctx, transferId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") {
      return <p role="alert">{tr("inventory.transfers.notFound")}</p>;
    }
    throw err;
  }

  const inScope = (id: string) => branches.some((b) => b.id === id);
  const open = transfer.status === "SENT";
  const canReceive = open && (can.transfer || can.adjust) && inScope(transfer.toBranch.id);
  const canCancel = open && can.transfer && inScope(transfer.fromBranch.id);
  const received = transfer.status === "RECEIVED";
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const labelOf = (line: Line) => {
    const name = locale === "ar" && line.nameAr ? line.nameAr : line.name;
    return line.variantName ? `${name} — ${line.variantName}` : name;
  };
  const shortOf = (line: Line) => (line.qtyReceived === null ? 0 : line.qtySent - line.qtyReceived);
  const unitsReceived = transfer.lines.reduce((sum, line) => sum + (line.qtyReceived ?? 0), 0);
  const org = await getDb().organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { name: true, legalName: true, receiptAddress: true, receiptPhone: true },
  });
  const fromSide = inScope(transfer.fromBranch.id);
  const backHref = `/inventory/transfers?branch=${fromSide ? transfer.fromBranch.id : transfer.toBranch.id}&dir=${fromSide ? "outgoing" : "incoming"}`;

  return (
    <div className="flex flex-col gap-4">
      <Link href={backHref} className="text-sm underline-offset-4 hover:underline">
        {tr("inventory.transfers.back")}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">
          <bdi>{transfer.reference}</bdi>
        </h1>
        <span data-testid="transfer-status" className="badge">
          {tr(`inventory.transfers.status.${transfer.status}` as const)}
        </span>
      </div>
      {query.sent && open ? <p role="status">{tr("inventory.transfers.sentNotice")}</p> : null}
      {query.received && received ? <p role="status">{tr("inventory.transfers.receive.done")}</p> : null}
      {query.cancelled && transfer.status === "CANCELLED" ? (
        <p role="status">{tr("inventory.transfers.cancelled")}</p>
      ) : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">{tr("inventory.transfers.column.from")}</dt>
        <dd>{transfer.fromBranch.name}</dd>
        <dt className="text-muted">{tr("inventory.transfers.column.to")}</dt>
        <dd>{transfer.toBranch.name}</dd>
        <dt className="text-muted">{tr("inventory.transfers.column.sent")}</dt>
        <dd>{dateFormat.format(transfer.sentAt)}</dd>
        <dt className="text-muted">{tr("inventory.transfers.sentBy")}</dt>
        <dd>{transfer.sentByName}</dd>
        {transfer.receivedAt ? (
          <>
            <dt className="text-muted">{tr("inventory.transfers.receivedAt")}</dt>
            <dd>{dateFormat.format(transfer.receivedAt)}</dd>
            <dt className="text-muted">{tr("inventory.transfers.receivedBy")}</dt>
            <dd>{transfer.receivedByName}</dd>
          </>
        ) : null}
        {transfer.cancelledAt ? (
          <>
            <dt className="text-muted">{tr("inventory.transfers.cancelledAt")}</dt>
            <dd>{dateFormat.format(transfer.cancelledAt)}</dd>
            <dt className="text-muted">{tr("inventory.transfers.cancelledBy")}</dt>
            <dd>{transfer.cancelledByName}</dd>
          </>
        ) : null}
        {transfer.note ? (
          <>
            <dt className="text-muted">{tr("inventory.transfers.note")}</dt>
            <dd>{transfer.note}</dd>
          </>
        ) : null}
        {transfer.receiveNote ? (
          <>
            <dt className="text-muted">{tr("inventory.transfers.receiveNote")}</dt>
            <dd>{transfer.receiveNote}</dd>
          </>
        ) : null}
      </dl>

      <div className="flex flex-wrap gap-2">
        <PrintButton label={tr("inventory.transfers.print")}>
          <article
            className="print-a4"
            dir={locale === "ar" ? "rtl" : "ltr"}
            lang={locale}
            data-testid="transfer-print"
          >
            <header style={{ display: "flex", justifyContent: "space-between", gap: "8mm", marginBottom: "6mm" }}>
              <div>
                <p style={{ fontWeight: 700, fontSize: "14px" }}>{org.legalName ?? org.name}</p>
                {org.receiptAddress ? <p>{org.receiptAddress}</p> : null}
                {org.receiptPhone ? <p dir="ltr">{org.receiptPhone}</p> : null}
              </div>
              <div style={{ textAlign: "end" }}>
                <p style={{ fontWeight: 700, fontSize: "14px" }}>{tr("inventory.transfers.printTitle")}</p>
                <p dir="ltr">{transfer.reference}</p>
                <p>{dateFormat.format(transfer.sentAt)}</p>
                <p>{tr(`inventory.transfers.status.${transfer.status}` as const)}</p>
              </div>
            </header>
            <p>
              <strong>{tr("inventory.transfers.column.from")}:</strong> {transfer.fromBranch.name} ·{" "}
              <strong>{tr("inventory.transfers.column.to")}:</strong> {transfer.toBranch.name}
            </p>
            <p style={{ marginBottom: "4mm" }}>
              <strong>{tr("inventory.transfers.sentBy")}:</strong> {transfer.sentByName}
              {transfer.receivedByName ? (
                <>
                  {" "}
                  · <strong>{tr("inventory.transfers.receivedBy")}:</strong> {transfer.receivedByName}
                </>
              ) : null}
            </p>
            <table>
              <thead>
                <tr>
                  <th>{tr("inventory.column.item")}</th>
                  <th>{tr("inventory.column.sku")}</th>
                  <th className="num">{tr("inventory.transfers.line.sent")}</th>
                  <th className="num">{tr("inventory.transfers.line.received")}</th>
                  {received ? <th className="num">{tr("inventory.transfers.line.short")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {transfer.lines.map((line) => (
                  <tr key={`${line.ref.productId}|${line.ref.variantId ?? ""}`}>
                    <td>{labelOf(line)}</td>
                    <td>
                      <bdi>{line.sku}</bdi>
                    </td>
                    <td className="num">{line.qtySent}</td>
                    {/* Blank until received: the receiver writes the count on paper. */}
                    <td className="num">{line.qtyReceived ?? ""}</td>
                    {received ? (
                      <td className="num">
                        {shortOf(line) > 0 && line.shortfallReason
                          ? `${shortOf(line)} (${tr(`inventory.reason.${line.shortfallReason}` as const)})`
                          : ""}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{tr("inventory.transfers.total")}</th>
                  <th />
                  <th className="num">{transfer.unitsSent}</th>
                  <th className="num">{received ? unitsReceived : ""}</th>
                  {received ? <th className="num">{transfer.unitsSent - unitsReceived}</th> : null}
                </tr>
              </tfoot>
            </table>
            {transfer.note ? (
              <p style={{ marginTop: "4mm" }}>
                <strong>{tr("inventory.transfers.note")}:</strong> {transfer.note}
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "12mm", marginTop: "16mm" }}>
              <p style={{ flex: 1, borderTop: "1px solid #000", paddingTop: "2mm" }}>
                {tr("inventory.transfers.signSent")}
              </p>
              <p style={{ flex: 1, borderTop: "1px solid #000", paddingTop: "2mm" }}>
                {tr("inventory.transfers.signReceived")}
              </p>
            </div>
          </article>
        </PrintButton>
        {canCancel ? (
          <CancelTransferButton locale={locale} transferId={transfer.id} fromBranchName={transfer.fromBranch.name} />
        ) : null}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr className="text-sm text-muted">
              <th>{tr("inventory.column.item")}</th>
              <th className="text-start">{tr("inventory.column.sku")}</th>
              <th className="text-end">{tr("inventory.transfers.line.sent")}</th>
              {received ? (
                <>
                  <th className="text-end">{tr("inventory.transfers.line.received")}</th>
                  <th className="text-end">{tr("inventory.transfers.line.short")}</th>
                  <th className="text-start">{tr("inventory.transfers.line.reason")}</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {transfer.lines.map((line) => (
              <tr key={`${line.ref.productId}|${line.ref.variantId ?? ""}`}>
                <td>{labelOf(line)}</td>
                <td dir="ltr" className="text-start">
                  {line.sku}
                </td>
                <td dir="ltr" className="text-end">
                  {line.qtySent}
                </td>
                {received ? (
                  <>
                    <td dir="ltr" className="text-end">
                      {line.qtyReceived}
                    </td>
                    <td dir="ltr" className="text-end">
                      {shortOf(line) || "—"}
                    </td>
                    <td>{line.shortfallReason ? tr(`inventory.reason.${line.shortfallReason}` as const) : "—"}</td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canReceive ? (
        <ReceiveTransferForm
          locale={locale}
          transferId={transfer.id}
          lines={transfer.lines.map((line) => ({
            ref: line.ref,
            label: labelOf(line),
            sku: line.sku,
            qtySent: line.qtySent,
          }))}
        />
      ) : null}
    </div>
  );
}

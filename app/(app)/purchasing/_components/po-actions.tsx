"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { canCancel, canClose, canOrder, canReceive } from "@/modules/purchasing/rules";
import type { PoStatus } from "@/modules/purchasing/schemas";
import { ConfirmDialog } from "../../catalog/_components/confirm-dialog";
import { cancelPoAction, closePoAction, orderPoAction } from "../actions";
import { errorKey, plain, safeAction } from "../_lib/purchasing";

type Kind = "order" | "cancel" | "close";

type Props = {
  locale: Locale;
  poId: string;
  status: PoStatus;
  receivedUnits: number;
  /** Null on a weighed order, where units add grams to pieces. */
  outstandingUnits: number | null;
  can: { manage: boolean; receive: boolean };
};

/** State actions on a PO (P3, P4), each behind the shared confirm dialog. The server re-checks the state. */
export function PoActions({ locale, poId, status, receivedUnits, outstandingUnits, can }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const [open, setOpen] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = { status, receivedUnits };

  async function confirm() {
    if (!open) return;
    if (open === "close" && reason.trim() === "") return;
    setPending(true);
    const result = await safeAction(() =>
      open === "order"
        ? orderPoAction(poId)
        : open === "cancel"
          ? cancelPoAction(poId, reason.trim())
          : closePoAction(poId, reason.trim()),
    );
    setPending(false);
    setOpen(null);
    setReason("");
    if (!result.ok) setError(plain(locale, errorKey(result.error)));
    else setError(null);
    router.refresh();
  }

  const button = "btn";
  const titles: Record<Kind, string> = {
    order: tr("purchasing.action.order"),
    cancel: tr("purchasing.action.cancel"),
    close: tr("purchasing.action.close"),
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {can.receive && canReceive(state) ? (
          <Link href={`/purchasing/${poId}/receive`} className="btn btn-primary">
            {tr("purchasing.action.receive")}
          </Link>
        ) : null}
        {can.manage && canOrder(state) ? (
          <button type="button" className={button} onClick={() => setOpen("order")}>
            {titles.order}
          </button>
        ) : null}
        {can.manage && canClose(state) ? (
          <button type="button" className={button} onClick={() => setOpen("close")}>
            {titles.close}
          </button>
        ) : null}
        {can.manage && canCancel(state) ? (
          <button type="button" className={button} onClick={() => setOpen("cancel")}>
            {titles.cancel}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={open !== null}
        title={open ? titles[open] : ""}
        body={
          open ? (
            <div className="flex flex-col gap-2">
              <p>
                {open === "order"
                  ? tr("purchasing.action.orderBody")
                  : open === "cancel"
                    ? tr("purchasing.action.cancelBody")
                    : outstandingUnits === null
                      ? tr("purchasing.action.closeBodyWeighed")
                      : tr("purchasing.action.closeBody", { units: outstandingUnits })}
              </p>
              {open !== "order" ? (
                <label className="field">
                  <span>{tr("purchasing.action.reason")}</span>
                  <input
                    value={reason}
                    maxLength={500}
                    required={open === "close"}
                    onChange={(e) => setReason(e.target.value)}
                    className="input"
                  />
                </label>
              ) : null}
            </div>
          ) : null
        }
        confirmLabel={open ? titles[open] : ""}
        cancelLabel={tr("purchasing.action.keep")}
        pending={pending || (open === "close" && reason.trim() === "")}
        onConfirm={() => void confirm()}
        onClose={() => {
          setOpen(null);
          setReason("");
        }}
      />
    </div>
  );
}
